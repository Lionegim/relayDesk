import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const tick=()=>new Promise(r=>setImmediate(r));
async function ui() {
 const requests=[],cancelled=[],intervals=[];
 let timeline=null,nextTimeline;
 const root={querySelector:()=>timeline};
 const data={profiles:[{id:'anove',name:'Anove',accounts:[]},{id:'perso',name:'Personnel',accounts:[]}],messages:[],folders:[],contacts:[],services:{whatsapp:{name:'WhatsApp',auth:'qr',available:['read','drafts','send']}},integrations:{whatsapp:{configured:true}}};
 let snapshots=0,failSnapshot=false;
 const api={session:async()=>({enabled:false}),state:async()=>{snapshots++;if(failSnapshot){failSnapshot=false;throw new Error('Réseau temporaire');}return structuredClone(data)},startWhatsAppLink:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),cancelWhatsAppLink:async id=>{cancelled.push(id)},whatsAppLink:async()=>({status:'qr',qrDataUrl:'fake'})};
 const c={api,patch:()=>{if(nextTimeline!==undefined){timeline=nextTimeline;nextTimeline=undefined}},delegate:()=>{},renderApp:()=>'',NAV:[['all','Boîte']],GROUPS:[['all','Tous']],SETTINGS:{},WINDOWS:[7,30,90],
  localStorage:{getItem:()=>null,setItem:()=>{}},document:{getElementById:()=>root,addEventListener:()=>{}},queueMicrotask,setTimeout:()=>1,clearTimeout:()=>{},setInterval:fn=>{intervals.push(fn);return intervals.length},clearInterval:()=>{},URLSearchParams,location:{search:''},history:{replaceState:()=>{}},console};
 vm.createContext(c);
 vm.runInContext(readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')+'\nglobalThis.inspect=()=>state;globalThis.act=actions;globalThis.redraw=render;globalThis.refreshData=applyData;',c);
 await tick();
 const open=()=>{c.act.openConnect();c.act.pickService({svc:'whatsapp'});c.act.cPhone({}, {target:{value:'+33100000000'}});c.act.cNext();c.act.cNext()};
 return {c,api,requests,cancelled,intervals,open,failNextSnapshot:()=>{failSnapshot=true},draw:(before,after)=>{timeline=before;nextTimeline=after;c.redraw()}};
}
test('conversation WhatsApp : ouverture en bas, nouveaux messages suivis sans déplacer la lecture des anciens',async()=>{
 const u=await ui();
 const chat=(id,top,ready='true',height=1000)=>({dataset:{chatId:id,ready},scrollTop:top,clientHeight:200,scrollHeight:height});
 let after=chat('a',0);u.draw(null,after);assert.equal(after.scrollTop,1000);
 after=chat('a',100,'true',1200);u.draw(chat('a',100),after);assert.equal(after.scrollTop,100,'lecture ancienne préservée');
 after=chat('a',800,'true',1200);u.draw(chat('a',800),after);assert.equal(after.scrollTop,1200,'nouveaux messages suivis en bas');
 after=chat('b',0);u.draw(chat('a',100),after);assert.equal(after.scrollTop,1000,'nouveau fil ouvert en bas');
 after=chat('b',0);u.draw(chat('b',0,'false'),after);assert.equal(after.scrollTop,1000,'chargement initial terminé');
});
test('liaison UI : réponse ou erreur ancienne ne remplace pas une nouvelle fenêtre identique',async()=>{
 const u=await ui();u.open();u.c.act.closeConnect();u.open();
 u.requests[0].resolve({linkId:'old'});await tick();
 assert.equal(u.c.inspect().c.busy,true);assert.equal(u.c.inspect().c.linkId,undefined);assert.deepEqual(u.cancelled,['old']);
 u.requests[1].resolve({linkId:'new'});await tick();assert.equal(u.c.inspect().c.linkId,'new');
 u.c.act.closeConnect();u.open();u.c.act.closeConnect();u.open();
 u.requests[2].reject(new Error('Erreur ancienne'));await tick();assert.equal(u.c.inspect().c.busy,true);assert.equal(u.c.inspect().c.error,null);
});
test('liaison UI : snapshot temporairement indisponible après connexion est retenté par polling',async()=>{
 const u=await ui();u.api.whatsAppLink=async()=>({status:'connected',accountId:9,messages:3,threads:2});
 u.open();u.failNextSnapshot();u.requests[0].resolve({linkId:'active'});await tick();
 assert.equal(u.c.inspect().c.step,'auth');assert.match(u.c.inspect().c.error,/Réseau/);
 await u.intervals.at(-1)();await tick();assert.equal(u.c.inspect().c.step,'done');assert.equal(u.c.inspect().c.real.messages,3);
});

test('conversation WhatsApp : actualisation conserve les bulles jusqu’au chargement, puis réessaie après erreur',async()=>{
 const u=await ui(),s=u.c.inspect();
 const m={id:42,p:'anove',accountId:1,channel:'whatsapp',sortAt:100,count:2};
 s.data.messages.push(m);s.selectedId=42;s.details[42]={...m,body:'Ancien message',trail:[{body:'Historique'}]};
 let resolve,reject;u.api.message=()=>new Promise((a,b)=>{resolve=a;reject=b});
 const data=structuredClone(s.data);data.messages[0].sortAt=200;data.messages[0].count=3;
 u.c.refreshData(data);await tick();
 assert.equal(s.details[42].body,'Ancien message');assert.equal(s.details[42].refreshing,true);assert.equal(s.details[42].failed,undefined);
 reject(new Error('Coupure'));await tick();assert.equal(s.details[42].body,'Ancien message');assert.equal(s.details[42].stale,true);assert.equal(s.details[42].refreshing,false);
 u.c.refreshData(structuredClone(s.data));await tick();assert.equal(s.details[42].refreshing,true);
 resolve({...m,sortAt:200,count:3,body:'Nouveau message',trail:[{body:'Historique'}]});await tick();
 assert.equal(s.details[42].body,'Nouveau message');assert.equal(s.details[42].refreshing,undefined);
});

test('mémoire UI : pause invalide la proposition et une réponse tardive ne modifie pas une autre sélection',async()=>{
 const u=await ui(),s=u.c.inspect();s.data.messages=[{id:1,p:'anove',channel:'whatsapp',sortAt:1,count:1}];s.selectedId=1;
 s.details[1]={replyMemory:{available:true,enabled:true,sampleCount:1}};
 s.ai={forId:1,mode:'draft',result:{text:'Ancienne proposition'},loading:false};
 let finish;u.api.changeReplyMemory=()=>new Promise(r=>finish=r);
 const job=u.c.act.aiMemoryToggle();assert.equal(u.c.inspect().ai.result,null);assert.equal(u.c.inspect().ai.memoryBusy,true);
 u.c.act.aiClose();finish({available:true,enabled:false,sampleCount:1});await job;
 assert.equal(u.c.inspect().ai,null,'la fermeture du panneau ne le rouvre pas');
 s.ai={forId:1,mode:'draft',result:{text:'Ancienne proposition'},loading:false};s.details[1].replyMemory.enabled=true;
 u.api.changeReplyMemory=async()=>({available:true,enabled:false,sampleCount:1});await u.c.act.aiMemoryToggle();
 assert.equal(u.c.inspect().details[1].replyMemory.enabled,false);assert.equal(u.c.inspect().ai.result,null);
});

test('liaison UI : aucun QR sans confirmation du numéro international',async()=>{
 const u=await ui();u.c.act.openConnect();u.c.act.pickService({svc:'whatsapp'});u.c.act.cNext();
 assert.equal(u.c.inspect().c.step,'config');assert.equal(u.requests.length,0);
 u.c.act.cPhone({}, {target:{value:'0612345678'}});u.c.act.cNext();assert.equal(u.requests.length,0);
});

test('reconnexion UI : un ancien compte sans numéro reste modifiable',async()=>{
 const u=await ui();u.c.openWizard('whatsapp','Ancien',{id:7,address:null});
 assert.equal(u.c.inspect().c.phoneLocked,false);
 u.c.act.cPhone({}, {target:{value:'+33100000000'}});u.c.act.cNext();assert.equal(u.c.inspect().c.step,'auth');
 u.c.openWizard('whatsapp','Existant',{id:8,address:'+33100000000'});assert.equal(u.c.inspect().c.phoneLocked,true);
});
