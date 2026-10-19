import {createHash} from 'node:crypto';
import {normalizeIdentity} from '../contacts/identity.js';
import {timelineQuery} from '../contacts/timeline.js';
import {MEMORY_DAYS} from './reply-memory.js';

const key=i=>i.kind+':'+i.normalized;
const STOP=new Set('about after avec avant bonjour cette comme dans demande depuis email from hello information message merci notre objet pour reply sujet suite that their this votre vous with'.split(' '));
const terms=subject=>[...new Set(String(subject).toLowerCase().match(/[\p{L}\p{N}]{4,32}/gu)||[])].filter(t=>!STOP.has(t)).slice(0,8);
const empty=()=>({person:null,sources:[],styleExamples:[]});

// Only an unambiguous person in the sending profile can supply extra context.
// Display names, quoted signatures and unknown/group participants are never used
// to infer an identity. Unified timelines do not broaden AI access across profiles.
export function createPersonHistory(db,{people}) {
 const q=sql=>db.prepare(sql);
 return function context(messageId,memory) {
  if(!memory?.enabled)return empty();
  const current=q('SELECT * FROM messages WHERE id=?').get(messageId);
  if(!current?.account_id || current.compose_kind==='new' || current.external_id?.endsWith('@g.us'))return empty();
  const accounts=q('SELECT address FROM accounts').all(),own=new Set();
  for(const a of accounts)for(const kind of ['email','phone']){const value=normalizeIdentity(kind,a.address);if(value)own.add(kind+':'+value);}
  const contacts=people.list().filter(p=>p.p===current.profile_id),owners=new Map();
  for(const p of contacts)for(const i of p.identities){const k=key(i);if(!owners.has(k))owners.set(k,new Set());owners.get(k).add(p.id);}
  const structured=id=>q('SELECT kind,normalized FROM message_identities WHERE message_id=?').all(id).filter(i=>!own.has(key(i)));
  const parties=structured(messageId),resolved=new Set();
  for(const i of parties){const matches=owners.get(key(i));if(matches?.size!==1)return empty();resolved.add([...matches][0]);}
  if(!parties.length && current.channel==='whatsapp')for(const p of contacts)if(p.members.some(m=>q('SELECT 1 FROM contacts WHERE id=? AND account_id=? AND external_id=?').get(m.id,current.account_id,current.external_id)))resolved.add(p.id);
  if(resolved.size!==1)return empty();
  const person=contacts.find(p=>p.id===[...resolved][0]),identities=person.identities.filter(i=>owners.get(key(i))?.size===1 && !own.has(key(i))),keys=new Set(identities.map(key));
  const direct=person.members.map(m=>q('SELECT account_id,external_id FROM contacts WHERE id=?').get(m.id));
  const query=timelineQuery(db,{keys:identities,direct,profile:current.profile_id});
  const eligible=`AND m.id!=? AND COALESCE(r.enabled,1)=1 AND m.sort_at>MAX(COALESCE(r.learn_after,0),?)`;
  const from=query.from.replace('WHERE m.compose_kind', 'LEFT JOIN reply_memory r ON r.account_id=m.account_id AND r.conversation_id=m.external_id AND r.profile_id=m.profile_id WHERE m.compose_kind');
  const words=terms(current.subject),score=words.length?words.map(()=>"(instr(lower(m.subject||' '||m.preview),?)>0)").join('+'):'0';
  const metadata="m.id,m.account_id,m.external_id,m.channel,m.profile_id,m.account,m.subject,m.sort_at,COALESCE(r.learn_after,0) learn_after,json_extract(m.reply_meta,'$.at') body_at";
  const read=(order,extra=[])=>q(`${query.cte} SELECT ${metadata} ${from} ${eligible} ORDER BY ${order},m.sort_at DESC,m.id DESC LIMIT 24`).all(...query.args,messageId,memory.learnAfter || 0,...extra);
  const recent=read('m.sort_at DESC'),relevant=words.length?read(score+' DESC',words):[];
  const candidates=[...new Map([...relevant.slice(0,3),...recent,...relevant].map(m=>[m.id,m])).values()];
  const sources=[],styleExamples=[],styleLimit=Math.max(0,5-(memory.promptExamples || []).length);let remaining=12000;
  for(const m of candidates){
   if(m.external_id?.endsWith('@g.us'))continue;
   const involved=structured(m.id);
   const directMatch=direct.some(d=>d.account_id===m.account_id && d.external_id===m.external_id);
   if(involved.length?!involved.every(i=>keys.has(key(i))):!directMatch)continue;
   if(sources.length<6 && remaining>0){
    const value=q('SELECT substr(body,1,1400) body,from_name FROM messages WHERE id=?').get(m.id);
    const older=q("SELECT json_extract(value,'$.from') author,substr(json_extract(value,'$.body'),1,350) body,json_extract(value,'$.at') at FROM json_each((SELECT trail FROM messages WHERE id=?)) ORDER BY CAST(key AS INTEGER) LIMIT 2").all(m.id);
    const cutoff=Math.max(m.learn_after,memory.learnAfter || 0),parts=older.reverse().filter(t=>Number.isFinite(t.at) && t.at>cutoff).map(t=>`${t.author || ''}: ${t.body || ''}`);
    // After a reset, an undated body must not become 'new' merely because a
    // provider parser had to fall back to the import timestamp.
    const bodyAt=m.channel==='whatsapp'?q('SELECT MAX(ts) at FROM whatsapp_messages WHERE account_id=? AND chat_jid=?').get(m.account_id,m.external_id)?.at:m.body_at;
    if(!cutoff || Number.isFinite(bodyAt) && bodyAt>cutoff)parts.push(`${value.from_name}: ${value.body}`);
    const excerpt=parts.join('\n').slice(0,Math.min(2200,remaining));remaining-=excerpt.length;
    if(excerpt)sources.push({id:m.id,subject:m.subject,at:m.sort_at,channel:m.channel,account:m.account,excerpt});
   }
   // Only already learned, owner-sent samples can supply style. Match channel,
   // preserve source opt-outs/reset cutoffs and never learn from a received mail.
   if(m.channel===current.channel && styleExamples.length<styleLimit){
    const samples=q(`SELECT s.text FROM reply_memory_samples s JOIN reply_memory r ON r.account_id=s.account_id AND r.conversation_id=s.conversation_id
     WHERE s.account_id=? AND s.conversation_id=? AND r.enabled=1 AND r.profile_id=? AND s.sent_at>MAX(r.learn_after,?,?)
     AND NOT EXISTS(SELECT 1 FROM reply_memory_suggestions x WHERE x.account_id=s.account_id AND x.conversation_id=s.conversation_id AND x.sample_key=s.sample_key)
     ORDER BY s.sent_at DESC,s.sample_key LIMIT 5`).all(m.account_id,m.external_id,current.profile_id,memory.learnAfter || 0,Date.now()-MEMORY_DAYS*86400000);
    for(const s of samples){const text=s.text.slice(0,400);if(!styleExamples.includes(text))styleExamples.push(text);if(styleExamples.length===styleLimit)break;}
   }
   if(sources.length===6 && styleExamples.length===styleLimit)break;
  }
  return {person:{id:person.id,name:person.name,profileId:person.p},sources,styleExamples};
 };
}
export const personHistoryRevision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
