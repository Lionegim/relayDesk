// Historique WhatsApp : import complet de la fenêtre, demande au téléphone et suivi honnête. Faux socket uniquement :
// aucune connexion, aucun QR réel, aucun message envoyé à un correspondant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, PEER, tick, until, msg, setupWhatsApp, linkedAccount } from './whatsapp-helpers.js';

const peer = n => `3361000${String(n).padStart(4, '0')}@s.whatsapp.net`;
const threadOf = (store, accountId, jid = PEER) => store.db.prepare('SELECT * FROM messages WHERE account_id = ? AND external_id = ?').get(accountId, jid);
const FAST = { historyIdleMs: 150, fullResponseMs: 40, onDemandSpacingMs: 1, requestCooldownMs: 0, onDemandCount: 3 };

// Ajoute au faux socket les demandes au téléphone (messages de protocole vers soi-même), enregistrées sans effet.
function spyRequests(sock) {
  sock.pdo = [];
  sock.fetches = [];
  sock.sendPeerDataOperationMessage = async m => { sock.pdo.push(m); return `PDO${sock.pdo.length}`; };
  sock.fetchMessageHistory = async (count, key, ts) => { sock.fetches.push({ count, key, ts }); return `OD${sock.fetches.length}`; };
  return sock;
}
// Fin de l'historique de liaison (pause signalée) : une nouvelle demande devient possible.
const endLinkHistory = async sock => { sock.emit('messaging-history.status', { syncType: 2, status: 'paused', explicit: false }); await tick(); };
const fullResponse = (sock, code) => ({
  type: 'notify',
  messages: [{
    key: { remoteJid: `${ME}@s.whatsapp.net`, id: 'RESP1', fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000),
    message: { protocolMessage: { type: 17, peerDataOperationRequestResponseMessage: {
      peerDataOperationRequestType: 6,
      peerDataOperationResult: [{ fullHistorySyncOnDemandRequestResponse: { requestMetadata: { requestId: sock.pdo[0].fullHistorySyncOnDemandRequest.requestMetadata.requestId }, responseCode: code } }],
    } } },
  }],
});

test('lot fusionné : tous les messages de la fenêtre importés, sans troncature ni plafond', async () => {
  const ctx = await setupWhatsApp({ timing: { ...FAST, historyIdleMs: 10000 } });
  const { accountId, sock } = await linkedAccount(ctx, { messages: [] });
  // 6 000 messages sur 300 discussions, du plus récent au plus ancien (ordre Baileys), dont 250 dans une seule.
  const messages = [];
  for (let i = 0; i < 250; i++) messages.push(msg(`B${i}`, `Message ${i}`, { ago: 60 + i }));
  for (let i = 0; i < 5750; i++) messages.push(msg(`M${i}`, `Texte ${i}`, { chat: peer(i % 300), ago: 120 + i * 10 }));
  messages.push(msg('OLD', 'Hors fenêtre', { chat: peer(1), ago: 8 * 86400 }));
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages, syncType: 3, progress: 40 });
  await until(() => ctx.store.countThreads(accountId).threads === 301, 5000);
  assert.equal(threadOf(ctx.store, accountId).message_count, 250, 'tous les messages de la discussion, au-delà de 200');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages WHERE account_id = ?').get(accountId).n, 6000);
  const h = ctx.wa.sync.progress(accountId).history;
  assert.equal(h.state, 'receiving');
  assert.equal(h.progress, 40);
  assert.ok(!JSON.stringify(h).includes('@'), 'aucun JID exposé');
  ctx.wa.sync.stop();
});

test('liaison : isLatest et 8 s ne valent pas fin ; fin explicite, pause ou délai sans lot', async () => {
  const ctx = await setupWhatsApp({ timing: FAST });
  const { linkId, accountId, sock } = await linkedAccount(ctx);
  await new Promise(r => setTimeout(r, 70));
  assert.equal(ctx.wa.linkStatus(linkId).status, 'connected', 'la connexion est établie');
  let p = ctx.wa.sync.progress(accountId);
  assert.equal(p.history.state, 'receiving', 'premier lot marqué isLatest : historique encore en cours');
  assert.equal(p.status, 'syncing');
  assert.equal(p.history.source, 'link');
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages: [], syncType: 3, progress: 100 });
  sock.emit('messaging-history.status', { syncType: 3, status: 'paused' });
  await tick();
  assert.equal(ctx.wa.sync.progress(accountId).history.state, 'receiving', 'RECENT ne termine pas la liaison étendue');
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages: [msg('A2', 'Suite', { ago: 30 })], syncType: 2, progress: 100 });
  await tick();
  p = ctx.wa.sync.progress(accountId);
  assert.deepEqual([p.history.state, p.status, p.history.batches, p.history.messages], ['complete', 'idle', 3, 2]);

  // Pause signalée par Baileys (aucune tranche récente depuis 2 min) : partiel.
  const other = await setupWhatsApp({ timing: FAST });
  const b = await linkedAccount(other);
  b.sock.emit('messaging-history.status', { syncType: 2, status: 'paused', explicit: false });
  await tick();
  assert.equal(other.wa.sync.progress(b.accountId).history.state, 'partial');
  // L'amorçage initial seul ne couvre pas la fenêtre : il ne termine rien.
  const third = await setupWhatsApp({ timing: FAST });
  const c = await linkedAccount(third);
  c.sock.emit('messaging-history.status', { syncType: 0, status: 'complete', explicit: true });
  await tick();
  assert.equal(third.wa.sync.progress(c.accountId).history.state, 'receiving');
  await new Promise(r => setTimeout(r, 200));
  const h = third.wa.sync.progress(c.accountId);
  assert.equal(h.history.state, 'partial', 'délai sans nouveau lot');
  assert.match(h.history.reason, /incomplet/);
  assert.equal(h.status, 'idle');
  for (const x of [ctx, other, third]) x.wa.sync.stop();
});

test('syncNow : demande bornée à 7 jours, repli par discussion, aucun envoi', async () => {
  const ctx = await setupWhatsApp({ timing: FAST });
  const { accountId, sock } = await linkedAccount(ctx, { messages: [msg('A1', 'Bonjour', { ago: 3600 }), msg('A0', 'Plus ancien', { ago: 7200, fromMe: true })] });
  spyRequests(sock);
  await endLinkHistory(sock);
  await ctx.wa.sync.syncNow(accountId);
  assert.equal(sock.pdo.length, 1);
  const req = sock.pdo[0];
  assert.equal(req.peerDataOperationRequestType, 6);
  assert.equal(req.fullHistorySyncOnDemandRequest.historySyncConfig.fullSyncDaysLimit, 7);
  assert.match(req.fullHistorySyncOnDemandRequest.requestMetadata.requestId, /^[0-9a-f-]{36}$/);
  let h = ctx.wa.sync.progress(accountId).history;
  assert.deepEqual([h.state, h.source, h.mode], ['waiting', 'request', 'full']);
  await ctx.wa.sync.syncNow(accountId);
  assert.equal(sock.pdo.length, 1, 'pas de nouvelle demande tant que la précédente est en cours');

  // Le téléphone refuse l'historique complet : repli discussion par discussion depuis le plus ancien message connu.
  sock.emit('messages.upsert', fullResponse(sock, 4));
  await until(() => sock.fetches.length === 1);
  assert.deepEqual(sock.fetches[0].key, { remoteJid: PEER, id: 'A1', fromMe: false });
  h = ctx.wa.sync.progress(accountId).history;
  assert.equal(h.mode, 'chats');
  assert.match(h.reason, /ne propose pas/);
  // Lot à la demande plein et encore dans la fenêtre : un tour de plus, depuis le nouveau plus ancien.
  sock.emit('messaging-history.set', { chats: [], contacts: [], syncType: 6,
    messages: [msg('C1', 'a', { ago: 9000 }), msg('C2', 'b', { ago: 9100 }), msg('C3', 'c', { ago: 9200 })] });
  await until(() => sock.fetches.length === 2);
  assert.equal(sock.fetches[1].key.id, 'C3');
  assert.equal(threadOf(ctx.store, accountId).message_count, 5);
  await new Promise(r => setTimeout(r, 200));
  h = ctx.wa.sync.progress(accountId).history;
  assert.equal(h.state, 'partial', 'jamais « complet » sans signal explicite du téléphone');
  assert.equal(sock.sent.length, 0, 'aucun message envoyé à un correspondant');
  ctx.wa.sync.stop();
});

test('syncNow : sans réponse à la demande complète, repli ; hors ligne, demande après reconnexion', async () => {
  const ctx = await setupWhatsApp({ timing: FAST });
  const { accountId, sock } = await linkedAccount(ctx);
  spyRequests(sock);
  await endLinkHistory(sock);
  await ctx.wa.sync.syncNow(accountId);
  await until(() => sock.fetches.length === 1);
  assert.match(ctx.wa.sync.progress(accountId).history.reason, /Pas de réponse/);
  await new Promise(r => setTimeout(r, 200));

  // Coupure : la demande attend la reconnexion de la session enregistrée, sans QR.
  sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await tick();
  await ctx.wa.sync.syncNow(accountId);
  let h = ctx.wa.sync.progress(accountId).history;
  assert.equal(h.state, 'waiting');
  assert.match(h.reason, /Reconnexion/);
  await until(() => ctx.sockets.list.length === 3);
  const next = spyRequests(ctx.sockets.last());
  next.user = { id: `${ME}:7@s.whatsapp.net` };
  next.emit('connection.update', { connection: 'open' });
  await until(() => next.pdo.length === 1);
  h = ctx.wa.sync.progress(accountId).history;
  assert.equal(h.mode, 'full');
  ctx.wa.sync.stop();
});

test('syncNow : purge de la fenêtre et reconstruction de tous les fils', async () => {
  const ctx = await setupWhatsApp({ timing: FAST });
  const { accountId, sock } = await linkedAccount(ctx);
  spyRequests(sock);
  await endLinkHistory(sock);
  // Copie ancienne restée en base (fenêtre glissante) : elle apparaît dans le fil à la reconstruction suivante.
  ctx.store.waAddMessages(accountId, [{ chatJid: PEER, msgId: 'VIEUX', fromMe: false, ts: Date.now() - 9 * 86400000, text: 'Ancien' }]);
  sock.emit('messages.upsert', { type: 'notify', messages: [msg('N1', 'Nouveau', { ago: 5 })] });
  await tick();
  assert.equal(threadOf(ctx.store, accountId).message_count, 3);
  await ctx.wa.sync.syncNow(accountId);
  const t = threadOf(ctx.store, accountId);
  assert.equal(t.message_count, 2);
  assert.ok(!t.trail.includes('Ancien'), 'ancienne copie retirée du fil');
  ctx.wa.sync.stop();
});

test('déconnexion pendant un gros lot : traitement interrompu, rien de réécrit', async () => {
  const ctx = await setupWhatsApp({ timing: FAST });
  const { accountId, sock } = await linkedAccount(ctx);
  const messages = Array.from({ length: 4000 }, (_, i) => msg(`X${i}`, `T${i}`, { chat: peer(i % 50), ago: 100 + i }));
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages, syncType: 3 });
  await ctx.wa.disconnect(accountId);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(ctx.store.hasAccount(accountId), false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_messages WHERE account_id = ?').get(accountId).n, 0);
  assert.equal(ctx.wa.sync.progress(accountId), null);
  ctx.wa.sync.stop();
});

test('fin honnête : jalon seul, mauvais type, progression d’un autre lot, tranche en échec', async () => {
  // Demande bornée (mode full) : un lot RECENT à 100 % ou un jalon « complete » ne terminent pas le cycle.
  const ctx = await setupWhatsApp({ timing: { ...FAST, fullResponseMs: 5000, historyIdleMs: 10000 } });
  const { accountId, sock } = await linkedAccount(ctx);
  spyRequests(sock);
  await endLinkHistory(sock);
  await ctx.wa.sync.syncNow(accountId);
  sock.emit('messaging-history.status', { syncType: 2, status: 'complete', explicit: true });
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages: [msg('R1', 'récent', { ago: 50 })], syncType: 3, progress: 100 });
  await tick();
  assert.equal(ctx.wa.sync.progress(accountId).history.state, 'receiving');
  // Lot FULL sans progression : n'hérite pas du 100 % d'un autre lot.
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages: [msg('F1', 'complet', { ago: 60 })], syncType: 2 });
  await tick();
  assert.equal(ctx.wa.sync.progress(accountId).history.state, 'receiving');
  // Gros lot FULL final à 100 % : complet seulement après son import, avec ses messages comptés.
  const big = Array.from({ length: 2501 }, (_, i) => msg(`G${i}`, `t${i}`, { chat: peer(i % 40), ago: 100 + i }));
  sock.emit('messaging-history.status', { syncType: 2, status: 'complete', explicit: true });
  sock.emit('messaging-history.set', { chats: [], contacts: [], messages: big, syncType: 2, progress: 100 });
  assert.equal(ctx.wa.sync.progress(accountId).history.state, 'receiving', 'pas de fin avant l’import');
  await until(() => ctx.wa.sync.progress(accountId).history.state === 'complete', 5000);
  const p = ctx.wa.sync.progress(accountId);
  assert.equal(p.history.messages, 2501 + 2);
  assert.equal(p.total, ctx.store.countThreads(accountId).threads);
  assert.ok(p.total >= 41);
  ctx.wa.sync.stop();

  // Échec de la deuxième tranche : tranches déjà enregistrées visibles, cycle partiel, jamais complet ensuite.
  const bad = await setupWhatsApp({ timing: { ...FAST, fullResponseMs: 5000 } });
  const b = await linkedAccount(bad);
  spyRequests(b.sock);
  await endLinkHistory(b.sock);
  await bad.wa.sync.syncNow(b.accountId);
  const add = bad.store.waAddMessages.bind(bad.store);
  let calls = 0;
  bad.store.waAddMessages = (id, list) => { if (++calls === 2) throw new Error('disque'); return add(id, list); };
  const lot = Array.from({ length: 1001 }, (_, i) => msg(`E${i}`, `t${i}`, { chat: peer(i % 5), ago: 100 + i }));
  b.sock.emit('messaging-history.set', { chats: [], contacts: [], messages: lot, syncType: 2 });
  await until(() => bad.wa.sync.progress(b.accountId).history.state === 'partial', 5000);
  bad.store.waAddMessages = add;
  assert.ok(bad.store.countThreads(b.accountId).threads >= 5, 'tranche déjà enregistrée reconstruite');
  b.sock.emit('messaging-history.set', { chats: [], contacts: [], messages: [], syncType: 2, progress: 100 });
  await tick();
  const h = bad.wa.sync.progress(b.accountId).history;
  assert.equal(h.state, 'partial');
  assert.match(h.reason, /n’a pas pu être importée/);
  assert.ok(!/disque/.test(h.reason), 'raison publique générique');
  bad.wa.sync.stop();
});

test('lots avant identité : perte marquée avant un premier lot final et petits lots en échec interceptés',async()=>{
 const ctx=await setupWhatsApp({timing:{...FAST,historyIdleMs:10000}});
 const {accountId}=await ctx.wa.startLink({profileId:'perso',name:'Téléphone'});await tick();
 const sock=ctx.sockets.last();sock.user={id:`${ME}:1@s.whatsapp.net`};sock.auth.state.creds.me=sock.user;sock.auth.state.creds.registered=true;sock.emit('creds.update',{});
 sock.emit('messaging-history.set',{chats:[],contacts:[],messages:[],syncType:2,progress:100});
 for(let i=0;i<200;i++)sock.emit('messages.upsert',{type:'append',messages:[]});
 sock.emit('connection.update',{connection:'open'});await tick();
 const h=ctx.wa.sync.progress(accountId).history;assert.equal(h.state,'partial');assert.match(h.reason,/ignorée/);
 ctx.wa.sync.stop();

 const bad=await setupWhatsApp({timing:{...FAST,historyIdleMs:10000}}),b=await linkedAccount(bad);
 const add=bad.store.waAddMessages.bind(bad.store);bad.store.waAddMessages=()=>{throw new Error('disque')};
 assert.doesNotThrow(()=>b.sock.emit('messaging-history.set',{chats:[],contacts:[],messages:[msg('fail','Erreur')],syncType:3}));
 bad.store.waAddMessages=add;b.sock.emit('messaging-history.set',{chats:[],contacts:[],messages:[],syncType:2,progress:100});
 assert.equal(bad.wa.sync.progress(b.accountId).history.state,'partial');bad.wa.sync.stop();
});

test('media recovery replays newest to oldest, imports gaps between retained text, and deduplicates replay',async t=>{
 const c=await setupWhatsApp({timing:FAST});t.after(()=>{c.wa.sync.stop();c.db.close();});
 const latest=msg('latest','Dernier texte',{ago:60}),oldest=msg('oldest','Premier texte',{ago:8000});
 const {accountId,sock}=await linkedAccount(c,{messages:[oldest,latest]});spyRequests(sock);await endLinkHistory(sock);await c.wa.sync.syncNow(accountId);sock.emit('messages.upsert',fullResponse(sock,4));await until(()=>sock.fetches.length===1);
 assert.equal(sock.fetches[0].key.id,'latest');
 const photo={...msg('missingPhoto','',{ago:1000}),message:{imageMessage:{mimetype:'image/jpeg',fileLength:100,caption:'Photo retrouvée'}}};
 const gif={...msg('missingGif','',{ago:1500}),message:{videoMessage:{mimetype:'video/mp4',fileLength:200,gifPlayback:true}}};
 const page={syncType:6,chats:[],contacts:[],messages:[photo,gif,oldest]};sock.emit('messaging-history.set',page);await until(()=>sock.fetches.length===2);
 assert.equal(sock.fetches[1].key.id,'oldest');assert.equal(c.db.prepare('SELECT count(*) n FROM whatsapp_media').get().n,2);
 sock.emit('messaging-history.set',page);await tick();assert.equal(sock.fetches.length,2,'repeated cursor does not loop');assert.equal(c.db.prepare('SELECT count(*) n FROM whatsapp_messages WHERE account_id=?').get(accountId).n,4);assert.equal(c.db.prepare('SELECT count(*) n FROM whatsapp_media').get().n,2);assert.deepEqual(c.wa.sync.progress(accountId).media,{photos:1,gifs:1});assert.equal(sock.sent.length,0);
});

test('raw history pages advance across unsupported content but stop after the seven-day boundary',async t=>{
 const c=await setupWhatsApp({timing:FAST});t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId,sock}=await linkedAccount(c);spyRequests(sock);await endLinkHistory(sock);await c.wa.sync.syncNow(accountId);sock.emit('messages.upsert',fullResponse(sock,4));await until(()=>sock.fetches.length===1);
 const audio=(id,ago)=>({...msg(id,'',{ago}),message:{audioMessage:{mimetype:'audio/ogg',fileLength:500}}});
 sock.emit('messaging-history.set',{syncType:6,chats:[],contacts:[],messages:[audio('a',4000),audio('b',5000),audio('c',6000)]});await until(()=>sock.fetches.length===2);assert.equal(sock.fetches[1].key.id,'c');
 sock.emit('messaging-history.set',{syncType:6,chats:[],contacts:[],messages:[audio('d',7000),audio('e',8*86400),audio('f',9*86400)]});await tick();assert.equal(sock.fetches.length,2);assert.equal(c.db.prepare('SELECT count(*) n FROM whatsapp_messages WHERE account_id=?').get(accountId).n,1);assert.equal(sock.sent.length,0);
});

test('unrelated batches and accepted full requests without data cannot suppress chat replay',async t=>{
 for(const accepted of [false,true]){
 const c=await setupWhatsApp({timing:FAST});t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId,sock}=await linkedAccount(c);spyRequests(sock);await endLinkHistory(sock);await c.wa.sync.syncNow(accountId);
 if(accepted)sock.emit('messages.upsert',fullResponse(sock,0));
 sock.emit('messaging-history.set',{syncType:3,chats:[],contacts:[],messages:[msg('incidental','Texte')],progress:40});await until(()=>sock.fetches.length===1);assert.equal(c.wa.sync.progress(accountId).history.mode,'chats');assert.equal(sock.sent.length,0);
 }
});

test('hanging chat requests time out, expose failures and continue to the next conversation',async t=>{
 const c=await setupWhatsApp({timing:{...FAST,requestTimeoutMs:20}});t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId,sock}=await linkedAccount(c,{messages:[msg('one','A'),msg('two','B',{chat:peer(2)})]});spyRequests(sock);
 let count=0;sock.fetchMessageHistory=()=>{count++;return count===1?new Promise(()=>{}):Promise.resolve('ok');};await endLinkHistory(sock);await c.wa.sync.syncNow(accountId);sock.emit('messages.upsert',fullResponse(sock,4));await until(()=>count===2);const h=c.wa.sync.progress(accountId).history;assert.equal(h.requests,2);assert.equal(h.requestFailures,1);assert.equal(sock.sent.length,0);
});

test('newer raw chat anchors recover the omitted tail and media-only conversations without storing excluded content',async t=>{
 const c=await setupWhatsApp({timing:FAST});t.after(()=>{c.wa.sync.stop();c.db.close();});const {accountId,sock}=await linkedAccount(c,{messages:[msg('retained','Old text',{ago:9000})]});spyRequests(sock);
 const newer={...msg('rawHead','',{ago:60}),message:{audioMessage:{mimetype:'audio/ogg'}}};const unknown={...msg('unknownHead','',{chat:peer(3),ago:60}),message:{audioMessage:{mimetype:'audio/ogg'}}};
 const protectedHead={...msg('viewOnce','',{chat:peer(4),ago:60}),message:{viewOnceMessage:{message:{imageMessage:{mimetype:'image/jpeg'}}}}};
 sock.emit('chats.update',[{id:PEER,messages:[{message:newer}]},{id:peer(3),messages:[{message:unknown}]},{id:peer(4),messages:[{message:protectedHead}]}]);await tick();await endLinkHistory(sock);await c.wa.sync.syncNow(accountId);sock.emit('messages.upsert',fullResponse(sock,4));await until(()=>sock.fetches.length===2);
 assert.deepEqual(sock.fetches.map(x=>x.key.id),['rawHead','unknownHead']);assert.equal(c.db.prepare('SELECT count(*) n FROM whatsapp_messages WHERE account_id=?').get(accountId).n,1);assert.equal(sock.sent.length,0);
});
