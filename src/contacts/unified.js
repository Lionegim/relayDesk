import {createContactFields} from './fields.js';
import {personTimeline} from './timeline.js';
import {randomUUID,createHash} from 'node:crypto';
import {badRequest,notFound} from '../http/errors.js';
import {normalizeIdentity} from './identity.js';
export function createUnifiedPeople(db,people,changed=()=>{}) {
 const q=s=>db.prepare(s);const fields=createContactFields(db,changed);
 const anchor=id=>{const c=q('SELECT c.profile_id,c.external_id,a.svc,lower(a.address) address FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.id=?').get(id);return c?createHash('sha256').update(JSON.stringify(c)).digest('hex'):null;};
 const validEdge=e=>{try{const a=JSON.parse(e.members).anchors;return !!a && a[e.target_id]===anchor(e.target_id) && a[e.source_id]===anchor(e.source_id);}catch{return false;}};
 function list(){const original=people.list(),byId=new Map(original.map(c=>[c.id,c])),memberRoot=new Map(original.flatMap(c=>c.members.map(m=>[m.id,c.id]))),parent=new Map(original.map(c=>[c.id,c.id]));const root=id=>{let r=id;while(parent.get(r)!==r)r=parent.get(r);return r;};
  for(const e of q("SELECT target_id,source_id,members FROM contact_link_history WHERE kind='unified' AND undone_at IS NULL ORDER BY created_at,rowid").all()){if(!validEdge(e))continue;const a=memberRoot.get(e.target_id),b=memberRoot.get(e.source_id);if(a && b && root(a)!==root(b))parent.set(root(b),root(a));}
  const groups=new Map();for(const c of original){const id=root(c.id);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(c);}
  const profiles=new Map(q('SELECT id,name FROM profiles').all().map(p=>[p.id,p.name]));
  const result=[...groups].map(([id,rows])=>{const primary=byId.get(id),identities=[...new Map(rows.flatMap(c=>c.identities).map(i=>[i.kind+':'+i.normalized,{...i}])).values()];return {...primary,fields:rows.flatMap(c=>c.fields || []),fieldsRevision:fields.revision(rows.flatMap(c=>c.members.map(m=>m.id))),avatarUrl:rows.find(c=>c.avatarUrl)?.avatarUrl || null,p:'all',mainProfileId:primary.p,localIds:rows.map(c=>c.id),members:rows.flatMap(c=>c.members.map(m=>({...m,p:c.p,profileName:profiles.get(c.p)}))),profiles:[...new Set(rows.map(c=>c.p))].map(p=>({id:p,name:profiles.get(p)})),identities,ch:[...new Set(rows.flatMap(c=>c.ch))],g:[...new Set(rows.flatMap(c=>c.g))],sourceAccountIds:[...new Set(rows.flatMap(c=>c.sourceAccountIds))]};});
  const counts=new Map();for(const c of result)for(const i of c.identities){const key=i.kind+':'+i.normalized;counts.set(key,(counts.get(key)||0)+1);}for(const c of result)for(const i of c.identities)i.sharedWith=counts.get(i.kind+':'+i.normalized);return result;
 }
 function person(id){const p=list().find(c=>c.id===id || c.members.some(m=>m.id===id));if(!p)throw notFound('Personne introuvable');return p;}
 function timeline(p,{offset=0,limit=50}={}){if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw badRequest('Pagination invalide');
  const owners=new Map();for(const c of list())for(const i of c.identities){const key=i.kind+':'+i.normalized;owners.set(key,(owners.get(key)||0)+1);}
  const keys=new Set(p.identities.filter(i=>!i.needsCountryCode && owners.get(i.kind+':'+i.normalized)===1).map(i=>i.kind+':'+i.normalized));for(const a of q('SELECT address FROM accounts').all())for(const kind of ['email','phone']){const value=normalizeIdentity(kind,a.address);if(value)keys.delete(kind+':'+value);}
  const direct=p.members.map(m=>q('SELECT account_id,external_id FROM contacts WHERE id=?').get(m.id));
  return personTimeline(db,{keys:[...keys].map(key=>{const colon=key.indexOf(':');return {kind:key.slice(0,colon),normalized:key.slice(colon+1)};}),direct},{offset,limit});
 }
 function history(scope='all'){if(scope!=='all' && !q('SELECT 1 FROM profiles WHERE id=?').get(scope))throw notFound('Profil introuvable');return q(`SELECT h.*,CASE WHEN h.kind='unified' THEN 1 ELSE EXISTS(SELECT 1 FROM contact_merge_events e WHERE e.id=h.id) END available FROM contact_link_history h ${scope==='all'?'':'WHERE h.scope=?'} ORDER BY h.created_at DESC,h.rowid DESC LIMIT 500`).all(...(scope==='all'?[]:[scope])).map(e=>{let origins={};try{origins=JSON.parse(e.members).origins || {};}catch{}return {...e,sourceProfiles:origins.source || [e.scope_name],targetProfiles:origins.target || [e.scope_name],available:e.kind==='unified'?Number(validEdge(e)):e.available,canUndo:(e.kind==='unified' || !!e.available) && !e.undone_at};});}
 return {list,history,
  addField(id,input){const p=person(id);fields.assert(p.members.map(m=>m.id),input.revision);if(input.fieldId)fields.update(p.members.map(m=>m.id),input.fieldId,input.field);else fields.write(p.id,input.field);return this.detail(p.id);},
  removeField(id,input){const p=person(id);fields.assert(p.members.map(m=>m.id),input.revision);fields.remove(p.members.map(m=>m.id),input.fieldId);return this.detail(p.id);},

  detail(id,options){const p=person(id);return {...p,timeline:timeline(p,options),candidates:[],merges:history().filter(e=>e.canUndo && p.members.some(m=>m.id===e.target_id)).map(e=>({id:e.id,created_at:e.created_at}))};},
  addIdentity(id,input){const p=person(id);people.addIdentity(p.mainProfileId,p.id,input);changed();return this.detail(p.id);},
  removeIdentity(id,input){const p=person(id);if(input?.source!=='manual')throw badRequest('Une identité importée reste liée à sa source');for(const m of p.members)q("DELETE FROM contact_identities WHERE contact_id=? AND kind=? AND normalized=? AND source='manual'").run(m.id,input.kind,input.normalized);changed();return this.detail(p.id);},
  merge(target,source){const a=person(target),b=person(source);if(a.id===b.id)throw badRequest('Ces personnes sont déjà liées');const event=randomUUID();q('INSERT INTO contact_link_history VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(event,'unified','all','Tous les profils',a.id,b.id,a.name,b.name,JSON.stringify({target:a.members.map(m=>m.id),source:b.members.map(m=>m.id),origins:{target:a.profiles.map(p=>p.name),source:b.profiles.map(p=>p.name)},anchors:{[a.id]:anchor(a.id),[b.id]:anchor(b.id)}}),new Date().toISOString());changed();return this.detail(a.id);},
  undo(id){const e=q('SELECT * FROM contact_link_history WHERE id=? AND undone_at IS NULL').get(id);if(!e)throw notFound('Fusion introuvable');if(e.kind==='local')people.undo(e.scope,id);else q('UPDATE contact_link_history SET undone_at=? WHERE id=?').run(new Date().toISOString(),id);changed();return {undone:true};},
 };
}
