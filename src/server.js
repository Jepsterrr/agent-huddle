// Local HTTP endpoint the hook script posts to. Electron-free so it can be tested.
//
// onEvent(payload, mode) returns either a falsy value (reply immediately, no
// decision) or { promise, cancel }. The reply is held until the promise
// resolves with a hook output object (or null for "no decision"). If the hook
// goes away first, cancel() is called.

const http = require('http');

const MAX_BODY = 8 * 1024 * 1024;

function startServer({ token, onEvent, port = 0 }) {
  const server = http.createServer((req, res) => {
    const reject = (code) => {
      res.writeHead(code);
      res.end();
      req.destroy();
    };

    // Browsers always send Origin on cross-site POSTs; the hook never does.
    if (req.method !== 'POST' || req.url !== '/event') return reject(404);
    if (req.headers.origin || req.headers['x-huddle-token'] !== token) return reject(403);

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) return reject(413);
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(400);
      }

      let held = null;
      try {
        const ppid = Number(req.headers['x-huddle-ppid']);
        const m = req.headers['x-huddle-mode'];
        held = onEvent(payload, m === 'wait' || m === 'status' ? m : 'notify', {
          ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
        });
      } catch (err) {
        console.error('[huddle] event failed:', err);
      }
      if (!held) {
        res.writeHead(204);
        return res.end();
      }

      res.on('close', () => {
        if (!res.writableEnded) held.cancel();
      });
      held.promise.then((out) => {
        if (res.destroyed) return;
        if (out) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        } else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    req.on('error', () => {});
  });

  server.requestTimeout = 0;
  server.headersTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer };
