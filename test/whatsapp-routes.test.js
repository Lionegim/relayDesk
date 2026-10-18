import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createApp } from '../src/http/app.js';
import { createAssistantService } from '../src/mail/assistant-service.js';

async function setup(t, whatsapp) {
  const db = openDatabase(':memory:'); seedIfEmpty(db);
  const store = createStore(db);
  const server = createApp({ store, ai: { configured: false }, providers: whatsapp ? { whatsapp } : {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  return { store, db, request };
}

test('QR WhatsApp : paramètres validés avant démarrage, état privé sans QR dans snapshot', async t => {
  const calls = [];
  const wa = { configured: true, startLink: async c => { calls.push(c); return {linkId:'link-123'}; },
    linkStatus: () => ({status:'qr',qrDataUrl:'data:image/png;base64,dGVzdA=='}), cancelLink: () => {},
    sync: { permissions: () => [] } };
  const { request, store } = await setup(t,wa);
  for (const bad of [{profileId:'absent',name:'Téléphone'}, {profileId:'anove',name:''}, {profileId:'anove',name:'Téléphone',windowDays:30}]) {
    assert.equal((await request('POST','/api/whatsapp/links',bad)).status,400);
  }
  assert.equal(calls.length,0);
  assert.equal((await request('POST','/api/whatsapp/links',{profileId:'anove',name:' Téléphone '})).status,200);
  assert.deepEqual(calls[0],{profileId:'anove',name:'Téléphone',windowDays:7});
  const state = await request('GET','/api/state');
  assert.equal(state.body.integrations.whatsapp.configured,true,'aucun OAuth pour WhatsApp');
  assert.equal(JSON.stringify(state.body).includes('data:image/png'),false);
  assert.equal((await request('GET','/api/whatsapp/links/link-123')).body.status,'qr');
  assert.equal((await request('DELETE','/api/whatsapp/links/link-123',{})).body.cancelled,true);
  const other = store.upsertAccount('perso',{name:'Autre',channel:'whatsapp',svc:'whatsapp'});
  assert.equal((await request('POST','/api/whatsapp/links',{profileId:'anove',name:'Autre',accountId:other.id})).status,400);
  assert.equal((await request('POST','/api/profiles/anove/accounts',{name:'Fausse liaison',svc:'whatsapp'})).status,400,'aucune connexion simulée');
});

test('QR WhatsApp : connecteur absent refusé explicitement', async t => {
  const {request} = await setup(t);
  assert.equal((await request('POST','/api/whatsapp/links',{profileId:'anove',name:'Téléphone'})).status,503);
  assert.equal((await request('GET','/api/whatsapp/links/inconnu')).status,404);
});

test('classement WhatsApp : dossier local annoncé local et routé vers son compte', async t => {
  const {store,db} = await setup(t);
  const a = store.upsertAccount('anove',{name:'Téléphone',channel:'whatsapp',svc:'whatsapp',address:'33600000000'});
  db.prepare('UPDATE messages SET account_id = ?, external_id = ?, channel = ? WHERE id = 1').run(a.id,'chat@s.whatsapp.net','whatsapp');
  const assistant = createAssistantService({store,ai:{model:'fake',complete:async()=>JSON.stringify({category:'action',priority:'normal',reason:'Répondre.',folder:'D1'})},
    mail:{permissions:()=>['read','drafts','send'],updateMessage:(id,patch)=>store.updateMessage(id,patch)}});
  const proposal = await assistant.run('classify',1);
  const result = await assistant.apply(1,{proposalId:proposal.proposalId});
  assert.equal(result.synced,false);assert.equal(result.message.folderId,proposal.folderId);
});
