/**
 * Madness Project Nexus — 联机服务器（Render 单端口 · 自包含部署版）
 * -------------------------------------------------------------------
 * 所有服务合并在一个进程、一个动态端口(process.env.PORT 或 8081)：
 *   - HTTP 静态托管  : index.html + patched_online.swf + ruffle/*
 *   - WebSocket      : 页面客户端（在线人数），也作为 Ruffle 的 socketProxy
 *                      转发端点 —— Ruffle XMLSocket 无法直连 TCP，会先连
 *                      ws(s)://<host>:PORT/proxy，之后把本 WS 当作一个玩家
 *                      注册进同一份在线状态表。
 *
 * 每个连接一律视为一个玩家，收到每行 JSON 走统一 handleMessage / broadcast。
 * 无需额外的 843 policy、8082 原始 TCP、8083 独立代理。
 *
 * Render 启动: node server.js   (PORT 由平台注入 $PORT)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 8081;
const DEPLOY_ROOT = __dirname; // 自包含：server.js 所在目录即网站根

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  const m = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.css': 'text/css; charset=utf-8', '.swf': 'application/x-shockwave-flash',
    '.json': 'application/json; charset=utf-8'
  };
  return m[ext] || 'application/octet-stream';
}

// ---------- 玩家 ----------
const players = new Map();
let nextId = 1;
function makeId() { return nextId++; }

function broadcast(msg, exceptId) {
  const line = JSON.stringify(msg) + '\n';
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    try { if (p.ws) p.ws.send(line); } catch (e) {}
  }
}
function peerList() {
  const out = [];
  for (const p of players.values()) out.push({ id: p.id, name: p.name });
  return out;
}
function send(player, msg) {
  const line = JSON.stringify(msg) + '\n';
  try { if (player.ws) player.ws.send(line); } catch (e) {}
}

function handleMessage(player, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    player.name = String(msg.name || ('Player' + player.id)).slice(0, 24);
    send(player, { t: 'welcome', id: player.id, name: player.name });
    send(player, { t: 'peers', list: peerList().filter(p => p.id !== player.id) });
    broadcast({ t: 'peerJoin', id: player.id, name: player.name }, player.id);
    console.log(`[join] #${player.id} ${player.name} (共 ${players.size} 人)`);
    return;
  }
  if (msg.t === 'state') {
    player.state = { x: msg.x, y: msg.y, face: msg.face, status: msg.status,
      weapon: msg.weapon, aim: msg.aim, hp: msg.hp, dead: msg.dead };
    broadcast({ t: 'state', id: player.id, name: player.name, ...player.state }, player.id);
    return;
  }
  if (msg.t === 'ping') { send(player, { t: 'pong', ts: msg.ts }); return; }
}

function removePlayer(player) {
  if (!players.has(player.id)) return;
  players.delete(player.id);
  broadcast({ t: 'peerLeave', id: player.id });
  console.log(`[leave] #${player.id} ${player.name || ''} (剩 ${players.size} 人)`);
}

// ---------- WebSocket ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(k) { return crypto.createHash('sha1').update(k + GUID).digest('base64'); }
function wsEncode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let h;
  // 用二进制帧(0x82)：Ruffle 的 socketProxy 是字节管道，只认二进制帧，
  // 文本帧(0x81)会被静默丢弃 → 玩家收不到 welcome/state。浏览器 ws 同样接受二进制。
  if (len < 126) { h = Buffer.alloc(2); h[0] = 0x82; h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x82; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x82; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, payload]);
}
function wsDecode(buf) {
  const messages = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const b0 = buf[o], b1 = buf[o + 1];
    const op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = o + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    let payload = buf.slice(p, p + len);
    if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
    p += len;
    if (op === 0x8) messages.push({ close: true });
    else if (op === 0x1) messages.push({ text: payload.toString('utf8') });
    else if (op === 0x2) messages.push({ bin: payload });
    else if (op === 0x9) messages.push({ ping: true });
    o = p;
  }
  return { messages, rest: buf.slice(o) };
}

// ---------- HTTP + WS ----------
const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // 防目录穿越
  let abs = path.join(DEPLOY_ROOT, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
  } catch (e) {}
  fs.readFile(abs, (e, d) => {
    if (e) { res.writeHead(404); res.end('404 Not Found: ' + urlPath); return; }
    res.writeHead(200, { 'Content-Type': mimeOf(abs), 'Content-Length': d.length, 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const player = {
    id: makeId(), name: null, state: null,
    ws: { send: (str) => { try { socket.write(wsEncode(str)); } catch (e) {} } }
  };
  players.set(player.id, player);

  let buf = Buffer.alloc(0);
  let firstFrameHandled = false;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = wsDecode(buf);
    buf = rest;
    for (const m of messages) {
      if (m.close) { socket.end(); return; }
      if (m.ping) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch (e) {} continue; }
      let text = null;
      if (m.text) text = m.text; else if (m.bin) text = m.bin.toString('utf8');
      if (text == null) continue;

      // Ruffle socketProxy 首条帧是目标地址 "host:port"，非协议消息 → 消费
      if (!firstFrameHandled) {
        const t = text.trim();
        if (/^[\w.\-]+:\d+$/.test(t)) { firstFrameHandled = true; continue; }
      }
      for (const line of text.split('\n')) {
        const s = line.trim().replace(/\0/g, '');
        if (!s) continue;
        try { handleMessage(player, JSON.parse(s)); } catch (e) {}
      }
    }
  });

  socket.on('close', () => removePlayer(player));
  socket.on('error', () => removePlayer(player));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[web+ws+proxy] 监听 0.0.0.0:${PORT}`);
  console.log('联机服务器已就绪（Render 单端口模式）。');
  console.log(`  网页客户端 ws(s)://<host>:${PORT}   Ruffle socketProxy ${'/'}proxy`);
});