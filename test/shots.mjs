/** Gera capturas de tela do RegCall para conferencia visual. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';

const PORT = 4113;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('../shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
process.on('exit', () => { try { server.kill('SIGKILL'); } catch (e) {} });
await sleep(1200);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});

async function mk(nick) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector('#login-btn');
  return { ctx, page, nick };
}

const a = await mk('Ana');
await a.page.screenshot({ path: `${OUT}01-login.png` });

await a.page.fill('#login-nick', 'Ana');
await a.page.click('#login-btn');
await a.page.waitForSelector('#app:not(.hidden)');
await sleep(500);
await a.page.screenshot({ path: `${OUT}02-home.png` });

await a.page.click('#home-create');
await a.page.fill('#create-name', 'Squad da Madrugada');
await a.page.click('#create-confirm');
await a.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Squad da Madrugada');
await a.page.click('#btn-invite');
await a.page.waitForSelector('#modal-invite:not(.hidden)');
const code = (await a.page.textContent('#invite-code')).trim();
await a.page.screenshot({ path: `${OUT}03-convite.png` });
await a.page.click('#modal-invite [data-close]');

const b = await mk('Beto');
await b.page.fill('#login-nick', 'Beto');
await b.page.click('#login-btn');
await b.page.waitForSelector('#app:not(.hidden)');
await b.page.click('#home-join');
await b.page.fill('#join-code', code);
await b.page.click('#join-confirm');
await b.page.waitForFunction(() => document.querySelector('#room-name')?.textContent === 'Squad da Madrugada');

for (const [u, txt] of [[b, 'e aí, tudo certo pro rush de hoje?'], [a, 'bora! já tô com a tela pronta pra mostrar'], [b, 'manda ver https://regcall.app']]) {
  await u.page.fill('#composer-input', txt);
  await u.page.press('#composer-input', 'Enter');
  await sleep(250);
}
await sleep(600);
await a.page.screenshot({ path: `${OUT}04-chat.png` });

const joinVoice = (u) => u.page.evaluate(() => {
  [...document.querySelectorAll('#channel-list .chan')].find((x) => x.textContent.includes('Sala de Voz')).click();
});
await joinVoice(a);
await sleep(700);
await joinVoice(b);
await sleep(2500);

await a.page.evaluate(async () => {
  const eng = window.__rc.engine;
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 900;
  const x = c.getContext('2d');
  const draw = () => {
    const g = x.createLinearGradient(0, 0, 1600, 900);
    g.addColorStop(0, '#12141a'); g.addColorStop(1, '#243056');
    x.fillStyle = g; x.fillRect(0, 0, 1600, 900);
    x.fillStyle = '#f0c22b'; x.font = 'bold 78px Inter, sans-serif';
    x.fillText('tela compartilhada', 90, 420);
    x.fillStyle = '#dbdee1'; x.font = '38px Inter, sans-serif';
    x.fillText('1080p · 60fps · VP9', 90, 490);
  };
  draw(); setInterval(draw, 100);
  const stream = c.captureStream(30);
  eng.screenStream = stream;
  for (const peer of eng.peers.values()) {
    for (const t of stream.getTracks()) peer.pc.addTrack(t, stream);
    await eng._tuneVideoSenders(peer);
  }
  eng._publishTrackMap();
  window.__rc.setSharing(true);
});
await sleep(4000);
await b.page.screenshot({ path: `${OUT}05-call.png` });

await b.page.click('#btn-settings');
await sleep(900);
await b.page.screenshot({ path: `${OUT}06-config.png` });
await b.page.click('#modal-settings [data-close]');

await b.page.click('#btn-quality');
await sleep(400);
await b.page.screenshot({ path: `${OUT}07-qualidade.png` });

// mobile
const m = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
const mp = await m.newPage();
await mp.goto(BASE);
await mp.waitForSelector('#login-btn');
await mp.fill('#login-nick', 'Cris');
await mp.click('#login-btn');
await mp.waitForSelector('#app:not(.hidden)');
await mp.click('#home-join');
await mp.fill('#join-code', code);
await mp.click('#join-confirm');
await sleep(1200);
await mp.screenshot({ path: `${OUT}08-mobile.png` });

await browser.close();
server.kill('SIGKILL');
console.log('capturas em', OUT);
