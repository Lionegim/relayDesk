import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, badRequest, notFound } from './errors.js';
import { SERVICES, PERMISSIONS } from '../connectors.js';
import { summaryPrompt, draftPrompt } from '../ai/assistant.js';
import { emailFromIdToken } from '../providers/gmail/oauth.js';
import { readComposeInput } from '../providers/gmail/outbox.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const MAX_BODY = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON attendu', 'unsupported_media_type');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Requête trop volumineuse', 'too_large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw badRequest('JSON invalide');
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) throw notFound();
  let data;
  try { data = await readFile(file); } catch { throw notFound(); }
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const messageId = raw => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw badRequest('Identifiant de message invalide');
  return id;
};

const WINDOWS = [7, 30, 90];

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, location, 'cache-control': 'no-store' });
  res.end();
}

const accountId = raw => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw badRequest('Identifiant de compte invalide');
  return id;
};

// gmail : { oauth, sync, redirectUri, disconnect, outbox } (facultatif). allowedHosts : protège contre le DNS rebinding.
export function createApp({ store, ai, ownerName, gmail = null, allowedHosts = null }) {
  // Autorisation Google : navigation pleine page, puis retour vers l'interface avec le résultat dans l'URL.
  async function oauthRoute(pathname, url, res) {
    const back = params => redirect(res, '/?' + new URLSearchParams(params));
    if (pathname === '/oauth/google/start') {
      if (!gmail?.oauth.configured) return back({ connect_error: 'Renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env, puis redémarre Relay.' });
      const profileId = url.searchParams.get('profile'), name = (url.searchParams.get('name') || '').trim(), win = Number(url.searchParams.get('win'));
      if (!store.hasProfile(profileId) || !name || name.length > 80 || !WINDOWS.includes(win)) {
        return back({ connect_error: 'Paramètres de connexion invalides.' });
      }
      const perms = url.searchParams.has('perms') ? url.searchParams.get('perms').split(',') : ['read'];
      if (perms.some(p => !SERVICES.gmail.available.includes(p))) return back({ connect_error: 'Permission Gmail invalide ou indisponible.' });
      const existingId = url.searchParams.get('account');
      let account = null;
      if (existingId !== null) {
        account = store.getAccount(accountId(existingId));
        if (account.svc !== 'gmail' || account.profileId !== profileId || account.name !== name) throw badRequest('Compte Gmail invalide');
      }
      return redirect(res, gmail.oauth.start({ redirectUri: gmail.redirectUri, perms, context: { profileId, name, win, address: account?.address } }));
    }
    if (pathname === '/oauth/google/callback') {
      if (url.searchParams.get('error')) return back({ connect_error: 'Autorisation refusée dans Google.' });
      try {
        const r = await gmail.oauth.finish({ state: url.searchParams.get('state'), code: url.searchParams.get('code') });
        const email = emailFromIdToken(r.idToken);
        if (r.context.address && r.context.address !== email) throw badRequest('Choisis le compte Google déjà connecté pour modifier ses permissions.');
        const { account } = gmail.sync.connect({ profileId: r.context.profileId, name: r.context.name, windowDays: r.context.win, refreshToken: r.refreshToken, email, scopes: r.scopes });
        return back({ connect: 'gmail', account: account.id, profile: r.context.profileId, win: r.context.win });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(e);
        return back({ connect_error: e instanceof HttpError ? e.message : 'La connexion à Gmail a échoué.' });
      }
    }
    throw notFound();
  }

  // [méthode, motif, gestionnaire(params, body)]
  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, ai: { provider: 'mistral', configured: ai.configured, model: ai.model } })],
    ['GET', /^\/api\/state$/, () => {
      const snapshot = store.snapshot();
      for (const profile of snapshot.profiles) for (const account of profile.accounts) {
        account.perms = account.svc === 'gmail' && gmail ? gmail.sync.permissions(account.id) : [];
        if (account.svc === 'gmail') account.windowDays = store.getSync(account.id)?.window_days || 30;
      }
      return { ...snapshot, services: SERVICES, permissions: PERMISSIONS, ai: { configured: ai.configured }, integrations: { gmail: { configured: !!gmail?.oauth.configured } } };
    }],
    ['GET', /^\/api\/accounts\/([^/]+)\/sync$/, ([id]) => gmail?.sync.progress(accountId(id)) || (() => { throw notFound('Aucune synchronisation pour ce compte'); })()],
    ['POST', /^\/api\/accounts\/([^/]+)\/sync$/, ([id]) => {
      if (store.getAccount(accountId(id)).svc !== 'gmail' || !gmail) throw badRequest('Compte non synchronisable');
      gmail.sync.syncNow(accountId(id));
      return { started: true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/disconnect$/, ([id]) => {
      if (!gmail?.disconnect) throw badRequest('Déconnexion indisponible');
      return gmail.disconnect(accountId(id));
    }],
    ['GET', /^\/api\/messages\/([^/]+)$/, ([id]) => store.getMessage(messageId(id))],
    ['PATCH', /^\/api\/messages\/([^/]+)$/, ([id], body) => gmail ? gmail.sync.updateMessage(messageId(id), body) : store.updateMessage(messageId(id), body)],
    ['PUT', /^\/api\/messages\/([^/]+)\/draft$/, ([id], body) => gmail?.outbox
      ? gmail.outbox.saveDraft(messageId(id), body)
      : store.saveDraft(messageId(id), readComposeInput(body).text, readComposeInput(body))],
    ['POST', /^\/api\/messages\/([^/]+)\/send\/preview$/, ([id], body) => {
      if (!gmail?.outbox) throw badRequest('Envoi indisponible');
      return gmail.outbox.preview(messageId(id), body);
    }],
    ['POST', /^\/api\/messages\/([^/]+)\/send$/, ([id], body) => {
      if (!gmail?.outbox) throw badRequest('Envoi indisponible');
      return gmail.outbox.send(messageId(id), body);
    }],
    ['POST', /^\/api\/folders$/, (_, body) => store.createFolder(body)],
    ['PATCH', /^\/api\/contacts\/([^/]+)$/, ([id], body) => store.updateContact(id, body)],
    ['POST', /^\/api\/profiles\/([^/]+)\/accounts$/, ([id], body) => store.connectAccount(id, body)],
    ['POST', /^\/api\/ai\/summary$/, async (_, body) => {
      const m = store.getMessage(messageId(body.messageId));
      return { text: await ai.complete(summaryPrompt(m, ownerName), { maxTokens: 300 }) };
    }],
    ['POST', /^\/api\/ai\/draft$/, async (_, body) => {
      const m = store.getMessage(messageId(body.messageId));
      return { text: await ai.complete(draftPrompt(m, ownerName, body), { temperature: 0.5 }) };
    }],
  ];

  return http.createServer(async (req, res) => {
    try {
      if (allowedHosts && !allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Hôte non autorisé', 'forbidden_host');
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;
      if (pathname.startsWith('/oauth/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée', 'method_not_allowed');
        return await oauthRoute(pathname, url, res);
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée', 'method_not_allowed');
        return await serveStatic(req, res, pathname);
      }
      const matches = routes.filter(([, re]) => re.test(pathname));
      if (!matches.length) throw notFound('Route inconnue');
      const route = matches.find(([method]) => method === req.method);
      if (!route) throw new HttpError(405, 'Méthode non autorisée', 'method_not_allowed');
      const params = pathname.match(route[1]).slice(1);
      const body = req.method === 'GET' ? {} : await readJson(req);
      send(res, 200, await route[2](params, body));
    } catch (e) {
      const known = e instanceof HttpError;
      if (!known) console.error(e);
      send(res, known ? e.status : 500, { error: { code: known ? e.code : 'internal', message: known ? e.message : 'Erreur interne' } });
    }
  });
}
