import {createHash} from 'node:crypto';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {transaction} from '../db/index.js';
import {badRequest,notFound,HttpError} from '../http/errors.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedName=value=>String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/\p{L}+/gu)?.filter(x=>x.length>1).sort().join(' ') || '';
const usefulName=c=>!/[\d@]/.test(c.name) && !['contact','contact whatsapp','contact sans nom','unknown','inconnu'].map(normalizedName).includes(normalizedName(c.name)) && normalizedName(c.name).split(' ').length>1;
const identityKey=x=>`${x.kind}:${x.normalized}`;
const personVersion=c=>hash([c.id,c.name,c.title,c.members,[...c.identities].map(identityKey).sort()]);
const pairVersion=(a,b)=>hash([personVersion(a),personVersion(b)]);

// Indexed blocking avoids comparing every pair. Large shared-address/name buckets are
// bounded and reported, rather than creating unbounded suggestions for role accounts.
export async function detectDuplicates(profile,people) {
 const buckets=new Map(),pairs=new Map();let crowded=0,limited=false,steps=0;
 const add=(key,c)=>{if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(c);};
 for(const c of people){for(const i of c.identities)if(!i.normalized.startsWith('unresolved:'))add(identityKey(i),c);if(usefulName(c))add('name:'+normalizedName(c.name),c);}
 outer:for(const [key,group] of [...buckets].sort(([a],[b])=>Number(a.startsWith('name:'))-Number(b.startsWith('name:')))){if(++steps%25===0)await yieldLoop();if(group.length>50){crowded++;continue;}
  for(let x=0;x<group.length;x++)for(let y=x+1;y<group.length;y++){
   const [a,b]=[group[x],group[y]].sort((a,b)=>a.id.localeCompare(b.id)),id=hash([profile,a.id,b.id]);
   let p=pairs.get(id);if(!p){if(pairs.size>=1000){limited=true;break outer;}p={id,left:a.id,right:b.id,version:pairVersion(a,b),rank:0,reasons:[]};pairs.set(id,p);}
   const type=key.startsWith('name:')?'name':key.startsWith('email:')?'email':'phone';
   p.rank=Math.max(p.rank,type==='name'?1:2);p.reasons.push({type,value:type==='name'?null:key.slice(key.indexOf(':')+1)});
  }
 }
 return {items:[...pairs.values()].sort((a,b)=>b.rank-a.rank||a.id.localeCompare(b.id)),crowded,limited};
}

export function createDuplicateRepository(db,{people,changed=()=>{}}) {
 const q=s=>db.prepare(s),running=new Map();
 function input(profile){if(!q('SELECT 1 FROM profiles WHERE id=?').get(profile))throw notFound('Profil introuvable');
  const rows=q(`SELECT c.id,c.name,c.title,c.account_id,COALESCE(l.person_id,c.id) root,a.name account FROM contacts c LEFT JOIN contact_person_links l ON l.contact_id=c.id LEFT JOIN accounts a ON a.id=c.account_id WHERE c.profile_id=? ORDER BY c.id`).all(profile),groups=new Map();
  for(const c of rows){if(!groups.has(c.root))groups.set(c.root,{id:c.root,name:'',title:'',members:[],identities:[],accounts:[]});const g=groups.get(c.root);if(c.id===c.root){g.name=c.name;g.title=c.title;}g.members.push(c.id);if(c.account)g.accounts.push(c.account);}
  const byId=new Map(rows.map(c=>[c.id,c.root]));for(const i of q('SELECT i.contact_id,i.kind,i.normalized,i.display_value value FROM contact_identities i JOIN contacts c ON c.id=i.contact_id WHERE c.profile_id=? ORDER BY i.contact_id,i.kind,i.normalized').all(profile))groups.get(byId.get(i.contact_id)).identities.push(i);
  const result=[...groups.values()];for(const c of result){c.identities=[...new Map(c.identities.map(i=>[identityKey(i),{kind:i.kind,normalized:i.normalized,value:i.value}])).values()];c.accounts=[...new Set(c.accounts)];}return result;
 }
 const revision=contacts=>hash(contacts.map(personVersion));
 function current(profile,id,version){const row=q('SELECT * FROM contact_duplicate_candidates WHERE id=? AND profile_id=?').get(id,profile);if(!row)throw notFound('Suggestion introuvable');const all=input(profile),a=all.find(c=>c.id===row.left_id),b=all.find(c=>c.id===row.right_id);
  if(version!==row.version || !a || !b || pairVersion(a,b)!==version)throw new HttpError(409,'Ces fiches ont changé. Relance la recherche puis vérifie la nouvelle suggestion.','duplicate_changed');return {row,a,b};
 }
 return {
  async scan(profile){if(running.has(profile))return running.get(profile);const job=(async()=>{const contacts=input(profile),rev=revision(contacts),last=q('SELECT * FROM contact_duplicate_scans WHERE profile_id=?').get(profile);if(last?.revision===rev)return {changed:false};
   const result=await detectDuplicates(profile,contacts);if(revision(input(profile))!==rev)return {changed:false,stale:true};
   transaction(db,()=>{q('DELETE FROM contact_duplicate_candidates WHERE profile_id=?').run(profile);for(const c of result.items)q('INSERT INTO contact_duplicate_candidates VALUES (?,?,?,?,?,?,?,?)').run(c.id,profile,c.left,c.right,c.version,c.rank,JSON.stringify(c.reasons),new Date().toISOString());q('INSERT INTO contact_duplicate_scans VALUES (?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,scanned_at=excluded.scanned_at,crowded=excluded.crowded,limited=excluded.limited').run(profile,rev,new Date().toISOString(),result.crowded,Number(result.limited));});changed();return {changed:true};})();running.set(profile,job);try{return await job;}finally{running.delete(profile);}},
  list(profile){const all=input(profile),map=new Map(all.map(c=>[c.id,c])),scan=q('SELECT scanned_at,crowded,limited,revision FROM contact_duplicate_scans WHERE profile_id=?').get(profile);const items=[];
   for(const row of q('SELECT c.*,r.decision FROM contact_duplicate_candidates c LEFT JOIN contact_duplicate_reviews r ON r.candidate_id=c.id AND r.version=c.version WHERE c.profile_id=? ORDER BY c.rank DESC,c.id').all(profile)){const a=map.get(row.left_id),b=map.get(row.right_id);if(!a || !b)continue;items.push({id:row.id,version:row.version,rank:row.rank,reasons:JSON.parse(row.reasons),left:a,right:b,dismissed:row.decision==='dismissed',stale:pairVersion(a,b)!==row.version});}
   return {items,scannedAt:scan?.scanned_at || null,pending:!scan || scan.revision!==revision(all),crowded:scan?.crowded || 0,limited:!!scan?.limited,merges:q(`SELECT e.id,e.created_at,t.name targetName,s.name sourceName FROM contact_merge_events e JOIN contacts t ON t.id=e.target_id JOIN contacts s ON s.id=json_extract(e.members,'$.from') WHERE e.profile_id=? AND e.undone_at IS NULL ORDER BY e.created_at DESC LIMIT 30`).all(profile)};
  },
  dismiss(profile,id,{version,restore=false}={}){current(profile,id,version);if(restore)q('DELETE FROM contact_duplicate_reviews WHERE candidate_id=? AND version=?').run(id,version);else q("INSERT INTO contact_duplicate_reviews VALUES (?,?,'dismissed') ON CONFLICT(candidate_id,version) DO UPDATE SET decision='dismissed'").run(id,version);changed();return this.list(profile);},
  merge(profile,id,{version,keepId,confirm}={}){const {a,b}=current(profile,id,version);if(confirm!==true || ![a.id,b.id].includes(keepId))throw badRequest('Vérifie les deux fiches et choisis la fiche principale avant de confirmer');const person=people.merge(profile,keepId,keepId===a.id?b.id:a.id);q("INSERT OR IGNORE INTO contact_duplicate_reviews VALUES (?,?,'dismissed')").run(id,version);return {person,mergeId:person.merges[0]?.id};},
  async drain(){await Promise.allSettled([...running.values()]);},
 };
}

export function createDuplicateWorker(store,{intervalMs=60000,debounceMs=1000}={}) {
 let stopped=false,timer,unsubscribe;let pending=Promise.resolve();
 const scan=()=>{if(stopped)return pending;pending=pending.then(async()=>{if(stopped)return;for(const p of store.contactDuplicateProfiles()){if(stopped)return;await store.scanContactDuplicates(p.id);}}).catch(()=>{});return pending;};
 return {start(){if(unsubscribe)return;unsubscribe=store.subscribe(()=>{if(stopped || timer)return;timer=setTimeout(()=>{timer=null;scan();},debounceMs);timer.unref();});scan();this.interval=setInterval(scan,intervalMs);this.interval.unref();},async stop(){stopped=true;clearTimeout(timer);clearInterval(this.interval);unsubscribe?.();await pending;await store.drainContactDuplicates();}};
}
