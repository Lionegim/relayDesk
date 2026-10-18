import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const tick=()=>new Promise(r=>setImmediate(r));
async function ui() {
 const requests=[],cancelled=[],intervals=[];
 const data={profiles:[{id:'anove',name:'Anove',accounts:[]},{id:'perso',name:'Personnel',accounts:[]}],messages:[],folders:[],contacts:[],services:{whatsapp:{name:'WhatsApp',auth:'qr',available:['read','drafts','send']}},integrations:{whatsapp:{configured:true}}};
 let snapshots=0,failSnapshot=false;
 const api={state:async()=>{snapshots++;if(failSnapshot){failSnapshot=false;throw new Error('Réseau temporaire');}return structuredClone(data)},startWhatsAppLink:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),cancelWhatsAppLink:async id=>{cancelled.push(id)},whatsAppLink:async()=>({status:'qr',qrDataUrl:'fake'})};
 const c={api,patch:()=>{},delegate:()=>{},renderApp:()=>'',NAV:[['all','Boîte']],GROUPS:[['all','Tous']],SETTINGS:{},WINDOWS:[7,30,90],
  localStorage:{getItem:()=>null,setItem:()=>{}},document:{getElementById:()=>({}),addEventListener:()=>{}},queueMicrotask,setTimeout:()=>1,clearTimeout:()=>{},setInterval:fn=>{intervals.push(fn);return intervals.length},clearInterval:()=>{},URLSearchParams,location:{search:''},history:{replaceState:()=>{}},console};
 vm.createContext(c);
 vm.runInContext(readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')+'\nglobalThis.inspect=()=>state;globalThis.act=actions;',c);
 await tick();
 const open=()=>{c.act.openConnect();c.act.pickService({svc:'whatsapp'});c.act.cNext();c.act.cNext()};
 return {c,api,requests,cancelled,intervals,open,failNextSnapshot:()=>{failSnapshot=true}};
}
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
