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
 const api={session:async()=>({enabled:false}),state:async()=>{snapshots++;if(failSnapshot){failSnapshot=false;throw new Error('Réseau temporaire');}return structuredClone(data)},startWhatsAppLink:input=>new Promise((resolve,reject)=>requests.push({resolve,reject,input})),cancelWhatsAppLink:async id=>{cancelled.push(id)},whatsAppLink:async()=>({status:'qr',qrDataUrl:'fake'})};
 const c={api,patch:()=>{if(nextTimeline!==undefined){timeline=nextTimeline;nextTimeline=undefined}},delegate:()=>{},renderApp:()=>'',NAV:[['all','Boîte']],GROUPS:[['all','Tous']],SETTINGS:{},WINDOWS:[7,30,90],
  localStorage:{getItem:()=>null,setItem:()=>{}},document:{querySelector:()=>null,getElementById:()=>root,addEventListener:()=>{}},requestAnimationFrame:fn=>fn(),queueMicrotask,setTimeout:()=>1,clearTimeout:()=>{},setInterval:fn=>{intervals.push(fn);return intervals.length},clearInterval:()=>{},URLSearchParams,location:{search:''},history:{replaceState:()=>{}},console};
 vm.createContext(c);
 vm.runInContext(readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')+'\nglobalThis.inspect=()=>state;globalThis.act=actions;globalThis.redraw=render;globalThis.refreshData=applyData;globalThis.refreshDetails=loadDetails;',c);
 await tick();
 const open=()=>{c.act.openConnect();c.act.pickService({svc:'whatsapp'})};
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

test('liaison UI : QR direct, profil courant et aucun champ de numéro',async()=>{
 const u=await ui();u.open();assert.equal(u.c.inspect().c.step,'auth');assert.equal(u.requests.length,1);
 assert.equal(u.requests[0].input.profileId,'anove');assert.equal(u.requests[0].input.name,'WhatsApp');assert.equal('expectedPhone' in u.requests[0].input,false);
});

test('reconnexion UI : QR direct pour le compte existant sans saisie du numéro',async()=>{
 const u=await ui();u.c.openWizard('whatsapp','Ancien',{id:7,address:null});
 assert.equal(u.c.inspect().c.step,'auth');assert.equal(u.requests.length,1);assert.equal(u.requests[0].input.accountId,7);assert.equal(u.requests[0].input.reconnect,true);
});

test('liaison UI : nom automatique distinct pour ajouter un autre compte',async()=>{
 const u=await ui();u.c.inspect().data.profiles[0].accounts.push({name:'WhatsApp'},{name:'WhatsApp 2'});
 u.open();assert.equal(u.requests[0].input.name,'WhatsApp 3');
});

test('older loaded WhatsApp pages refresh reactions without losing history or local quote',async()=>{
 const u=await ui(),s=u.c.inspect(),m={id:42,p:'anove',accountId:1,channel:'whatsapp',sortAt:100,count:100};
 s.data.messages.push(m);s.selectedId=42;s.details[42]={...m,waId:'latest',body:'new',at:100,trail:[{id:'old',waId:'old',at:1,body:'old',reactions:[]}],history:{hasMore:false}};
 u.api.message=async()=>({...m,waId:'latest',body:'new',at:100,trail:[],draft:null});
 let emoji='👍';u.api.whatsAppInteractions=async(id,ids)=>{assert.equal(id,42);assert.deepEqual([...ids],['old']);return [{waId:'old',reactions:emoji?[{emoji,count:1,mine:true}]:[]}];};
 for(const value of ['👍','❤️','']){emoji=value;s.details[42].refreshing=true;await u.c.refreshDetails(42);const old=u.c.inspect().details[42].trail[0];assert.equal(old.body,'old');assert.equal(old.reactions.length,emoji?1:0);if(emoji)assert.equal(old.reactions[0].emoji,emoji);}
});

test('WhatsApp group UI allows quoted reply and reaction while preserving confirmation lock',async()=>{
 const u=await ui(),s=u.c.inspect(),m={id:42,p:'anove',accountId:1,channel:'whatsapp',group:true,waId:'g1',sortAt:100,count:1,body:'Bonjour groupe',trail:[]};
 s.data.messages.push(m);s.selectedId=42;s.details[42]=m;
 u.c.act.waReply({id:'g1'});assert.equal(u.c.inspect().draftMeta[42].localReplyTo,'g1');
 let sent=0;u.api.reactWhatsApp=async(id,input)=>{assert.equal(id,42);assert.equal(input.messageId,'g1');assert.equal(input.emoji,'👍');sent++;};u.api.message=async()=>m;
 await u.c.act.waReact({id:'g1',emoji:'👍'});assert.equal(sent,1);
 s.confirm={kind:'send'};u.c.act.waReplyCancel();await u.c.act.waReact({id:'g1',emoji:'👍'});assert.equal(sent,1);assert.equal(u.c.inspect().draftMeta[42].localReplyTo,'g1');
});

test('group @ suggestions support keyboard selection and keep mention bindings aligned through edits',async()=>{
 const u=await ui(),s=u.c.inspect(),m={id:42,p:'anove',accountId:1,channel:'whatsapp',group:true,waId:'g1',sortAt:100,count:1,body:'Bonjour',trail:[],draftVersion:1};
 s.data.messages.push(m);s.selectedId=42;s.details[42]=m;let calls=0;
 u.api.whatsAppParticipants=async()=>{calls++;return {scope:undefined,members:[{jid:'33611111111@s.whatsapp.net',name:'Alice',phone:'+33611111111',token:'@33611111111'},{jid:'33622222222@s.whatsapp.net',name:'Bob',phone:'+33622222222',token:'@33622222222'}]};};
 const type=value=>u.c.act.draft({}, {target:{value,selectionStart:value.length,selectionEnd:value.length}});
 type('@');await tick();assert.equal(calls,1);assert.equal(u.c.inspect().waMention.query,'');
 const editor={value:'@',focus(){},setSelectionRange(){}};u.c.document.querySelector=()=>editor;
 let prevented=0;u.c.act.waMentionKeys({}, {key:'ArrowDown',preventDefault(){prevented++;}});u.c.act.waMentionKeys({}, {key:'Enter',preventDefault(){prevented++;}});
 assert.equal(prevented,2);assert.equal(editor.value,'@33622222222 ','focused textarea receives the inserted token');assert.equal(u.c.inspect().drafts[42],'@33622222222 ');assert.equal(u.c.inspect().draftMeta[42].localMentions[0].name,'Bob');
 type('😊 '+u.c.inspect().drafts[42]);assert.equal(u.c.inspect().draftMeta[42].localMentions[0].start,3);
 type('😊 @3362222222 ');assert.equal(u.c.inspect().draftMeta[42].localMentions.length,0,'edited token loses notification binding');
 type('@ali');await tick();assert.equal(calls,1,'participant lookup cached while typing');u.c.act.waMentionSelect({jid:'33611111111@s.whatsapp.net'});assert.equal(u.c.inspect().draftMeta[42].localMentions[0].name,'Alice');
 s.ai={forId:42,mode:'draft',result:{text:'Réponse IA'},loading:false};u.c.act.aiInsert();assert.equal(u.c.inspect().draftMeta[42].localMentions.length,0,'AI replacement never inherits old notification recipients');
});

test('group suggestions never bind across conversation changes or while preview is locked',async()=>{
 const u=await ui(),s=u.c.inspect(),m={id:42,p:'anove',accountId:1,channel:'whatsapp',group:true,waId:'g1',sortAt:100,count:1,body:'Bonjour',trail:[]};s.data.messages.push(m);s.selectedId=42;s.details[42]=m;
 let resolve;u.api.whatsAppParticipants=()=>new Promise(r=>resolve=r);u.c.act.draft({}, {target:{value:'@',selectionStart:1,selectionEnd:1}});
 s.selectedId=43;resolve({scope:undefined,members:[{jid:'33611111111@s.whatsapp.net',name:'Alice',token:'@33611111111'}]});await tick();u.c.act.waMentionSelect({jid:'33611111111@s.whatsapp.net'});assert.equal(u.c.inspect().drafts[43],undefined);
 s.selectedId=42;s.confirm={kind:'send'};u.c.act.waMentionSelect({jid:'33611111111@s.whatsapp.net'});assert.equal(u.c.inspect().drafts[42],'@');
});
test('extending a selected numeric mention drops binding; replaced account never displays old suggestions',async()=>{
 const u=await ui(),s=u.c.inspect(),m={id:42,p:'anove',accountId:1,channel:'whatsapp',group:true,waId:'g1',sortAt:100,count:1,body:'Bonjour',trail:[],participantScope:'A',conversationIdentity:'old'};s.data.messages.push(m);s.selectedId=42;s.details[42]=m;
 const member={jid:'33611111111@s.whatsapp.net',name:'Private old name',token:'@33611111111'};let resolve;u.api.whatsAppParticipants=()=>new Promise(r=>resolve=r);
 const type=value=>u.c.act.draft({}, {target:{value,selectionStart:value.length,selectionEnd:value.length}});
 type('@');s.details[42]={...m,participantScope:'B',conversationIdentity:'new'};resolve({scope:'A',members:[member]});await tick();assert.equal(u.c.inspect().waParticipants[42],undefined);
 s.waParticipants[42]={scope:'A',conversationIdentity:'old',members:[member],loadedAt:Date.now()};u.c.act.waMentionSelect({jid:member.jid});assert.equal(u.c.inspect().drafts[42],'@','stale member cannot be picked');
 s.waParticipants[42]={scope:'B',conversationIdentity:'new',members:[member],loadedAt:Date.now()};u.c.act.waMentionSelect({jid:member.jid});
 type('@336111111119');assert.equal(u.c.inspect().draftMeta[42].localMentions.length,0);
});
test('late detail read cannot restore old participant scope after same-id conversation replacement',async()=>{
 const u=await ui(),s=u.c.inspect(),old={id:42,p:'anove',accountId:1,channel:'whatsapp',group:true,conversationIdentity:'old',participantScope:'scope-old',sortAt:100,count:1,trail:[],body:'Old private body'};
 s.data.messages.push(old);s.selectedId=42;s.details[42]={...old,refreshing:true};
 let resolve,calls=0;u.api.message=()=>{calls++;return calls===1?new Promise(r=>resolve=r):Promise.resolve({...old,conversationIdentity:'new',participantScope:'scope-new',body:'New conversation'});};
 const pending=u.c.refreshDetails(42);const fresh=structuredClone(s.data);fresh.messages[0]={...old,conversationIdentity:'new'};u.c.refreshData(fresh);resolve(old);await pending;await tick();
 assert.equal(u.c.inspect().details[42].conversationIdentity,'new');assert.equal(u.c.inspect().details[42].body,'New conversation');
});
