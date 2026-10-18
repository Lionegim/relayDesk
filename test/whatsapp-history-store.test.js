import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { chatToRecord } from '../src/providers/whatsapp/parse.js';

test('historique WhatsApp : lecture au-delà de 200 sans suppression, déduplication et purge isolée à sept jours',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());seedIfEmpty(db,{demo:false});const store=createStore(db);
 const a=store.upsertAccount('perso',{name:'Téléphone',channel:'whatsapp',svc:'whatsapp'});
 const b=store.upsertAccount('anove',{name:'Autre téléphone',channel:'whatsapp',svc:'whatsapp'});
 const since=Date.now()-7*86400000,jid='33600000000@s.whatsapp.net';
 const recent=Array.from({length:501},(_,i)=>({chatJid:jid,msgId:String(i),fromMe:false,ts:since+1000+i,text:'Texte récent'}));
 store.waAddMessages(a.id,recent);store.waAddMessages(a.id,recent);
 assert.equal(store.waChatMessages(a.id,jid,200).length,501,'une lecture ne tronque pas la fenêtre');
 assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_messages WHERE account_id=?').get(a.id).n,501);
 const expired={chatJid:jid,msgId:'expired',fromMe:false,ts:since-1,text:'Hors fenêtre'};
 store.waAddMessages(a.id,[expired]);store.waAddMessages(b.id,[expired]);
 store.waPruneBefore(a.id,since);
 assert.equal(store.waChatMessages(a.id,jid).length,501);
 const source=store.waChatMessages(a.id,jid);
 const thread=store.upsertThread(a.id,chatToRecord(jid,source,{name:'Contact test'}));
 assert.equal(store.getMessage(thread).trail.length,500,'toute la fenêtre importée est consultable');
 assert.equal(store.waChatMessages(b.id,jid).length,1,'aucun changement dans un autre profil');
});
