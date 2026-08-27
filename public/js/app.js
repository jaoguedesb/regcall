/**
 * RegCall — interface
 */
import { RTCEngine, QUALITY_PRESETS, formatBits } from './rtc.js';

/* ============================ helpers ============================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const AVATAR_COLORS = [
  '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#00b0f4',
];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function linkify(text) {
  const safe = escapeHtml(text);
  return safe.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const clean = m.replace(/[.,;:!?)]+$/, '');
    const tail = m.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
  });
}

function initials(nick) {
  const parts = String(nick || '?').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(nick || '?').slice(0, 2).toUpperCase();
}

function safeAvatarUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch (e) { return ''; }
}

function avatarStyle(user) {
  const color = /^#[0-9a-f]{6}$/i.test(user?.color || '') ? user.color : '#d77e49';
  const avatar = safeAvatarUrl(user?.avatar);
  return `background-color:${color}${avatar ? `;background-image:url(${JSON.stringify(avatar)})` : ''}`
    .replaceAll('"', '&quot;');
}

function paintAvatar(element, user) {
  const avatar = safeAvatarUrl(user?.avatar);
  element.textContent = avatar ? '' : initials(user?.nick);
  element.style.backgroundColor = user?.color || '#d77e49';
  element.style.backgroundImage = avatar ? `url(${JSON.stringify(avatar)})` : '';
  element.classList.toggle('has-photo', Boolean(avatar));
}

function timeLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `Hoje às ${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

const ICONS = {
  hash: '<svg viewBox="0 0 24 24"><path d="M5.5 9h13M4.5 15h13M10 3.5 8 20.5M16 3.5l-2 17"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/><path d="M3 3l18 18"/></svg>',
  deafOff: '<svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4.5" height="7" rx="2"/><rect x="17" y="13" width="4.5" height="7" rx="2"/><path d="M3 3l18 18"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20h8"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>',
};

/* ============================ estado ============================ */

const state = {
  socket: null,
  engine: null,
  config: null,
  me: null,
  room: null,
  directory: [],
  activeChannel: null,     // {id,name,type}
  voiceChannelId: null,
  view: 'home',            // home | chat | call
  focused: null,
  typingUsers: new Map(),
  pendingJoinCode: null,
  connectedOnce: false,
};

const store = {
  get(key, def) {
    try { const v = localStorage.getItem(`regcall.${key}`); return v === null ? def : JSON.parse(v); }
    catch (e) { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(`regcall.${key}`, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};

function authSession() { return store.get('googleSession', null); }
function saveAuthSession(session) { store.set('googleSession', session); }

function consumeOAuthCallback() {
  if (!location.hash.includes('access_token=')) return;
  const hash = new URLSearchParams(location.hash.slice(1));
  const accessToken = hash.get('access_token');
  if (accessToken) {
    saveAuthSession({
      accessToken,
      refreshToken: hash.get('refresh_token') || '',
      expiresAt: Number(hash.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || 3600),
    });
  }
  history.replaceState({}, '', location.pathname + location.search);
}

async function getAccessToken() {
  const session = authSession();
  if (!session?.accessToken) return '';
  if (!session.expiresAt || session.expiresAt > Date.now() / 1000 + 60) return session.accessToken;
  if (!session.refreshToken || !state.config?.supabasePublishableKey) return '';
  const response = await fetch(`${state.config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: state.config.supabasePublishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!response.ok) { saveAuthSession(null); return ''; }
  const data = await response.json();
  const fresh = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
  };
  saveAuthSession(fresh);
  return fresh.accessToken;
}

/* ============================ boot ============================ */

$$('img[data-fallback]').forEach((img) => {
  img.addEventListener('error', () => {
    if (img.dataset.done) return;
    img.dataset.done = '1';
    img.src = img.dataset.fallback;
  }, { once: true });
  // dispara a checagem tambem quando a imagem ja falhou antes do listener
  if (img.complete && img.naturalWidth === 0) { img.dataset.done = '1'; img.src = img.dataset.fallback; }
});

async function boot() {
  consumeOAuthCallback();
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
  } catch (e) {
    state.config = { appName: 'RegCall', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], requiresPassword: false };
  }
  document.title = state.config.appName || 'RegCall';

  if (state.config.requiresPassword) $('#login-pass-field').classList.remove('hidden');


  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode) state.pendingJoinCode = joinCode.toUpperCase();

  buildQualityUI();
  loadSettings();
  wireUI();
  warnInsecureContext();
  if (authSession()?.accessToken) doLogin();
}

/**
 * Sem HTTPS (ou localhost) o navegador bloqueia a captura de tela.
 * É de longe o motivo nº 1 de "não funciona" — então avisa antes de tentar.
 */
function warnInsecureContext() {
  if (window.isSecureContext) return;
  const host = location.hostname;
  const url = `http://localhost:${location.port || 80}${location.pathname}`;
  const msg = `Você abriu o RegCall por "${location.origin}". Sem HTTPS o navegador bloqueia a `
    + `captura de tela e do áudio da live.<br><br>`
    + (['localhost', '127.0.0.1'].includes(host)
      ? 'Estranho: localhost deveria ser considerado seguro. Atualize o navegador.'
      : `Na mesma máquina, acesse <b>${escapeHtml(url)}</b>. Para acessar de outros aparelhos, publique com HTTPS (Render, Railway, ou Cloudflare Tunnel).`);
  const el = $('#login-error');
  el.innerHTML = msg;
  el.style.textAlign = 'left';
  el.style.lineHeight = '1.5';
}

function buildColorPicker(root, selected) {
  root.innerHTML = '';
  for (const c of AVATAR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-dot' + (c === selected ? ' sel' : '');
    b.style.background = c;
    b.dataset.color = c;
    b.addEventListener('click', () => {
      $$('.color-dot', root).forEach((d) => d.classList.remove('sel'));
      b.classList.add('sel');
    });
    root.appendChild(b);
  }
}

/* ============================ login ============================ */

function startGoogleLogin() {
  if (!state.config?.googleAuthEnabled) {
    $('#login-error').textContent = 'Login Google ainda não foi configurado no servidor.';
    return;
  }
  const redirectTo = location.origin + location.pathname + location.search;
  const url = new URL(`${state.config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('redirect_to', redirectTo);
  location.assign(url.toString());
}

async function doLogin() {
  const password = $('#login-pass').value;
  const accessToken = await getAccessToken();
  if (!accessToken) { startGoogleLogin(); return; }

  $('#login-btn').disabled = true;
  $('#login-error').textContent = '';

  try {
    await connectSocket();
    const resp = await emit('auth', { accessToken, password });
    if (!resp.ok) throw new Error(resp.error);

    state.me = resp.me;
    state.directory = resp.rooms || [];

    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderMe();
    setupEngine();
    showHome();

    if (state.pendingJoinCode) {
      const code = state.pendingJoinCode;
      state.pendingJoinCode = null;
      history.replaceState({}, '', location.pathname);
      joinRoomByCode(code);
    }
  } catch (err) {
    $('#login-error').textContent = err.message || 'Não deu pra conectar.';
  } finally {
    $('#login-btn').disabled = false;
  }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    if (state.socket && state.socket.connected) return resolve();
    const socket = window.io({
      // Comeca com polling e sobe para WebSocket quando a rede/proxy permite.
      // Forcar WebSocket primeiro causava quedas em redes moveis e corporativas.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
      timeout: 20000,
    });
    state.socket = socket;

    const timer = setTimeout(() => reject(new Error('Servidor não respondeu.')), 12000);

    socket.once('connect', () => { clearTimeout(timer); state.connectedOnce = true; resolve(); });
    socket.once('connect_error', (e) => { clearTimeout(timer); reject(new Error('Falha de conexão com o servidor.')); });

    socket.on('disconnect', () => {
      toast('Conexão perdida. Reconectando…', 'error');
      if (state.engine) state.engine.closeAll();
    });
    socket.on('connect', () => {
      if (!state.me) return;
      // reconectou: refaz auth e volta pra sala
      reAuthenticate();
    });

    bindSocketEvents(socket);
  });
}

async function reAuthenticate() {
  if (state._reconnecting) return;
  state._reconnecting = true;
  try {
    const accessToken = await getAccessToken();
    const resp = await emit('auth', { accessToken, password: $('#login-pass').value });
    if (!resp.ok) { toast(resp.error, 'error'); return; }
    state.me = { ...state.me, ...resp.me };
    state.directory = resp.rooms || [];
    renderMe();
    renderDirectory();
    const roomId = state.room?.id;
    const code = state.room?.code;
    if (roomId) {
      const r = await emit('room:join', { roomId, code });
      if (r.ok) {
        state.room = r.room;
        renderRoom();
        toast('Reconectado!', 'success');
        if (state.voiceChannelId) {
          const ch = state.voiceChannelId;
          state.voiceChannelId = null;
          await joinVoice(ch);
        }
      } else {
        state.room = null;
        showHome();
      }
    }
  } catch (err) {
    console.error('[RegCall] falha ao restaurar sessao:', err);
    toast('Reconectei ao servidor, mas nao consegui restaurar a chamada.', 'error');
  } finally {
    state._reconnecting = false;
  }
}

function emit(event, payload) {
  return new Promise((resolve) => {
    if (!state.socket) return resolve({ ok: false, error: 'Sem conexão.' });
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'Tempo esgotado.' }); } }, 12000);
    state.socket.emit(event, payload, (resp) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(resp || { ok: false, error: 'Resposta inválida.' });
    });
  });
}

/* ============================ socket events ============================ */

function bindSocketEvents(socket) {
  socket.on('rooms:directory', (list) => {
    state.directory = list;
    renderDirectory();
  });

  socket.on('room:state', (room) => {
    if (!state.room || room.id !== state.room.id) return;
    state.room = room;
    renderRoom();
  });

  socket.on('chat:message', (msg) => {
    if (!state.room) return;
    if (state.activeChannel && msg.channelId === state.activeChannel.id) {
      appendMessage(msg);
    }
  });

  socket.on('chat:typing', ({ channelId, nick, id }) => {
    if (!state.activeChannel || channelId !== state.activeChannel.id) return;
    if (id === state.me?.id) return;
    state.typingUsers.set(id, { nick, at: Date.now() });
    renderTyping();
  });


  socket.on('voice:kicked', () => {
    leaveVoice();
    toast('O canal de voz foi removido.', 'error');
  });
}

/* ============================ engine ============================ */

function setupEngine() {
  if (state.engine) return;
  state.engine = new RTCEngine({
    socket: state.socket,
    iceServers: state.config.iceServers,
    handlers: {
      streams: () => renderStage(),
      peerState: (peerId, st) => {
        if (st === 'failed') console.warn('peer failed', peerId);
      },
      stats: (s) => renderStats(s),
      screenEnded: () => {
        setSharing(false);
        toast('Compartilhamento encerrado.');
      },
    },
  });
  applySettingsToEngine();

  // destrava o audio no primeiro clique (política de autoplay)
  const unlock = () => { state.engine.resumeAudio(); };
  document.addEventListener('click', unlock);
  document.addEventListener('keydown', unlock);
}

/* ============================ render: eu ============================ */

function renderMe() {
  if (!state.me) return;
  const av = $('#me-avatar');
  paintAvatar(av, state.me);
  $('#me-nick').textContent = state.me.nick;
  $('#me-sub').textContent = state.room ? state.room.name : 'online';
  paintAvatar($('#profile-avatar'), state.me);
  $('#profile-name').textContent = state.me.nick;
}

/* ============================ render: home ============================ */

function showHome() {
  state.view = 'home';
  state.activeChannel = null;
  $('#view-home').classList.remove('hidden');
  $('#view-chat').classList.add('hidden');
  $('#view-call').classList.add('hidden');
  $('#topbar-title').textContent = 'Início';
  $('#topbar-icon').textContent = '🏠';
  $('#topbar-sub').textContent = 'Escolha ou crie uma sala';
  $('#btn-home').classList.add('active');
  $$('#guild-list .guild').forEach((g) => g.classList.remove('active'));
  $('#room-name').textContent = 'Início';
  $('#channel-list').innerHTML = `
    <div class="cat"><span>Atalhos</span></div>
    <button class="chan" data-home-act="create">${ICONS.plus}<span class="nm">Criar sala</span></button>
    <button class="chan" data-home-act="join">${ICONS.hash}<span class="nm">Entrar com código</span></button>`;
  $$('#channel-list [data-home-act]').forEach((b) => {
    b.addEventListener('click', () => {
      openModal(b.dataset.homeAct === 'create' ? '#modal-create' : '#modal-join');
    });
  });
  $('#member-list').innerHTML = '';
  renderDirectory();
}

function renderDirectory() {
  const root = $('#room-directory');
  if (!root) return;
  if (!state.directory.length) {
    root.innerHTML = '<div class="empty-state">Nenhuma sala ativa ainda. Seja o primeiro a criar uma.</div>';
  } else {
    root.innerHTML = '';
    for (const r of state.directory) {
      const card = document.createElement('button');
      card.className = 'room-card';
      card.innerHTML = `
        <b>${escapeHtml(r.name)}</b>
        <div class="rc-meta">
          <span><span class="dot"></span>${r.online} online</span>
          <span>${r.voice} na voz</span>
        </div>
        <span class="rc-code">${escapeHtml(r.code)}</span>`;
      card.addEventListener('click', () => joinRoomById(r.id));
      root.appendChild(card);
    }
  }

  // barra lateral de salas
  const list = $('#guild-list');
  list.innerHTML = '';
  for (const r of state.directory) {
    const b = document.createElement('button');
    b.className = 'guild' + (state.room && state.room.id === r.id ? ' active' : '');
    b.title = r.name;
    b.dataset.room = r.id;
    b.textContent = initials(r.name);
    b.addEventListener('click', () => joinRoomById(r.id));
    list.appendChild(b);
  }
}

/* ============================ salas ============================ */

async function joinRoomById(roomId) {
  const resp = await emit('room:join', { roomId });
  if (!resp.ok) return toast(resp.error, 'error');
  enterRoom(resp.room);
}

async function joinRoomByCode(code) {
  const resp = await emit('room:join', { code });
  if (!resp.ok) return toast(resp.error, 'error');
  enterRoom(resp.room);
}

function enterRoom(room) {
  const changed = !state.room || state.room.id !== room.id;
  state.room = room;
  if (changed) {
    state.activeChannel = null;
    if (state.voiceChannelId) leaveVoice();
  }
  $('#btn-home').classList.remove('active');
  renderMe();
  const first = room.channels.find((c) => c.type === 'text') || room.channels[0];
  if (first) {
    openChannel(first);
  } else {
    state.view = 'chat';
    $('#view-home').classList.add('hidden');
    $('#view-call').classList.add('hidden');
    $('#view-chat').classList.remove('hidden');
    $('#messages').innerHTML = '<div class="empty-state">Esta sala não tem canais. Crie um pelo menu da sala.</div>';
    renderRoom();
  }
  closeNav();
}

function renderRoom() {
  if (!state.room) return;
  const room = state.room;

  // Na tela inicial a barra lateral mostra os atalhos, não os canais da sala.
  if (state.view === 'home') {
    renderVoicePanel();
    return;
  }
  $('#room-name').textContent = room.name;

  // canais
  const list = $('#channel-list');
  const text = room.channels.filter((c) => c.type === 'text');
  const voice = room.channels.filter((c) => c.type === 'voice');
  list.innerHTML = '';

  list.appendChild(categoryEl('Canais de texto'));
  for (const ch of text) list.appendChild(channelEl(ch));
  list.appendChild(categoryEl('Canais de live'));
  for (const ch of voice) {
    list.appendChild(channelEl(ch));
    const members = room.members.filter((m) => m.voiceChannelId === ch.id);
    if (members.length) {
      const wrap = document.createElement('div');
      wrap.className = 'vc-members';
      for (const m of members) wrap.appendChild(voiceMemberEl(m));
      list.appendChild(wrap);
    }
  }

  renderMembers();
  renderVoicePanel();
  if (state.view === 'call') renderStage();
  if (state.view === 'chat') {
    const n = room.members.length;
    $('#topbar-sub').textContent = `${n} ${n === 1 ? 'membro' : 'membros'}`;
  }

  // guilds
  $$('#guild-list .guild').forEach((g) => g.classList.toggle('active', g.dataset.room === room.id));
  $('#btn-home').classList.remove('active');
}

function categoryEl(label) {
  const el = document.createElement('div');
  el.className = 'cat';
  el.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const add = document.createElement('button');
  add.innerHTML = ICONS.plus;
  add.title = 'Criar canal';
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVoice = label.includes('live');
    $(`input[name="chtype"][value="${isVoice ? 'voice' : 'text'}"]`).checked = true;
    openModal('#modal-channel');
  });
  el.appendChild(add);
  return el;
}

function channelEl(ch) {
  const b = document.createElement('button');
  const active = state.activeChannel && state.activeChannel.id === ch.id;
  b.className = 'chan' + (active ? ' active' : '');
  b.innerHTML = `${ch.type === 'voice' ? ICONS.speaker : ICONS.hash}<span class="nm">${escapeHtml(ch.name)}</span>`;
  b.addEventListener('click', () => openChannel(ch));
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (state.room.ownerUid !== state.me.uid) return;
    if (confirm(`Apagar o canal "${ch.name}"?`)) {
      emit('channel:delete', { channelId: ch.id }).then((r) => { if (!r.ok) toast(r.error, 'error'); });
    }
  });
  return b;
}

function voiceMemberEl(m) {
  const row = document.createElement('div');
  row.className = 'vc-member';
  row.dataset.peer = m.id;
  const badges = [];
  if (m.sharing) badges.push(`<span class="live">${ICONS.screen}</span>`);
  row.innerHTML = `
    <span class="avatar${m.avatar ? ' has-photo' : ''}" style="${avatarStyle(m)}">${m.avatar ? '' : escapeHtml(initials(m.nick))}</span>
    <span class="nm">${escapeHtml(m.nick)}</span>
    <span class="badges">${badges.join('')}</span>`;
  return row;
}

function renderMembers() {
  const root = $('#member-list');
  root.innerHTML = '';
  if (!state.room) return;
  const cat = document.createElement('div');
  cat.className = 'member-cat';
  cat.textContent = `Online — ${state.room.members.length}`;
  root.appendChild(cat);

  for (const m of state.room.members) {
    const row = document.createElement('div');
    row.className = 'member-row' + (m.id === state.me.id ? ' is-me' : '');
    row.dataset.peer = m.id;
    const badges = [];
    if (m.sharing) badges.push(`<span class="live">${ICONS.screen}</span>`);
    row.innerHTML = `
      <span class="avatar-wrap">
        <span class="avatar${m.avatar ? ' has-photo' : ''}" style="${avatarStyle(m)}">${m.avatar ? '' : escapeHtml(initials(m.nick))}</span>
        <span class="presence"></span>
      </span>
      <span class="nm">${escapeHtml(m.nick)}</span>
      ${m.uid === state.room.ownerUid ? '<span class="tag owner">DONO</span>' : ''}
      <span class="badges">${badges.join('')}</span>`;
    root.appendChild(row);
  }
}

/* ============================ canais ============================ */

async function openChannel(ch) {
  if (ch.type === 'voice') {
    state.activeChannel = ch;
    showCall(ch);          // define state.view antes de renderizar a barra lateral
    renderRoom();
    await joinVoice(ch.id);
    renderStage();
    return;
  }

  state.activeChannel = ch;
  state.typingUsers.clear();
  renderTyping();
  showChat(ch);
  renderRoom();

  const resp = await emit('chat:history', { channelId: ch.id });
  const box = $('#messages');
  box.innerHTML = '';
  box.appendChild(chatIntro(ch));
  if (resp.ok) for (const m of resp.messages) appendMessage(m, true);
  box.scrollTop = box.scrollHeight;
  closeNav();
}

function chatIntro(ch) {
  const el = document.createElement('div');
  el.className = 'chat-intro';
  el.innerHTML = `
    <div class="big">${ICONS.hash}</div>
    <h3>Bem-vindo a #${escapeHtml(ch.name)}</h3>
    <p>Este é o começo do canal <b>#${escapeHtml(ch.name)}</b>.</p>`;
  return el;
}

function showChat(ch) {
  state.view = 'chat';
  $('#view-home').classList.add('hidden');
  $('#view-call').classList.add('hidden');
  $('#view-chat').classList.remove('hidden');
  $('#topbar-icon').textContent = '#';
  $('#topbar-title').textContent = ch.name;
  const n = state.room ? state.room.members.length : 0;
  $('#topbar-sub').textContent = n ? `${n} ${n === 1 ? 'membro' : 'membros'}` : '';
  $('#composer-input').placeholder = `Conversar em #${ch.name}`;
  $('#composer-input').focus();
}

function showCall(ch) {
  state.view = 'call';
  $('#view-home').classList.add('hidden');
  $('#view-chat').classList.add('hidden');
  $('#view-call').classList.remove('hidden');
  $('#topbar-icon').textContent = '📺';
  $('#topbar-title').textContent = ch.name;
  $('#topbar-sub').textContent = 'Canal de live';
  renderStage();
  closeNav();
}

/* ============================ chat ============================ */

let lastMsgMeta = { authorId: null, ts: 0 };

function appendMessage(msg, bulk = false) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  if (msg.system) {
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.textContent = msg.text;
    box.appendChild(el);
    lastMsgMeta = { authorId: null, ts: 0 };
  } else {
    const grouped = lastMsgMeta.authorId === msg.authorId && msg.ts - lastMsgMeta.ts < 5 * 60 * 1000;
    const el = document.createElement('div');
    el.className = 'msg' + (grouped ? ' grouped' : '');
    if (grouped) {
      el.innerHTML = `
        <div class="msg-gap">${new Date(msg.ts).toTimeString().slice(0, 5)}</div>
        <div class="msg-body"><div class="msg-text">${linkify(msg.text)}</div></div>`;
    } else {
      el.innerHTML = `
        <span class="avatar${msg.avatar ? ' has-photo' : ''}" style="${avatarStyle(msg)}">${msg.avatar ? '' : escapeHtml(initials(msg.nick))}</span>
        <div class="msg-body">
          <div class="msg-head"><b style="color:${msg.color || '#fff'}">${escapeHtml(msg.nick)}</b><time>${timeLabel(msg.ts)}</time></div>
          <div class="msg-text">${linkify(msg.text)}</div>
        </div>`;
    }
    box.appendChild(el);
    lastMsgMeta = { authorId: msg.authorId, ts: msg.ts };
    state.typingUsers.delete(msg.authorId);
    renderTyping();
  }

  if (!bulk && nearBottom) box.scrollTop = box.scrollHeight;
}

function renderTyping() {
  const now = Date.now();
  for (const [id, t] of state.typingUsers) if (now - t.at > 4000) state.typingUsers.delete(id);
  const names = [...state.typingUsers.values()].map((t) => t.nick);
  const el = $('#typing');
  if (!names.length) { el.textContent = ''; return; }
  el.textContent = names.length === 1
    ? `${names[0]} está digitando…`
    : `${names.slice(0, 3).join(', ')} estão digitando…`;
}
setInterval(renderTyping, 2000);

/* ============================ voz ============================ */

async function joinVoice(channelId) {
  if (state.voiceChannelId === channelId) return;
  if (state.voiceChannelId) {
    state.engine.closeAll();
    await emit('voice:leave', {});
  }

  const resp = await emit('voice:join', { channelId });
  if (!resp.ok) { toast(resp.error, 'error'); return; }

  state.voiceChannelId = channelId;
  for (const p of resp.peers || []) state.engine.addPeer(p.peerId, p.polite);

  state.engine.startStats(2000);
  state.socket.emit('me:state', { muted: true, deafened: false, sharing: false });
  renderVoicePanel();
  renderStage();
}

async function leaveVoice() {
  if (!state.voiceChannelId) return;
  if (state.engine.isSharing) state.engine.stopScreen();
  state.engine.closeAll();
  state.engine.stopStats();
  state.voiceChannelId = null;
  state.focused = null;
  await emit('voice:leave', {});
  renderVoicePanel();
  renderStage();
  if (state.view === 'call') {
    const t = state.room?.channels.find((c) => c.type === 'text');
    if (t) openChannel(t); else showHome();
  }
}

function renderVoicePanel() {
  const panel = $('#voice-panel');
  if (!state.voiceChannelId) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const ch = state.room?.channels.find((c) => c.id === state.voiceChannelId);
  $('#voice-where').textContent = `${ch ? ch.name : 'Live'} / ${state.room ? state.room.name : ''}`;
  $('#btn-share').classList.toggle('active', state.engine.isSharing);
  $('#cb-share').classList.toggle('live', state.engine.isSharing);
  $('#quality-label').textContent = QUALITY_PRESETS[state.engine.settings.quality].label;
}

function voiceParticipants() {
  if (!state.room || !state.voiceChannelId) return [];
  return state.room.members.filter((m) => m.voiceChannelId === state.voiceChannelId);
}

/* ============================ stage (tiles) ============================ */

const tiles = new Map();

function renderStage() {
  const stage = $('#stage');
  if (state.view !== 'call') return;

  const participants = voiceParticipants();
  if (!state.voiceChannelId || !participants.length) {
    stage.classList.remove('focus-mode');
    for (const [, t] of tiles) t.root.remove();
    tiles.clear();
    stage.innerHTML = '<div class="call-empty">Ninguém por aqui ainda. Convide a galera!</div>';
    return;
  }
  const emptyMsg = stage.querySelector('.call-empty');
  if (emptyMsg) emptyMsg.remove();

  const seen = new Set();
  for (const p of participants) {
    let tile = tiles.get(p.id);
    if (!tile) {
      tile = createTile(p.id);
      tiles.set(p.id, tile);
      stage.appendChild(tile.root);
    }
    updateTile(tile, p);
    seen.add(p.id);
  }
  for (const [id, tile] of [...tiles]) {
    if (!seen.has(id)) { tile.root.remove(); tiles.delete(id); if (state.focused === id) state.focused = null; }
  }

  // ordem: quem compartilha primeiro
  const order = participants
    .slice()
    .sort((a, b) => (b.sharing ? 1 : 0) - (a.sharing ? 1 : 0) || a.nick.localeCompare(b.nick));
  for (const p of order) {
    const t = tiles.get(p.id);
    if (t) stage.appendChild(t.root);
  }

  stage.classList.toggle('focus-mode', Boolean(state.focused && tiles.has(state.focused)));
  for (const [id, t] of tiles) t.root.classList.toggle('focused', id === state.focused);

}

function createTile(peerId) {
  const root = document.createElement('div');
  root.className = 'tile';
  root.dataset.peer = peerId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.dataset.rcMedia = '1';
  video.classList.add('hidden');

  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';

  const label = document.createElement('div');
  label.className = 'tile-label';

  const badge = document.createElement('div');
  badge.className = 'tile-badge hidden';
  badge.textContent = 'AO VIVO';

  const stats = document.createElement('div');
  stats.className = 'tile-stats hidden';

  const actions = document.createElement('div');
  actions.className = 'tile-actions hidden';
  const btnExpand = document.createElement('button');
  btnExpand.innerHTML = ICONS.expand;
  btnExpand.title = 'Expandir';
  btnExpand.addEventListener('click', (e) => { e.stopPropagation(); toggleFocus(peerId); });
  const btnFs = document.createElement('button');
  btnFs.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  btnFs.title = 'Tela cheia';
  btnFs.addEventListener('click', (e) => { e.stopPropagation(); requestFs(root); });
  actions.append(btnExpand, btnFs);

  root.append(video, avatar, label, badge, stats, actions);
  root.addEventListener('dblclick', () => requestFs(root));
  root.addEventListener('click', () => { if (root.classList.contains('has-video')) toggleFocus(peerId); });

  return { root, video, avatar, label, badge, stats, actions, streamId: null };
}

function toggleFocus(peerId) {
  state.focused = state.focused === peerId ? null : peerId;
  renderStage();
}

function requestFs(el) {
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
}

function updateTile(tile, p) {
  const isMe = p.id === state.me.id;
  const stream = isMe ? state.engine.screenStream : state.engine.mediaOf(p.id).screen;

  const hasVideo = Boolean(stream && stream.getVideoTracks().some((t) => t.readyState === 'live'));
  tile.root.classList.toggle('has-video', hasVideo);

  if (hasVideo) {
    if (tile.streamId !== stream.id) {
      tile.video.srcObject = stream;
      tile.streamId = stream.id;
      tile.video.play().catch(() => {});
    }
    // A propria live fica muda para evitar retorno; espectadores ouvem apenas
    // o audio que veio junto com a transmissao de tela.
    tile.video.muted = isMe;
    tile.video.classList.remove('hidden');
    tile.avatar.classList.add('hidden');
    tile.badge.classList.remove('hidden');
    tile.actions.classList.remove('hidden');
  } else {
    if (tile.streamId) { tile.video.srcObject = null; tile.streamId = null; }
    tile.video.classList.add('hidden');
    tile.avatar.classList.remove('hidden');
    tile.badge.classList.add('hidden');
    tile.actions.classList.add('hidden');
    paintAvatar(tile.avatar, p);
    if (state.focused === p.id) state.focused = null;
  }

  const badges = [];
  tile.label.innerHTML = `<span class="nm">${escapeHtml(p.nick)}${isMe ? ' (você)' : ''}</span>${badges.join('')}`;
}

/* ============================ estatísticas ============================ */

function renderStats(s) {
  const root = $('#conn-stats');
  if (!root) return;
  if (!s) {
    root.innerHTML = '<span class="muted">Entre em um canal de live para ver as estatísticas.</span>';
    return;
  }
  root.innerHTML = `
    <div><i>Peers</i><b>${s.peers}</b></div>
    <div><i>Latência</i><b>${s.rtt != null ? s.rtt + ' ms' : '—'}</b></div>
    <div><i>Envio</i><b>${formatBits(s.up)}</b></div>
    <div><i>Recebimento</i><b>${formatBits(s.down)}</b></div>
    <div><i>Perda</i><b>${s.loss.toFixed(1)}%</b></div>
    <div><i>FPS</i><b>${s.fps || '—'}</b></div>
    <div><i>Resolução</i><b>${s.resolution}</b></div>
    <div><i>Rota</i><b>${s.transport}</b></div>`;

  // qualidade do sinal no painel de voz
  const panel = $('.voice-status');
  panel.classList.remove('weak', 'bad');
  if (s.rtt != null) {
    if (s.rtt > 250 || s.loss > 8) panel.classList.add('bad');
    else if (s.rtt > 120 || s.loss > 3) panel.classList.add('weak');
  }
  $('#voice-state').textContent = panel.classList.contains('bad')
    ? 'Conexão instável' : 'Live conectada';

  // estatística no tile de quem compartilha (resolução real do vídeo daquele tile)
  for (const [, tile] of tiles) {
    if (tile.root.classList.contains('has-video') && tile.video.videoWidth) {
      tile.stats.classList.remove('hidden');
      tile.stats.textContent = `${tile.video.videoWidth}x${tile.video.videoHeight} · ${s.fps || '–'}fps`;
    } else tile.stats.classList.add('hidden');
  }
}

/* ============================ diagnóstico ============================ */

/** Monta o texto de diagnóstico (também usado pelo botão de copiar). */
async function buildDiagnostics() {
  const d = await state.engine.diagnostics();
  const lines = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'ultimoErroDeTela') continue;
    lines.push(`${k.padEnd(20)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  lines.push('');
  if (d.ultimoErroDeTela === 'nenhum') {
    lines.push('ultimo erro de tela   nenhum');
  } else {
    const e = d.ultimoErroDeTela;
    lines.push(`ultimo erro de tela   ${e.name}: ${e.message}`);
    lines.push(`quando                ${e.at}`);
    for (const t of e.attempts || []) lines.push(`  tentativa           ${t}`);
  }
  return lines.join('\n');
}

async function renderDiagnostics() {
  const out = $('#diag-out');
  out.textContent = 'Gerando…';
  try {
    const text = await buildDiagnostics();
    // destaca as linhas problemáticas
    out.innerHTML = escapeHtml(text)
      .replace(/^(contextoSeguro\s+)false$/m, '$1<span class="bad">false</span>')
      .replace(/^(getDisplayMedia\s+)false$/m, '$1<span class="bad">false</span>')
      .replace(/^(ultimo erro de tela\s+)(?!nenhum)(.+)$/m, '$1<span class="bad">$2</span>');
  } catch (err) {
    out.textContent = `Falha ao gerar diagnóstico: ${err.message}`;
  }
}

/* ============================ controles ============================ */

function setSharing(sharing) {
  $('#btn-share').classList.toggle('active', sharing);
  $('#cb-share').classList.toggle('live', sharing);
  state.socket.emit('me:state', { sharing });
  renderStage();
}

const KNOWN_SCREEN_ERRORS = [
  'RegCallUnsupported', 'NotAllowedError', 'AbortError', 'NotFoundError',
  'NotReadableError', 'OverconstrainedError', 'TypeError', 'InvalidStateError',
];

/** Traduz o erro do getDisplayMedia em algo acionável. */
function screenErrorMessage(err) {
  const name = err?.name || 'Error';
  switch (name) {
    case 'RegCallUnsupported':
      return err.message;
    case 'NotAllowedError':
      return 'A transmissão não foi iniciada. Clique em Tela e escolha uma janela ou monitor. Se o seletor não aparecer, libere a captura de tela para o navegador nas configurações do sistema.';
    case 'AbortError':
      return null;
    case 'NotFoundError':
      return 'Nenhuma tela disponível para capturar. No macOS, libere a gravação de tela para o navegador em Ajustes → Privacidade e Segurança → Gravação de Tela, e reinicie o navegador.';
    case 'NotReadableError':
      return 'O sistema não deixou capturar a tela. No macOS/Windows, verifique a permissão de gravação de tela do navegador e feche outros programas que estejam capturando.';
    case 'OverconstrainedError':
      return `A resolução escolhida não coube (${err.constraint || 'restrição desconhecida'}). Tente uma qualidade menor em Configurações.`;
    case 'TypeError':
      return 'O navegador recusou as opções de captura. Se estiver em uma aba incorporada (iframe), abra o RegCall em uma aba própria.';
    case 'InvalidStateError':
      return 'A página precisa estar visível para iniciar a captura. Volte para a aba do RegCall e tente de novo.';
    default:
      return `Não deu pra compartilhar a tela — ${name}: ${err?.message || 'sem detalhes'}`;
  }
}

async function toggleShare() {
  if (state.engine?.isSharing) {
    state.engine.stopScreen();
    setSharing(false);
    return;
  }
  if (!state.voiceChannelId) {
    toast('Entre em um canal de live antes de transmitir a tela.', 'error');
    return;
  }

  const unsupported = RTCEngine.screenSupport();
  if (unsupported) { toast(unsupported.message, 'error'); return; }

  try {
    await state.engine.startScreen();
    setSharing(true);
    toast(`Transmitindo em ${QUALITY_PRESETS[state.engine.settings.quality].label}`, 'success');
  } catch (err) {
    console.error('[RegCall] falha ao compartilhar tela:', err, err?.attempts || '');
    const msg = screenErrorMessage(err);
    if (msg) {
      toast(msg, 'error');
      // erro que não se encaixa em nenhum caso conhecido: manda pro diagnóstico
      if (!KNOWN_SCREEN_ERRORS.includes(err?.name)) {
        setTimeout(() => toast('Abra Configurações → Diagnóstico e copie os detalhes.', 'error'), 3400);
      }
    }
  }
}

/* ============================ modais ============================ */

function openModal(sel) {
  $('#modal-root').classList.remove('hidden');
  $$('#modal-root .modal').forEach((m) => m.classList.add('hidden'));
  $(sel).classList.remove('hidden');
  const input = $('input:not([readonly]), select', $(sel));
  if (input) setTimeout(() => input.focus(), 40);
}

function closeModal() {
  $('#modal-root').classList.add('hidden');
  $$('#modal-root .modal').forEach((m) => m.classList.add('hidden'));
}

/* ============================ settings ============================ */

function buildQualityUI() {
  const sel = $('#sel-quality');
  sel.innerHTML = '';
  const grid = $('#quality-grid');
  grid.innerHTML = '';
  for (const [key, q] of Object.entries(QUALITY_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = q.label;
    sel.appendChild(opt);

    const b = document.createElement('button');
    b.className = 'q-opt';
    b.dataset.q = key;
    b.innerHTML = `<b>${q.label}</b><small>${q.note}</small>`;
    b.addEventListener('click', () => { applyQuality(key); closeModal(); });
    grid.appendChild(b);
  }
}

function markQuality() {
  const q = state.engine ? state.engine.settings.quality : store.get('quality', '1080p60');
  $$('#quality-grid .q-opt').forEach((b) => b.classList.toggle('sel', b.dataset.q === q));
  $('#sel-quality').value = q;
  $('#quality-label').textContent = QUALITY_PRESETS[q].label;
}

async function applyQuality(key) {
  if (!QUALITY_PRESETS[key]) return;
  state.engine.settings.quality = key;
  store.set('quality', key);
  markQuality();
  if (state.engine.isSharing) {
    await state.engine.applyQualityLive();
    toast(`Qualidade ajustada para ${QUALITY_PRESETS[key].label}`, 'success');
  }
}

function loadSettings() {
  const s = {
    quality: store.get('quality', '1080p60'),
    contentHint: store.get('hint', 'detail'),
    codec: store.get('codec', 'auto'),
    systemAudio: store.get('sysaudio', true),
  };
  $('#sel-quality').value = s.quality;
  $('#sel-hint').value = s.contentHint;
  $('#sel-codec').value = s.codec;
  $('#opt-sysaudio').checked = s.systemAudio;
  $('#quality-label').textContent = QUALITY_PRESETS[s.quality].label;
  state._settings = s;
}

function applySettingsToEngine() {
  Object.assign(state.engine.settings, state._settings || {});
  markQuality();
}

/* ============================ nav mobile ============================ */

function toggleNav() { $('#app').classList.toggle('nav-open'); }
function closeNav() { $('#app').classList.remove('nav-open'); }

/* ============================ wiring ============================ */

function wireUI() {
  $('#login-btn').addEventListener('click', startGoogleLogin);
  $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  $('#btn-home').addEventListener('click', showHome);
  $('#btn-create-room').addEventListener('click', () => openModal('#modal-create'));
  $('#btn-explore').addEventListener('click', () => { showHome(); });
  $('#home-create').addEventListener('click', () => openModal('#modal-create'));
  $('#home-join').addEventListener('click', () => openModal('#modal-join'));

  // criar sala
  $('#create-confirm').addEventListener('click', async () => {
    const name = $('#create-name').value.trim();
    if (!name) return toast('Dá um nome pra sala.', 'error');
    const resp = await emit('room:create', { name });
    if (!resp.ok) return toast(resp.error, 'error');
    closeModal();
    $('#create-name').value = '';
    enterRoom(resp.room);
    toast(`Sala criada! Código: ${resp.room.code}`, 'success');
  });
  $('#create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#create-confirm').click(); });

  // entrar por código
  $('#join-confirm').addEventListener('click', async () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (!code) return toast('Cola o código aí.', 'error');
    const resp = await emit('room:join', { code });
    if (!resp.ok) return toast(resp.error, 'error');
    closeModal();
    $('#join-code').value = '';
    enterRoom(resp.room);
  });
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-confirm').click(); });

  // criar canal
  $('#channel-confirm').addEventListener('click', async () => {
    const name = $('#channel-name').value.trim();
    const type = $('input[name="chtype"]:checked').value;
    if (!name) return toast('Nome do canal?', 'error');
    const resp = await emit('channel:create', { name, type });
    if (!resp.ok) return toast(resp.error, 'error');
    closeModal();
    $('#channel-name').value = '';
  });
  $('#channel-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#channel-confirm').click(); });

  // convite
  $('#btn-invite').addEventListener('click', showInvite);
  $('#copy-link').addEventListener('click', async () => {
    const link = $('#invite-link').value;
    try { await navigator.clipboard.writeText(link); toast('Link copiado!', 'success'); }
    catch (e) { $('#invite-link').select(); document.execCommand?.('copy'); toast('Link copiado!', 'success'); }
  });

  // perfil / nick
  $('#btn-profile').addEventListener('click', () => {
    if (!state.me) return;
    paintAvatar($('#profile-avatar'), state.me);
    $('#profile-name').textContent = state.me.nick;
    openModal('#modal-profile');
  });
  $('#profile-logout').addEventListener('click', async () => {
    const session = authSession();
    if (session?.accessToken && state.config?.supabasePublishableKey) {
      fetch(`${state.config.supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: state.config.supabasePublishableKey, Authorization: `Bearer ${session.accessToken}` },
      }).catch(() => {});
    }
    saveAuthSession(null);
    state.socket?.close();
    location.reload();
  });

  // configurações
  $('#btn-settings').addEventListener('click', async () => {
    openModal('#modal-settings');
    markQuality();
    renderDiagnostics();
  });
  $('#diag-refresh').addEventListener('click', renderDiagnostics);
  $('#diag-copy').addEventListener('click', async () => {
    try {
      const text = await buildDiagnostics();
      await navigator.clipboard.writeText(text);
      toast('Diagnóstico copiado. Pode colar onde precisar.', 'success');
    } catch (err) {
      const out = $('#diag-out');
      const range = document.createRange();
      range.selectNodeContents(out);
      const sel = getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      toast('Selecionei o texto — use Ctrl+C para copiar.', '');
    }
  });

  const bindOpt = (sel, key, storeKey, after) => {
    $(sel).addEventListener('change', async () => {
      const el = $(sel);
      const value = el.type === 'checkbox' ? el.checked : el.value;
      state.engine.settings[key] = value;
      state._settings[key] = value;
      store.set(storeKey, value);
      if (after) await after(value);
    });
  };
  bindOpt('#sel-hint', 'contentHint', 'hint', () => state.engine.applyQualityLive());
  bindOpt('#sel-codec', 'codec', 'codec', () => {
    if (state.engine.isSharing) toast('O codec vale na próxima transmissão.', '');
  });
  bindOpt('#opt-sysaudio', 'systemAudio', 'sysaudio');
  $('#sel-quality').addEventListener('change', () => applyQuality($('#sel-quality').value));

  // qualidade rápida
  $('#btn-quality').addEventListener('click', () => { markQuality(); openModal('#modal-quality'); });
  $('#cb-quality').addEventListener('click', () => { markQuality(); openModal('#modal-quality'); });

  // controles da live
  $('#btn-share').addEventListener('click', toggleShare);
  $('#cb-share').addEventListener('click', toggleShare);
  $('#btn-hangup').addEventListener('click', leaveVoice);
  $('#cb-hangup').addEventListener('click', leaveVoice);
  $('#cb-fullscreen').addEventListener('click', () => {
    const target = state.focused ? tiles.get(state.focused)?.root : $('#stage');
    if (target) requestFs(target);
  });

  // chat
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#composer-input');
    const text = input.value.trim();
    if (!text || !state.activeChannel) return;
    input.value = '';
    const resp = await emit('chat:send', { channelId: state.activeChannel.id, text });
    if (!resp.ok) { toast(resp.error, 'error'); input.value = text; }
  });
  let typingThrottle = 0;
  $('#composer-input').addEventListener('input', () => {
    const now = Date.now();
    if (now - typingThrottle < 1800) return;
    typingThrottle = now;
    if (state.activeChannel) state.socket.emit('chat:typing', { channelId: state.activeChannel.id });
  });
  $('#btn-emoji').addEventListener('click', () => {
    const input = $('#composer-input');
    input.value += '😄';
    input.focus();
  });

  // membros / menu
  $('#btn-members').addEventListener('click', () => $('#members').classList.toggle('collapsed'));
  $('#btn-menu').addEventListener('click', toggleNav);

  // menu da sala
  $('#sidebar-head').addEventListener('click', (e) => {
    if (!state.room) return;
    const ctx = $('#ctx-room');
    const rect = $('#sidebar-head').getBoundingClientRect();
    ctx.style.left = `${rect.left + 8}px`;
    ctx.style.top = `${rect.bottom + 4}px`;
    ctx.classList.remove('hidden');
    e.stopPropagation();
  });
  $$('#ctx-room button').forEach((b) => {
    b.addEventListener('click', async () => {
      $('#ctx-room').classList.add('hidden');
      const act = b.dataset.act;
      if (act === 'invite') showInvite();
      if (act === 'channel') openModal('#modal-channel');
      if (act === 'rename') {
        const name = prompt('Novo nome da sala:', state.room.name);
        if (name) {
          const r = await emit('room:rename', { name });
          if (!r.ok) toast(r.error, 'error');
        }
      }
      if (act === 'leave') {
        await leaveVoice();
        await emit('room:leave', {});
        state.room = null;
        showHome();
        renderMe();
      }
    });
  });

  // fechar overlays
  document.addEventListener('click', (e) => {
    if (!$('#ctx-room').contains(e.target)) $('#ctx-room').classList.add('hidden');
    if (e.target.matches('[data-close], .modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-root').classList.contains('hidden')) closeModal();
      else if (state.focused) { state.focused = null; renderStage(); }
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.socket) state.socket.close();
  });
}

function showInvite() {
  if (!state.room) return toast('Entre em uma sala primeiro.', 'error');
  $('#invite-code').textContent = state.room.code;
  $('#invite-link').value = `${location.origin}/?join=${state.room.code}`;
  openModal('#modal-invite');
}

/* ============================ debug / testes ============================ */

window.__rc = {
  state,
  get engine() { return state.engine; },
  setSharing, toggleShare, screenErrorMessage,
  buildDiagnostics, renderDiagnostics,
  joinVoice, leaveVoice, renderStage,
};

/* ============================ go ============================ */

boot();
