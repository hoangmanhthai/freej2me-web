const http = require('http');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');

function fail(socket, code, msg) {
  try {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
  } catch (e) {
  }
  try {
    socket.destroy();
  } catch (e) {
  }
}

function makeAccept(key) {
  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function writeFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  socket.write(Buffer.concat([header, payload]));
}

class WsParser {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const hi = this.buf.readUInt32BE(off);
        const lo = this.buf.readUInt32BE(off + 4);
        off += 8;
        if (hi !== 0) throw new Error('frame too large');
        len = lo;
      }
      if (!masked) throw new Error('client frame not masked');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      off += 4;
      const payload = this.buf.subarray(off, off + len);
      off += len;
      this.buf = this.buf.subarray(off);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.onFrame({ fin, opcode, payload });
    }
  }
}

const listenPort = parseInt(process.argv[2] || '8000', 10);

const rootDir = path.resolve(__dirname, '..');
const webDir = path.join(rootDir, 'web');

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.jar') return 'application/java-archive';
  return 'application/octet-stream';
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const total = st.size;
    const range = req.headers.range;
    const isHead = req.method === 'HEAD';
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentTypeFor(filePath));
    res.setHeader('X-Served-By', 'nso-wsproxy');

    if (range) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      const clampedEnd = Math.min(end, total - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${clampedEnd}/${total}`,
        'Content-Length': clampedEnd - start + 1,
      });
      if (isHead) {
        res.end();
        return;
      }
      fs.createReadStream(filePath, { start, end: clampedEnd }).pipe(res);
      return;
    }

    res.writeHead(200, { 'Content-Length': total });
    if (isHead) {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  let u;
  try {
    u = new URL(req.url, 'http://localhost/');
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (u.pathname === '/') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  if (u.pathname === '/web') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  if (u.pathname === '/__range_test') {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Served-By', 'nso-wsproxy');
    const body = Buffer.from('ok\n', 'utf8');
    const total = body.length;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      const clampedEnd = Math.min(end, total - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${clampedEnd}/${total}`,
        'Content-Length': clampedEnd - start + 1,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(body.subarray(start, clampedEnd + 1));
      return;
    }
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'text/plain; charset=utf-8' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
    return;
  }

  if (!u.pathname.startsWith('/web/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const rel = u.pathname.substring('/web/'.length);
  let filePath = path.join(webDir, rel);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (u.pathname.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
  }

  serveFile(req, res, filePath);
});

server.on('upgrade', (req, socket) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost/');
  } catch (e) {
    fail(socket, 400, 'Bad Request');
    return;
  }

  const host = url.searchParams.get('host');
  const portStr = url.searchParams.get('port');
  const port = parseInt(portStr || '', 10);

  if (!host || !port || port < 1 || port > 65535) {
    fail(socket, 400, 'Bad Request');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const ver = req.headers['sec-websocket-version'];
  if (!key || ver !== '13') {
    fail(socket, 400, 'Bad Request');
    return;
  }

  const accept = makeAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
  );

  const tcp = net.connect({ host, port });
  tcp.setNoDelay(true);
  tcp.on('data', data => {
    writeFrame(socket, 0x2, Buffer.from(data));
  });
  tcp.on('close', () => {
    console.error('[proxy] tcp closed', host, port);
    try {
      writeFrame(socket, 0x8, Buffer.alloc(0));
    } catch (e) {
    }
    try {
      socket.destroy();
    } catch (e) {
    }
  });
  tcp.on('error', (e) => {
    console.error('[proxy] tcp error', host, port, e.message);
    try {
      writeFrame(socket, 0x8, Buffer.alloc(0));
    } catch (e2) {
    }
    try {
      socket.destroy();
    } catch (e3) {
    }
  });

  let fragOpcode = null;
  let fragParts = [];
  let fragLen = 0;

  function deliverToTcp(opcode, payload) {
    if (opcode === 0x2 || opcode === 0x1) {
      tcp.write(payload);
    }
  }

  const parser = new WsParser(frame => {
    if (frame.opcode === 0x8) {
      try {
        tcp.destroy();
      } catch (e) {
      }
      try {
        socket.destroy();
      } catch (e) {
      }
      return;
    }
    if (frame.opcode === 0x9) {
      writeFrame(socket, 0xa, frame.payload);
      return;
    }

    if (frame.opcode === 0x0) {
      if (fragOpcode == null) {
        return;
      }
      if (frame.payload.length) {
        fragParts.push(Buffer.from(frame.payload));
        fragLen += frame.payload.length;
      }
      if (frame.fin) {
        const payload = fragParts.length === 1 ? fragParts[0] : Buffer.concat(fragParts, fragLen);
        const opcode = fragOpcode;
        fragOpcode = null;
        fragParts = [];
        fragLen = 0;
        deliverToTcp(opcode, payload);
      }
      return;
    }

    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (frame.fin) {
        deliverToTcp(frame.opcode, Buffer.from(frame.payload));
        return;
      }
      fragOpcode = frame.opcode;
      fragParts = [];
      fragLen = 0;
      if (frame.payload.length) {
        fragParts.push(Buffer.from(frame.payload));
        fragLen += frame.payload.length;
      }
      return;
    }
  });

  socket.on('data', chunk => {
    try {
      parser.push(chunk);
    } catch (e) {
      try {
        tcp.destroy();
      } catch (e) {
      }
      try {
        socket.destroy();
      } catch (e) {
      }
    }
  });
  socket.on('close', () => {
    try {
      tcp.destroy();
    } catch (e) {
    }
  });
  socket.on('error', () => {
    try {
      tcp.destroy();
    } catch (e) {
    }
  });
});

server.listen(listenPort, '127.0.0.1', () => {
  process.stdout.write(`web server on http://127.0.0.1:${listenPort}/web/\n`);
  process.stdout.write(`socket proxy on ws://127.0.0.1:${listenPort}/?host=...&port=...\n`);
});
