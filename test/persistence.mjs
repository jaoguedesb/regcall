import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4120;
const SUPABASE_PORT = 4121;
const cwd = fileURLToPath(new URL('..', import.meta.url));
let savedPayload = null;

const supabase = createServer(async (req, res) => {
  if (!req.url?.startsWith('/rest/v1/regcall_state')) return res.writeHead(404).end();
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(savedPayload ? [{ payload: savedPayload }] : []));
  }
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    savedPayload = JSON.parse(body)[0].payload;
    return res.writeHead(201).end();
  }
  res.writeHead(405).end();
});
await new Promise((resolve) => supabase.listen(SUPABASE_PORT, resolve));

function start() {
  return spawn(process.execPath, ['server.js'], {
    cwd,
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPABASE_URL: `http://localhost:${SUPABASE_PORT}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SUPABASE_STATE_ID: 'persistence-test',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function ready() {
  for (let i = 0; i < 50; i++) {
    const health = await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.json()).catch(() => null);
    if (health?.ok) return health;
    await sleep(100);
  }
  throw new Error('Servidor nao iniciou');
}

async function createRoom() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/socket.io/?EIO=4&transport=websocket`);
    const timer = setTimeout(() => reject(new Error('timeout no Socket.IO')), 5000);
    ws.onmessage = ({ data }) => {
      if (data.startsWith('0')) ws.send('40');
      else if (data.startsWith('40')) ws.send('421["auth",{"uid":"persist-test","nick":"Teste"}]');
      else if (data.startsWith('431')) ws.send('422["room:create",{"name":"Sala Persistida"}]');
      else if (data.startsWith('432')) {
        clearTimeout(timer);
        const payload = JSON.parse(data.slice(3));
        ws.close();
        resolve(payload[0]?.room);
      }
    };
    ws.onerror = () => reject(new Error('falha no WebSocket'));
  });
}

let server = start();
try {
  const initialHealth = await ready();
  if (initialHealth.persistence !== 'supabase') throw new Error('Supabase nao foi ativado');
  const room = await createRoom();
  if (room?.name !== 'Sala Persistida') throw new Error('Sala nao foi criada');
  await sleep(700);
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));

  server = start();
  const health = await ready();
  if (health.rooms !== 1) throw new Error(`Esperava 1 sala apos reinicio; recebeu ${health.rooms}`);
  console.log('PASS  sala e canais sobrevivem ao reinicio no Supabase');
} finally {
  server.kill('SIGTERM');
  supabase.close();
}
