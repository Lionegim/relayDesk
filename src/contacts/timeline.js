import {badRequest} from '../http/errors.js';

// Resolve through structured identities and provider conversation keys. UNION
// keeps one conversation even when several linked addresses match it.
export function timelineQuery(db,{keys,direct,profile=null}) {
 const cte=`WITH matched AS (
  SELECT mi.message_id id FROM json_each(?) k JOIN message_identities mi
   ON mi.kind=json_extract(k.value,'$.kind') AND mi.normalized=json_extract(k.value,'$.normalized')
  UNION SELECT m.id FROM json_each(?) d JOIN messages m
   ON m.account_id=json_extract(d.value,'$.account_id') AND m.external_id=json_extract(d.value,'$.external_id')
 )`;
 const from=`FROM matched x JOIN messages m ON m.id=x.id JOIN accounts a ON a.id=m.account_id AND a.profile_id=m.profile_id JOIN profiles p ON p.id=m.profile_id
  WHERE m.compose_kind!='new'${profile?' AND m.profile_id=?':''}`;
 const args=[JSON.stringify(keys),JSON.stringify(direct),...(profile?[profile]:[])];
 return {cte,from,args,all:(select,tail='',extra=[])=>db.prepare(`${cte} SELECT ${select} ${from} ${tail}`).all(...args,...extra)};
}
export function personTimeline(db,scope,{offset=0,limit=50}={}) {
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw badRequest('Pagination invalide');
 const query=timelineQuery(db,scope),stats=query.all(`COUNT(*) total,COALESCE(SUM(m.message_count),0) messages,MIN(CASE WHEN m.sort_at>0 THEN m.sort_at END) firstAt,MAX(m.sort_at) lastAt`)[0];
 const channels=query.all('m.channel channel,COUNT(*) conversations,COALESCE(SUM(m.message_count),0) messages','GROUP BY m.channel ORDER BY m.channel');
 const items=query.all(`m.id,m.profile_id p,p.name profileName,m.account_id accountId,m.channel,m.from_name AS "from",m.subject,m.preview,m.sort_at sortAt,m.message_count count,m.account`,'ORDER BY m.sort_at DESC,m.id DESC LIMIT ? OFFSET ?',[limit,offset]);
 return {items,total:stats.total,nextOffset:offset+limit<stats.total?offset+limit:null,activity:{messages:stats.messages,firstAt:stats.firstAt,lastAt:stats.lastAt,channels}};
}
