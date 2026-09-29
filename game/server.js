// Сервер для сетевой игры: раздаёт файлы и пересылает сообщения между игроками.
// Без зависимостей: node game/server.js [порт]
// Комнаты по коду: первый — хост (считает симуляцию), второй — гость.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8080;
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') { res.writeHead(302, { Location: '/game/' }); return res.end(); }
  if (url.endsWith('/')) url += 'index.html';
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket (RFC 6455, только текстовые кадры) ----------
const rooms = new Map(); // код → { host, guest }

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  const client = { socket, buf: Buffer.alloc(0), frags: [], room: null, role: null };
  socket.on('data', (d) => onData(client, d));
  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));
});

function send(client, obj) {
  if (!client || client.socket.destroyed) return;
  const data = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  client.socket.write(Buffer.concat([head, data]));
}

function onData(client, chunk) {
  client.buf = Buffer.concat([client.buf, chunk]);
  while (client.buf.length >= 2) {
    const b = client.buf;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let payload = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      payload = Buffer.from(payload.map((v, i) => v ^ mask[i & 3]));
    }
    client.buf = b.subarray(need);
    if (op === 0x8) { client.socket.end(); return; }
    if (op === 0x9) { client.socket.write(Buffer.from([0x8a, 0])); continue; }
    if (op === 0x1 || op === 0x0) {
      client.frags.push(payload);
      if (fin) {
        const text = Buffer.concat(client.frags).toString('utf8');
        client.frags = [];
        onMessage(client, text);
      }
    }
  }
}

function onMessage(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.t === 'host') {
    let code;
    do code = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(code));
    rooms.set(code, { host: client, guest: null });
    client.room = code; client.role = 'host';
    send(client, { t: 'hosted', code });
  } else if (msg.t === 'join') {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    if (!room) return send(client, { t: 'error', text: 'Комната не найдена' });
    if (room.guest) return send(client, { t: 'error', text: 'Комната заполнена' });
    room.guest = client;
    client.room = String(msg.code).toUpperCase(); client.role = 'guest';
    send(client, { t: 'joined', code: client.room });
    send(room.host, { t: 'guest' });
  } else if (client.room) {
    // Пересылка между хостом и гостем
    const room = rooms.get(client.room);
    if (!room) return;
    send(client.role === 'host' ? room.guest : room.host, text);
  }
}

function leave(client) {
  if (!client.room) return;
  const code = client.room;
  const room = rooms.get(code);
  client.room = null;
  if (!room) return;
  const other = client.role === 'host' ? room.guest : room.host;
  send(other, { t: 'left' });
  if (client.role === 'host') rooms.delete(code);
  else room.guest = null;
}

server.listen(PORT, () => console.log(`Линия фронта: http://localhost:${PORT}/game/  (WebSocket: /ws)`));
