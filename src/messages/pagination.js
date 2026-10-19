// Curseurs liés aux filtres et à la révision du fil ; aucune donnée ni secret dans le curseur.
import {createHash} from 'node:crypto';
import {badRequest,HttpError} from '../http/errors.js';
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const encodeCursor=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor(value) {
 if(typeof value!=='string' || value.length>1000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw badRequest('Curseur invalide');
 try {const decoded=JSON.parse(Buffer.from(value,'base64url').toString());if(!decoded || typeof decoded!=='object' || Array.isArray(decoded)) throw Error();return decoded;}catch{throw badRequest('Curseur invalide');}
}
export function pageLimit(value=50) {
 const n=Number(value);if(!Number.isInteger(n) || n<1 || n>100) throw badRequest('Taille de page invalide (1 à 100)');return n;
}
export function listPage(db,{profile,nav='all',channel='all',folder=null,q='',limit=50,cursor=null}) {
 const sql=text=>db.prepare(text);limit=pageLimit(limit);
 const unified=profile==='all';
 if(!unified && !sql('SELECT 1 FROM profiles WHERE id=?').get(profile)) throw badRequest('Profil invalide');
 if(!['all','unread','todo','drafts'].includes(nav) || !['all','email','whatsapp','sms','linkedin','instagram'].includes(channel) || typeof q!=='string' || q.length>500) throw badRequest('Filtres invalides');
 const folders=sql('SELECT id,parent_id FROM folders'+(unified?'':' WHERE profile_id=?')).all(...(unified?[]:[profile])),subtree=id=>{
  const ids=new Set([id]);let added=true;while(added){added=false;for(const f of folders) if(ids.has(f.parent_id) && !ids.has(f.id)){ids.add(f.id);added=true;}}return [...ids];
 };
 if(folder && !folders.some(f=>f.id===folder)) throw badRequest('Dossier invalide pour ce profil');
 const base=unified?'archived=0':'profile_id=? AND archived=0',baseParams=unified?[]:[profile];
 const counts=sql('SELECT COUNT(*) AS all_count, COALESCE(SUM(unread),0) AS unread, COALESCE(SUM(flagged),0) AS todo, COALESCE(SUM(draft_saved_at IS NOT NULL),0) AS drafts FROM messages WHERE '+base).get(...baseParams);
 counts.all=counts.all_count;delete counts.all_count;counts.folders=Object.fromEntries(folders.map(f=>{const ids=subtree(f.id);return[f.id,sql(`SELECT COUNT(*) AS n FROM messages WHERE ${base} AND folder_id IN (${ids.map(()=>'?')})`).get(...baseParams,...ids).n];}));
 let where=base,params=[...baseParams];
 if(folder){const ids=subtree(folder);where+=` AND folder_id IN (${ids.map(()=>'?')})`;params.push(...ids);}
 else if(nav!=='all') where+=' AND '+({unread:'unread=1',todo:'flagged=1',drafts:'draft_saved_at IS NOT NULL'}[nav]);
 if(channel!=='all'){where+=' AND channel=?';params.push(channel);}
 q=q.trim().toLowerCase();if(q){where+=" AND instr(relay_lower(from_name || ' ' || subject || ' ' || preview),?)>0";params.push(q);}
 const total=sql(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...params).n;
 const scope=fingerprint([profile,nav,channel,folder,q]);
 if(cursor){const c=decodeCursor(cursor);if(c.scope!==scope || !Number.isSafeInteger(c.id) || !Number.isSafeInteger(c.at)) throw badRequest('Curseur incompatible avec ces filtres');where+=' AND (sort_at<? OR (sort_at=? AND id<?))';params.push(c.at,c.at,c.id);}
 const rows=sql(`SELECT * FROM messages WHERE ${where} ORDER BY sort_at DESC,id DESC LIMIT ?`).all(...params,limit+1),hasMore=rows.length>limit;rows.length=Math.min(rows.length,limit);const last=rows.at(-1);
 return{rows,counts,page:{limit,total,hasMore,nextCursor:hasMore?encodeCursor({scope,at:last.sort_at,id:last.id}):null}};
}
export function historyPage(options,revision,kind) {
 const limit=pageLimit(options.limit),c=options.before?decodeCursor(options.before):null;
 if(c && (c.revision!==revision || c.kind!==kind)) throw new HttpError(409,'La conversation a changé : recharge-la avant de continuer.','history_changed');
 return{limit,c};
}
