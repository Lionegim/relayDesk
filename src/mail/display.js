import sanitize from 'sanitize-html';
import {bodyHtml,bodyText as gmailText} from '../providers/gmail/parse.js';
import {bodyText as outlookText} from '../providers/outlook/parse.js';
import {fingerprint} from '../messages/pagination.js';
import {HttpError} from '../http/errors.js';
const escape=s=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Parse with a maintained HTML parser. No styles, ids, forms, images, active content,
// or remote resources enter the app DOM. Links require an explicit user click.
export function safeMailHtml(source) {
 return sanitize(String(source || '').slice(0,500000),{
  allowedTags:['p','div','span','br','hr','strong','b','em','i','u','s','ul','ol','li','blockquote','pre','code','h1','h2','h3','h4','h5','h6','table','thead','tbody','tfoot','tr','th','td','caption','a','sup','sub'],
  allowedAttributes:{a:['href','title','target','rel'],td:['colspan','rowspan'],th:['colspan','rowspan','scope'],ol:['start']},
  allowedSchemes:['http','https','mailto'],allowProtocolRelative:false,
  nonTextTags:['script','style','textarea','option','noscript','iframe','object','svg','math','head','title','template'],
  transformTags:{a:(tag,attrs)=>({tagName:'a',attribs:{...attrs,target:'_blank',rel:'noopener noreferrer'}})},
  enforceHtmlBoundary:true,
 });
}
export const displayHtml=(html,text)=>html?safeMailHtml(html):'<div class="mail-plain">'+escape(text)+'</div>';
export function displayRevision(store,id){const m=store.getMessage(id);return fingerprint([m.accountId,m.sortAt,m.count,m.body,m.trail]);}
export async function readMailDisplay({store,mail,id}) {
 const source=store.getMessageSource(id),account=source.accountId && store.getAccount(source.accountId);
 if(!account || !['gmail','outlook'].includes(account.svc) || store.composeContext(id).kind==='new')return null;
 const revision=displayRevision(store,id),cached=store.db.prepare('SELECT payload FROM mail_display WHERE message_id=? AND revision=?').get(id,revision);
 if(cached)return JSON.parse(cached.payload);
 const provider=mail.providerFor(account.id);
 return provider.sync.exclusive(account.id,async c=>{
  const live=()=>{if(!c.live() || displayRevision(store,id)!==revision)throw new HttpError(409,'La conversation a changé.','history_changed');};
  live();let rows,latestHtml=null;const stored=store.getMessage(id);
  if(account.svc==='gmail'){
   const thread=await c.gmail.getThread(source.externalId);
   const msgs=(thread.messages || []).filter(m=>!(m.labelIds || []).some(l=>['TRASH','SPAM','DRAFT'].includes(l)));
   const latest=msgs.at(-1);if(!latest || Number(latest.internalDate)!==stored.sortAt || gmailText(latest)!==stored.body)throw new HttpError(409,'La conversation a changé.','history_changed');
   const visible=new Set(stored.trail.map(t=>t.id));
   rows=msgs.filter(m=>visible.has(m.id) || m===latest).map(m=>({id:m.id,html:displayHtml(bodyHtml(m),gmailText(m))}));
   latestHtml=rows.find(r=>r.id===latest.id)?.html || null;
  }else{
   // Only records already visible in the stored conversation. Never include drafts,
   // trash or spam returned alongside the provider conversation.
   const visible=new Set(stored.trail.map(t=>t.id));
   const msgs=await c.graph.conversation(source.externalId);
   const at=m=>Date.parse(m.receivedDateTime || m.sentDateTime || '') || 0;
   let meta={};try{meta=JSON.parse(store.db.prepare('SELECT reply_meta FROM messages WHERE id=?').get(id).reply_meta || '{}');}catch{}
   const sorted=msgs.filter(m=>!m.isDraft).sort((a,b)=>at(a)-at(b));
   const latest=sorted.findLast(m=>at(m)===stored.sortAt && (meta.messageId ? String(m.internetMessageId || '').trim()===meta.messageId : outlookText(m)===stored.body));
   if(!latest)throw new HttpError(409,'La conversation a changé.','history_changed');
   rows=sorted.filter(m=>visible.has(m.id) || m===latest).map(m=>({id:m.id,html:displayHtml(m.body?.contentType?.toLowerCase()==='html'?m.body.content:null,outlookText(m))}));
   latestHtml=rows.find(r=>r.id===latest.id)?.html || null;
  }
  live();const payload={latest:latestHtml,items:Object.fromEntries(rows.map(r=>[r.id,r.html]))};
  store.db.prepare('INSERT INTO mail_display VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(id,revision,JSON.stringify(payload));
  return payload;
 });
}
