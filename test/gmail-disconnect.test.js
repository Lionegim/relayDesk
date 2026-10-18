import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, connected, thread } from './helpers/fake-google.js';
import { createGmailDisconnect } from '../src/providers/gmail/disconnect.js';

test('déconnexion : révocation, puis compte, secret, état et messages supprimés', async () => {
  const ctx = setup();
  const account = await connected(ctx);
  assert.equal(ctx.store.snapshot().messages.filter(m => m.accountId === account.id).length, 1);
  const disconnect = createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: ctx.g.fetch, log: {} });
  const res = await disconnect(account.id);
  assert.deepEqual(res, { disconnected: true, revoked: true });
  assert.deepEqual(ctx.g.revoked, ['rt-secret']);
  assert.equal(ctx.store.hasAccount(account.id), false);
  assert.equal(ctx.store.getSecret(account.id), null);
  assert.equal(ctx.store.getSync(account.id), null);
  assert.equal(ctx.store.snapshot().messages.filter(m => m.accountId === account.id).length, 0);
  assert.ok(ctx.store.snapshot().messages.some(m => m.p === 'perso'), 'les autres messages du profil restent');
});

test('déconnexion : une révocation impossible n’empêche pas la suppression', async () => {
  const ctx = setup();
  const account = await connected(ctx);
  const down = async url => { if (String(url).includes('/revoke')) throw new TypeError('fetch failed'); return ctx.g.fetch(url); };
  const disconnect = createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: down, log: {} });
  assert.deepEqual(await disconnect(account.id), { disconnected: true, revoked: false });
  assert.equal(ctx.store.hasAccount(account.id), false);
});

test('déconnexion pendant un import : aucune écriture ensuite, aucune erreur', async () => {
  const ctx = setup();
  const { account, job } = ctx.sync.connect({ profileId: 'perso', name: 'Gmail JH', windowDays: 30, refreshToken: 'rt', email: 'jh@gmail.com' });
  const disconnect = createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: ctx.g.fetch, log: {} });
  await disconnect(account.id);
  await job;
  assert.equal(ctx.store.hasAccount(account.id), false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(account.id).n, 0);
});

test('déconnexion : refusée pour un compte non Gmail', async () => {
  const ctx = setup();
  const demo = ctx.store.snapshot().profiles.find(p => p.id === 'anove').accounts.find(a => a.name === 'WhatsApp pro');
  const disconnect = createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: ctx.g.fetch, log: {} });
  await assert.rejects(disconnect(demo.id), e => e.status === 400);
});

test('déconnexion : les dossiers importés survivent, un nouveau compte au même identifiant s’importe', async () => {
  const ctx = setup({ threads: { t1: thread('t1', { labels: ['INBOX', 'Label_7'] }) }, labels: [{ id: 'Label_7', name: 'Clients', type: 'user' }] });
  const account = await connected(ctx);
  const folder = ctx.store.snapshot().messages.find(m => m.accountId === account.id).folderId;
  assert.ok(folder);
  // Dossier importé avant la migration 002 : provenance encore portée par folders.account_id.
  ctx.db.prepare('UPDATE folders SET account_id = ?, external_id = ? WHERE id = ?').run(account.id, 'Label_7', folder);
  const disconnect = createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: ctx.g.fetch, log: {} });
  await disconnect(account.id);
  assert.equal(ctx.store.snapshot().folders.find(f => f.id === folder)?.name, 'Clients', 'le dossier reste');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM folder_labels WHERE folder_id = ?').get(folder).n, 0);

  const again = await connected(ctx);
  assert.equal(again.id, account.id, 'SQLite réutilise l’identifiant');
  assert.equal(ctx.store.getAccount(again.id).status, 'Connecté');
  const newFolder = ctx.store.snapshot().messages.find(m => m.accountId === again.id).folderId;
  assert.notEqual(newFolder, folder);
  assert.equal(ctx.store.snapshot().folders.find(f => f.id === newFolder).name, 'Clients');
});

test('déconnexion : attend l’action en cours du même compte', async () => {
  const ctx = setup();
  const account = await connected(ctx);
  const order = [];
  let release;
  const blocker = ctx.sync.forget(account.id, () => new Promise(r => { release = r; order.push('action'); }));
  const disconnect = createGmailDisconnect({ store: ctx.store, vault: ctx.vault, sync: ctx.sync, fetchImpl: ctx.g.fetch, log: {} });
  const done = disconnect(account.id).then(() => order.push('suppression'));
  await new Promise(r => setTimeout(r, 10));
  assert.ok(ctx.store.hasAccount(account.id), 'pas supprimé tant que l’action tourne');
  release();
  await blocker;
  await done;
  assert.deepEqual(order, ['action', 'suppression']);
});
