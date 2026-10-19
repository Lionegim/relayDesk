import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { html,raw,when,cls } from '../public/js/dom.js';
const c=vm.createContext({html,raw,when,cls,ICON:{sparkle:'*',lines:'≡'},CH:{whatsapp:{label:'WhatsApp'}}});
vm.runInContext(readFileSync(new URL('../public/js/views.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.connect=s=>String(whatsappConnectDialog(s));globalThis.chat=(s,v,m)=>String(whatsappView(s,v,m));globalThis.list=(s,v)=>String(messageList(s,v));',c);
function render({send=true,text='Réponse locale',confirm=null,full=true,group=false}={}) {
 const m={id:9,accountId:3,channel:'whatsapp',from:'Moi (à Claire)',subject:'WhatsApp · Claire',initials:'C',account:'Téléphone',sortAt:Date.UTC(2026,9,18,13)};
 const details={...m,group,fromMe:true,at:m.sortAt,body:'DERNIER <script>danger()</script>',trail:[{from:'Alice',fromMe:false,at:m.sortAt-60000,body:'MILIEU'},{fromMe:true,at:m.sortAt-86400000,body:'PREMIER'}]};
 return c.chat({details:full?{9:full==='failed'?{failed:true,trail:[]}:details}:{},drafts:{9:text},data:{folders:[]},confirm},{profile:{accounts:[{id:3,perms:send?['send']:[]}]}},m);
}
test('vue WhatsApp : chronologie, sens des bulles, heures et texte échappé',()=>{
 const markup=render();
 assert.ok(markup.indexOf('PREMIER')<markup.indexOf('MILIEU')&&markup.indexOf('MILIEU')<markup.indexOf('DERNIER'));
 assert.match(markup,/wa-msg wa-out/);assert.match(markup,/wa-msg wa-in/);
 assert.match(markup,/datetime="2026-10-18T13:00:00.000Z"/);
 assert.match(markup,/DERNIER &lt;script&gt;danger\(\)&lt;\/script&gt;/);
 assert.match(markup,/data-chat-id="9" data-ready="true"/);
 assert.match(markup,/>Claire<\/strong>/);
 assert.match(markup,/data-on-click="sendPreview"/);assert.doesNotMatch(markup,/data-on-click="confirmSend"/);
 assert.match(markup,/data-key="draft-9" data-on-input="draft"/);
 assert.doesNotMatch(markup,/en ligne|Distribué|Lu à/);
});
test('vue WhatsApp : aperçu bloqué sans permission, au-delà de la limite et pendant confirmation',()=>{
 for(const options of [{send:false},{text:''},{text:'x'.repeat(4097)},{confirm:{kind:'send'}}])assert.match(render(options),/data-on-click="sendPreview"[^>]*disabled/);
 assert.match(render({full:false}),/data-ready="false"/);
});
test('vue WhatsApp : échec de chargement sans direction inventée',()=>{
 const markup=render({full:'failed'});
 assert.match(markup,/Discussion indisponible/);
 assert.doesNotMatch(markup,/wa-msg wa-in|wa-msg wa-out|Reçu :|Vous :/);
 assert.match(markup,/data-ready="false"/);
});

test('suivi WhatsApp : affiche attente ou erreur avec compteurs reçus, sans annoncer complet',()=>{
 const state={channel:'whatsapp',query:''};
 const view={byNav:[],list:[],inProfile:[],profile:{name:'Personnel',accounts:[{id:3,name:'Téléphone',svc:'whatsapp',sync:{status:'syncing',threads:4,messages:29}}]}};
 let markup=c.list(state,view);
 assert.match(markup,/Récupération de l’historique/);assert.match(markup,/4 conversations · 29 messages/);
 assert.match(markup,/data-on-click="accountSync"[^>]*disabled/);
 view.profile.accounts[0].sync={status:'partial',error:'Historique partiel : téléphone indisponible',threads:4,messages:29};
 markup=c.list(state,view);assert.match(markup,/Historique partiel/);assert.doesNotMatch(markup,/Synchronisation complète/);
});

test('vue groupe WhatsApp : auteur visible et aperçu d’envoi désactivé',()=>{
 const markup=render({group:true});assert.match(markup,/wa-author">Alice/);assert.match(markup,/Claire · Groupe/);
 assert.match(markup,/Groupe : lecture et IA/);assert.match(markup,/data-on-click="sendPreview"[^>]*disabled/);
});

test('connexion WhatsApp : écran QR sans formulaire ni étapes de configuration',()=>{
 const markup=c.connect({c:{step:'auth',svc:'whatsapp',profile:'perso',linkId:'test',link:{status:'qr',qrDataUrl:'data:image/png;base64,dGVzdA=='}},data:{profiles:[{id:'perso',name:'Personnel'}]}});
 assert.match(markup,/QR code pour connecter WhatsApp/);assert.match(markup,/identifié automatiquement/);assert.match(markup,/Personnel/);
 assert.doesNotMatch(markup,/<input|Numéro WhatsApp|Permissions|dialog-steps/);assert.match(markup,/approbation de l’aperçu exact/);
});
