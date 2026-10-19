import {personTimeline} from './timeline.js';
import {randomUUID,createHash} from 'node:crypto';
import {transaction} from '../db/index.js';
import {badRequest,notFound,HttpError} from '../http/errors.js';
import {normalizeIdentity} from './identity.js';
import {parseAddressList} from '../mail/mime.js';
const clean=(v,max=200)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
export function createContactsRepository(db,changed=()=>{}) {
 const q=s=>db.prepare(s);
 const contact=(profile,id)=>q('SELECT * FROM contacts WHERE id=? AND profile_id=?').get(id,profile) || (()=>{throw notFound('Contact introuvable dans ce profil');})();
 const root=id=>q('SELECT person_id FROM contact_person_links WHERE contact_id=?').get(id)?.person_id || id;
 const members=id=>q('SELECT id FROM contacts WHERE id=? OR id IN (SELECT contact_id FROM contact_person_links WHERE person_id=?)').all(id,id).map(c=>c.id);
 function owners(profile,kind,value) {
  return new Set(q('SELECT c.id FROM contact_identities i JOIN contacts c ON c.id=i.contact_id WHERE c.profile_id=? AND i.kind=? AND i.normalized=?').all(profile,kind,value).map(c=>root(c.id))).size;
 }
 const identities=ids=>ids.flatMap(id=>q('SELECT kind,normalized,value.display_value AS value,source FROM contact_identities value WHERE contact_id=?').all(id));
 function indexMessage(id,items) {
  q('DELETE FROM message_identities WHERE message_id=?').run(id);
  for(const item of items || []) {const value=normalizeIdentity(item.kind,item.value);if(value)q('INSERT OR IGNORE INTO message_identities VALUES (?,?,?)').run(id,item.kind,value);}
 }
 function view(c) {
  const ids=members(c.id), records=ids.map(id=>q('SELECT * FROM contacts WHERE id=?').get(id));
  const unique=new Map();for(const x of identities(ids))unique.set(`${x.kind}:${x.normalized}`,{...x,needsCountryCode:x.normalized.startsWith('unresolved:'),sharedWith:owners(c.profile_id,x.kind,x.normalized)});
  return {id:c.id,p:c.profile_id,name:c.name,title:c.title,freq:c.freq,ch:[...new Set(records.flatMap(r=>JSON.parse(r.channels)))],last:c.last,g:[...new Set(records.flatMap(r=>JSON.parse(r.groups)))],order:c.position,identities:[...unique.values()],members:records.map(r=>({id:r.id,name:r.name,accountId:r.account_id})),sourceAccountIds:[...new Set(records.map(r=>r.account_id).filter(Boolean))]};
 }
 function timeline(profile,id,{offset=0,limit=50}={}) {
  contact(profile,id);id=root(id);contact(profile,id);
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw badRequest('Pagination invalide');
  const ids=members(id), keys=new Set(identities(ids).filter(x=>owners(profile,x.kind,x.normalized)===1).map(x=>`${x.kind}:${x.normalized}`));
  for(const a of q('SELECT address FROM accounts').all())for(const kind of ['email','phone']){const value=normalizeIdentity(kind,a.address);if(value)keys.delete(`${kind}:${value}`);}
  const legacy=ids.map(key=>q('SELECT account_id,external_id FROM contacts WHERE id=?').get(key));
  return personTimeline(db,{profile,keys:[...keys].map(key=>{const colon=key.indexOf(':');return {kind:key.slice(0,colon),normalized:key.slice(colon+1)};}),direct:legacy},{offset,limit});
 }
 return {
  indexMessage,
  backfill() {
   transaction(db,()=>{
    for(const m of q("SELECT m.id,m.channel,m.handle,m.reply_meta,m.external_id FROM messages m WHERE NOT EXISTS(SELECT 1 FROM message_identities x WHERE x.message_id=m.id)").all()) {
     const items=[];
     if(m.channel==='email') {let meta={};try{meta=JSON.parse(m.reply_meta || '{}');}catch{}
      for(const raw of [m.handle,meta.from,meta.to,meta.cc])for(const a of parseAddressList(raw))items.push({kind:'email',value:a.email});
     } else if(m.channel==='whatsapp' && /^\d+@s\.whatsapp\.net$/.test(m.external_id || ''))items.push({kind:'phone',value:'+'+m.external_id.split('@')[0]});
     indexMessage(m.id,items);
    }
    for(const c of q("SELECT id,external_id FROM contacts WHERE external_id LIKE '%@s.whatsapp.net'").all()) {
     const value=normalizeIdentity('phone','+'+c.external_id.split('@')[0]);if(value)q('INSERT OR IGNORE INTO contact_identities VALUES (?,?,?,?,?)').run(c.id,'phone',value,value,'whatsapp');
    }
   });
  },
  list:()=>q('SELECT * FROM contacts WHERE id NOT IN (SELECT contact_id FROM contact_person_links WHERE contact_id!=person_id) ORDER BY position,id').all().map(view),
  detail(profile,id,options) {const c=contact(profile,root(contact(profile,id).id));const person=view(c);const keys=new Set(person.identities.map(x=>`${x.kind}:${x.normalized}`));
   const candidates=this.list().filter(x=>x.p===profile && x.id!==c.id && x.identities.some(i=>!i.needsCountryCode && keys.has(`${i.kind}:${i.normalized}`))).slice(0,30).map(x=>({id:x.id,name:x.name,identities:x.identities}));
   return {...person,timeline:timeline(profile,c.id,options),candidates,merges:q('SELECT id,created_at FROM contact_merge_events WHERE profile_id=? AND target_id=? AND undone_at IS NULL ORDER BY created_at DESC').all(profile,c.id)};
  },
  import(accountId,records) {
   const a=q('SELECT * FROM accounts WHERE id=?').get(accountId);if(!a || !['gmail','outlook'].includes(a.svc))throw badRequest('Compte de contacts invalide');
   if(!Array.isArray(records)||records.length>20000)throw badRequest('Import trop volumineux');
   let imported=0;
   transaction(db,()=>{for(const r of records) {
    const external=clean(r.externalId,500);if(!external)continue;
    const externalId='addressbook:'+external;
    let c=q('SELECT id FROM contacts WHERE account_id=? AND external_id=?').get(accountId,externalId);
    const values=(r.identities || []).slice(0,100).map(x=>({...x,normalized:normalizeIdentity(x.kind,x.value) || (x.kind==='phone' && clean(x.value,254)?'unresolved:'+clean(x.value,254):null)})).filter(x=>x.normalized);
    const name=clean(r.name)||values[0]?.value||'Contact sans nom';
    if(!c){c={id:'ct-'+createHash('sha256').update(`${accountId}:${externalId}`).digest('hex').slice(0,32)};q("INSERT INTO contacts(id,profile_id,name,title,channels,position,account_id,external_id) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM contacts),?,?)").run(c.id,a.profile_id,name,clean(r.title),'["email"]',accountId,externalId);}
    else q('UPDATE contacts SET name=?,title=? WHERE id=?').run(name,clean(r.title),c.id);
    q('DELETE FROM contact_identities WHERE contact_id=? AND source=?').run(c.id,a.svc);
    for(const x of values)q('INSERT OR IGNORE INTO contact_identities VALUES (?,?,?,?,?)').run(c.id,x.kind,x.normalized,clean(x.value,254),a.svc);
    imported++;
   }});changed();return {imported,profileId:a.profile_id,accountId};
  },
  addIdentity(profile,id,input) {
   const c=contact(profile,root(contact(profile,id).id));const value=normalizeIdentity(input?.kind,input?.value);
   if(!value)throw badRequest('Adresse email ou téléphone international (+…) invalide');
   q('INSERT OR IGNORE INTO contact_identities VALUES (?,?,?,?,?)').run(c.id,input.kind,value,clean(input.value,254),'manual');changed();return this.detail(profile,c.id);
  },
  removeIdentity(profile,id,input) {
   const c=contact(profile,root(contact(profile,id).id));if(input?.source!=='manual')throw badRequest('Une identité importée reste liée à sa source');
   transaction(db,()=>{for(const member of members(c.id))q("DELETE FROM contact_identities WHERE contact_id=? AND kind=? AND normalized=? AND source='manual'").run(member,input.kind,input.normalized);});changed();return this.detail(profile,c.id);
  },
  merge(profile,target,source) {
   const a=contact(profile,root(contact(profile,target).id)),b=contact(profile,root(contact(profile,source).id));if(a.id===b.id)throw badRequest('Ces contacts sont déjà liés');
   const moved=members(b.id),event=randomUUID();
   transaction(db,()=>{for(const id of [...members(a.id),...moved])q('INSERT INTO contact_person_links VALUES (?,?) ON CONFLICT(contact_id) DO UPDATE SET person_id=excluded.person_id').run(id,a.id);
    q('INSERT INTO contact_merge_events VALUES (?,?,?,?,NULL,?)').run(event,profile,a.id,JSON.stringify({from:b.id,moved}),new Date().toISOString());
    q('INSERT INTO contact_link_history VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(event,'local',profile,q('SELECT name FROM profiles WHERE id=?').get(profile).name,a.id,b.id,a.name,b.name,JSON.stringify({from:b.id,moved}),new Date().toISOString());});changed();return this.detail(profile,a.id);
  },
  undo(profile,event) {
   const e=q('SELECT * FROM contact_merge_events WHERE id=? AND profile_id=? AND undone_at IS NULL').get(event,profile);if(!e)throw notFound('Fusion introuvable');
   const {from,moved}=JSON.parse(e.members);contact(profile,from);for(const id of moved)if(root(id)!==e.target_id)throw new HttpError(409,'Annule d’abord la fusion suivante de ces contacts.','merge_changed');
   transaction(db,()=>{for(const id of moved)q('UPDATE contact_person_links SET person_id=? WHERE contact_id=?').run(from,id);q('UPDATE contact_merge_events SET undone_at=? WHERE id=?').run(new Date().toISOString(),event);q('UPDATE contact_link_history SET undone_at=? WHERE id=?').run(new Date().toISOString(),event);});changed();return this.detail(profile,from);
  },
 };
}
