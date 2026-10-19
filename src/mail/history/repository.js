import {randomUUID} from 'node:crypto';
import {transaction} from '../../db/index.js';
import {badRequest} from '../../http/errors.js';

export function createHistoryRepository(db,changed=()=>{}) {
 const q=sql=>db.prepare(sql),now=()=>new Date().toISOString();
 const get=id=>q('SELECT * FROM mail_history_imports WHERE account_id=?').get(id);
 const account=id=>q('SELECT * FROM accounts WHERE id=?').get(id);
 const identity=a=>JSON.stringify([a.identity,a.svc,a.profile_id,a.address?.toLowerCase()]);
 const current=(job,active=true)=>{const j=get(job.account_id),a=account(job.account_id);return !!(j && a && j.job_id===job.job_id && j.identity===identity(a) && (!active || ['running','retrying'].includes(j.status)));};
 const touch=id=>{q('UPDATE mail_history_imports SET updated_at=? WHERE account_id=?').run(now(),id);changed();};
 return {
  current,get,
  active:()=>!!q("SELECT 1 FROM mail_history_imports WHERE status IN ('running','retrying') LIMIT 1").get(),
  status(id){const j=get(id);if(!j)return null;return {status:j.status,enumerated:!!j.enumerated,discovered:j.discovered,done:j.done,error:j.error,retryAt:j.retry_at,startedAt:j.started_at,updatedAt:j.updated_at};},
  start(id){const a=account(id);if(!a || !['gmail','outlook'].includes(a.svc))throw badRequest('Compte Gmail ou Outlook requis.');const j=get(id);
   if(j && j.identity===identity(a)){if(j.status!=='complete')q("UPDATE mail_history_imports SET status='running',error=NULL,retry_at=0 WHERE account_id=?").run(id);}
   else transaction(db,()=>{q('DELETE FROM mail_history_imports WHERE account_id=?').run(id);q("INSERT INTO mail_history_imports(account_id,job_id,identity,status,started_at,updated_at) VALUES(?,?,?,'running',?,?)").run(id,randomUUID(),identity(a),now(),now());});touch(id);return this.status(id);
  },
  pause(id){q("UPDATE mail_history_imports SET status='paused' WHERE account_id=? AND status!='complete'").run(id);touch(id);return this.status(id);},
  due(at=Date.now()){return q("SELECT * FROM mail_history_imports WHERE status IN ('running','retrying') AND retry_at<=? ORDER BY updated_at,account_id").all(at);},
  pending(id,limit=5){return q('SELECT external_id FROM mail_history_items WHERE account_id=? AND done=0 ORDER BY external_id LIMIT ?').all(id,limit).map(x=>x.external_id);},
  page(job,{ids,next}){if(!current(job))return false;transaction(db,()=>{
   let added=0;for(const id of new Set(ids))added+=Number(q('INSERT OR IGNORE INTO mail_history_items(account_id,external_id) VALUES(?,?)').run(job.account_id,id).changes);
   q("UPDATE mail_history_imports SET cursor=?,enumerated=?,discovered=discovered+?,status='running',failures=0,retry_at=0,error=NULL WHERE account_id=?").run(next==null?null:JSON.stringify(next),Number(next==null),added,job.account_id);
  });touch(job.account_id);return true;},
  applied(job,ids){if(!current(job))return false;transaction(db,()=>{let done=0;for(const id of ids)done+=Number(q('UPDATE mail_history_items SET done=1 WHERE account_id=? AND external_id=? AND done=0').run(job.account_id,id).changes);q("UPDATE mail_history_imports SET done=done+?,status='running',failures=0,retry_at=0,error=NULL WHERE account_id=?").run(done,job.account_id);});touch(job.account_id);return true;},
  complete(job){if(!current(job))return;const j=get(job.account_id);if(!j.enumerated || j.done!==j.discovered)return;q("UPDATE mail_history_imports SET status='complete',error=NULL,retry_at=0 WHERE account_id=?").run(job.account_id);touch(job.account_id);},
  restart(job){if(!current(job,false))return;transaction(db,()=>{q('UPDATE mail_history_items SET done=0 WHERE account_id=?').run(job.account_id);q("UPDATE mail_history_imports SET job_id=?,cursor=NULL,enumerated=0,done=0,status=?,failures=failures+1,retry_at=?,error=? WHERE account_id=?").run(randomUUID(),get(job.account_id).status==='paused'?'paused':'retrying',Date.now()+60000,'Nouvelle lecture de l’historique après réinitialisation du suivi fournisseur, sans créer de doublons.',job.account_id);});touch(job.account_id);},
  failed(job,error){if(!current(job))return;const auth=['invalid_grant','oauth_client_changed'].includes(error?.code);q('UPDATE mail_history_imports SET status=?,failures=failures+1,retry_at=?,error=? WHERE account_id=?').run(auth?'paused':'retrying',Date.now()+Math.min(1800000,15000*2**Math.min(job.failures,7)),auth?'Reconnecte ce compte puis reprends l’import.':'Lecture temporairement interrompue. Reprise automatique sans doublon.',job.account_id);touch(job.account_id);},
 };
}
