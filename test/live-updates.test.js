import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createApp} from '../src/http/app.js';
import {createLiveUpdates as serverLive} from '../src/http/live-updates.js';
import {createLiveUpdates as browserLive,ARCHIVE_REFRESH_MS} from '../public/js/live.js';
import {HttpError} from '../src/http/errors.js';
import {setupWhatsApp,pairAndOpen,msg,PEER,until} from './whatsapp-helpers.js';

const tick=()=>new Promise(setImmediate);
async function stream(res) {
  const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
  return {reader,async next(){
    while(!buffer.includes('\n\n')) { const part=await reader.read();if(part.done)return null;buffer+=decoder.decode(part.value,{stream:true}); }
    const i=buffer.indexOf('\n\n'),frame=buffer.slice(0,i);buffer=buffer.slice(i+2);return frame;
  }};
}

test('WhatsApp arrival pushes a private invalidation to two screens, without polling or sending',async t=>{
  const ctx=await setupWhatsApp();let revoked=false;
  const auth={origin:'https://relay.example.test',handle:async()=>false,
    requireSession(req){if(revoked || req.headers.cookie!=='test-owner')throw new HttpError(401,'Connexion requise','auth_required');return{id:'owner-session'};},assertMutation(){},assertRecent(){}};
  const server=createApp({store:ctx.store,ai:{configured:false},providers:{whatsapp:ctx.wa},auth});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeLiveUpdates();await new Promise(r=>server.close(r));ctx.wa.sync.stop();await ctx.wa.sync.drain();ctx.db.close();});
  assert.equal((await fetch(base+'/api/events')).status,401);
  assert.equal((await fetch(base+'/api/events',{headers:{cookie:'test-owner',origin:'https://attacker.example'}})).status,403);
  assert.equal((await fetch(base+'/api/events',{headers:{cookie:'test-owner','sec-fetch-site':'cross-site'}})).status,403);
  const open=()=>fetch(base+'/api/events',{headers:{cookie:'test-owner',origin:auth.origin,'sec-fetch-site':'same-origin'}});
  const a=await open(),b=await open();assert.match(a.headers.get('content-type'),/text\/event-stream/);assert.equal(a.headers.get('cache-control'),'no-store');
  const sa=await stream(a),sb=await stream(b);assert.match(await sa.next(),/event: connected/);assert.match(await sb.next(),/event: connected/);
  const linking=await ctx.wa.startLink({profileId:'perso',name:'WhatsApp fictif',windowDays:7});await until(()=>!!ctx.sockets.last());await pairAndOpen(ctx);
  await until(()=>ctx.wa.linkStatus(linking.linkId).status==='connected');
  // Drain connection metadata before the message under test.
  await sa.next();await sb.next();
  ctx.sockets.last().emit('messages.upsert',{type:'notify',messages:[msg('LIVE-1','Texte fictif privé, absent du flux',{ago:0})]});
  const fa=await sa.next(),fb=await sb.next();
  assert.equal(fa,'event: invalidate\ndata: {}');assert.equal(fb,fa);
  const row=ctx.db.prepare('SELECT id FROM messages WHERE external_id=?').get(PEER);
  assert.ok(row);assert.equal(ctx.store.getMessage(row.id).body,'Texte fictif privé, absent du flux');
  assert.equal(ctx.sockets.last().sent.length,0);
  revoked=true;
  ctx.store.saveDraft(row.id,'Un brouillon fictif ne doit pas être envoyé');
  assert.equal(await sa.next(),null,'revoked session is closed before another event');assert.equal(await sb.next(),null);
  assert.equal((await open()).status,401);
});

test('idle live streams revalidate without extending sessions; slow readers and shutdown are bounded',async()=>{
  let listener,valid=true,checks=0;
  const store={subscribe(fn){listener=fn;return()=>{listener=null;}}};
  const auth={origin:'https://relay.example.test',requireSession(req,options){assert.equal(options.touch,false);checks++;if(!valid)throw new Error();return{id:'s'};}};
  const live=serverLive({store,auth,heartbeatMs:10,maxClients:2,maxPerSession:1});
  const response=()=>Object.assign(new EventEmitter(),{frames:[],ended:false,writeHead(){},flushHeaders(){},write(frame){this.frames.push(frame);return true;},end(){this.ended=true;this.emit('close');}});
  const req={headers:{host:'relay.example.test',origin:auth.origin}};
  const res=response();live.connect(req,res,{id:'s'});
  assert.throws(()=>live.connect(req,response(),{id:'s'}),e=>e.status===429);
  valid=false;await until(()=>res.ended);assert.ok(checks>=2);
  valid=true;const slow=response();slow.write=()=>false;live.connect(req,slow,{id:'s'});assert.equal(slow.ended,true);
  const next=response();live.connect(req,next,{id:'s'});live.close();assert.equal(next.ended,true);assert.equal(listener,null);
});

class FakeSource {
  static instances=[];
  constructor(url){assert.equal(url,'/api/events');this.handlers={};FakeSource.instances.push(this);}
  addEventListener(name,fn){this.handlers[name]=fn;}
  emit(name){this.handlers[name]?.();}
  close(){this.closed=true;}
}
test('browser coalesces arrivals, follows an in-flight refresh, and catches up on reconnect',async()=>{
  let calls=0,release;
  const live=browserLive({EventSourceImpl:FakeSource,delayMs:0,canRefresh:()=>true,refresh:async()=>{calls++;if(calls===1)await new Promise(r=>{release=r;});}});
  live.start();const source=FakeSource.instances.at(-1);source.emit('connected');
  await until(()=>calls===1);source.emit('invalidate');source.emit('invalidate');await tick();release();
  await until(()=>calls===2);source.emit('error');assert.equal(live.connected,false);
  source.emit('connected');await until(()=>calls===3);assert.equal(live.connected,true);
  live.stop();assert.equal(source.closed,true);source.emit('invalidate');await tick();assert.equal(calls,3);
  live.start();FakeSource.instances.at(-1).emit('connected');await until(()=>calls===4);live.stop();
});
test('browser defers live changes during exact-preview confirmation and retries failed reads',async()=>{
  let blocked=true,calls=0;
  const live=browserLive({EventSourceImpl:FakeSource,delayMs:0,canRefresh:()=>!blocked,refresh:async()=>{calls++;if(calls===1)throw new Error('temporary network failure');}});
  live.start();const source=FakeSource.instances.at(-1);source.emit('connected');source.emit('invalidate');await tick();assert.equal(calls,0);
  blocked=false;live.invalidate();await until(()=>calls===2,2500);live.stop();
});
test('browser adapts refresh pacing during bulk imports and returns to the normal cadence afterward',async()=>{
 let bulk=true,calls=0;const pacing=[];
 const live=browserLive({EventSourceImpl:FakeSource,delayMs:()=>{pacing.push(bulk);return bulk?35:0;},canRefresh:()=>true,refresh:async()=>{calls++;}});live.start();const source=FakeSource.instances.at(-1);source.emit('connected');for(let i=0;i<50;i++)source.emit('invalidate');await tick();assert.equal(calls,0,'bulk progress is coalesced instead of flooding reads');await until(()=>calls===1);assert.deepEqual(pacing,[true]);bulk=false;source.emit('invalidate');await until(()=>calls===2);assert.deepEqual(pacing,[true,false]);live.stop();
});

// Six screens share one owner session; allow user actions within the 240/min API cap.
test('bulk refresh pacing stays below the shared session budget for six screens',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reads=0;const clients=[],sources=[];
 for(let i=0;i<6;i++){const live=browserLive({EventSourceImpl:FakeSource,delayMs:()=>ARCHIVE_REFRESH_MS,canRefresh:()=>true,refresh:async()=>{reads+=3;}});live.start();clients.push(live);sources.push(FakeSource.instances.at(-1));}
 for(let step=0;step<60000/ARCHIVE_REFRESH_MS;step++){for(const source of sources){source.emit('invalidate');source.emit('invalidate');}t.mock.timers.tick(ARCHIVE_REFRESH_MS);for(let n=0;n<5;n++)await Promise.resolve();}
 assert.equal(reads,216);assert.ok(reads<240,'even three reads per refresh leave room for user actions');for(const live of clients)live.stop();
});
test('server coalesces archive bursts for older open screens and restores ordinary live notices afterward',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let listener,bulk=true;const store={history:{active:()=>bulk},subscribe(fn){listener=fn;return()=>{};}};
 const live=serverLive({store}),res=Object.assign(new EventEmitter(),{frames:[],writeHead(){},flushHeaders(){},write(frame){this.frames.push(frame);return true;},end(){}});live.connect({headers:{host:'relay.example.test'}},res);const initial=res.frames.length;
 for(let i=0;i<1000;i++)listener();t.mock.timers.tick(4999);assert.equal(res.frames.length,initial);t.mock.timers.tick(1);assert.equal(res.frames.length,initial+1);assert.equal(res.frames.at(-1),'event: invalidate\ndata: {}\n\n');
 bulk=false;listener();t.mock.timers.tick(40);assert.equal(res.frames.length,initial+2);live.close();
});
