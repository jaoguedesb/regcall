/**
 * Testes focados no compartilhamento de tela.
 * Inclui o caminho REAL do getDisplayMedia (com o Chromium auto-selecionando a tela)
 * e os fluxos que mais quebram: compartilhar sozinho, alguem entrar depois,
 * trocar a qualidade ao vivo e parar/recomecar.
 *
 * Uso: node test/share.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4114;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 30000, interval = 300, label = 'condicao' } = {}) {
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
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[srv:err] ${d}`));
process.on('exit', () => { try { server.kill('SIGKILL'); } catch (e) {} });

await waitFor(async () => {
  const r = await fetch(`${BASE}/api/health`).then((x) => x.json()).catch(() => null);
  return r && r.ok;
}, { label: 'servidor subir' });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // faz o Chromium escolher a tela sozinho, sem o seletor
    '--auto-select-desktop-capture-source=Entire screen',
    '--auto-accept-this-tab-capture',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

const users = [];
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
  await page.waitForSelector('#app:not(.hidden)');
  const u = { ctx, page, errors, nick };
  users.push(u);
  return u;
}

const joinVoice = (u) => u.page.evaluate(() => {
  [...document.querySelectorAll('#channel-list .chan')]
    .find((x) => x.textContent.includes('Sala de Voz')).click();
});

try {
  const a = await newUser('Ana');

  /* ---------- contexto seguro ---------- */
  const support = await a.page.evaluate(() => ({
    secure: window.isSecureContext,
    hasApi: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
  }));
  check('localhost e contexto seguro e expoe getDisplayMedia', support.secure && support.hasApi, JSON.stringify(support));

  /* ---------- erro claro fora de canal de voz ---------- */
  await a.page.click('#home-create');
  await a.page.fill('#create-name', 'Sala Tela');
  await a.page.click('#create-confirm');
  await a.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Sala Tela');
  await a.page.click('#btn-invite');
  await a.page.waitForSelector('#modal-invite:not(.hidden)');
  const code = (await a.page.textContent('#invite-code')).trim();
  await a.page.click('#modal-invite [data-close]');

  await a.page.evaluate(() => window.__rc.toggleShare());
  await sleep(400);
  const warnText = await a.page.textContent('#toasts');
  check('Avisa pra entrar na voz antes de compartilhar', /canal de voz/i.test(warnText), warnText.trim());
  await sleep(3400);

  /* ---------- compartilhar SOZINHO, via getDisplayMedia de verdade ---------- */
  await joinVoice(a);
  await a.page.waitForSelector('#voice-panel:not(.hidden)');

  const shareResult = await a.page.evaluate(async () => {
    try {
      await window.__rc.engine.startScreen();
      const t = window.__rc.engine.screenStream.getVideoTracks()[0];
      const s = t.getSettings();
      window.__rc.setSharing(true);
      return { ok: true, w: s.width, h: s.height, fps: Math.round(s.frameRate || 0) };
    } catch (e) {
      return { ok: false, name: e.name, message: e.message, attempts: e.attempts || null };
    }
  });
  check('getDisplayMedia real funciona (sozinho no canal)', shareResult.ok === true, JSON.stringify(shareResult));

  const localTile = await waitFor(async () => a.page.evaluate(() => {
    const t = document.querySelector('#stage .tile.has-video video');
    return t && t.videoWidth ? { w: t.videoWidth, h: t.videoHeight } : null;
  }), { label: 'preview local aparecer' });
  check('Preview local da tela aparece', true, `${localTile.w}x${localTile.h}`);

  /* ---------- alguem entra DEPOIS que a tela ja esta no ar ---------- */
  const b = await newUser('Beto');
  await b.page.click('#home-join');
  await b.page.fill('#join-code', code);
  await b.page.click('#join-confirm');
  await b.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Sala Tela');
  await joinVoice(b);

  const lateOk = await waitFor(async () => {
    const r = await b.page.evaluate(async () => {
      const eng = window.__rc.engine;
      const id = [...eng.peers.keys()][0];
      if (!id) return null;
      const stats = await eng.peers.get(id).pc.getStats();
      let bytes = 0, w = 0;
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') { bytes = s.bytesReceived || 0; w = s.frameWidth || w; } });
      return { screen: Boolean(eng.mediaOf(id).screen), bytes, w };
    });
    return r && r.screen && r.bytes > 5000 ? r : null;
  }, { timeout: 45000, label: 'quem entrou depois receber a tela' });
  check('Quem entra depois recebe a tela que ja estava no ar', true, `${lateOk.bytes} bytes, ${lateOk.w}px`);

  /* ---------- trocar qualidade ao vivo ---------- */
  const qualityOk = await a.page.evaluate(async () => {
    try {
      const eng = window.__rc.engine;
      eng.settings.quality = '720p30';
      await eng.applyQualityLive();
      const peer = [...eng.peers.values()][0];
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      const p = sender.getParameters();
      return { ok: true, maxBitrate: p.encodings?.[0]?.maxBitrate, fps: p.encodings?.[0]?.maxFramerate, deg: p.degradationPreference };
    } catch (e) { return { ok: false, name: e.name, message: e.message }; }
  });
  check('Trocar a qualidade ao vivo aplica bitrate/fps no sender',
    qualityOk.ok && qualityOk.maxBitrate === 2_500_000 && qualityOk.fps === 30, JSON.stringify(qualityOk));

  /* ---------- parar e recomecar ---------- */
  await a.page.evaluate(() => { window.__rc.engine.stopScreen(); window.__rc.setSharing(false); });
  await waitFor(async () => b.page.evaluate(() => {
    const eng = window.__rc.engine;
    return !eng.mediaOf([...eng.peers.keys()][0]).screen;
  }), { label: 'tela sumir' });

  const restart = await a.page.evaluate(async () => {
    try { await window.__rc.engine.startScreen(); window.__rc.setSharing(true); return { ok: true }; }
    catch (e) { return { ok: false, name: e.name, message: e.message, attempts: e.attempts || null }; }
  });
  check('Recomecar a transmissao funciona', restart.ok === true, JSON.stringify(restart));

  const backOk = await waitFor(async () => {
    const r = await b.page.evaluate(async () => {
      const eng = window.__rc.engine;
      const id = [...eng.peers.keys()][0];
      const stats = await eng.peers.get(id).pc.getStats();
      let bytes = 0;
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') bytes = s.bytesReceived || 0; });
      return { screen: Boolean(eng.mediaOf(id).screen), bytes };
    });
    return r.screen && r.bytes > 3000 ? r : null;
  }, { timeout: 45000, label: 'tela voltar apos recomecar' });
  check('A tela reaparece no outro lado apos recomecar', true, `${backOk.bytes} bytes`);

  /* ---------- mensagens de erro traduzidas ---------- */
  const errMsgs = await a.page.evaluate(() => {
    const cases = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'TypeError', 'WeirdError'];
    return cases.map((name) => {
      const e = new Error('teste'); e.name = name;
      return { name, msg: window.__rc.screenErrorMessage(e) };
    });
  });
  const permissionActionable = /escolha uma janela|libere a captura/i.test(
    errMsgs.find((x) => x.name === 'NotAllowedError').msg || '',
  );
  const unknownVerbose = /WeirdError/.test(errMsgs.find((x) => x.name === 'WeirdError').msg || '');
  const allMapped = errMsgs.filter((x) => x.name !== 'NotAllowedError').every((x) => typeof x.msg === 'string' && x.msg.length > 20);
  check('Bloqueio ou cancelamento mostra uma instrucao util', permissionActionable);
  check('Cada erro do navegador vira uma instrucao util', allMapped && unknownVerbose,
    errMsgs.map((x) => x.name).join(', '));

  /* ---------- falha simulada: o erro real nao pode ser mascarado ---------- */
  await a.page.evaluate(() => { window.__rc.engine.stopScreen(); window.__rc.setSharing(false); });
  await sleep(300);

  const masked = await a.page.evaluate(async () => {
    const md = navigator.mediaDevices;
    const original = md.getDisplayMedia.bind(md);
    let call = 0;
    md.getDisplayMedia = async () => {
      call++;
      // 1a tentativa: erro REAL do sistema. Se houvesse retry, a 2a viraria
      // NotAllowedError (ativacao do clique ja consumida) e esconderia a causa.
      const e = new Error(call === 1 ? 'Could not start video source' : 'Must be handling a user gesture');
      e.name = call === 1 ? 'NotReadableError' : 'NotAllowedError';
      throw e;
    };
    let captured = null;
    try { await window.__rc.engine.startScreen(); }
    catch (err) { captured = { name: err.name, message: err.message, attempts: err.attempts, calls: call }; }
    md.getDisplayMedia = original;
    return captured;
  });
  check('Erro real do sistema nao e mascarado por retry',
    masked?.name === 'NotReadableError' && masked.calls === 1, JSON.stringify(masked));

  const friendly = await a.page.evaluate(() => {
    const e = new Error('x'); e.name = 'NotReadableError';
    return window.__rc.screenErrorMessage(e);
  });
  check('NotReadableError vira instrucao sobre permissao do sistema',
    /gravação de tela/i.test(friendly), friendly);

  /* ---------- diagnostico registra o erro ---------- */
  const diag = await a.page.evaluate(() => window.__rc.buildDiagnostics());
  check('Diagnostico registra o ultimo erro de tela',
    /NotReadableError/.test(diag) && /Could not start video source/.test(diag));
  check('Diagnostico traz contexto seguro, API e navegador',
    /contextoSeguro\s+true/.test(diag) && /getDisplayMedia\s+true/.test(diag) && /navegador/.test(diag));

  await a.page.click('#btn-settings');
  await a.page.waitForSelector('#modal-settings:not(.hidden)');
  await waitFor(async () => (await a.page.textContent('#diag-out')).includes('NotReadableError'),
    { label: 'diagnostico aparecer na tela' });
  check('Painel de diagnostico renderiza nas Configuracoes', true);
  await a.page.click('#modal-settings [data-close]');

  const errs = users.flatMap((u) => u.errors)
    .filter((e) => !/favicon|logo\.png|404|Failed to load resource|falha ao compartilhar/i.test(e));
  check('Sem erros de JavaScript inesperados', errs.length === 0, errs.slice(0, 4).join(' | '));
} catch (err) {
  console.error('\nERRO NO TESTE:', err);
  failures++;
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} verificacoes passaram.`);
process.exit(failures ? 1 : 0);
