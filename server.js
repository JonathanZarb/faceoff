'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const rooms = require('./rooms');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function requireAuth(query, body) {
  const code = (query.code || body.code || '').toString();
  const playerId = (query.playerId || body.playerId || '').toString();
  const token = (query.token || body.token || '').toString();
  return rooms.authenticate(code, playerId, token);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    if (pathname === '/api/rooms' && req.method === 'POST') {
      const body = await readBody(req);
      const { room, playerId, token } = rooms.createRoom(body.name);
      return sendJson(res, 200, { code: room.code, playerId, token, state: rooms.viewFor(room, playerId) });
    }

    if (pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/join$/i) && req.method === 'POST') {
      const code = pathname.split('/')[3];
      const body = await readBody(req);
      const result = rooms.joinRoom(code, body.name);
      if (result.error) return sendJson(res, 400, { error: result.error });
      return sendJson(res, 200, {
        code: result.room.code,
        playerId: result.playerId,
        token: result.token,
        state: rooms.viewFor(result.room, result.playerId),
      });
    }

    if (pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/state$/i) && req.method === 'GET') {
      const code = pathname.split('/')[3];
      const auth = requireAuth({ ...parsed.query, code }, {});
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      return sendJson(res, 200, { state: rooms.viewFor(auth.room, auth.player.id) });
    }

    if (pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/action$/i) && req.method === 'POST') {
      const code = pathname.split('/')[3];
      const body = await readBody(req);
      const auth = requireAuth({ code }, body);
      if (auth.error) return sendJson(res, 400, { error: auth.error });
      const { room, player } = auth;

      let result;
      switch (body.type) {
        case 'draw':
          result = rooms.doDraw(room, player, { source: body.source, cardId: body.cardId });
          break;
        case 'discard':
          result = rooms.doDiscard(room, player, { cardIds: body.cardIds });
          break;
        case 'callFaceOff':
          result = rooms.doCallFaceOff(room, player);
          break;
        case 'nextHand':
          result = rooms.doNextHand(room, player);
          break;
        case 'newMatch':
          result = rooms.doNewMatch(room, player);
          break;
        default:
          return sendJson(res, 400, { error: 'Unknown action type.' });
      }
      if (result.error) return sendJson(res, 400, { error: result.error });
      return sendJson(res, 200, { state: rooms.viewFor(room, player.id) });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Face Off server listening on http://localhost:${PORT}`);
});

module.exports = server;
