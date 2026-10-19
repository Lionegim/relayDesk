import {randomUUID} from 'node:crypto';
import {transaction} from '../db/index.js';
import {badRequest,notFound} from '../http/errors.js';
import {timelineQuery} from './timeline.js';
import {normalizeIdentity} from './identity.js';
const DAY=86400000;
export function createContactNetwork(db,{people,unified,changed=()=>{}}) {
 const q=s=>db.prepare(s);
 const scope=p=>{if(p!=='all' && !q('SELECT 1 FROM profiles WHERE id=?').get(p))throw notFound('Profil introuvable');};
 const list=p=>{scope(p);return p==='all'?unified.list():people.list().filter(c=>c.p===p);};
 function groups(p,contacts=list(p)) {
  return q('SELECT * FROM person_groups WHERE scope=? ORDER BY created_at,id').all(p).map(g=>({...g,members:contacts.filter(c=>c.members.some(m=>q('SELECT 1 FROM person_group_members WHERE group_id=? AND contact_id=?').get(g.id,m.id))).map(c=>c.id)}));
 }
 const group=(p,id)=>{scope(p);return q('SELECT * FROM person_groups WHERE scope=? AND id=?').get(p,id) || (()=>{throw notFound('Groupe introuvable');})();};
 return {groups,
  save(p,input,id=null) {
   scope(p);if(!input || typeof input.name!=='string' || !input.name.trim() || input.name.trim().length>80)throw badRequest('Nom du groupe requis (80 caractères maximum)');
   if(id)group(p,id);else id=randomUUID();
   const name=input.name.trim(),other=q('SELECT id FROM person_groups WHERE scope=? AND name=? AND id!=?').get(p,name,id);if(other)throw badRequest('Ce nom de groupe existe déjà');
   q('INSERT INTO person_groups VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id,p,name,Date.now());changed();return groups(p).find(g=>g.id===id);
  },
  membership(p,id,personId,on) {
   group(p,id);if(typeof on!=='boolean')throw badRequest('Appartenance invalide');const person=list(p).find(c=>c.id===personId);if(!person)throw notFound('Personne introuvable dans ce profil');
   transaction(db,()=>{for(const m of person.members){if(on)q('INSERT OR IGNORE INTO person_group_members VALUES (?,?)').run(id,m.id);else q('DELETE FROM person_group_members WHERE group_id=? AND contact_id=?').run(id,m.id);}});changed();return groups(p);
  },
  network(p,{days=90,now=Date.now()}={}) {
   if(![30,90,365].includes(days))throw badRequest('Période invalide');const contacts=list(p),owners=new Map();
   for(const c of contacts)for(const i of c.identities){const k=i.kind+':'+i.normalized;owners.set(k,(owners.get(k)||0)+1);}
   const own=new Set();for(const a of q('SELECT address FROM accounts').all())for(const kind of ['email','phone']){const n=normalizeIdentity(kind,a.address);if(n)own.add(kind+':'+n);}
   const since=now-days*DAY;
   const nodes=contacts.map(c=>{
    const keys=c.identities.filter(i=>!i.needsCountryCode && !own.has(i.kind+':'+i.normalized) && owners.get(i.kind+':'+i.normalized)===1).map(i=>({kind:i.kind,normalized:i.normalized}));
    const direct=c.members.map(m=>q('SELECT account_id,external_id FROM contacts WHERE id=?').get(m.id));
    const query=timelineQuery(db,{keys,direct,profile:p==='all'?null:p});
    const rows=query.all('m.id,m.account_id,m.external_id,m.channel,m.sort_at,m.trail,m.reply_meta','AND m.sort_at>=? AND m.sort_at<=?',[since,now]);
    let count=0,score=0,lastAt=null;const seen=new Set();
    const add=(key,at)=>{if(!Number.isFinite(at)||at<since||at>now||seen.has(key))return;seen.add(key);count++;score+=Math.pow(2,-(now-at)/(days*DAY/3));lastAt=Math.max(lastAt || 0,at);};
    for(const m of rows){if(m.channel==='whatsapp'){
      if(!/^\d+@(s\.whatsapp\.net|lid)$/.test(m.external_id || ''))continue;
      for(const w of q('SELECT msg_id,ts FROM whatsapp_messages WHERE account_id=? AND chat_jid=? AND ts>=? AND ts<=?').all(m.account_id,m.external_id,since,now))add(m.account_id+':'+w.msg_id,w.ts);
     }else{let meta={};try{meta=JSON.parse(m.reply_meta || '{}');}catch{}add(m.account_id+':latest:'+m.id,meta.at);for(const t of JSON.parse(m.trail || '[]'))add(m.account_id+':'+(t.id || JSON.stringify([t.at,t.from,t.body])),t.at);}
    }
    return {id:c.id,name:c.name,messages:count,score:Math.round(score*100)/100,lastAt,band:score>=12?'frequent':score>=3?'regular':count?'occasional':'inactive'};
   }).sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
   const coverage=q('SELECT id,name,svc FROM accounts WHERE '+(p==='all'?'1=1':'profile_id=?')+' ORDER BY position,id').all(...(p==='all'?[]:[p])).filter(a=>['gmail','outlook','whatsapp'].includes(a.svc)).map(a=>{
    const firstAt=a.svc==='whatsapp'?q('SELECT MIN(ts) at FROM whatsapp_messages WHERE account_id=? AND ts>0 AND ts<=?').get(a.id,now).at:q('SELECT MIN(sort_at) at FROM messages WHERE account_id=? AND sort_at>0 AND sort_at<=? AND compose_kind!=\'new\'').get(a.id,now).at;
    const history=a.svc==='whatsapp'?null:q('SELECT status FROM mail_history_imports WHERE account_id=?').get(a.id)?.status;
    return {id:a.id,name:a.name,svc:a.svc,firstAt,complete:history==='complete',importing:['running','retrying'].includes(history),partial:a.svc==='whatsapp'};
   });
   return {days,since,asOf:now,nodes,coverage,groups:groups(p,contacts)};
  },
 };
}
