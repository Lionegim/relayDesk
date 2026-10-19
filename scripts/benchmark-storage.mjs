// Mesure indicative synthétique, jamais un import du téléphone. Aucun .env ni connecteur.
import {mkdtempSync,mkdirSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createBackup,restoreBackup} from '../src/ops/backup.js';
const count=Number(process.argv[2]||10000);
if(!Number.isInteger(count)||count<100||count>100000)throw new Error('Nombre fictif de messages entre 100 et 100000 requis.');
const root=mkdtempSync(join(tmpdir(),'relay-capacity-')),dataDir=join(root,'data');mkdirSync(dataDir);let db;
try{
 db=openDatabase(join(dataDir,'relay.db'));seedIfEmpty(db,{demo:false});const store=createStore(db);
 const account=store.upsertAccount('perso',{name:'WhatsApp synthétique',channel:'whatsapp',svc:'whatsapp',address:'+33000000000'});
 const started=performance.now(),now=Date.now();
 for(let offset=0;offset<count;offset+=1000){
  const list=Array.from({length:Math.min(1000,count-offset)},(_,i)=>{const n=offset+i,chat=n%100;return{chatJid:'33000000'+chat+(chat%2?'@g.us':'@s.whatsapp.net'),msgId:'fake-'+n,fromMe:n%3===0,ts:now-(count-n)*1000,text:'Texte purement synthétique pour mesurer le stockage. '.repeat(4)+n};});
  store.waAddMessages(account.id,list);
 }
 const importMs=Math.round(performance.now()-started);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const archive=join(root,'archives','test.rlybak'),backupKey=randomBytes(32),vaultKey=randomBytes(32),options={dataDir,archive,backupKey,vaultKey};
 const backupAt=performance.now();await createBackup(options);const backupMs=Math.round(performance.now()-backupAt);
 const restoreAt=performance.now();await restoreBackup({...options,dataDir:join(root,'restored')});
 console.log(JSON.stringify({synthetic:true,node:process.version,messages:count,conversations:100,groups:50,importMs,backupMs,restoreMs:Math.round(performance.now()-restoreAt),databaseBytes:statSync(join(dataDir,'relay.db')).size,archiveBytes:statSync(archive).size,peakRssBytes:process.resourceUsage().maxRSS*1024,limitations:['text_only','no_phone_history_decoding','no_network','no_provider_or_ai_load','not_a_hosted_server_benchmark']}));
}finally{db?.close();rmSync(root,{recursive:true,force:true});}
