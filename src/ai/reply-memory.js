// Apprentissage déterministe local : aucun appel IA, aucun accès réseau, jamais de brouillon ni de texte reçu.
import { createHash, randomUUID } from 'node:crypto';
import { stripQuoted } from '../providers/gmail/parse.js';
export const MEMORY_DAYS = 180;
export const MEMORY_LIMIT = 24;
const MAX_TEXT = 1200;
const clean = value => {
  const lines=String(value || '').split(/\r?\n/);
  const boundary=lines.findIndex((line,i)=> /^\s*(?:_{5,}|-{2,}\s*(?:Forwarded message|Message transféré|Original Message|Message d’origine)|Begin forwarded message:|On .+ wrote:|Le .+ a écrit\s*:)/i.test(line) ||
    (/^\s*(From|De|Van|Von)\s*:/i.test(line) && lines.slice(i+1,i+10).filter(l=>/^\s*(Sent|Envoyé|Verzonden|Gesendet|To|À|Aan|An|Subject|Objet|Onderwerp|Betreff)\s*:/i.test(l)).length>=2));
  const own=(boundary<0?lines:lines.slice(0,boundary)).filter(l=>!/^\s*>/.test(l)).join('\n');
  return stripQuoted(own).split(/\n-- ?\n|\n(?:Sent from my |Envoyé de mon )/i)[0].replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0,MAX_TEXT);
};
const hash = text => createHash('sha256').update(text).digest('hex');

export function styleOf(samples) {
  if (!samples.length) return [];
  const words = samples.map(s => s.text.split(/\s+/).length), avg = words.reduce((a,b)=>a+b,0)/words.length;
  const traits = [avg <= 15 ? 'Réponses courtes' : avg >= 60 ? 'Réponses développées' : 'Réponses de longueur moyenne'];
  const count = re => samples.filter(s => re.test(s.text)).length;
  if (count(/\b(tu|toi|ton|ta|tes)\b/i) > count(/\b(vous|votre|vos)\b/i)) traits.push('Tutoiement fréquent');
  else if (count(/\b(vous|votre|vos)\b/i)) traits.push('Vouvoiement fréquent');
  if (count(/\p{Extended_Pictographic}/u) >= samples.length/3) traits.push('Emojis fréquents');
  if (count(/^(salut|coucou|yo|hey)\b/i) >= samples.length/3) traits.push('Salutations familières');
  else if (count(/^(bonjour|bonsoir|hello|hi)\b/i) >= samples.length/3) traits.push('Salutation en début de message');
  if (count(/\n/) >= samples.length/2) traits.push('Messages en plusieurs lignes');
  return traits;
}

export function createReplyMemoryRepository(db) {
  const q = sql => db.prepare(sql);
  function get(scope, create = true) {
    if (!scope?.accountId || !scope.conversationId) return null;
    if (create) q('INSERT OR IGNORE INTO reply_memory (account_id,conversation_id,profile_id,revision,identity) VALUES (?,?,?,?,?)')
      .run(scope.accountId,scope.conversationId,scope.profileId,randomUUID(),randomUUID());
    const row=q('SELECT * FROM reply_memory WHERE account_id=? AND conversation_id=? AND profile_id=?').get(scope.accountId,scope.conversationId,scope.profileId);
    if (!row) return null;
    const changed=q('DELETE FROM reply_memory_samples WHERE account_id=? AND conversation_id=? AND sent_at<?')
      .run(scope.accountId,scope.conversationId,Date.now()-MEMORY_DAYS*86400000).changes;
    if(changed) touch(scope);
    return q('SELECT * FROM reply_memory WHERE account_id=? AND conversation_id=?').get(scope.accountId,scope.conversationId);
  }
  function touch(s) { q('UPDATE reply_memory SET revision=? WHERE account_id=? AND conversation_id=?').run(randomUUID(),s.accountId,s.conversationId); }
  function samples(s) {return q('SELECT text,sent_at AS at FROM reply_memory_samples WHERE account_id=? AND conversation_id=? ORDER BY sent_at DESC,sample_key').all(s.accountId,s.conversationId);}
  return {
    observe(scope, sent) {
      const row=get(scope); if(!row?.enabled) return;
      const before=JSON.stringify(samples(scope));
      for(const m of sent || []) {
        if(m.fromMe !== true || !Number.isFinite(m.at) || m.at <= row.learn_after || m.at < Date.now()-MEMORY_DAYS*86400000 || m.at > Date.now()+60000) continue;
        const text=clean(m.text); if(!text || q('SELECT 1 FROM reply_memory_suggestions WHERE account_id=? AND conversation_id=? AND sample_key=?').get(scope.accountId,scope.conversationId,hash(text))) continue;
        q('INSERT OR IGNORE INTO reply_memory_samples (account_id,conversation_id,sample_key,text,sent_at) VALUES (?,?,?,?,?)')
          .run(scope.accountId,scope.conversationId,hash(text),text,m.at).changes;
      }
      q(`DELETE FROM reply_memory_samples WHERE account_id=? AND conversation_id=? AND sample_key NOT IN
        (SELECT sample_key FROM reply_memory_samples WHERE account_id=? AND conversation_id=? ORDER BY sent_at DESC,sample_key LIMIT ?)`)
        .run(scope.accountId,scope.conversationId,scope.accountId,scope.conversationId,MEMORY_LIMIT).changes;
      if(JSON.stringify(samples(scope))!==before) touch(scope);
    },
    ignore(scope,text,{remove=false}={}) {
      if(!get(scope)) return;
      const key=hash(clean(text));
      q('INSERT OR REPLACE INTO reply_memory_suggestions VALUES (?,?,?,?)').run(scope.accountId,scope.conversationId,key,Date.now());
      if(remove && q('DELETE FROM reply_memory_samples WHERE account_id=? AND conversation_id=? AND sample_key=?').run(scope.accountId,scope.conversationId,key).changes) touch(scope);
      q('DELETE FROM reply_memory_suggestions WHERE created_at<?').run(Date.now()-MEMORY_DAYS*86400000);
    },
    prune() {
      const cutoff=Date.now()-MEMORY_DAYS*86400000;
      for(const s of q('SELECT DISTINCT account_id AS accountId,conversation_id AS conversationId FROM reply_memory_samples WHERE sent_at<?').all(cutoff)) touch(s);
      q('DELETE FROM reply_memory_samples WHERE sent_at<?').run(cutoff);
      q('DELETE FROM reply_memory_suggestions WHERE created_at<?').run(cutoff);
    },
    view(scope) {
      const row=get(scope); if(!row) return {available:false,enabled:false,sampleCount:0,traits:[],examples:[]};
      const list=samples(scope);
      return {available:true,enabled:!!row.enabled,revision:row.revision,identity:row.identity,learnAfter:row.learn_after,sampleCount:list.length,traits:styleOf(list),
        examples:list.slice(0,3).map(s=>({text:s.text.slice(0,240),at:s.at})),retentionDays:MEMORY_DAYS,
        // Exemples bornés pour l'appel de rédaction, jamais exposés via la vue publique.
        promptExamples:row.enabled?list.slice(0,5).map(s=>s.text.slice(0,400)):[]};
    },
    change(scope, {enabled,reset=false}) {
      const row=get(scope); if(!row) return this.view(scope);
      if(reset) q('DELETE FROM reply_memory_samples WHERE account_id=? AND conversation_id=?').run(scope.accountId,scope.conversationId);
      q('UPDATE reply_memory SET enabled=?,learn_after=?,revision=? WHERE account_id=? AND conversation_id=?')
        .run(enabled===undefined?row.enabled:+enabled,Date.now(),randomUUID(),scope.accountId,scope.conversationId);
      return this.view(scope);
    },
    forget(scope) {q('DELETE FROM reply_memory WHERE account_id=? AND conversation_id=?').run(scope.accountId,scope.conversationId);},
  };
}
