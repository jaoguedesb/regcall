/**
 * RegCall - servidor de sinalizacao + estado das salas
 * -----------------------------------------------------
 * Express serve o front-end estatico.
 * Socket.IO cuida de: presenca, salas, canais, chat e sinalizacao WebRTC.
 * O audio/video NAO passa por aqui - vai direto peer-to-peer (mesh).
 */

import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'RegCall';
const SERVER_PASSWORD = (process.env.SERVER_PASSWORD || '').trim();

/* ------------------------------------------------------------------ */
/* ICE servers                                                         */
/* ------------------------------------------------------------------ */

function buildIceServers() {
  const servers = [];

  const stunExtra = (process.env.STUN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const stunUrls = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
    ...stunExtra,
  ];
  servers.push({ urls: stunUrls });

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUser = process.env.TURN_USERNAME || '';
  const turnCred = process.env.TURN_CREDENTIAL || '';

  if (turnUrls.length && turnUser && turnCred) {
    servers.push({ urls: turnUrls, username: turnUser, credential: turnCred });
  }

  return servers;
}

/* ------------------------------------------------------------------ */
/* Estado em memoria                                                   */
/* ------------------------------------------------------------------ */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, User>} socketId -> user */
const users = new Map();

const MAX_MESSAGES_PER_CHANNEL = 300;
const MAX_ROOMS = 200;

const AVATAR_COLORS = [
  '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#00b0f4',
];

const ADJECTIVES = ['Rapido', 'Dourado', 'Silencioso', 'Curioso', 'Bravo', 'Elegante', 'Turbo', 'Sonoro'];
const NOUNS = ['Tucano', 'Jaguar', 'Falcao', 'Lobo', 'Golfinho', 'Tatu', 'Coruja', 'Panda'];

function randomNick() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}${n}${Math.floor(Math.random() * 90 + 10)}`;
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  // garante unicidade
  for (const room of rooms.values()) {
    if (room.code === code) return makeRoomCode();
  }
  return code;
}

// Remove caracteres de controle (mantem acentos, emojis, espacos e pontuacao).
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function sanitize(str, max) {
  if (typeof str !== 'string') return '';
  return str.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

function createRoom(name, ownerUid) {
  const id = randomUUID();
  const room = {
    id,
    name: sanitize(name, 40) || 'Nova sala',
    code: makeRoomCode(),
    ownerUid,
    createdAt: Date.now(),
    channels: [
      { id: randomUUID(), name: 'geral', type: 'text' },
      { id: randomUUID(), name: 'avisos', type: 'text' },
      { id: randomUUID(), name: 'Sala de Voz', type: 'voice' },
      { id: randomUUID(), name: 'Jogatina', type: 'voice' },
    ],
    messages: new Map(), // channelId -> [msg]
    members: new Set(),  // socketIds
  };
  for (const ch of room.channels) {
    if (ch.type === 'text') room.messages.set(ch.id, []);
  }
  rooms.set(id, room);
  return room;
}

function roomPublic(room) {
  const members = [];
  for (const sid of room.members) {
    const u = users.get(sid);
    if (u) members.push(userPublic(u));
  }
  members.sort((a, b) => a.nick.localeCompare(b.nick));
  return {
    id: room.id,
    name: room.name,
    code: room.code,
    ownerUid: room.ownerUid,
    channels: room.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    members,
  };
}

function userPublic(u) {
  return {
    id: u.id,
    uid: u.uid,
    nick: u.nick,
    color: u.color,
    roomId: u.roomId,
    voiceChannelId: u.voiceChannelId,
    muted: u.muted,
    deafened: u.deafened,
    sharing: u.sharing,
    camera: u.camera,
    speaking: false,
  };
}

function roomsDirectory() {
  const list = [];
  for (const room of rooms.values()) {
    let online = 0;
    for (const sid of room.members) if (users.has(sid)) online++;
    list.push({
      id: room.id,
      name: room.name,
      code: room.code,
      online,
      voice: [...room.members].filter((sid) => users.get(sid)?.voiceChannelId).length,
      createdAt: room.createdAt,
    });
  }
  list.sort((a, b) => b.online - a.online || a.createdAt - b.createdAt);
  return list;
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(`room:${roomId}`).emit('room:state', roomPublic(room));
}

function broadcastDirectory() {
  io.emit('rooms:directory', roomsDirectory());
}

/** Todos os socketIds que estao no mesmo canal de voz (menos ele mesmo). */
function voicePeers(user) {
  const room = rooms.get(user.roomId);
  if (!room || !user.voiceChannelId) return [];
  const peers = [];
  for (const sid of room.members) {
    if (sid === user.id) continue;
    const other = users.get(sid);
    if (other && other.voiceChannelId === user.voiceChannelId) peers.push(sid);
  }
  return peers;
}

function leaveVoice(user, { silent = false } = {}) {
  if (!user.voiceChannelId) return;
  const peers = voicePeers(user);
  const channelId = user.voiceChannelId;
  user.voiceChannelId = null;
  user.sharing = false;
  user.camera = false;
  for (const pid of peers) {
    io.to(pid).emit('rtc:peer-left', { peerId: user.id, channelId });
  }
  if (!silent && user.roomId) broadcastRoom(user.roomId);
}

function leaveRoom(user, { silent = false } = {}) {
  const room = rooms.get(user.roomId);
  leaveVoice(user, { silent: true });
  const oldRoomId = user.roomId;
  user.roomId = null;
  if (room) {
    room.members.delete(user.id);
    const sock = io.sockets.sockets.get(user.id);
    if (sock) sock.leave(`room:${room.id}`);
    if (!silent) {
      broadcastRoom(room.id);
      systemMessage(room, `${user.nick} saiu da sala.`);
    }
    // limpa salas vazias e sem dono online (deixa 10 min de graca via timestamp)
    if (room.members.size === 0) {
      room.emptySince = Date.now();
    }
  }
  return oldRoomId;
}

function systemMessage(room, text) {
  const channel = room.channels.find((c) => c.type === 'text');
  if (!channel) return;
  const msg = {
    id: randomUUID(),
    channelId: channel.id,
    system: true,
    text,
    ts: Date.now(),
  };
  pushMessage(room, channel.id, msg);
  io.to(`room:${room.id}`).emit('chat:message', msg);
}

function pushMessage(room, channelId, msg) {
  if (!room.messages.has(channelId)) room.messages.set(channelId, []);
  const arr = room.messages.get(channelId);
  arr.push(msg);
  if (arr.length > MAX_MESSAGES_PER_CHANNEL) arr.splice(0, arr.length - MAX_MESSAGES_PER_CHANNEL);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(compression());

app.get('/api/config', (_req, res) => {
  res.json({
    appName: APP_NAME,
    iceServers: buildIceServers(),
    requiresPassword: Boolean(SERVER_PASSWORD),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, users: users.size, uptime: process.uptime() });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    setHeaders(res, filePath) {
      // Revalida a interface para nao executar JS antigo apos uma correcao.
      if (/\.(?:html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
  pingTimeout: 25000,
  pingInterval: 20000,
});

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  /** @type {User} */
  const user = {
    id: socket.id,
    uid: null,
    nick: randomNick(),
    color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    roomId: null,
    voiceChannelId: null,
    muted: false,
    deafened: false,
    sharing: false,
    camera: false,
    authed: !SERVER_PASSWORD,
  };
  users.set(socket.id, user);

  const ok = (cb, data) => typeof cb === 'function' && cb({ ok: true, ...data });
  const fail = (cb, error) => typeof cb === 'function' && cb({ ok: false, error });
  const requireAuth = (cb) => {
    if (!user.authed) {
      fail(cb, 'Autentique-se primeiro.');
      return false;
    }
    return true;
  };

  socket.emit('hello', { id: socket.id, requiresPassword: Boolean(SERVER_PASSWORD) });

  /* ---------------- identidade ---------------- */

  socket.on('auth', (payload = {}, cb) => {
    if (SERVER_PASSWORD) {
      if (sanitize(payload.password, 200) !== SERVER_PASSWORD) {
        return fail(cb, 'Senha do servidor incorreta.');
      }
    }
    user.authed = true;
    user.uid = sanitize(payload.uid, 64) || randomUUID();
    const nick = sanitize(payload.nick, 24);
    if (nick) user.nick = nick;
    if (typeof payload.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.color)) {
      user.color = payload.color;
    }
    ok(cb, { me: userPublic(user), rooms: roomsDirectory() });
  });

  socket.on('me:update', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const nick = sanitize(payload.nick, 24);
    if (nick) user.nick = nick;
    if (typeof payload.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.color)) {
      user.color = payload.color;
    }
    ok(cb, { me: userPublic(user) });
    if (user.roomId) broadcastRoom(user.roomId);
  });

  socket.on('me:state', (payload = {}) => {
    if (!user.authed) return;
    if (typeof payload.muted === 'boolean') user.muted = payload.muted;
    if (typeof payload.deafened === 'boolean') user.deafened = payload.deafened;
    if (typeof payload.sharing === 'boolean') user.sharing = payload.sharing;
    if (typeof payload.camera === 'boolean') user.camera = payload.camera;
    if (user.roomId) broadcastRoom(user.roomId);
  });

  socket.on('me:speaking', (payload = {}) => {
    if (!user.authed || !user.roomId || !user.voiceChannelId) return;
    socket.to(`room:${user.roomId}`).emit('peer:speaking', {
      id: user.id,
      speaking: Boolean(payload.speaking),
    });
  });

  /* ---------------- salas ---------------- */

  socket.on('rooms:list', (_p, cb) => {
    if (!requireAuth(cb)) return;
    ok(cb, { rooms: roomsDirectory() });
  });

  socket.on('room:create', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    if (rooms.size >= MAX_ROOMS) return fail(cb, 'Limite de salas atingido no servidor.');
    const room = createRoom(payload.name, user.uid);
    joinRoom(room, cb);
    broadcastDirectory();
  });

  socket.on('room:join', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    let room = null;
    if (payload.roomId) room = rooms.get(payload.roomId) || null;
    if (!room && payload.code) {
      const code = sanitize(payload.code, 12).toUpperCase();
      for (const r of rooms.values()) if (r.code === code) { room = r; break; }
    }
    if (!room) return fail(cb, 'Sala nao encontrada. Confira o codigo.');
    joinRoom(room, cb);
    broadcastDirectory();
  });

  function joinRoom(room, cb) {
    if (user.roomId === room.id) {
      return ok(cb, { room: roomPublic(room) });
    }
    if (user.roomId) leaveRoom(user);
    user.roomId = room.id;
    room.members.add(user.id);
    room.emptySince = null;
    socket.join(`room:${room.id}`);
    ok(cb, { room: roomPublic(room) });
    broadcastRoom(room.id);
    systemMessage(room, `${user.nick} entrou na sala.`);
  }

  socket.on('room:leave', (_p, cb) => {
    if (!requireAuth(cb)) return;
    leaveRoom(user);
    ok(cb, { rooms: roomsDirectory() });
    broadcastDirectory();
  });

  socket.on('room:rename', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const room = rooms.get(user.roomId);
    if (!room) return fail(cb, 'Voce nao esta em uma sala.');
    if (room.ownerUid !== user.uid) return fail(cb, 'Apenas o dono pode renomear a sala.');
    const name = sanitize(payload.name, 40);
    if (!name) return fail(cb, 'Nome invalido.');
    room.name = name;
    ok(cb, {});
    broadcastRoom(room.id);
    broadcastDirectory();
  });

  /* ---------------- canais ---------------- */

  socket.on('channel:create', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const room = rooms.get(user.roomId);
    if (!room) return fail(cb, 'Voce nao esta em uma sala.');
    const name = sanitize(payload.name, 30).toLowerCase().replace(/\s+/g, '-');
    if (!name) return fail(cb, 'Nome invalido.');
    if (room.channels.length >= 40) return fail(cb, 'Limite de canais atingido.');
    const type = payload.type === 'voice' ? 'voice' : 'text';
    const channel = {
      id: randomUUID(),
      name: type === 'voice' ? sanitize(payload.name, 30) : name,
      type,
    };
    room.channels.push(channel);
    if (type === 'text') room.messages.set(channel.id, []);
    ok(cb, { channel });
    broadcastRoom(room.id);
  });

  socket.on('channel:delete', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const room = rooms.get(user.roomId);
    if (!room) return fail(cb, 'Voce nao esta em uma sala.');
    if (room.ownerUid !== user.uid) return fail(cb, 'Apenas o dono pode apagar canais.');
    const idx = room.channels.findIndex((c) => c.id === payload.channelId);
    if (idx === -1) return fail(cb, 'Canal nao encontrado.');
    const [removed] = room.channels.splice(idx, 1);
    room.messages.delete(removed.id);
    // tira quem estava nesse canal de voz
    for (const sid of room.members) {
      const u = users.get(sid);
      if (u && u.voiceChannelId === removed.id) {
        leaveVoice(u, { silent: true });
        io.to(sid).emit('voice:kicked', { channelId: removed.id });
      }
    }
    ok(cb, {});
    broadcastRoom(room.id);
  });

  /* ---------------- chat ---------------- */

  socket.on('chat:history', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const room = rooms.get(user.roomId);
    if (!room) return fail(cb, 'Voce nao esta em uma sala.');
    const msgs = room.messages.get(payload.channelId) || [];
    ok(cb, { messages: msgs });
  });

  socket.on('chat:send', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const room = rooms.get(user.roomId);
    if (!room) return fail(cb, 'Voce nao esta em uma sala.');
    const channel = room.channels.find((c) => c.id === payload.channelId && c.type === 'text');
    if (!channel) return fail(cb, 'Canal invalido.');
    const text = sanitize(payload.text, 2000);
    if (!text) return fail(cb, 'Mensagem vazia.');
    const msg = {
      id: randomUUID(),
      channelId: channel.id,
      authorId: user.id,
      authorUid: user.uid,
      nick: user.nick,
      color: user.color,
      text,
      ts: Date.now(),
    };
    pushMessage(room, channel.id, msg);
    io.to(`room:${room.id}`).emit('chat:message', msg);
    ok(cb, { id: msg.id });
  });

  socket.on('chat:typing', (payload = {}) => {
    if (!user.authed || !user.roomId) return;
    socket.to(`room:${user.roomId}`).emit('chat:typing', {
      channelId: payload.channelId,
      nick: user.nick,
      id: user.id,
    });
  });

  /* ---------------- voz ---------------- */

  socket.on('voice:join', (payload = {}, cb) => {
    if (!requireAuth(cb)) return;
    const room = rooms.get(user.roomId);
    if (!room) return fail(cb, 'Voce nao esta em uma sala.');
    const channel = room.channels.find((c) => c.id === payload.channelId && c.type === 'voice');
    if (!channel) return fail(cb, 'Canal de voz invalido.');

    if (user.voiceChannelId === channel.id) return ok(cb, { peers: voicePeers(user) });
    if (user.voiceChannelId) leaveVoice(user, { silent: true });

    user.voiceChannelId = channel.id;
    const peers = voicePeers(user);

    // Quem ja estava no canal recebe o novo peer.
    // Regra de "polite": quem chega depois e o educado (polite = true).
    for (const pid of peers) {
      io.to(pid).emit('rtc:peer-joined', { peerId: user.id, channelId: channel.id, polite: false });
    }
    ok(cb, { peers: peers.map((id) => ({ peerId: id, polite: true })) });
    broadcastRoom(room.id);
    broadcastDirectory();
  });

  socket.on('voice:leave', (_p, cb) => {
    if (!requireAuth(cb)) return;
    leaveVoice(user);
    ok(cb, {});
    broadcastDirectory();
  });

  /* ---------------- sinalizacao WebRTC ---------------- */

  socket.on('rtc:signal', (payload = {}) => {
    if (!user.authed || !payload.to) return;
    const target = users.get(payload.to);
    if (!target || target.roomId !== user.roomId) return;
    io.to(payload.to).emit('rtc:signal', {
      from: user.id,
      description: payload.description,
      candidate: payload.candidate,
    });
  });

  // Mapa "streamId -> tipo" (mic | screen | screen-audio | camera)
  socket.on('rtc:tracks', (payload = {}) => {
    if (!user.authed || !user.roomId) return;
    const map = payload.map && typeof payload.map === 'object' ? payload.map : {};
    const targets = payload.to ? [payload.to] : voicePeers(user);
    for (const pid of targets) {
      io.to(pid).emit('rtc:tracks', { from: user.id, map });
    }
  });

  socket.on('rtc:renegotiate', (payload = {}) => {
    if (!user.authed || !payload.to) return;
    io.to(payload.to).emit('rtc:renegotiate', { from: user.id });
  });

  /* ---------------- desconexao ---------------- */

  socket.on('disconnect', () => {
    const roomId = user.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      leaveVoice(user, { silent: true });
      if (room) {
        room.members.delete(user.id);
        users.delete(socket.id);
        broadcastRoom(roomId);
        systemMessage(room, `${user.nick} saiu.`);
        if (room.members.size === 0) room.emptySince = Date.now();
      } else {
        users.delete(socket.id);
      }
    } else {
      users.delete(socket.id);
    }
    broadcastDirectory();
  });
});

/* ------------------------------------------------------------------ */
/* Limpeza de salas vazias                                             */
/* ------------------------------------------------------------------ */

const ROOM_TTL_MS = 1000 * 60 * 60; // 1h vazia -> apaga
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, room] of rooms) {
    let online = 0;
    for (const sid of room.members) if (users.has(sid)) online++;
    if (online === 0) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > ROOM_TTL_MS) {
        rooms.delete(id);
        changed = true;
      }
    } else {
      room.emptySince = null;
    }
  }
  if (changed) broadcastDirectory();
}, 60_000).unref?.();

httpServer.listen(PORT, () => {
  const ice = buildIceServers();
  const hasTurn = ice.some((s) => JSON.stringify(s.urls).includes('turn'));
  console.log(`\n  ${APP_NAME} rodando em http://localhost:${PORT}`);
  console.log(`  TURN configurado: ${hasTurn ? 'sim' : 'NAO (so funciona na mesma rede/redes simples)'}`);
  if (SERVER_PASSWORD) console.log('  Senha do servidor: ativada');
  console.log('');
});
