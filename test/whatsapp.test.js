import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, PEER, tick, until, closed, msg, setupWhatsApp, pairAndOpen, linkedAccount } from './whatsapp-helpers.js';
import { parseMessage, directJid, textOf } from '../src/providers/whatsapp/parse.js';

const threadOf = (store, accountId, jid = PEER) => store.db.prepare('SELECT * FROM messages WHERE account_id = ? AND external_id = ?').get(accountId, jid);

test('filtrage : conversations directes et texte seulement', () => {
  assert.equal(directJid('33612345678:12@s.whatsapp.net'), '33612345678@s.whatsapp.net');
  assert.equal(directJid('123456789012@lid'), '123456789012@lid');
  for (const jid of ['120363000@g.us', 'status@broadcast', '1203@newsletter', 'x@s.whatsapp.net', null]) assert.equal(directJid(jid), null);
  assert.equal(textOf({ extendedTextMessage: { text: ' Lien ' } }), 'Lien');
  assert.equal(textOf({ imageMessage: { caption: 'Photo' } }), null);
  assert.equal(textOf({ ephemeralMessage: { message: { conversation: 'x' } } }), null);
  assert.equal(textOf({ viewOnceMessageV2: { message: { imageMessage: { caption: 'x' } } } }), null);
  assert.equal(textOf({ extendedTextMessage: { text: 'x', contextInfo: { expiration: 86400 } } }), null);
  assert.equal(textOf({ reactionMessage: { text: '👍' } }), null);
  assert.equal(textOf({ protocolMessage: { type: 0 } }), null);
  const since = Date.now() - 7 * 86400000;
  assert.equal(parseMessage(msg('a', 'vieux', { ago: 8 * 86400 }), { since }), null);
  assert.equal(parseMessage(msg('a', 'groupe', { chat: '1203@g.us' }), { since }), null);
  assert.equal(parseMessage({ ...msg('a', 'x'), messageTimestamp: { low: Math.floor(Date.now() / 1000), toNumber() { return this.low; } } }, { since }).text, 'x');
});

test('liaison : QR en mémoire, validation, identité, import 7 jours', async () => {
  const ctx = await setupWhatsApp();
  const { store, wa, sockets, db, logs } = ctx;
  const { linkId, accountId } = await wa.startLink({ profileId: 'perso', name: 'WhatsApp perso', windowDays: 7 });
  assert.match(linkId, /^[0-9a-f-]{36}$/);
  assert.equal(store.getAccount(accountId).status, 'En attente du QR');
  assert.equal(wa.linkStatus(linkId).status, 'starting');
  await tick();
  sockets.last().emit('connection.update', { qr: 'faux-qr-de-test' });
  await until(() => wa.linkStatus(linkId).status === 'qr');
  const st = wa.linkStatus(linkId);
  assert.equal(st.status, 'qr');
  assert.match(st.qrDataUrl, /^data:image\/png;base64,/);
  await assert.rejects(() => wa.startLink({ profileId: 'perso', name: 'WhatsApp perso' }), { status: 409 });

  const sock = await pairAndOpen(ctx);
  assert.equal(sockets.list.length, 2, 'redémarrage demandé par WhatsApp après le QR');
  assert.equal(wa.cancelLink(linkId).cancelled, false, 'fermer la fenêtre après validation ne déconnecte rien');
  assert.equal(store.getAccount(accountId).address, `+${ME}`);
  assert.equal(store.getAccount(accountId).status, 'Connecté');
  assert.equal(wa.linkStatus(linkId).qrDataUrl, undefined);

  const now = Math.floor(Date.now() / 1000);
  sock.emit('messaging-history.set', {
    chats: [{ id: PEER, unreadCount: 1 }, { id: '33600000001@s.whatsapp.net', ephemeralExpiration: 604800 }],
    contacts: [{ id: PEER, name: 'Claire Dubois' }],
    messages: [
      msg('A1', 'Bonjour, on se voit jeudi ?', { ago: 7200 }),
      msg('A2', 'Oui, 10h.', { fromMe: true, ago: 3600 }),
      msg('A2', 'Oui, 10h.', { fromMe: true, ago: 3600 }), // doublon
      msg('OLD', 'Trop ancien', { ago: 9 * 86400 }),
      msg('G1', 'Groupe', { chat: '120363000@g.us' }),
      msg('S1', 'Statut', { chat: 'status@broadcast' }),
      msg('N1', 'Chaîne', { chat: '1203@newsletter' }),
      msg('E1', 'Éphémère', { chat: '33600000001@s.whatsapp.net' }),
      { key: { remoteJid: PEER, id: 'V1', fromMe: false }, messageTimestamp: now, message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'vue unique' } } } } },
    ],
    isLatest: true,
  });
  await tick();
  const t = threadOf(store, accountId);
  assert.equal(t.from_name, 'Moi (à Claire Dubois)');
  assert.equal(t.body, 'Oui, 10h.');
  assert.equal(t.message_count, 2);
  assert.equal(t.unread, 1);
  assert.equal(t.channel, 'whatsapp');
  assert.deepEqual(JSON.parse(t.trail).map(x => x.body), ['Bonjour, on se voit jeudi ?']);
  assert.equal(store.countThreads(accountId).threads, 2);
  const done = wa.linkStatus(linkId);
  assert.deepEqual({ status: done.status, threads: done.threads, messages: done.messages }, { status: 'connected', threads: 2, messages: 3 });
  assert.deepEqual(wa.sync.permissions(accountId), ['read', 'drafts', 'send']);
  assert.equal(wa.sync.progress(accountId).status, 'syncing', 'isLatest seul ne prouve pas la fin de l’historique');
  const contact = db.prepare('SELECT * FROM contacts WHERE account_id = ?').get(accountId);
  assert.equal(contact.name, 'Claire Dubois');
  assert.equal(contact.title, '+33698765432');

  // Clés Signal (rotation) et identifiants : chiffrés, jamais en clair, jamais dans les journaux.
  await sock.auth.state.keys.set({ 'pre-key': { 1: { public: Buffer.from('pub'), private: Buffer.from('cle-privee-test') } } });
  await sock.auth.state.keys.set({ 'pre-key': { 1: { public: Buffer.from('pub2'), private: Buffer.from('cle-privee-2') } } });
  assert.equal((await sock.auth.state.keys.get('pre-key', ['1']))['1'].private.toString(), 'cle-privee-2');
  const rows = db.prepare('SELECT * FROM whatsapp_auth WHERE account_id = ?').all(accountId);
  assert.ok(rows.some(r => r.kind === 'creds') && rows.some(r => r.kind === 'pre-key'));
  const dump = rows.map(r => Buffer.from(r.ciphertext).toString('latin1')).join('');
  for (const secret of ['cle-privee', 'noiseKey', 'faux-qr-de-test', ME]) assert.ok(!dump.includes(secret));
  assert.ok(!JSON.stringify(store.snapshot()).includes('faux-qr'));
  assert.ok(!logs.join('\n').includes('faux-qr'));
  await sock.auth.state.keys.set({ 'pre-key': { 1: null } });
  assert.equal((await sock.auth.state.keys.get('pre-key', ['1']))['1'], null);
  wa.sync.stop();
});

test('annulation avant validation, liaison expirée, doublons', async () => {
  const ctx = await setupWhatsApp({ timing: { linkTtlMs: 80 } });
  const { store, wa, sockets } = ctx;
  const a = await wa.startLink({ profileId: 'perso', name: 'WA test' });
  await tick();
  sockets.last().emit('connection.update', { qr: 'faux-qr' });
  await until(() => wa.linkStatus(a.linkId).status === 'qr');
  assert.deepEqual(wa.cancelLink(a.linkId), { cancelled: true });
  assert.equal(store.hasAccount(a.accountId), false, 'compte provisoire retiré');
  assert.equal(sockets.last().ended, true);
  assert.equal(wa.linkStatus(a.linkId).status, 'error');
  assert.throws(() => wa.linkStatus('00000000-0000-4000-8000-000000000000'), { status: 404 });
  assert.throws(() => wa.linkStatus('../x'), { status: 404 });

  const b = await wa.startLink({ profileId: 'perso', name: 'WA test' });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(wa.linkStatus(b.linkId).status, 'error');
  assert.equal(store.hasAccount(b.accountId), false);
  await assert.rejects(() => wa.startLink({ profileId: 'perso', name: 'Gmail perso' }), { status: 400 }, 'nom d’un compte Gmail');
  await assert.rejects(() => wa.startLink({ profileId: 'perso', name: 'X', windowDays: 400 }), { status: 400 });
  await assert.rejects(() => wa.startLink({ profileId: 'nope', name: 'X' }), { status: 404 });
  wa.sync.stop();
});

test('identité : un autre téléphone ne remplace jamais le compte', async () => {
  const ctx = await setupWhatsApp();
  const { store, wa, sockets } = ctx;
  const { accountId, sock } = await linkedAccount(ctx);
  // Appareil retiré depuis le téléphone : à reconnecter, session effacée.
  sock.emit('connection.update', closed(401));
  await tick();
  assert.equal(store.getAccount(accountId).status, 'À reconnecter');
  assert.deepEqual(wa.sync.permissions(accountId), []);
  await assert.rejects(() => wa.startLink({ profileId: 'perso', name: 'WhatsApp perso' }), { status: 409 }, 'compte existant : reconnexion explicite');
  await assert.rejects(() => wa.startLink({ profileId: 'atlas', name: 'WhatsApp perso', accountId }), { status: 400 });

  const { linkId } = await wa.startLink({ profileId: 'perso', name: 'WhatsApp perso', accountId });
  await tick();
  const other = await pairAndOpen(ctx, { phone: '33711111111' });
  assert.equal(other.loggedOut, true, 'appareil lié au mauvais numéro retiré');
  const st = wa.linkStatus(linkId);
  assert.equal(st.status, 'error');
  assert.match(st.error, /ne correspond pas/);
  assert.equal(store.getAccount(accountId).address, `+${ME}`);
  assert.equal(threadOf(store, accountId).message_count, 1, 'données du compte conservées');

  // Même numéro : reconnexion acceptée.
  const again = await wa.startLink({ profileId: 'perso', name: 'WhatsApp perso', accountId });
  await tick();
  await pairAndOpen(ctx);
  assert.equal(store.getAccount(accountId).status, 'Connecté');
  assert.equal(wa.linkStatus(again.linkId).status, 'syncing');

  // Même numéro dans un second compte du profil : refusé.
  const dup = await wa.startLink({ profileId: 'perso', name: 'WhatsApp bis' });
  await tick();
  await pairAndOpen(ctx);
  assert.match(wa.linkStatus(dup.linkId).error, /déjà relié/);
  assert.equal(store.hasAccount(dup.accountId), false);
  assert.ok(sockets.list.length >= 5);
  wa.sync.stop();
});

test('redémarrage : seules les sessions enregistrées reprennent, sans QR', async () => {
  const ctx = await setupWhatsApp();
  const { accountId } = await linkedAccount(ctx);
  const provisional = await ctx.wa.startLink({ profileId: 'atlas', name: 'WA jamais lié' });
  await tick();
  ctx.wa.sync.stop();

  const next = await setupWhatsApp({ db: ctx.db, vault: ctx.vault });
  await next.wa.sync.start();
  await tick();
  assert.equal(next.sockets.list.length, 1, 'aucune connexion pour un compte jamais lié');
  assert.equal(next.store.getAccount(provisional.accountId).status, 'À reconnecter');
  const sock = next.sockets.last();
  assert.equal(sock.auth.state.creds.me.id, `${ME}:7@s.whatsapp.net`, 'identifiants relus et déchiffrés');
  sock.user = { id: `${ME}:7@s.whatsapp.net` };
  sock.emit('connection.update', { connection: 'open' });
  await tick();
  assert.equal(next.store.getAccount(accountId).status, 'Connecté');
  sock.emit('messages.upsert', { type: 'notify', messages: [msg('B1', 'Tu es là ?', { ago: 10 })] });
  await tick();
  assert.equal(threadOf(next.store, accountId).message_count, 2);

  // Coupure réseau : nouvelle tentative automatique avec la même session.
  sock.emit('connection.update', closed(428));
  await new Promise(r => setTimeout(r, 60));
  assert.equal(next.sockets.list.length, 2);
  // Session devenue invalide : WhatsApp demande un QR, qui n'est jamais montré.
  next.sockets.last().emit('connection.update', { qr: 'faux-qr' });
  await tick();
  assert.equal(next.store.getAccount(accountId).status, 'À reconnecter');
  assert.equal(next.sockets.last().ended, true);
  assert.deepEqual(next.wa.sync.permissions(accountId), []);
  next.wa.sync.stop();
});

test('actions locales et nouveau message reçu', async () => {
  const ctx = await setupWhatsApp();
  const { accountId, sock } = await linkedAccount(ctx);
  const id = threadOf(ctx.store, accountId).id;
  const folder = ctx.store.createFolder({ profileId: 'perso', name: 'Famille' });
  ctx.wa.sync.updateMessage(id, { unread: false, flagged: true, archived: true, folderId: folder.id });
  sock.emit('messages.upsert', { type: 'append', messages: [msg('C0', 'Ancien envoi', { fromMe: true, ago: 1800 })] });
  await tick();
  let t = threadOf(ctx.store, accountId);
  assert.deepEqual([t.unread, t.flagged, t.archived, t.folder_id], [0, 1, 1, folder.id], 'état local conservé');
  sock.emit('messages.upsert', { type: 'notify', messages: [msg('C1', 'Nouveau message', { ago: 5 })] });
  await tick();
  t = threadOf(ctx.store, accountId);
  assert.deepEqual([t.unread, t.flagged, t.archived, t.folder_id], [1, 1, 0, folder.id]);
  assert.throws(() => ctx.wa.sync.updateMessage(1, { unread: true }), { status: 400 }, 'message d’un autre fournisseur');
  ctx.wa.sync.stop();
});

test('envoi : aperçu exact, JID stocké, usage unique, pas de relance', async () => {
  const ctx = await setupWhatsApp();
  const { store, wa } = ctx;
  const { accountId, sock } = await linkedAccount(ctx);
  const id = threadOf(store, accountId).id;

  const draft = await wa.outbox.saveDraft(id, { text: 'Brouillon', mode: 'reply' });
  assert.equal(draft.synced, false);
  await assert.rejects(() => wa.outbox.saveDraft(id, { text: 'x', mode: 'forward', to: 'a@b.fr' }), { status: 400 });
  await assert.rejects(() => wa.outbox.preview(id, { text: 'x', mode: 'replyAll' }), { status: 400 });
  await assert.rejects(() => wa.outbox.preview(id, { text: '  ', mode: 'reply' }), { status: 400 });
  await assert.rejects(() => wa.outbox.preview(id, { text: 'x'.repeat(4097), mode: 'reply' }), { status: 400 });
  await assert.rejects(() => wa.outbox.preview(1, { text: 'x', mode: 'reply' }), { status: 400 }, 'fil Gmail');

  const p = await wa.outbox.preview(id, { text: 'Parfait, à jeudi.', mode: 'reply', to: 'autre@x.fr' });
  assert.deepEqual({ ...p, digest: undefined }, {
    channel: 'whatsapp', from: `WhatsApp perso (+${ME})`, to: ['Claire Dubois (+33698765432)'], cc: [],
    subject: 'WhatsApp · Claire Dubois', body: 'Parfait, à jeudi.', digest: undefined,
  });
  await assert.rejects(() => wa.outbox.send(id, { text: 'Parfait, à jeudi !', mode: 'reply', digest: p.digest }), { code: 'digest_mismatch' });

  // Hors ligne : rien n'est tenté et la validation reste utilisable.
  sock.emit('connection.update', closed(428));
  await tick();
  await assert.rejects(() => wa.outbox.send(id, { text: 'Parfait, à jeudi.', mode: 'reply', digest: p.digest }), { code: 'whatsapp_offline' });
  await new Promise(r => setTimeout(r, 40));
  const live = ctx.sockets.last();
  live.user = { id: `${ME}:7@s.whatsapp.net` };
  live.emit('connection.update', { connection: 'open' });
  await tick();

  const r = await wa.outbox.send(id, { text: 'Parfait, à jeudi.', mode: 'reply', digest: p.digest, to: '33700000000@s.whatsapp.net' });
  assert.deepEqual(r, { sent: true, draftRemoved: true });
  assert.deepEqual(live.sent, [{ jid: PEER, content: { text: 'Parfait, à jeudi.' } }], 'destinataire : JID stocké seulement');
  const t = threadOf(store, accountId);
  assert.equal(t.body, 'Parfait, à jeudi.');
  assert.equal(t.draft_text, null);
  await assert.rejects(() => wa.outbox.send(id, { text: 'Parfait, à jeudi.', mode: 'reply', digest: p.digest }), { code: 'confirmation_invalid' });

  // Échec ambigu : validation consommée, aucun nouvel essai automatique.
  const q = await wa.outbox.preview(id, { text: 'Encore', mode: 'reply' });
  live.failSend = true;
  await assert.rejects(() => wa.outbox.send(id, { text: 'Encore', mode: 'reply', digest: q.digest }), { code: 'send_uncertain' });
  live.failSend = false;
  await assert.rejects(() => wa.outbox.send(id, { text: 'Encore', mode: 'reply', digest: q.digest }), { code: 'confirmation_invalid' });
  assert.equal(live.sent.length, 1);

  // Déconnexion : validations purgées, appareil retiré, données effacées.
  const z = await wa.outbox.preview(id, { text: 'Dernier', mode: 'reply' });
  const out = await wa.disconnect(accountId);
  assert.deepEqual(out, { disconnected: true, revoked: true });
  assert.equal(live.loggedOut, true);
  assert.equal(store.hasAccount(accountId), false);
  for (const table of ['whatsapp_auth', 'whatsapp_messages', 'whatsapp_chats', 'contacts']) {
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(accountId).n, 0, table);
  }
  await assert.rejects(() => wa.outbox.send(id, { text: 'Dernier', mode: 'reply', digest: z.digest }), { status: 404 });
  assert.equal(live.sent.length, 1);
  await assert.rejects(() => wa.disconnect(1), { status: 400 });
  wa.sync.stop();
});
