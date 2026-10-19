// Base entièrement synthétique : aucun import de données de démonstration nominatives ni fournisseur réseau.
import {join} from 'node:path';
import {existsSync,readdirSync} from 'node:fs';
import {openDatabase} from '../../src/db/index.js';
import {seedIfEmpty} from '../../src/db/seed.js';
import {createStore} from '../../src/store.js';
import {acquireInstanceLock} from '../../src/runtime/instance-lock.js';
const dir=process.argv[2];if(!dir)throw new Error('Dossier neuf explicite requis.');
if(existsSync(dir) && readdirSync(dir).length)throw new Error('Refus de modifier un dossier non vide.');
const unlock=acquireInstanceLock(dir);let db;
try {
 db=openDatabase(join(dir,'relay.db'));
 if(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n)throw new Error('Refus de modifier une base existante.');
 seedIfEmpty(db,{demo:true,seed:{PROFILES:[{id:'perso',name:'TEST — fictional messages only',kind:'Test environment',initials:'T',accounts:[]}],FOLDERS:[],MESSAGES:[],CONTACTS:[]}});
 const store=createStore(db),now=Date.now();
 for(const [svc,channel] of [['gmail','email'],['outlook','email'],['whatsapp','whatsapp']]){
  const account=store.upsertAccount('perso',{name:'TEST '+svc,svc,channel,address:svc==='whatsapp'?'+33000000000':svc+'@example.invalid'});
  store.setAccountStatus(account.id,'Test — disconnected','muted');
  const id=store.upsertThread(account.id,{externalId:svc==='whatsapp'?'33000000001@s.whatsapp.net':'synthetic-'+svc,from:'Fictional Contact '+svc,initials:'FC',handle:svc+'@example.invalid',sortAt:now,unread:true,flagged:false,label:'Test only',subject:'TEST — fictional conversation',preview:'Synthetic fixture. No message was imported or sent.',body:'This conversation was generated for the hosted test. It contains no real messages, account access or credentials.',triage:'À lire',trail:[],count:1,archived:false});
  store.saveDraft(id,'TEST DRAFT — not sent.');
  store.rememberReply(id,'Hi, thanks! This is a fictional style example.');
 }
 db.exec('PRAGMA wal_checkpoint(TRUNCATE)');console.log(JSON.stringify({synthetic:true,profiles:1,conversations:3,connectors:false,ai:false}));
} finally {db?.close();unlock();}
