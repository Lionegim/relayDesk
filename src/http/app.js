import {HISTORY_WINDOWS} from '../mail/history/windows.js';
import {readMailDisplay} from '../mail/display.js';
import {importAddressBook} from '../contacts/import.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, badRequest, notFound } from './errors.js';
import { SERVICES, PERMISSIONS } from '../connectors.js';
import { createAssistantService } from '../mail/assistant-service.js';
import { emailFromIdToken } from '../providers/gmail/oauth.js';
import { createMailService } from '../mail/service.js';
import { createSessionAccess } from './session-access.js';
import {mailboxAddress} from '../providers/mail-credentials.js';
import {createLiveUpdates} from './live-updates.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const MAX_BODY = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.webp':'image/webp' };
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
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': extname(file)==='.html'?'no-store':'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const messageId = raw => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw badRequest('Identifiant de message invalide');
  return id;
};

const WINDOWS = [0,7,30,90,180,365,730];

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
export function createApp({ store, ai, ownerName, gmail = null, providers = {}, push = null, allowedHosts = null, health = null, readiness = null, operations = null, auth = null }) {
  providers = { ...providers, ...(gmail ? { gmail } : {}) };
  const access=createSessionAccess();
  const mail = createMailService({ store, providers });
  const assistant = createAssistantService({ store, ai, mail, ownerName });
  const live = createLiveUpdates({ store, auth });
  // Autorisation Google : navigation pleine page, puis retour vers l'interface avec le résultat dans l'URL.
  async function oauthRoute(pathname, url, res, session=null, json=false,req=null) {
    if (!['/oauth/google/start', '/oauth/google/callback', '/oauth/microsoft/start', '/oauth/microsoft/callback'].includes(pathname)) throw notFound();
    const service = pathname.startsWith('/oauth/microsoft/') ? 'outlook' : 'gmail';
    const provider = providers[service];
    const def = SERVICES[service];
    const back = params => {
      if(json && params.connect_error) throw new HttpError(400,params.connect_error,'oauth_start_invalid');
      return redirect(res, '/?' + new URLSearchParams({ provider: service, ...params }));
    };
    const authorize=context=>{
      if(auth) {const latest=auth.requireSession(req);if(latest.id!==session.id) throw new HttpError(401,'Session remplacée : recommence la connexion.','auth_required');auth.assertRecent(latest);}
      if(!store.hasProfile(context.profileId)) throw badRequest('Profil de connexion introuvable.');
      const target=context.target;
      if(!target) return;
      if(!store.hasAccount(target.id) || store.accountIdentity(target.id)!==target.identity) throw new HttpError(409,'Le compte a changé : recommence la connexion.','account_changed');
      const current=store.getAccount(target.id);
      if(current.profileId!==context.profileId || current.svc!==service || current.name!==context.name || (current.address || '').toLowerCase()!==(target.address || '').toLowerCase() || (provider.sync.generation?.(target.id) || 0)!==target.generation) throw new HttpError(409,'Le compte a changé : recommence la connexion.','account_changed');
    };
    if (pathname.endsWith('/start')) {
      if (!provider?.oauth.configured) return back({ connect_error: `Connexion ${def.name} non configurée : consulte la documentation de connexion.` });
      const profileId = url.searchParams.get('profile'), name = (url.searchParams.get('name') || '').trim(), win = Number(url.searchParams.get('win'));
      if (!store.hasProfile(profileId) || !name || name.length > 80 || !WINDOWS.includes(win)) {
        return back({ connect_error: 'Paramètres de connexion invalides.' });
      }
      const perms = url.searchParams.has('perms') ? url.searchParams.get('perms').split(',') : ['read'];
      if (perms.some(p => !def.available.includes(p))) return back({ connect_error: 'Permission de messagerie invalide ou indisponible.' });
      const existingId = url.searchParams.get('account');
      let account = store.accountForName(profileId,name);
      if (existingId !== null) {
        account = store.getAccount(accountId(existingId));
        if (account.svc !== service || account.profileId !== profileId || account.name !== name) throw badRequest('Compte de messagerie invalide');
      }
      if(account && (account.svc!==service || account.profileId!==profileId || account.name!==name)) throw badRequest('Compte de messagerie invalide');
      const historyDays=account?null:Number(url.searchParams.get('historyDays') ?? 365);if(historyDays!==null && !HISTORY_WINDOWS.includes(historyDays))throw badRequest('Historique invalide');
      const context={profileId,name,win,historyDays,expectNew:!account,address:account?.address,target:account?{id:account.id,identity:store.accountIdentity(account.id),generation:provider.sync.generation?.(account.id) || 0,address:account.address}:null};
      const location=provider.oauth.start({redirectUri:provider.redirectUri,perms,context});
      if(auth) access.rememberOAuth(session,service,location,context);
      return json?send(res,200,{url:location}):redirect(res,location);
    }
    if (pathname.endsWith('/callback')) {
      if(auth) {const original=access.consumeOAuth(session,service,url.searchParams.get('state'));if(original)authorize(original);}
      if (url.searchParams.get('error')) return back({ connect_error: `Autorisation refusée dans ${def.provider}.` });
      try {
        const r = await provider.oauth.finish({ state: url.searchParams.get('state'), code: url.searchParams.get('code') });
        authorize(r.context);
        const email = mailboxAddress(r.email || (provider.oauth.mode!=='web'?emailFromIdToken(r.idToken):null));
        if (r.context.address && mailboxAddress(r.context.address) !== email) throw badRequest('Choisis le compte déjà connecté pour modifier ses permissions.');
        const {account,ready}=provider.sync.connect({profileId:r.context.profileId,name:r.context.name,windowDays:r.context.win,historyDays:r.context.historyDays ?? (r.context.expectNew?365:null),refreshToken:r.refreshToken,email,scopes:r.scopes,expectedAccount:r.context.target,expectNew:r.context.expectNew,authorize:()=>authorize(r.context)});
        if(ready) await ready;
        return back({ connect: service, account: account.id, profile: r.context.profileId, win: r.context.win });
      } catch (e) {
        // Les erreurs fournisseur peuvent inclure code OAuth, URL ou corps : ne jamais les journaliser.
        return back({ connect_error: e instanceof HttpError ? e.message : `La connexion à ${def.name} a échoué.` });
      }
    }
    throw notFound();
  }

  // [méthode, motif, gestionnaire(params, body)]
  const routes = [
    ['POST', /^\/api\/messages\/([^/]+)\/display$/, ([id]) => readMailDisplay({store,mail,id:messageId(id)})],
    ['GET', /^\/api\/profiles\/([^/]+)\/network$/, ([p],body,session,url) => store.contactNetwork(p,{days:Number(url.searchParams.get('days') || 90)})],
    ['POST', /^\/api\/profiles\/([^/]+)\/person-groups$/, ([p],body) => store.savePersonGroup(p,body)],
    ['PATCH', /^\/api\/profiles\/([^/]+)\/person-groups\/([^/]+)$/, ([p,id],body) => store.savePersonGroup(p,body,id)],
    ['PUT', /^\/api\/profiles\/([^/]+)\/person-groups\/([^/]+)\/members\/([^/]+)$/, ([p,id,person],body) => store.personGroupMembership(p,id,person,body.on)],
    ['GET', /^\/api\/ops\/health$/, () => operations?operations():({status:'unconfigured'})],
    ['GET', /^\/api\/health$/, () => health ? health() : auth ? ({ok:true}) : ({ ok: true, ai: { provider: 'mistral', configured: ai.configured, model: ai.model } })],
    ['GET', /^\/api\/state$/, (_,body,session,url) => {
      const params=Object.fromEntries(url.searchParams),paged=params.paged==='1';
      const snapshot=store.snapshot(paged?{profile:params.profile || store.firstProfileId(),nav:params.nav,channel:params.channel,folder:params.folder || null,q:params.q,limit:params.limit,cursor:params.cursor}:null);
      for (const profile of snapshot.profiles) for (const account of profile.accounts) {
        account.perms = mail.permissions(account);
        if(['gmail','outlook'].includes(account.svc)){account.history=store.history.status(account.id);const window=store.mailWindows.policy(account.id);account.historyDays=window.days;account.historyWindowRevision=`${window.days}:${window.contentRevision}`;}
        if(push && ['gmail','outlook'].includes(account.svc)) account.notifications=push.status(account.id);
        if (providers[account.svc]) account.windowDays = account.svc === 'whatsapp' ? 7 : store.getSync(account.id)?.window_days || 30;
        if (account.svc === 'whatsapp' && providers.whatsapp) account.sync = providers.whatsapp.sync.progress?.(account.id) || null;
      }
      return { ...snapshot, services: SERVICES, permissions: PERMISSIONS, ai: { configured: ai.configured }, integrations: Object.fromEntries(Object.entries(providers).map(([k,p]) => [k, { configured: !!(p.configured ?? p.oauth?.configured) }])) };
    }],
    ['POST', /^\/api\/whatsapp\/links$/, (_, body) => {
      const wa = providers.whatsapp;
      if (!wa?.configured) throw new HttpError(503, 'La liaison WhatsApp est indisponible.', 'whatsapp_unavailable');
      const { profileId, name, accountId } = body;
      if (body.reconnect !== undefined && (typeof body.reconnect !== 'boolean' || accountId === undefined)) throw badRequest('Reconnexion invalide');
      if (!store.hasProfile(profileId) || typeof name !== 'string' || !name.trim() || name.trim().length > 80 || (body.windowDays !== undefined && body.windowDays !== 7)) throw badRequest('Paramètres de liaison invalides');
      if (accountId !== undefined) {
        if (!Number.isInteger(accountId)) throw badRequest('Compte invalide');
        const a = store.getAccount(accountId);
        if (a.svc !== 'whatsapp' || a.profileId !== profileId || a.name !== name.trim()) throw badRequest('Compte WhatsApp invalide');
      }
      const input = { profileId, name: name.trim(), windowDays: 7, ...(body.expectedPhone !== undefined ? {expectedPhone:body.expectedPhone} : {}), ...(accountId !== undefined ? { accountId } : {}) };
      return body.reconnect === true ? wa.relink(input) : wa.startLink(input);
    }],
    ['GET', /^\/api\/whatsapp\/links\/([a-zA-Z0-9-]+)$/, ([id]) => {
      if (!providers.whatsapp) throw notFound();
      return providers.whatsapp.linkStatus(id);
    }],
    ['DELETE', /^\/api\/whatsapp\/links\/([a-zA-Z0-9-]+)$/, async ([id]) => {
      if (!providers.whatsapp) throw notFound();
      await providers.whatsapp.cancelLink(id);
      return { cancelled: true };
    }],
    ['GET', /^\/api\/accounts\/([^/]+)\/history-window$/, ([id])=>store.mailWindows.describe(accountId(id))],
    ['POST', /^\/api\/accounts\/([^/]+)\/history-window\/preview$/, ([id],body)=>store.mailWindows.preview(accountId(id),body.days)],
    ['PUT', /^\/api\/accounts\/([^/]+)\/history-window$/, ([id],body)=>{
      const aid=accountId(id),provider=mail.providerFor(aid),identity=body.identity;
      if(typeof identity!=='string' || store.accountIdentity(aid)!==identity)throw new HttpError(409,'Le compte a changé : recommence depuis les paramètres.','account_changed');
      if(!provider.sync.queue)throw badRequest('Réglage indisponible pour ce compte.');
      return provider.sync.queue(aid,()=>{if(store.accountIdentity(aid)!==identity)throw new HttpError(409,'Le compte a changé.','account_changed');const result=store.mailWindows.set(aid,body.days,body.revision);if(result.changed){store.history.reset(aid);result.storageOptimized=(result.cleanup.removed || result.cleanup.trimmed || store.mailWindows.needsCompaction())?store.mailWindows.compact():true;}return result;});
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/history$/, ([id],body) => {
      const aid=accountId(id),provider=mail.providerFor(aid);
      if(!provider.sync.historyPage)throw badRequest('Import complet indisponible pour ce compte.');
      if(body.action==='pause')return store.history.pause(aid);
      if(body.action!=='start')throw badRequest('Action d’import invalide.');
      if(!provider.sync.permissions(aid).includes('read'))throw badRequest('Reconnecte ce compte avant l’import.');
      return store.history.start(aid);
    }],
    ['GET', /^\/api\/accounts\/([^/]+)\/sync$/, ([id]) => mail.providerFor(accountId(id)).sync.progress(accountId(id)) || (() => { throw notFound('Aucune synchronisation pour ce compte'); })()],
    ['POST', /^\/api\/accounts\/([^/]+)\/sync$/, async ([id]) => {
      const aid = accountId(id), provider = mail.providerFor(aid);
      if (store.getAccount(aid).svc === 'whatsapp') await provider.sync.syncNow(aid);
      else provider.sync.syncNow(aid);
      return { started: true };
    }],
    ['POST', /^\/api\/accounts\/([^/]+)\/disconnect$/, ([id]) => {
      return mail.providerFor(accountId(id)).disconnect(accountId(id));
    }],
    ['GET', /^\/api\/messages\/([^/]+)$/, ([id],body,session,url) => ({ ...store.getMessage(messageId(id),{limit:url.searchParams.get('limit') ?? 50,before:url.searchParams.get('before')}), aiResults: assistant.results(messageId(id)), replyMemory:store.getReplyMemory(messageId(id)) })],
    ['GET', /^\/api\/messages\/([^/]+)\/memory$/, ([id]) => store.getReplyMemory(messageId(id))],
    ['PATCH', /^\/api\/messages\/([^/]+)\/memory$/, ([id],body) => store.changeReplyMemory(messageId(id),body)],
    ['PATCH', /^\/api\/messages\/([^/]+)$/, ([id], body) => mail.updateMessage(messageId(id), body)],
    ['POST', /^\/api\/drafts$/, (_, body) => mail.createComposition(body.accountId)],
    ['PUT', /^\/api\/messages\/([^/]+)\/draft$/, ([id], body) => {if(!Number.isSafeInteger(body.baseVersion) || body.baseVersion<0) throw badRequest('Version du brouillon requise');return mail.saveDraft(messageId(id),body);}],
    ['POST', /^\/api\/messages\/([^/]+)\/send\/preview$/, async ([id], body, session) => {
      if(!Number.isSafeInteger(body.baseVersion) || body.baseVersion<0) throw badRequest('Version du brouillon requise');
      const preview={...await mail.preview(messageId(id),body),requiresConfirmation:store.requiresDraftReview(messageId(id))};
      return auth?access.rememberPreview(session,messageId(id),body,preview):preview;
    }],
    ['POST', /^\/api\/messages\/([^/]+)\/send$/, ([id], body, session) => {
      if(body.direct===true && store.requiresDraftReview(messageId(id)))throw new HttpError(409,'Ce brouillon utilise une proposition IA : valide son aperçu exact.','preview_required');
      if(auth) access.consumePreview(session,messageId(id),body);
      return mail.send(messageId(id), body);
    }],
    ['POST', /^\/api\/folders$/, (_, body) => store.createFolder(body)],
    ['PATCH', /^\/api\/contacts\/([^/]+)$/, ([id], body) => store.updateContact(id, body)],
    ['POST', /^\/api\/accounts\/([^/]+)\/contacts\/import$/, ([id]) => {const aid=accountId(id);return importAddressBook({store,provider:mail.providerFor(aid),accountId:aid});}],
    ['GET', /^\/api\/profiles\/([^/]+)\/contact-history$/, ([p]) => store.contactHistory(p)],
    ['GET', /^\/api\/profiles\/([^/]+)\/contact-duplicates$/, ([p]) => store.contactDuplicates(p)],
    ['POST', /^\/api\/profiles\/([^/]+)\/contact-duplicates\/scan$/, async ([p]) => {await store.scanContactDuplicates(p);return store.contactDuplicates(p);}],
    ['POST', /^\/api\/profiles\/([^/]+)\/contact-duplicates\/([^/]+)\/dismiss$/, ([p,id],body) => store.dismissContactDuplicate(p,id,body)],
    ['POST', /^\/api\/profiles\/([^/]+)\/contact-duplicates\/([^/]+)\/merge$/, ([p,id],body) => store.mergeContactDuplicate(p,id,body)],
    ['GET', /^\/api\/profiles\/([^/]+)\/contacts\/([^/]+)$/, ([p,id],body,session,url) => store.person(p,id,{offset:Number(url.searchParams.get('offset') || 0),limit:50})],
    ['POST', /^\/api\/profiles\/([^/]+)\/contacts\/([^/]+)\/identities$/, ([p,id],body) => store.addContactIdentity(p,id,body)],
    ['DELETE', /^\/api\/profiles\/([^/]+)\/contacts\/([^/]+)\/identities$/, ([p,id],body) => store.removeContactIdentity(p,id,body)],
    ['POST', /^\/api\/profiles\/([^/]+)\/contacts\/([^/]+)\/merge$/, ([p,id],body) => {if(typeof body.sourceId!=='string')throw badRequest('Contact source requis');return store.mergeContacts(p,id,body.sourceId);}],
    ['POST', /^\/api\/profiles\/([^/]+)\/contact-merges\/([^/]+)\/undo$/, ([p,id]) => store.undoContactMerge(p,id)],
    ['POST', /^\/api\/profiles\/([^/]+)\/accounts$/, ([id], body) => store.connectAccount(id, body)],
    ['POST', /^\/api\/ai\/summary$/, async (_, body) => {
      return assistant.run('summary', messageId(body.messageId), body);
    }],
    ['POST', /^\/api\/ai\/draft$/, async (_, body) => {
      return assistant.run('draft', messageId(body.messageId), body);
    }],
    ['POST', /^\/api\/ai\/classify$/, (_, body) => assistant.run('classify', messageId(body.messageId), body)],
    ['POST', /^\/api\/ai\/classify\/apply$/, (_, body) => assistant.apply(messageId(body.messageId), body)],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      for(const [name,value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name,value);
      if (allowedHosts && !allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Hôte non autorisé', 'forbidden_host');
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;
      if(auth && await auth.handle(req,res,url)) return;
      if(push && await push.handle(req,res,url,readJson,send))return;
      if(!auth && pathname==='/auth/session' && req.method==='GET') return send(res,200,{enabled:false,authenticated:false});
      // Ressources publiques fixes : uniquement du code et des images génériques, jamais index.html ni contenu privé.
      const publicLogin=['/login','/js/login.js','/js/app.js','/js/api.js','/js/views.js','/js/dom.js','/js/constants.js','/js/pwa.js','/js/live.js','/js/network.js','/styles.css','/sw.js','/manifest.webmanifest','/offline.html','/fonts/inter-latin-wght-normal.woff2','/fonts/jetbrains-mono-latin-wght-normal.woff2'].includes(pathname) || /^\/icons\/[a-zA-Z0-9_-]+\.(png|svg)$/.test(pathname);
      const publicHealth=['/api/health','/api/ready'].includes(pathname) && req.method==='GET';
      if(pathname==='/api/ready' && req.method==='GET') {const value=readiness?readiness():{ok:true};return send(res,value.ok?200:503,{ok:!!value.ok});}
      let session=null;
      if(auth && !publicLogin && !publicHealth) {
        try {session=auth.requireSession(req,{touch:pathname!=='/api/events'});}catch(error) {
          if(pathname==='/' && ['GET','HEAD'].includes(req.method)) return redirect(res,'/login');
          throw error;
        }
        access.limit(session,pathname,req.method);
        if(!['GET','HEAD'].includes(req.method)) auth.assertMutation(req,session);
        if(/^(\/api\/whatsapp\/links|\/api\/oauth\/|.*\/disconnect$)/.test(pathname)) auth.assertRecent(session);
      }
      if(publicLogin) {
        if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Méthode non autorisée','method_not_allowed');
        return await serveStatic(req,res,pathname==='/login'?'/login.html':pathname);
      }
      if (pathname === '/api/events') {
        if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée', 'method_not_allowed');
        return live.connect(req, res, session);
      }
      if(req.method==='POST' && /^\/api\/oauth\/(google|microsoft)\/start$/.test(pathname)) {
        const body=await readJson(req),start=new URL('/oauth/'+pathname.split('/')[3]+'/start','http://localhost');
        for(const [key,value] of Object.entries(body)) if(['profile','name','win','perms','account'].includes(key)) start.searchParams.set(key,String(value));
        return await oauthRoute(start.pathname,start,res,session,true,req);
      }
      if (pathname.startsWith('/oauth/')) {
        if(auth && pathname.endsWith('/start')) throw new HttpError(405,'Utilise le parcours de connexion protégé.','method_not_allowed');
        if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée', 'method_not_allowed');
        return await oauthRoute(pathname,url,res,session,false,req);
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
      send(res, 200, await route[2](params,body,session,url));
    } catch (e) {
      const known = e instanceof HttpError;
      if (!known) console.error('Requête interrompue : erreur interne.');
      send(res, known ? e.status : 500, { error: { code: known ? e.code : 'internal', message: known ? e.message : 'Erreur interne' } });
    }
  });
  server.closeLiveUpdates = () => live.close();
  server.once('close', () => live.close());
  return server;
}
