import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupOutlook, connectedOutlook, G } from './outlook-helpers.js';

const day = n => new Date(Date.now() - n * 86400000).toISOString();

function mailbox(ms) {
  ms.add({ conversationId: 'C1', parentFolderId: 'F-sent', from: { emailAddress: { name: 'JH', address: 'jh@outlook.fr' } }, toRecipients: [{ emailAddress: { name: 'Claire Dubois', address: 'claire@atlas.fr' } }], body: 'Trois créneaux possibles.', isRead: true, receivedDateTime: day(2) });
  ms.add({ conversationId: 'C1', body: 'Mardi 10h.\r\n\r\nLe 3 oct., JH a écrit :\r\n> Trois créneaux', ccRecipients: [{ emailAddress: { name: 'Hugo', address: 'hugo@atlas.fr' } }], headers: [{ name: 'References', value: '<m0@outlook.fr>' }], receivedDateTime: day(1) });
  ms.add({ conversationId: 'C2', parentFolderId: 'F-clients', subject: 'Contrat', isRead: true, receivedDateTime: day(3) });
  ms.add({ conversationId: 'C3', parentFolderId: 'F-junk', subject: 'Spam', receivedDateTime: day(1) });
  ms.add({ conversationId: 'C4', subject: 'Ancien', receivedDateTime: day(90) });
  ms.add({ conversationId: 'C5', subject: 'Promo', inferenceClassification: 'other', headers: [{ name: 'List-Unsubscribe', value: '<x>' }], receivedDateTime: day(1) });
}
const rows = (store, accountId) => store.snapshot().messages.filter(m => m.accountId === accountId);

test('import initial : fenêtre, dossiers, archivage, en-têtes de réponse, rotation chiffrée du jeton', async () => {
  const ctx = setupOutlook();
  mailbox(ctx.ms);
  const account = await connectedOutlook(ctx);
  const acc = ctx.store.getAccount(account.id);
  assert.deepEqual([acc.svc, acc.status, acc.address], ['outlook', 'Connecté', 'jh@outlook.fr']);
  const list = rows(ctx.store, account.id);
  assert.deepEqual(list.map(m => m.subject).sort(), ['Atelier', 'Contrat', 'Promo'], 'ni indésirable ni hors fenêtre');
  const c1 = list.find(m => m.subject === 'Atelier');
  assert.deepEqual([c1.from, c1.count, c1.unread, c1.archived], ['Claire Dubois', 2, true, false]);
  const full = ctx.store.getMessage(c1.id);
  assert.equal(full.body, 'Mardi 10h.', 'citation retirée');
  assert.equal(full.trail[0].from, 'Moi');
  const reply = ctx.store.composeContext(c1.id).reply;
  assert.equal(reply.from, '"Claire Dubois" <claire@atlas.fr>');
  assert.equal(reply.cc, '"Hugo" <hugo@atlas.fr>');
  assert.equal(reply.references, '<m0@outlook.fr>');
  const c2 = list.find(m => m.subject === 'Contrat');
  assert.equal(c2.archived, false, 'visible dans son dossier personnel');
  assert.equal(ctx.store.snapshot().folders.find(f => f.id === c2.folderId).name, 'Clients');
  assert.equal(list.find(m => m.subject === 'Promo').label, 'Newsletter');
  // Jeton renouvelé par Microsoft : rechiffré, jamais en clair.
  const secret = ctx.vault.open(account.id, ctx.store.getSecret(account.id));
  assert.match(secret.refreshToken, /^rt-rot-/);
  assert.ok(!ctx.db.prepare('SELECT ciphertext FROM secrets').get().ciphertext.toString().includes('rt-rot'));
  assert.deepEqual(ctx.sync.permissions(account.id), ['read']);
  assert.equal(ctx.sync.progress(account.id).status, 'ok');
});

test('synchronisation incrémentale : nouveau message, lu ailleurs, suppression, curseur expiré', async () => {
  const ctx = setupOutlook();
  mailbox(ctx.ms);
  const account = await connectedOutlook(ctx);
  const c1msg = ctx.ms.messages.find(m => m.conversationId === 'C1' && m.parentFolderId === 'F-inbox');
  ctx.ms.change(c1msg, { isRead: true });
  ctx.ms.add({ conversationId: 'C6', subject: 'Nouveau', receivedDateTime: new Date().toISOString() });
  ctx.ms.moveTo(ctx.ms.messages.find(m => m.conversationId === 'C5'), 'F-deleted');
  await ctx.sync.syncNow(account.id);
  let list = rows(ctx.store, account.id);
  assert.deepEqual(list.map(m => m.subject).sort(), ['Atelier', 'Contrat', 'Nouveau']);
  assert.equal(list.find(m => m.subject === 'Atelier').unread, false);
  ctx.ms.expireDelta = true;
  ctx.ms.add({ conversationId: 'C7', subject: 'Après expiration', receivedDateTime: new Date().toISOString() });
  await ctx.sync.syncNow(account.id);
  ctx.ms.expireDelta = false;
  list = rows(ctx.store, account.id);
  assert.ok(list.some(m => m.subject === 'Après expiration'), 'réimport complet');
  assert.equal(ctx.store.getSync(account.id).status, 'ok');
});

test('accès révoqué : « À reconnecter »', async () => {
  const ctx = setupOutlook();
  const account = await connectedOutlook(ctx);
  ctx.store.putSecret(account.id, ctx.vault.seal(account.id, { refreshToken: 'revoked', email: 'jh@outlook.fr', scopes: [`${G}Mail.Read`] }));
  ctx.sync.forget(account.id, () => {}); // nouveau client, sans jeton d'accès en cache
  await ctx.sync.syncNow(account.id);
  assert.equal(ctx.store.getAccount(account.id).status, 'À reconnecter');
});

test('oubli pendant l’import : aucune écriture ensuite', async () => {
  const ctx = setupOutlook();
  mailbox(ctx.ms);
  const { account, job } = ctx.sync.connect({ profileId: 'perso', name: 'Outlook JH', windowDays: 30, refreshToken: 'rt', email: 'jh@outlook.fr', scopes: [`${G}Mail.Read`] });
  await ctx.sync.forget(account.id, () => ctx.store.deleteAccount(account.id));
  await job;
  assert.equal(ctx.store.hasAccount(account.id), false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(account.id).n, 0);
});

test('classement avec Mail.ReadWrite : lu, drapeau, archivage, dossier créé par chemin ; sans permission : local', async () => {
  const ctx = setupOutlook();
  mailbox(ctx.ms);
  const account = await connectedOutlook(ctx, [`${G}Mail.ReadWrite`]);
  const c1 = rows(ctx.store, account.id).find(m => m.subject === 'Atelier');
  ctx.ms.calls.length = 0;
  await ctx.sync.updateMessage(c1.id, { unread: false, flagged: true });
  const patches = ctx.ms.calls.filter(c => c.method === 'PATCH');
  assert.deepEqual(patches.map(c => c.body), [{ isRead: true }, { flag: { flagStatus: 'flagged' } }]);
  await ctx.sync.updateMessage(c1.id, { archived: true });
  assert.equal(ctx.ms.messages.find(m => m.conversationId === 'C1' && m.body.startsWith('Mardi')).parentFolderId, 'F-archive');
  // Dossier local imbriqué sans équivalent Outlook : créé segment par segment, puis lié.
  const parent = ctx.store.createFolder({ profileId: 'perso', name: 'Projets', parentId: null });
  const child = ctx.store.createFolder({ profileId: 'perso', name: 'Atlas', parentId: parent.id });
  await ctx.sync.updateMessage(c1.id, { archived: false });
  await ctx.sync.updateMessage(c1.id, { folderId: child.id });
  const projets = ctx.ms.folders.find(f => f.displayName === 'Projets');
  const atlas = ctx.ms.folders.find(f => f.displayName === 'Atlas' && f.parentFolderId === projets.id);
  assert.ok(atlas, 'Projets/Atlas créé');
  assert.equal(ctx.store.folderLabel(child.id, account.id), atlas.id);
  assert.equal(ctx.ms.messages.find(m => m.conversationId === 'C1' && m.body.startsWith('Mardi')).parentFolderId, atlas.id);
  await ctx.sync.updateMessage(c1.id, { folderId: null });
  assert.equal(ctx.ms.messages.find(m => m.conversationId === 'C1' && m.body.startsWith('Mardi')).parentFolderId, 'F-inbox');
  // Erreur Graph : rien d'écrit localement, aucun détail de la réponse.
  ctx.ms.fail = m => m === 'PATCH';
  await assert.rejects(ctx.sync.updateMessage(c1.id, { flagged: false }), e => e.code === 'outlook_write' && !/secret/.test(e.message));
  ctx.ms.fail = null;
  assert.equal(ctx.store.getMessage(c1.id).flagged, true);

  const ro = setupOutlook();
  mailbox(ro.ms);
  const a2 = await connectedOutlook(ro);
  const m2 = rows(ro.store, a2.id).find(m => m.subject === 'Atelier');
  ro.ms.calls.length = 0;
  await ro.sync.updateMessage(m2.id, { unread: false });
  assert.equal(ro.ms.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(ro.store.getMessage(m2.id).unread, false);
});

test('revue : suppression définitive (@removed sans conversation) appliquée après redémarrage', async () => {
  const ctx = setupOutlook();
  mailbox(ctx.ms);
  const account = await connectedOutlook(ctx);
  assert.ok(rows(ctx.store, account.id).some(m => m.subject === 'Contrat'));
  const { createOutlookSync } = await import('../src/providers/outlook/sync.js');
  const restarted = createOutlookSync({ store: ctx.store, vault: ctx.vault, oauth: ctx.oauth, fetchImpl: ctx.ms.fetch, log: {} });
  ctx.ms.hardDelete(ctx.ms.messages.find(m => m.conversationId === 'C2'));
  await restarted.syncNow(account.id);
  assert.ok(!rows(ctx.store, account.id).some(m => m.subject === 'Contrat'), 'conversation retirée');
  // Un message d'une conversation à plusieurs messages : la conversation est mise à jour, pas supprimée.
  ctx.ms.hardDelete(ctx.ms.messages.find(m => m.conversationId === 'C1' && m.parentFolderId === 'F-sent'));
  await restarted.syncNow(account.id);
  assert.equal(rows(ctx.store, account.id).find(m => m.subject === 'Atelier').count, 1);
});

test('revue : liste de dossiers paginée, sous-dossier de la boîte de réception, aucun doublon créé', async () => {
  const ctx = setupOutlook();
  ctx.ms.pageSize = 2;
  for (let i = 0; i < 5; i++) ctx.ms.folders.push({ id: `F-x${i}`, displayName: `Dossier ${i}`, parentFolderId: 'root' });
  ctx.ms.folders.push({ id: 'F-proj', displayName: 'Projet', parentFolderId: 'F-inbox' });
  ctx.ms.add({ conversationId: 'CZ', parentFolderId: 'F-x4', subject: 'Dernière page', receivedDateTime: day(1) });
  ctx.ms.add({ conversationId: 'CP', parentFolderId: 'F-proj', subject: 'Sous la boîte', receivedDateTime: day(1) });
  const account = await connectedOutlook(ctx, [`${G}Mail.ReadWrite`]);
  const list = rows(ctx.store, account.id);
  const folderName = m => ctx.store.snapshot().folders.find(f => f.id === m.folderId)?.name;
  const z = list.find(m => m.subject === 'Dernière page'), p = list.find(m => m.subject === 'Sous la boîte');
  assert.deepEqual([folderName(z), z.archived], ['Dossier 4', false]);
  assert.deepEqual([folderName(p), p.archived], ['Boîte de réception/Projet', false]);
  // Dossier Relay au même nom qu'un dossier Outlook de la dernière page : réutilisé, pas recréé.
  const local = ctx.store.createFolder({ profileId: 'perso', name: 'Dossier 4', parentId: null });
  const before = ctx.ms.folders.length;
  await ctx.sync.updateMessage(p.id, { folderId: local.id });
  assert.equal(ctx.ms.folders.length, before);
  assert.equal(ctx.ms.messages.find(m => m.conversationId === 'CP').parentFolderId, 'F-x4');
});

test('revue : déplacé dans un dossier reste visible ; archiver depuis un dossier ; corbeille jamais touchée', async () => {
  const ctx = setupOutlook();
  mailbox(ctx.ms);
  ctx.ms.add({ conversationId: 'C1', parentFolderId: 'F-deleted', subject: 'Atelier', body: 'supprimé', receivedDateTime: day(1.5) });
  const account = await connectedOutlook(ctx, [`${G}Mail.ReadWrite`]);
  const inboxMsg = () => ctx.ms.messages.find(m => m.conversationId === 'C1' && m.body.startsWith('Mardi'));
  ctx.ms.moveTo(inboxMsg(), 'F-clients');
  await ctx.sync.syncNow(account.id);
  let c1 = rows(ctx.store, account.id).find(m => m.subject === 'Atelier');
  assert.equal(c1.archived, false, 'toujours visible dans son dossier');
  assert.equal(ctx.store.snapshot().folders.find(f => f.id === c1.folderId).name, 'Clients');
  await ctx.sync.updateMessage(c1.id, { archived: true, unread: false });
  assert.equal(inboxMsg().parentFolderId, 'F-archive');
  const trashed = ctx.ms.messages.find(m => m.body === 'supprimé');
  assert.deepEqual([trashed.parentFolderId, trashed.isRead], ['F-deleted', false], 'corbeille non modifiée');
  await ctx.sync.syncNow(account.id);
  c1 = rows(ctx.store, account.id).find(m => m.subject === 'Atelier');
  assert.deepEqual([c1.archived, c1.folderId], [true, null], 'archivé après synchronisation');
  await ctx.sync.updateMessage(c1.id, { archived: false });
  assert.equal(inboxMsg().parentFolderId, 'F-inbox');
});
