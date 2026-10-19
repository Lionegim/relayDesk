import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../src/db/index.js';
import {seedIfEmpty} from '../src/db/seed.js';
import {createStore} from '../src/store.js';
import {createVault} from '../src/secrets.js';
import {createGmailSync} from '../src/providers/gmail/sync.js';
import {GMAIL_SCOPES} from '../src/providers/gmail/oauth.js';
import {createHistoryWorker} from '../src/mail/history/worker.js';
import {setupOutlook,connectedOutlook} from './outlook-helpers.js';
const wait=()=>new Promise(r=>setImmediate(r));
const json=body=>new Response(JSON.stringify(body));
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'relay-archive-')),file=join(dir,'relay.db');let db=openDatabase(file);seedIfEmpty(db,{demo:false});let store=createStore(db);const vault=createVault(randomBytes(32));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},get db(){return db;},vault,reopen(){db.close();db=openDatabase(file);store=createStore(db);}};}
function gmail(f,n=1103){const calls=[],old=Date.parse('2014-01-01T00:00:00Z');let fail=false,hold,expired=false;const ids=Array.from({length:n},(_,i)=>'t'+i.toString().padStart(5,'0'));
 const fetchImpl=async(url,init)=>{const u=new URL(url),path=u.pathname.split('/users/me/')[1];calls.push({path,query:u.searchParams.toString(),method:init.method});if(hold)await hold();if(fail && path.startsWith('threads/'))return new Response('{}',{status:429});
 if(path==='profile')return json({historyId:'live-100'});if(path==='labels')return json({labels:[]});if(path==='history')return expired?new Response('{}',{status:404}):json({historyId:'live-101',history:[]});
 if(path==='threads'){const start=Number(u.searchParams.get('pageToken') || 0),list=u.searchParams.has('q')?ids.slice(-1):ids;return json({threads:list.slice(start,start+100).map(id=>({id})),...(start+100<list.length?{nextPageToken:String(start+100)}:{})});}
 if(path.startsWith('threads/')){const id=path.slice(8);return json({id,messages:[{id:'m'+id,internalDate:String(old+ids.indexOf(id)),labelIds:['INBOX'],snippet:'Synthetic only',payload:{mimeType:'text/plain',body:{data:Buffer.from('Synthetic archive text').toString('base64url')},headers:[{name:'From',value:'Example <example@example.test>'},{name:'Subject',value:id}]}}]});}throw new Error('Unexpected network path');};
 const oauth={refresh:async()=>({access_token:'fake',expires_in:3600})};
 const build=()=>createGmailSync({store:f.store,vault:f.vault,oauth,fetchImpl,log:{}});
 return {calls,ids,build,setExpired(v){expired=v;},setFail(v){fail=v;},setHold(v){hold=v;}};
}
async function pump(worker,store,id,max=1000){for(let i=0;i<max && store.history.status(id).status!=='complete';i++){worker.tick();await worker.drain();}assert.equal(store.history.status(id).status,'complete');}
test('full Gmail archive exceeds 1000 threads, resumes from disk, preserves live cursor/drafts and deduplicates overlapping pages',async t=>{
 const f=fixture(t),g=gmail(f),sync=g.build(),connection=sync.connect({profileId:'perso',name:'Synthetic Gmail',windowDays:7,refreshToken:'fake',email:'owner@example.test',scopes:[GMAIL_SCOPES.read]});await connection.job;const id=connection.account.id;
 assert.equal(f.store.countThreads(id).threads,1);const row=f.db.prepare('SELECT id FROM messages WHERE account_id=?').get(id);f.store.saveDraft(row.id,'Keep this draft');
 f.store.history.start(id);let worker=createHistoryWorker({store:f.store,providers:{gmail:{sync}},intervalMs:999999});worker.start();for(let i=0;i<14;i++){worker.tick();await worker.drain();}await worker.stop();const before=f.store.history.status(id);assert.ok(before.done>0);f.reopen();
 worker=createHistoryWorker({store:f.store,providers:{gmail:{sync:g.build()}},intervalMs:999999});worker.start();await pump(worker,f.store,id);await worker.stop();assert.equal(f.store.countThreads(id).threads,1103);assert.equal(f.store.history.status(id).discovered,1103);assert.equal(f.store.history.status(id).done,1103);assert.equal(f.store.getSync(id).history_id,'live-100');assert.equal(f.db.prepare('SELECT draft_text FROM messages WHERE id=?').get(row.id).draft_text,'Keep this draft');
 const job=f.store.history.get(id);f.store.history.start(id);assert.equal(f.store.history.get(id).job_id,job.job_id,'completed import is idempotent');assert.equal(g.calls.filter(c=>!['GET'].includes(c.method)).length,0,'no provider writes or sends');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM (SELECT account_id,external_id FROM messages GROUP BY account_id,external_id HAVING COUNT(*)>1)').get().n,0);
});
test('pause, 429 retry, stale identity and expired checkpoint retain durable deduplication',async t=>{
 const f=fixture(t),g=gmail(f,10),sync=g.build(),c=sync.connect({profileId:'perso',name:'Synthetic Gmail',windowDays:7,refreshToken:'fake',email:'owner@example.test'});await c.job;const id=c.account.id;f.store.history.start(id);const job=f.store.history.get(id);
 f.store.history.page(job,{ids:['t00000','t00000','t00001'],next:'next'});assert.equal(f.store.history.status(id).discovered,2);f.store.history.applied(job,['t00000']);f.store.history.applied(job,['t00000']);assert.equal(f.store.history.status(id).done,1);
 f.store.history.pause(id);assert.equal(f.store.history.page(job,{ids:['t00002'],next:null}),false);assert.equal(f.store.history.due().length,0);f.store.history.start(id);
 g.setFail(true);const worker=createHistoryWorker({store:f.store,providers:{gmail:{sync}},intervalMs:999999});worker.start();await worker.drain();assert.equal(f.store.history.status(id).status,'retrying');assert.ok(f.store.history.status(id).retryAt>Date.now());assert.equal(f.store.history.status(id).done,1);assert.equal(f.store.history.due().length,0);g.setFail(false);
 f.store.history.restart(f.store.history.get(id));assert.equal(f.store.history.get(id).cursor,null);assert.equal(f.store.history.status(id).done,0);f.store.history.start(id);assert.equal(f.store.history.page(job,{ids:['stale'],next:'stale'}),false,'a pre-reset operation cannot overwrite the checkpoint');await pump(worker,f.store,id);await worker.stop();assert.equal(f.store.countThreads(id).threads,10);
 const previous=f.store.history.get(id);f.db.prepare('UPDATE accounts SET address=? WHERE id=?').run('other@example.test',id);assert.equal(f.store.history.current(previous),false);f.store.history.start(id);assert.notEqual(f.store.history.get(id).job_id,previous.job_id);f.store.deleteAccount(id);assert.equal(f.store.history.get(id),undefined);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mail_history_items').get().n,0);
});
test('pausing while provider fetch is pending prevents archive writes and checkpoint advancement',async t=>{
 const f=fixture(t),g=gmail(f,10),sync=g.build(),c=sync.connect({profileId:'perso',name:'Synthetic Gmail',windowDays:7,refreshToken:'fake',email:'owner@example.test'});await c.job;const id=c.account.id;f.store.history.start(id);f.store.history.page(f.store.history.get(id),{ids:['t00000'],next:null});
 let release,entered;const waiting=new Promise(r=>entered=r),hold=new Promise(r=>release=r);g.setHold(async()=>{entered();await hold;});const worker=createHistoryWorker({store:f.store,providers:{gmail:{sync}},intervalMs:999999});worker.start();await waiting;f.store.history.pause(id);release();await worker.drain();assert.equal(f.store.history.status(id).done,0);assert.equal(f.store.countThreads(id).threads,1);await worker.stop();
});
test('Outlook full baseline imports old sent/archived mail and preserves removals and live delta after adoption',async t=>{
 const f=setupOutlook();t.after(()=>f.db.close());const old=f.ms.add({conversationId:'old-archive',parentFolderId:'F-archive',receivedDateTime:'2013-01-01T00:00:00Z',subject:'Old archive'});f.ms.add({conversationId:'old-sent',parentFolderId:'F-sent',receivedDateTime:'2012-01-01T00:00:00Z',subject:'Old sent'});const a=await connectedOutlook(f);
 assert.ok(!f.db.prepare('SELECT 1 FROM messages WHERE external_id=? AND account_id=?').get('old-archive',a.id));f.store.history.start(a.id);const worker=createHistoryWorker({store:f.store,providers:{outlook:{sync:f.sync}},intervalMs:999999});worker.start();await pump(worker,f.store,a.id);await worker.stop();assert.ok(f.db.prepare('SELECT 1 FROM messages WHERE external_id=? AND account_id=?').get('old-archive',a.id));
 const cursor=JSON.parse(f.store.getSync(a.id).history_id);assert.equal(cursor.ids[old.id],'old-archive');f.ms.add({conversationId:'new-after-import',subject:'New arrival'});await f.sync.syncNow(a.id);assert.ok(f.db.prepare('SELECT 1 FROM messages WHERE external_id=? AND account_id=?').get('new-after-import',a.id));assert.equal(f.ms.sent.length,0);
 const publicState=f.store.history.status(a.id);assert.ok(!JSON.stringify(publicState).includes('deltaLink'));assert.ok(!('cursor' in publicState));
});
test('expired Gmail page token restarts enumeration and completed archives reconcile after live cursor expiry',async t=>{
 const f=fixture(t),g=gmail(f,3),sync=g.build(),c=sync.connect({profileId:'perso',name:'Synthetic Gmail',windowDays:7,refreshToken:'fake',email:'owner@example.test'});await c.job;const id=c.account.id;f.store.history.start(id);f.store.history.page(f.store.history.get(id),{ids:[],next:'expired'});
 const worker=createHistoryWorker({store:f.store,providers:{gmail:{sync:{...sync,historyPage:async()=>{throw Object.assign(new Error(),{code:'archive_cursor_expired'});}}}},intervalMs:999999});worker.start();await worker.drain();await worker.stop();assert.equal(f.store.history.get(id).cursor,null);assert.equal(f.store.history.status(id).status,'retrying');
 const realWorker=createHistoryWorker({store:f.store,providers:{gmail:{sync}},intervalMs:999999});f.store.history.start(id);realWorker.start();await pump(realWorker,f.store,id);await realWorker.stop();g.setExpired(true);await sync.syncNow(id);assert.equal(f.store.history.status(id).status,'retrying','expired live cursor schedules full archive reconciliation');
});
test('Outlook keeps live tracking for deeply nested folders and recovers if an archive folder disappears',async t=>{
 const f=setupOutlook();t.after(()=>f.db.close());for(let i=1;i<=7;i++)f.ms.folders.push({id:'deep'+i,displayName:'Depth '+i,parentFolderId:i===1?'F-inbox':'deep'+(i-1)});
 const old=f.ms.add({conversationId:'deep-old',parentFolderId:'deep7',receivedDateTime:'2011-01-01T00:00:00Z'});const a=await connectedOutlook(f);f.store.history.start(a.id);const worker=createHistoryWorker({store:f.store,providers:{outlook:{sync:f.sync}},intervalMs:999999});worker.start();await pump(worker,f.store,a.id);await worker.stop();
 assert.ok(JSON.parse(f.store.getSync(a.id).history_id).links.deep7);f.ms.add({conversationId:'deep-new',parentFolderId:'deep7'});await f.sync.syncNow(a.id);assert.ok(f.db.prepare('SELECT 1 FROM messages WHERE external_id=? AND account_id=?').get('deep-new',a.id));assert.ok(JSON.parse(f.store.getSync(a.id).history_id).links.deep7);
 f.ms.hardDelete(old);await f.sync.syncNow(a.id);assert.equal(f.db.prepare('SELECT 1 FROM messages WHERE external_id=? AND account_id=?').get('deep-old',a.id),undefined);
 await assert.rejects(f.sync.historyPage(a.id,{folders:['vanished-folder'],index:0,link:null,links:{}}),{code:'archive_cursor_expired'});
});
test('history controls return immediately, expose only progress and reject other channels/actions',async t=>{
 const {createApp}=await import('../src/http/app.js');const f=fixture(t),a=f.store.upsertAccount('perso',{name:'Test Gmail',svc:'gmail',channel:'email',address:'owner@example.test'}),wa=f.store.upsertAccount('perso',{name:'Test WA',svc:'whatsapp',channel:'whatsapp',address:'+33600000000'});
 const server=createApp({store:f.store,ai:{configured:false},providers:{gmail:{sync:{permissions:()=>['read'],historyPage:()=>{throw new Error('must not run in request');}}},whatsapp:{sync:{permissions:()=>['read'],progress:()=>null}}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 const post=(id,action)=>fetch(`${base}/api/accounts/${id}/history`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
 const started=await post(a.id,'start');assert.equal(started.status,200);assert.equal((await started.json()).status,'running');const snapshot=await (await fetch(base+'/api/state?paged=1&profile=perso')).json(),account=snapshot.profiles.flatMap(p=>p.accounts).find(x=>x.id===a.id);assert.equal(account.history.done,0);assert.ok(!('job_id' in account.history));assert.equal((await post(a.id,'pause')).status,200);assert.equal(f.store.history.status(a.id).status,'paused');assert.equal((await post(a.id,'delete')).status,400);assert.equal((await post(wa.id,'start')).status,400);
});
test('a live Outlook reset mid-import fences queued archive work and reconciles already processed old conversations',async t=>{
 const f=setupOutlook();t.after(()=>f.db.close());const old=f.ms.add({conversationId:'old-mid-reset',parentFolderId:'F-inbox',receivedDateTime:'2010-01-01T00:00:00Z'}),a=await connectedOutlook(f);f.store.history.start(a.id);const worker=createHistoryWorker({store:f.store,providers:{outlook:{sync:f.sync}},intervalMs:999999});worker.start();await worker.drain();worker.tick();await worker.drain();const job=f.store.history.get(a.id);assert.equal(job.done,1);assert.equal(job.enumerated,0);
 f.ms.expireDelta=true;await f.sync.syncNow(a.id);f.ms.expireDelta=false;const reset=f.store.history.get(a.id);assert.notEqual(reset.job_id,job.job_id);assert.equal(reset.done,0);assert.equal(f.store.history.current(job),false);assert.equal(f.store.history.page(job,{ids:['stale'],next:null}),false);
 f.ms.hardDelete(old);f.store.history.start(a.id);await pump(worker,f.store,a.id);await f.sync.syncNow(a.id);await worker.stop();assert.equal(f.db.prepare('SELECT 1 FROM messages WHERE account_id=? AND external_id=?').get(a.id,'old-mid-reset'),undefined);
});
