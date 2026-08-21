/**
 * Teste de malha com 3 participantes + renegociacao simultanea.
 * Esse e o cenario onde negociacao mal feita quebra (glare / colisao de ofertas).
 *
 * Uso: node test/mesh3.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4112;
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
  stdio: ['ignore', 'pipe', 'pipe'],
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

const startFakeShare = (page) => page.evaluate(async () => {
  const eng = window.__rc.engine;
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const c = canvas.getContext('2d');
  let i = 0;
  setInterval(() => { c.fillStyle = `hsl(${(i += 11) % 360},70%,50%)`; c.fillRect(0, 0, 1280, 720); }, 40);
  const stream = canvas.captureStream(30);
  eng.screenStream = stream;
  for (const peer of eng.peers.values()) {
    for (const t of stream.getTracks()) peer.pc.addTrack(t, stream);
    await eng._tuneVideoSenders(peer);
  }
  eng._publishTrackMap();
  window.__rc.setSharing(true);
});

try {
  const a = await newUser('Ana');
  const b = await newUser('Beto');
  const c = await newUser('Cris');

  await a.page.click('#home-create');
  await a.page.fill('#create-name', 'Mesh 3');
  await a.page.click('#create-confirm');
  await a.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Mesh 3');
  await a.page.click('#btn-invite');
  await a.page.waitForSelector('#modal-invite:not(.hidden)');
  const code = (await a.page.textContent('#invite-code')).trim();
  await a.page.click('#modal-invite [data-close]');

  for (const u of [b, c]) {
    await u.page.click('#home-join');
    await u.page.fill('#join-code', code);
    await u.page.click('#join-confirm');
    await u.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Mesh 3');
  }
  check('3 usuarios na mesma sala', true);

  const joinVoice = (u) => u.page.evaluate(() => {
    [...document.querySelectorAll('#channel-list .chan')]
      .find((x) => x.textContent.includes('Sala de Voz')).click();
  });

  // entram quase ao mesmo tempo — cenario de corrida
  await Promise.all([joinVoice(a), joinVoice(b)]);
  await sleep(400);
  await joinVoice(c);

  const allConnected = await waitFor(async () => {
    const states = await Promise.all(users.map((u) => u.page.evaluate(() => {
      const eng = window.__rc.engine;
      return [...eng.peers.values()].map((p) => p.pc.connectionState);
    })));
    const ok = states.every((s) => s.length === 2 && s.every((x) => x === 'connected'));
    return ok ? states : null;
  }, { timeout: 45000, label: 'malha completa conectar' });
  check('Malha completa: cada um com 2 peers conectados', true, JSON.stringify(allConnected));

  // dois compartilham a tela ao mesmo tempo (renegociacao simultanea)
  await Promise.all([startFakeShare(a.page), startFakeShare(b.page)]);

  const screensOk = await waitFor(async () => {
    const seen = await c.page.evaluate(() => {
      const eng = window.__rc.engine;
      return [...eng.peers.keys()].map((id) => Boolean(eng.mediaOf(id).screen));
    });
    return seen.length === 2 && seen.every(Boolean) ? seen : null;
  }, { timeout: 60000, label: 'Cris receber as duas telas' });
  check('Duas transmissoes simultaneas chegam no terceiro', true, JSON.stringify(screensOk));

  const stillStable = await c.page.evaluate(() => {
    const eng = window.__rc.engine;
    return [...eng.peers.values()].map((p) => `${p.pc.connectionState}/${p.pc.signalingState}`);
  });
  check('Conexoes seguem estaveis apos renegociar', stillStable.every((s) => s === 'connected/stable'), JSON.stringify(stillStable));

  const tiles = await c.page.evaluate(() => document.querySelectorAll('#stage .tile.has-video').length);
  check('UI mostra 2 tiles com video', tiles === 2, `tiles=${tiles}`);

  // um sai da sala inteira
  await b.page.evaluate(async () => {
    await window.__rc.leaveVoice();
  });
  const afterLeave = await waitFor(async () => {
    const r = await Promise.all([a, c].map((u) => u.page.evaluate(() => window.__rc.engine.peers.size)));
    return r.every((n) => n === 1) ? r : null;
  }, { label: 'peers caírem para 1' });
  check('Saida de um participante limpa a malha', true, JSON.stringify(afterLeave));

  const errs = users.flatMap((u) => u.errors).filter((e) => !/favicon|logo\.png|404|Failed to load resource/i.test(e));
  check('Sem erros de JavaScript', errs.length === 0, errs.slice(0, 5).join(' | '));
} catch (err) {
  console.error('\nERRO NO TESTE:', err);
  failures++;
} finally {
  await browser.close();
  server.kill('SIGKILL');
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} verificacoes passaram.`);
process.exit(failures ? 1 : 0);
