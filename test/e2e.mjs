/**
 * Teste end-to-end do RegCall com dois navegadores reais (Chromium).
 * Verifica: login, criar sala, entrar por codigo, chat, canal de voz,
 * conexao WebRTC estabelecida e audio remoto realmente chegando.
 *
 * Uso: node test/e2e.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4111;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 15000, interval = 250, label = 'condicao' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timeout esperando ${label} (ultimo: ${JSON.stringify(last)})`);
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[srv:err] ${d}`));

const cleanup = () => { try { server.kill('SIGKILL'); } catch (e) {} };
process.on('exit', cleanup);

await waitFor(async () => {
  const r = await fetch(`${BASE}/api/health`).then((x) => x.json()).catch(() => null);
  return r && r.ok;
}, { label: 'servidor subir' });
check('Servidor responde /api/health', true);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

async function newUser(nick) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('#login-btn');
  await page.fill('#login-nick', nick);
  await page.click('#login-btn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
  return { ctx, page, errors, nick };
}

try {
  /* ---------- login ---------- */
  const a = await newUser('Alice');
  const b = await newUser('Bruno');
  check('Dois usuarios logam e veem o app', true);

  const nickA = await a.page.textContent('#me-nick');
  check('Nick aparece no painel', nickA === 'Alice', `got "${nickA}"`);

  /* ---------- criar sala ---------- */
  await a.page.click('#home-create');
  await a.page.fill('#create-name', 'Sala de Teste');
  await a.page.click('#create-confirm');
  await a.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Sala de Teste');
  check('Alice cria a sala', true);

  await a.page.click('#btn-invite');
  await a.page.waitForSelector('#modal-invite:not(.hidden)');
  const code = (await a.page.textContent('#invite-code')).trim();
  check('Codigo de convite gerado', /^[A-Z0-9]{6}$/.test(code), code);
  await a.page.click('#modal-invite [data-close]');

  /* ---------- entrar por codigo ---------- */
  await b.page.click('#home-join');
  await b.page.fill('#join-code', code);
  await b.page.click('#join-confirm');
  await b.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Sala de Teste');
  check('Bruno entra pelo codigo', true);

  await waitFor(async () => (await a.page.$$('#member-list .member-row')).length === 2, { label: '2 membros' });
  check('Lista de membros mostra os dois', true);

  /* ---------- chat ---------- */
  await b.page.fill('#composer-input', 'oi galera, teste 123');
  await b.page.press('#composer-input', 'Enter');
  await waitFor(async () => (await a.page.textContent('#messages')).includes('oi galera, teste 123'), { label: 'mensagem chegar' });
  check('Chat entrega a mensagem em tempo real', true);

  /* ---------- trocar nick ---------- */
  await b.page.click('#btn-profile');
  await b.page.waitForSelector('#modal-profile:not(.hidden)');
  await b.page.fill('#profile-nick', 'BrunoPRO');
  await b.page.click('#profile-save');
  await waitFor(async () => (await a.page.textContent('#member-list')).includes('BrunoPRO'), { label: 'nick novo propagar' });
  check('Troca de nick propaga pra todo mundo', true);

  /* ---------- criar canal ---------- */
  await a.page.click('#sidebar-head');
  await a.page.click('#ctx-room button[data-act="channel"]');
  await a.page.waitForSelector('#modal-channel:not(.hidden)');
  await a.page.click('#modal-channel .type-opt:has(input[value="voice"]) .type-box');
  const voiceChecked = await a.page.isChecked('input[name="chtype"][value="voice"]');
  check('Selecionar tipo "voz" no modal de canal', voiceChecked);
  await a.page.fill('#channel-name', 'Sala Secreta');
  await a.page.click('#channel-confirm');
  await waitFor(async () => (await b.page.textContent('#channel-list')).includes('Sala Secreta'), { label: 'canal novo' });
  check('Criar canal de voz propaga', true);

  /* ---------- entrar na voz ---------- */
  const joinVoice = async (u) => {
    await u.page.evaluate(() => {
      const btns = [...document.querySelectorAll('#channel-list .chan')];
      const target = btns.find((x) => x.textContent.includes('Sala de Voz'));
      target.click();
    });
  };
  await joinVoice(a);
  await a.page.waitForSelector('#voice-panel:not(.hidden)', { timeout: 15000 });
  check('Alice entra no canal de voz', true);

  await joinVoice(b);
  await b.page.waitForSelector('#voice-panel:not(.hidden)', { timeout: 15000 });
  check('Bruno entra no canal de voz', true);

  /* ---------- conexao WebRTC ---------- */
  const pcState = (page) => page.evaluate(() => {
    const eng = window.__rc?.engine;
    if (!eng) return { err: 'engine ausente' };
    return [...eng.peers.values()].map((p) => ({
      conn: p.pc.connectionState,
      ice: p.pc.iceConnectionState,
      senders: p.pc.getSenders().filter((s) => s.track).map((s) => s.track.kind),
      receivers: p.pc.getReceivers().filter((r) => r.track).map((r) => r.track.kind),
    }));
  });

  const connected = await waitFor(async () => {
    const sa = await pcState(a.page);
    const sb = await pcState(b.page);
    const okA = Array.isArray(sa) && sa.length === 1 && ['connected', 'completed'].includes(sa[0].conn === 'connected' ? 'connected' : sa[0].ice);
    const okB = Array.isArray(sb) && sb.length === 1 && ['connected', 'completed'].includes(sb[0].conn === 'connected' ? 'connected' : sb[0].ice);
    return okA && okB ? { sa, sb } : null;
  }, { timeout: 30000, label: 'peer connection conectar' });
  check('PeerConnection estabelecida nos dois lados', true,
    `A=${connected.sa[0].conn}/${connected.sa[0].ice} B=${connected.sb[0].conn}/${connected.sb[0].ice}`);

  check('Audio do microfone e enviado', connected.sa[0].senders.includes('audio') && connected.sb[0].senders.includes('audio'));
  check('Audio remoto e recebido', connected.sa[0].receivers.includes('audio') && connected.sb[0].receivers.includes('audio'));

  /* ---------- bytes realmente trafegando ---------- */
  const audioBytes = await waitFor(async () => {
    const v = await a.page.evaluate(async () => {
      const eng = window.__rc.engine;
      const peer = [...eng.peers.values()][0];
      const stats = await peer.pc.getStats();
      let bytes = 0;
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived || 0; });
      return bytes;
    });
    return v > 1000 ? v : null;
  }, { timeout: 25000, label: 'bytes de audio recebidos' });
  check('Audio realmente trafega P2P', true, `${audioBytes} bytes recebidos`);

  /* ---------- mapa de streams (mic vs tela) ---------- */
  const media = await a.page.evaluate(() => {
    const eng = window.__rc.engine;
    const id = [...eng.peers.keys()][0];
    const m = eng.mediaOf(id);
    return { mic: Boolean(m.mic), screen: Boolean(m.screen) };
  });
  check('Stream do microfone classificada corretamente', media.mic === true && media.screen === false, JSON.stringify(media));

  /* ---------- compartilhamento de tela (track de video sintetico) ---------- */
  await a.page.evaluate(async () => {
    const eng = window.__rc.engine;
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    let i = 0;
    setInterval(() => { ctx.fillStyle = `hsl(${(i += 7) % 360},70%,50%)`; ctx.fillRect(0, 0, 1280, 720); }, 40);
    const stream = canvas.captureStream(30);
    // simula exatamente o caminho de startScreen()
    eng.screenStream = stream;
    for (const peer of eng.peers.values()) {
      for (const t of stream.getTracks()) peer.pc.addTrack(t, stream);
      await eng._tuneVideoSenders(peer);
    }
    eng._publishTrackMap();
    window.__rc.setSharing(true);
  });

  const videoOk = await waitFor(async () => {
    const r = await b.page.evaluate(async () => {
      const eng = window.__rc.engine;
      const id = [...eng.peers.keys()][0];
      const m = eng.mediaOf(id);
      const peer = eng.peers.get(id);
      const stats = await peer.pc.getStats();
      let bytes = 0, w = 0, h = 0;
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') { bytes = s.bytesReceived || 0; w = s.frameWidth || w; h = s.frameHeight || h; }
      });
      return { hasScreen: Boolean(m.screen), bytes, w, h };
    });
    return r.hasScreen && r.bytes > 5000 ? r : null;
  }, { timeout: 40000, label: 'video da tela chegar' });
  check('Compartilhamento de tela chega no outro peer', true, `${videoOk.bytes} bytes, ${videoOk.w}x${videoOk.h}`);

  const tileHasVideo = await waitFor(async () => {
    return await b.page.evaluate(() => {
      const tile = [...document.querySelectorAll('#stage .tile')].find((t) => t.classList.contains('has-video'));
      if (!tile) return null;
      const v = tile.querySelector('video');
      return v && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
    });
  }, { timeout: 20000, label: 'tile com video renderizar' });
  check('UI renderiza o tile de tela ao vivo', true, `${tileHasVideo.w}x${tileHasVideo.h}`);

  /* ---------- mutar ---------- */
  await b.page.click('#btn-mic');
  await waitFor(async () => (await a.page.evaluate(() => {
    const me = window.__rc.state.room.members.find((m) => m.nick === 'BrunoPRO');
    return me && me.muted === true;
  })), { label: 'mute propagar' });
  const trackDisabled = await b.page.evaluate(() => window.__rc.engine.micStream.getAudioTracks()[0].enabled === false);
  check('Mutar desativa a track e propaga o estado', trackDisabled);

  await b.page.click('#btn-mic');
  const trackEnabled = await b.page.evaluate(() => window.__rc.engine.micStream.getAudioTracks()[0].enabled === true);
  check('Desmutar reativa a track', trackEnabled);

  /* ---------- ensurdecer ---------- */
  await b.page.click('#btn-deaf');
  const deafOk = await b.page.evaluate(() => {
    const eng = window.__rc.engine;
    const allMuted = [...eng.audioEls.values()].every((el) => el.muted);
    return eng.deafened && allMuted;
  });
  check('Ensurdecer muta todo o audio remoto', deafOk);
  await b.page.click('#btn-deaf');

  /* ---------- parar de compartilhar ---------- */
  await a.page.evaluate(() => { window.__rc.engine.stopScreen(); window.__rc.setSharing(false); });
  const gone = await waitFor(async () => {
    const r = await b.page.evaluate(() => {
      const eng = window.__rc.engine;
      const id = [...eng.peers.keys()][0];
      return !eng.mediaOf(id).screen;
    });
    return r ? true : null;
  }, { timeout: 20000, label: 'tela sumir' });
  check('Parar de compartilhar remove a tela do outro lado', gone === true);

  /* ---------- sair da voz ---------- */
  await b.page.click('#btn-hangup');
  await waitFor(async () => (await a.page.evaluate(() => window.__rc.engine.peers.size === 0)), { label: 'peer sair' });
  check('Sair da chamada fecha a conexao do outro lado', true);

  /* ---------- navegacao: home <-> sala ---------- */
  await a.page.click('#btn-home');
  await sleep(300);
  let sidebar = await a.page.textContent('#channel-list');
  check('Botao Início mostra os atalhos na barra lateral', sidebar.includes('Criar sala'));

  // provoca um broadcast de estado da sala enquanto o usuario esta na home
  await b.page.fill('#composer-input', 'ping');
  await b.page.press('#composer-input', 'Enter');
  await b.page.click('#btn-profile');
  await b.page.fill('#profile-nick', 'BrunoZ');
  await b.page.click('#profile-save');
  await sleep(700);
  sidebar = await a.page.textContent('#channel-list');
  check('Home nao e sobrescrita por atualizacoes da sala', sidebar.includes('Criar sala'), sidebar.slice(0, 60));

  await a.page.click(`#guild-list .guild`);
  await waitFor(async () => (await a.page.textContent('#channel-list')).includes('Sala de Voz'), { label: 'voltar pra sala' });
  check('Voltar pra sala restaura os canais', true);

  /* ---------- sair da sala ---------- */
  await a.page.click('#sidebar-head');
  await a.page.click('#ctx-room button[data-act="leave"]');
  await waitFor(async () => (await a.page.textContent('#channel-list')).includes('Criar sala'), { label: 'voltar pra home' });
  const leftOk = await b.page.evaluate(() => window.__rc.state.room.members.length === 1);
  check('Sair da sala remove o membro pros outros', leftOk);

  /* ---------- erros de console ---------- */
  const realErrors = [...a.errors, ...b.errors].filter((e) => !/favicon|logo\.png|404|Failed to load resource/i.test(e));
  check('Sem erros de JavaScript no console', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

  await a.ctx.close();
  await b.ctx.close();
} catch (err) {
  console.error('\nERRO NO TESTE:', err);
  failures++;
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} verificacoes passaram.`);
process.exit(failures ? 1 : 0);
