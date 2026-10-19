import { HttpError } from './errors.js';

// Same-origin, cookie-authenticated invalidations only. Message content still uses the private APIs.
export function createLiveUpdates({ store, auth, heartbeatMs = 15000, maxClients = 64, maxPerSession = 6 }) {
  const clients = new Set();
  let pending = null, closed = false;
  const remove = client => { clients.delete(client); client.res.end(); };
  function write(client, frame) {
    try {
      if (auth && auth.requireSession(client.req, { touch: false }).id !== client.sessionId) throw new Error();
      if (!client.res.write(frame)) remove(client); // Never accumulate a slow reader's backlog.
    } catch { remove(client); }
  }
  const unsubscribe = store.subscribe?.(() => {
    if (closed || pending || !clients.size) return;
    pending = setTimeout(() => {
      pending = null;
      for (const client of clients) write(client, 'event: invalidate\ndata: {}\n\n');
    }, 40);
    pending.unref?.();
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) write(client, ': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    connect(req, res, session) {
      if (closed) throw new HttpError(503, 'Application en cours de redémarrage.', 'unavailable');
      const origin = auth?.origin || `${auth ? 'https' : 'http'}://${req.headers.host}`;
      if ((req.headers.origin && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        throw new HttpError(403, 'Requête refusée.', 'forbidden_origin');
      }
      if (clients.size >= maxClients || [...clients].filter(c => c.sessionId === session?.id).length >= maxPerSession) {
        throw new HttpError(429, 'Trop de connexions actives.', 'rate_limited');
      }
      const client = { req, res, sessionId: session?.id };
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      clients.add(client);
      res.once('close', () => clients.delete(client));
      write(client, 'retry: 2000\nevent: connected\ndata: {}\n\n');
    },
    close() {
      closed = true;
      clearTimeout(pending); clearInterval(heartbeat); unsubscribe?.();
      for (const client of clients) remove(client);
    },
  };
}
