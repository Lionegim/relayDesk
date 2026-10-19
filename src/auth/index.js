// Authentification du propriétaire unique (lot 3) : OIDC (code + PKCE), sessions opaques révocables, CSRF.
// Aucune inscription, aucune liste d'adresses : seul le couple émetteur + sub configuré est accepté, avec l'acr exigé.
// Rien ici ne journalise de jeton, de code, de cookie ni de claim.
import { createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.js';
import { createOidcClient } from './oidc.js';
import { createRateLimiter } from './rate-limit.js';

const TX_TTL_MS = 10 * 60000;          // durée d'une connexion en cours chez le fournisseur
const MAX_TX = 200;                    // connexions en cours conservées au plus
const TOUCH_MS = 60000;                // mise à jour de last_seen au plus une fois par minute
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;   // 32 octets en base64url

const sha256 = value => createHash('sha256').update(value).digest();
const b64 = buf => buf.toString('base64url');
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(name, value, { maxAgeS, secure }) {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : []), `Max-Age=${maxAgeS}`].join('; ');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body === null ? '' : JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers });
  res.end();
}

// Libellé d'appareil lisible, sans conserver l'agent utilisateur complet.
function deviceLabel(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return `${browser} · ${os}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE,
  binding TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  acr TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);`;

/**
 * config : configuration du runtime, avec config.auth (voir readAuthConfig).
 * db : DatabaseSync ouverte (la table auth_sessions est créée si besoin).
 * oidc : adaptateur { authorizationUrl, callback, random } ou options { fetch } pour l'adaptateur openid-client (tests).
 */
export async function createOwnerAuth({ config, db, clock = Date.now, oidc = null, log = console }) {
  const auth = config?.auth;
  if (!auth) throw new Error('createOwnerAuth : config.auth requis.');
  const enabled = !!auth.enabled;
  if (config.mode === 'hosted' && !enabled) throw new Error('Mode hébergé : authentification obligatoire.');
  const secure = !!auth.secureCookies;
  const SESSION_COOKIE = secure ? '__Host-relay_session' : 'relay_session';
  const TX_COOKIE = secure ? '__Host-relay_login' : 'relay_login';
  const origin = auth.publicBaseUrl;

  if (!enabled) {
    // Mode local sans authentification (compatibilité) : seule /auth/session répond, pour informer l'interface.
    return {
      enabled: false,
      async handle(req, res, url) {
        if (url.pathname !== '/auth/session') return false;
        if (req.method !== 'GET') { send(res, 405, { error: 'Méthode non autorisée', code: 'method_not_allowed' }, { allow: 'GET' }); return true; }
        send(res, 200, { enabled: false, authenticated: false });
        return true;
      },
      requireSession: () => null,
      assertMutation: () => {},
      assertRecent: () => {},
      close() {},
    };
  }

  const client = oidc && typeof oidc.callback === 'function' ? oidc : createOidcClient(auth, { fetch: oidc?.fetch });
  // Lien entre une session et la configuration qui l'a créée : un changement d'émetteur, de client, de propriétaire
  // ou d'acr exigé invalide toutes les sessions existantes au redémarrage.
  const binding = b64(sha256(['v1', auth.issuer, auth.clientId, auth.ownerSub, auth.mfaAcr].join('\n')));

  db.exec(SCHEMA);
  db.prepare('DELETE FROM auth_sessions WHERE binding != ? OR expires_at <= ? OR revoked_at IS NOT NULL').run(binding, clock());
  const q = sql => db.prepare(sql);
  const transactions = new Map(); // id -> { state, nonce, codeVerifier, forceLogin, expires }
  const limiter = createRateLimiter({ clock });
  const sweep = setInterval(() => {
    const now = clock();
    for (const [id, tx] of transactions) if (tx.expires <= now) transactions.delete(id);
    q('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ? OR revoked_at IS NOT NULL').run(now, now - auth.idleTtlMs);
  }, 5 * 60000);
  sweep.unref?.();

  const csrfFor = token => b64(createHmac('sha256', token).update('relay-csrf-v1').digest());
  const fail = (status, message, code) => new HttpError(status, message, code);
  const unauthenticated = () => fail(401, 'Connexion requise.', 'auth_required');

  function rowFor(token) {
    if (!TOKEN.test(token || '')) return null;
    return q('SELECT * FROM auth_sessions WHERE token_hash = ?').get(sha256(token)) || null;
  }
  const live = (row, now) => row && !row.revoked_at && row.binding === binding && row.expires_at > now && now - row.last_seen_at < auth.idleTtlMs;

  function requireSession(req, { touch = true } = {}) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const row = rowFor(token);
    const now = clock();
    if (!live(row, now)) throw unauthenticated();
    if (touch && now - row.last_seen_at >= TOUCH_MS) q('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    return {
      id: row.id, csrfToken: csrfFor(token), authenticatedAt: row.authenticated_at, createdAt: row.created_at,
      expiresAt: row.expires_at, idleExpiresAt: Math.min(row.expires_at, now + auth.idleTtlMs), acr: row.acr, mfa: row.acr === auth.mfaAcr,
    };
  }

  // Mutations : Origin exact, Fetch Metadata (rejet inter-sites) et jeton CSRF lié à la session.
  function assertMutation(req, session) {
    if (SAFE.has(req.method)) return;
    if (!session) throw unauthenticated();
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw fail(403, 'Requête refusée.', 'csrf_rejected');
    if (req.headers.origin !== origin) throw fail(403, 'Requête refusée.', 'csrf_rejected');
    if (!sameText(req.headers['x-csrf-token'], session.csrfToken)) throw fail(403, 'Requête refusée.', 'csrf_rejected');
  }

  function assertRecent(session) {
    if (!session || clock() - session.authenticatedAt > auth.recentMs) {
      throw fail(403, 'Reconnecte-toi pour confirmer cette action.', 'reauth_required');
    }
  }

  function limited(req, res) {
    if (limiter.take(req.socket?.remoteAddress || 'inconnu')) return false;
    send(res, 429, { error: 'Trop de tentatives, réessaie dans une minute.', code: 'rate_limited' }, { 'retry-after': '60' });
    return true;
  }

  async function login(req, res, url) {
    if (limited(req, res)) return;
    const now = clock();
    for (const [id, tx] of transactions) if (tx.expires <= now) transactions.delete(id);
    if (transactions.size >= MAX_TX) { send(res, 429, { error: 'Trop de connexions en cours.', code: 'rate_limited' }); return; }
    const forceLogin = url.searchParams.get('reauth') === '1';
    const tx = { state: client.random.state(), nonce: client.random.nonce(), codeVerifier: client.random.codeVerifier(), forceLogin, expires: now + TX_TTL_MS };
    let location;
    try {
      location = await client.authorizationUrl({ ...tx, acrValues: auth.mfaAcr });
    } catch {
      log.warn?.('Authentification : fournisseur OIDC injoignable.');
      send(res, 502, { error: 'Fournisseur d’identité indisponible.', code: 'idp_unavailable' });
      return;
    }
    const id = b64(randomBytes(32));
    transactions.set(id, tx);
    redirect(res, location, { 'set-cookie': cookie(TX_COOKIE, id, { maxAgeS: TX_TTL_MS / 1000, secure }) });
  }

  async function callback(req, res, url) {
    if (limited(req, res)) return;
    const clearTx = cookie(TX_COOKIE, '', { maxAgeS: 0, secure });
    const txId = parseCookies(req.headers.cookie)[TX_COOKIE];
    const tx = txId ? transactions.get(txId) : null;
    if (txId) transactions.delete(txId); // usage unique, réussite ou échec
    const deny = (status, message, code) => send(res, status, { error: message, code }, { 'set-cookie': clearTx });
    if (!tx || tx.expires <= clock()) return deny(400, 'Connexion expirée : recommence.', 'login_expired');
    if (url.searchParams.has('error')) return deny(401, 'Connexion refusée par le fournisseur.', 'login_denied');
    let claims;
    try {
      // Adresse de retour reconstruite sur l'origine publique fixe, jamais sur Host ou X-Forwarded-*.
      const current = new URL(`${url.pathname}${url.search}`, origin);
      claims = await client.callback(current, { codeVerifier: tx.codeVerifier, state: tx.state, nonce: tx.nonce });
    } catch {
      log.warn?.('Authentification : réponse du fournisseur refusée.');
      return deny(401, 'Connexion refusée.', 'login_failed');
    }
    if (claims?.iss !== auth.issuer || claims?.sub !== auth.ownerSub) {
      log.warn?.('Authentification : identité non autorisée.');
      return deny(403, 'Ce compte n’est pas autorisé.', 'owner_mismatch');
    }
    if (claims.acr !== auth.mfaAcr) return deny(403, 'Authentification forte requise.', 'mfa_required');
    const now = clock();
    if(claims.auth_time!==undefined && (!Number.isInteger(claims.auth_time) || claims.auth_time<=0 || claims.auth_time*1000>now+60000)) return deny(401,'Date d’authentification invalide.','auth_time_invalid');
    const authTime = Number.isFinite(claims.auth_time) ? claims.auth_time * 1000 : 0;
    // Réauthentification demandée : auth_time signé obligatoire et récent (prompt=login, max_age=0 côté fournisseur).
    if (tx.forceLogin && (!Number.isFinite(claims.auth_time) || now - authTime > 5 * 60000)) return deny(401, 'Reconnexion non confirmée.', 'reauth_failed');
    // Rotation : la session éventuelle de ce navigateur est révoquée ; un nouveau jeton est toujours émis.
    const previous = rowFor(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    const token = b64(randomBytes(32));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (previous) q('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, previous.id);
      q(`INSERT INTO auth_sessions (id, token_hash, binding, device, created_at, authenticated_at, last_seen_at, expires_at, acr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID().replaceAll('-', ''), sha256(token), binding, deviceLabel(req.headers['user-agent']),
        now, Math.min(authTime, now), now, now + auth.sessionTtlMs, claims.acr);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    redirect(res, '/', { 'set-cookie': [clearTx, cookie(SESSION_COOKIE, token, { maxAgeS: Math.floor(auth.sessionTtlMs / 1000), secure })] });
  }

  function sessionView(row, currentId, now) {
    return {
      id: row.id, current: row.id === currentId, device: row.device, createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(), expiresAt: new Date(Math.min(row.expires_at, row.last_seen_at + auth.idleTtlMs)).toISOString(),
      authenticatedAt: new Date(row.authenticated_at).toISOString(), mfa: row.acr === auth.mfaAcr, recent: now - row.authenticated_at <= auth.recentMs,
    };
  }

  const routes = {
    'GET /auth/login': login,
    'GET /auth/callback': callback,
    'GET /auth/session': (req, res) => {
      let s;
      try { s = requireSession(req); } catch { return send(res, 401, { enabled: true, authenticated: false }); }
      const now = clock();
      send(res, 200, {
        enabled: true, authenticated: true, csrfToken: s.csrfToken, sessionId: s.id,
        authenticatedAt: new Date(s.authenticatedAt).toISOString(), expiresAt: new Date(Math.min(s.expiresAt, s.idleExpiresAt)).toISOString(),
        mfa: s.mfa, recent: now - s.authenticatedAt <= auth.recentMs,
      });
    },
    'POST /auth/logout': (req, res) => {
      const s = requireSession(req);
      assertMutation(req, s);
      q('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(clock(), s.id);
      send(res, 200, { loggedOut: true }, { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAgeS: 0, secure }) });
    },
    'GET /auth/sessions': (req, res) => {
      const s = requireSession(req);
      const now = clock();
      const rows = q('SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND binding = ? AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC')
        .all(binding, now, now - auth.idleTtlMs);
      send(res, 200, { sessions: rows.map(r => sessionView(r, s.id, now)) });
    },
  };

  return {
    enabled: true,
    // true si la requête relevait de /auth/* (réponse déjà envoyée), false sinon.
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/auth/')) return false;
      try {
        const m = /^\/auth\/sessions\/([^/]+)$/.exec(url.pathname);
        if (m) {
          if (req.method !== 'DELETE') { send(res, 405, { error: 'Méthode non autorisée', code: 'method_not_allowed' }, { allow: 'DELETE' }); return true; }
          const s = requireSession(req);
          assertMutation(req, s);
          const id = m[1];
          if (!SESSION_ID.test(id)) throw fail(404, 'Session introuvable.', 'not_found');
          // Retirer un autre appareil est un changement sensible ; sa propre session revient à se déconnecter.
          if (id !== s.id) assertRecent(s);
          const done = q('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND binding = ?').run(clock(), id, binding);
          if (!done.changes) throw fail(404, 'Session introuvable.', 'not_found');
          send(res, 200, { revoked: true }, id === s.id ? { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAgeS: 0, secure }) } : {});
          return true;
        }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) {
          const known = Object.keys(routes).some(k => k.endsWith(` ${url.pathname}`));
          send(res, known ? 405 : 404, { error: known ? 'Méthode non autorisée' : 'Introuvable', code: known ? 'method_not_allowed' : 'not_found' });
          return true;
        }
        await route(req, res, url);
      } catch (e) {
        if (!(e instanceof HttpError)) { log.error?.('Authentification : erreur interne.'); e = fail(500, 'Erreur interne.', 'internal'); }
        if (!res.headersSent) send(res, e.status, { error: e.message, code: e.code });
      }
      return true;
    },
    origin,
    requireSession,
    assertMutation,
    assertRecent,
    close() { clearInterval(sweep); transactions.clear(); limiter.clear(); },
  };
}

export { readAuthConfig, AuthConfigError } from './config.js';
export { createOidcClient } from './oidc.js';
