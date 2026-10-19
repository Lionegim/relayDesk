import {randomUUID} from 'node:crypto';
import {transaction} from '../../db/index.js';
import {badRequest,HttpError} from '../../http/errors.js';
export const HISTORY_WINDOWS=[30,90,180,365,730,0];
export function createHistoryWindows(db,changed=()=>{}) {
 const q=s=>db.prepare(s),validate=days=>{if(!HISTORY_WINDOWS.includes(days))throw badRequest('Historique invalide : 30, 90, 180, 365, 730 jours ou tout.');};
 function account(id){const a=q('SELECT * FROM accounts WHERE id=?').get(id);if(!a || !['gmail','outlook'].includes(a.svc))throw badRequest('Compte Gmail ou Outlook requis.');return a;}
 const policy=id=>{account(id);const p=q('SELECT days,revision,updated_at updatedAt,content_revision contentRevision FROM mail_history_windows WHERE account_id=?').get(id);return p || {days:0,revision:0,updatedAt:null,contentRevision:0};};
 const cutoff=(id,now=Date.now())=>{const p=policy(id);return p.days?now-p.days*86400000:0;};
 function plan(id,days,now){validate(days);const edge=days?now-days*86400000:0;const remove=[],trim=[],protectedDrafts=[];
  for(const m of q("SELECT id,external_id,sort_at,body,trail,draft_saved_at,reply_meta,handle FROM messages WHERE account_id=? AND compose_kind!='new'").all(id)) {
   if(edge && m.sort_at<edge){if(m.draft_saved_at)protectedDrafts.push(m.id);else remove.push(m.id);continue;}
   if(!edge)continue;const trail=JSON.parse(m.trail || '[]'),keep=trail.filter(t=>Number.isFinite(t.at) && t.at>=edge);
   if(keep.length!==trail.length)trim.push({id:m.id,trail:keep,removed:trail.length-keep.length,meta:m.reply_meta,handle:m.handle});
  }
  return {remove,trim,protectedDrafts,cutoff:edge};
 }
 function prune(id,days,now=Date.now(),atomic=true) {
  const p=plan(id,days,now);if(!days)return {removed:0,trimmed:0,protectedDrafts:0};
  const apply=()=>{
   for(const mid of p.remove)q('DELETE FROM messages WHERE id=?').run(mid);
   for(const m of p.trim){q('UPDATE messages SET trail=?,message_count=? WHERE id=?').run(JSON.stringify(m.trail),m.trail.length+1,m.id);q('DELETE FROM ai_results WHERE message_id=?').run(m.id);
    // Preserve the original structured participant superset until the bounded
    // provider backfill reindexes it. Display names cannot prove that a retained
    // mixed-person conversation became one-to-one; a superset safely excludes
    // uncertain threads from extra person-history AI context.

   }
   if(p.remove.length || p.trim.length)q('DELETE FROM mail_display WHERE message_id IN (SELECT id FROM messages WHERE account_id=?)').run(id);
   if(p.remove.length || p.trim.length)q('UPDATE mail_history_windows SET content_revision=content_revision+1 WHERE account_id=?').run(id);
   const removed=q('DELETE FROM reply_memory_samples WHERE account_id=? AND sent_at<?').run(id,p.cutoff).changes;
   q('DELETE FROM reply_memory_suggestions WHERE account_id=? AND created_at<?').run(id,p.cutoff);
   if(removed || p.remove.length || p.trim.length)q('UPDATE reply_memory SET revision=? WHERE account_id=?').run(randomUUID(),id);
  };if(atomic)transaction(db,apply);else apply();
  if(p.remove.length || p.trim.length)changed();return {removed:p.remove.length,trimmed:p.trim.reduce((n,r)=>n+r.removed,0),protectedDrafts:p.protectedDrafts.length};
 }
 return {policy,cutoff,
  describe(id){const a=account(id),p=policy(id),stats=q("SELECT COUNT(*) conversations,COALESCE(SUM(message_count),0) messages,MIN(sort_at) firstAt,COALESCE(SUM(length(CAST(body AS BLOB))+length(CAST(trail AS BLOB))),0) contentBytes FROM messages WHERE account_id=? AND compose_kind!='new'").get(id);return {accountId:id,identity:a.identity,name:a.name,profileId:a.profile_id,svc:a.svc,address:a.address,...p,...stats};},
  preview(id,days){const p=plan(id,days,Date.now());return {...this.describe(id),requestedDays:days,removeConversations:p.remove.length,removeOlderMessages:p.trim.reduce((n,r)=>n+r.removed,0),protectedDrafts:p.protectedDrafts.length};},
  initialize(id,days){validate(days);account(id);q('INSERT INTO mail_history_windows(account_id,days,revision,updated_at) VALUES (?,?,1,?) ON CONFLICT(account_id) DO NOTHING').run(id,days,Date.now());changed();},
  set(id,days,revision){validate(days);const before=policy(id);if(revision!==before.revision)throw new HttpError(409,'Le réglage a changé : recharge les paramètres.','history_window_changed');if(days===before.days)return {settings:this.describe(id),cleanup:{removed:0,trimmed:0,protectedDrafts:0},changed:false};
   let cleanup;transaction(db,()=>{q('INSERT INTO mail_history_windows(account_id,days,revision,updated_at) VALUES (?,?,1,?) ON CONFLICT(account_id) DO UPDATE SET days=excluded.days,revision=revision+1,updated_at=excluded.updated_at').run(id,days,Date.now());
    cleanup=prune(id,days,Date.now(),false);q('UPDATE sync_state SET window_days=? WHERE account_id=?').run(days || 365,id);q('UPDATE reply_memory SET revision=? WHERE account_id=?').run(randomUUID(),id);
   });changed();return {settings:this.describe(id),cleanup,changed:true};
  },
  prune(id){const p=policy(id);return prune(id,p.days);},
  compact(){const before=q('PRAGMA temp_store').get().temp_store;try{db.exec('PRAGMA temp_store=MEMORY');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.exec('VACUUM');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return true;}catch{return false;}finally{db.exec(`PRAGMA temp_store=${before}`);}},
  needsCompaction(){return q('PRAGMA freelist_count').get().freelist_count>128;},
  // Provider payloads are filtered before indexing, storage, AI learning and display.
  gmail(id,thread){const edge=cutoff(id);if(!edge)return thread;const filtered={...thread,messages:(thread.messages || []).filter(m=>Number(m.internalDate)>=edge)};if(!filtered.messages.some(m=>!(m.labelIds || []).some(l=>['DRAFT','TRASH','SPAM'].includes(l))) && (thread.messages || []).some(m=>!(m.labelIds || []).some(l=>['DRAFT','TRASH','SPAM'].includes(l))) && q('SELECT 1 FROM messages WHERE account_id=? AND external_id=? AND draft_saved_at IS NOT NULL').get(id,thread.id))return thread;return filtered;},
  outlook(id,conversation,messages,skip=new Set()){const edge=cutoff(id);if(!edge)return messages;const filtered=messages.filter(m=>(Date.parse(m.receivedDateTime || m.sentDateTime || '') || 0)>=edge);if(!filtered.some(m=>!m.isDraft && !skip.has(m.parentFolderId)) && messages.some(m=>!m.isDraft && !skip.has(m.parentFolderId)) && q('SELECT 1 FROM messages WHERE account_id=? AND external_id=? AND draft_saved_at IS NOT NULL').get(id,conversation))return messages;return filtered;},
 };
}
