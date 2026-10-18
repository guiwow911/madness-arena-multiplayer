const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const messages = [];
    ws.addEventListener('message', event => {
      const raw = event.data;
      const text = raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : raw;
      try { messages.push({ message: JSON.parse(text.replace(/\0+$/, '')), raw }); } catch (_) {}
    });
    ws.addEventListener('open', () => resolve({ ws, messages }), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

async function waitFor(client, predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = client.messages.find(item => predicate(item.message));
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('UI and Ruffle transports share one player and use compatible frame types', async t => {
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const deadline = Date.now() + 5000;
  while (!output.includes('已就绪')) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
    if (Date.now() > deadline) throw new Error(`Server did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  const sidA = 'aaaabbbb-1111-2222-3333-444455556666';
  const sidB = 'bbbbcccc-1111-2222-3333-444455556666';
  const ui = await connect(`ws://127.0.0.1:${port}/?sid=${sidA}`);
  const proxy = await connect(`ws://127.0.0.1:${port}/proxy?sid=${sidA}`);
  const second = await connect(`ws://127.0.0.1:${port}/?sid=${sidB}`);
  t.after(() => { ui.ws.close(); proxy.ws.close(); second.ws.close(); });

  ui.ws.send(JSON.stringify({ t: 'join', name: 'Alice' }));
  const uiWelcome = await waitFor(ui, m => m.t === 'welcome', 'UI welcome');
  assert.equal(typeof uiWelcome.raw, 'string', 'browser UI must receive text frames');

  proxy.ws.send('127.0.0.1:8082'); // Ruffle socketProxy destination preface
  proxy.ws.send(JSON.stringify({ t: 'join', name: 'Alice' }) + '\0');
  const proxyWelcome = await waitFor(proxy, m => m.t === 'welcome', 'proxy welcome');
  assert.ok(proxyWelcome.raw instanceof ArrayBuffer, 'Ruffle proxy must receive binary frames');
  assert.ok(new TextDecoder().decode(proxyWelcome.raw).endsWith('\0'), 'XMLSocket server messages must be NUL-terminated');
  assert.equal(proxyWelcome.message.id, uiWelcome.message.id, 'one browser tab must count as one player');

  second.ws.send(JSON.stringify({ t: 'join', name: 'Bob' }));
  const bobWelcome = await waitFor(second, m => m.t === 'welcome', 'second player welcome');
  const peerJoin = await waitFor(ui, m => m.t === 'peerJoin' && m.id === bobWelcome.message.id, 'peerJoin');
  assert.equal(peerJoin.message.name, 'Bob');
});
