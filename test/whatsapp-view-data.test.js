import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupWhatsApp, linkedAccount, msg } from './whatsapp-helpers.js';

test('conversation WhatsApp : direction et horodatage exacts, même si le correspondant se nomme Moi', async t => {
  const c = await setupWhatsApp();
  t.after(() => { c.wa.sync.stop(); c.db.close(); });
  const { accountId, sock } = await linkedAccount(c, { messages: [msg('in','Reçu',{ago:300}),msg('out','Envoyé',{fromMe:true,ago:200})] });
  const id = c.db.prepare('SELECT id FROM messages WHERE account_id=?').get(accountId).id;
  let full = c.store.getMessage(id);
  assert.equal(full.fromMe,true);
  assert.equal(full.at,full.sortAt);
  assert.deepEqual(full.trail.map(m=>m.fromMe),[false]);
  sock.emit('contacts.update',[{id:'33698765432@s.whatsapp.net',name:'Moi'}]);
  sock.emit('messages.upsert',{type:'notify',messages:[msg('last','Nouveau reçu',{ago:100,pushName:'Moi'})]});
  full = c.store.getMessage(id);
  assert.equal(full.from,'Moi');
  assert.equal(full.fromMe,false,'un nom de contact ne décide jamais de la direction');
  assert.deepEqual(full.trail.map(m=>m.fromMe),[true,false]);
  assert.ok(full.at>full.trail[0].at && full.trail[0].at>full.trail[1].at);
  assert.equal(c.sockets.last().sent.length,0);
});
