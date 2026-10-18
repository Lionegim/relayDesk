import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, badRequest, notFound } from './errors.js';
import { SERVICES, PERMISSIONS } from '../connectors.js';
import { summaryPrompt, draftPrompt } from '../ai/assistant.js';

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

export function createApp({ store, ai, ownerName }) {
  // [méthode, motif, gestionnaire(params, body)]
  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, ai: { provider: 'mistral', configured: ai.configured, model: ai.model } })],
    ['GET', /^\/api\/state$/, () => ({ ...store.snapshot(), services: SERVICES, permissions: PERMISSIONS, ai: { configured: ai.configured } })],
    ['PATCH', /^\/api\/messages\/([^/]+)$/, ([id], body) => store.updateMessage(messageId(id), body)],
    ['PUT', /^\/api\/messages\/([^/]+)\/draft$/, ([id], body) => store.saveDraft(messageId(id), body.text)],
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
      const { pathname } = new URL(req.url, 'http://localhost');
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
