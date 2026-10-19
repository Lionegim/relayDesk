// Client Gmail REST. Le jeton d'accès reste en mémoire ; seul le jeton de rafraîchissement est stocké (chiffré).
import { HttpError } from '../../http/errors.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';

export function createGmailClient({ refreshToken, oauth, fetchImpl = globalThis.fetch, initialAccess = null, onRotate=()=>{} }) {
  let access = initialAccess; // { token, expiresAt }

  let rt=refreshToken,refreshing=null;
  async function accessToken(force=false) {
    if(!force && access && access.expiresAt-60000>Date.now()) return access.token;
    if(refreshing) return refreshing;
    refreshing=(async()=>{
      const t=await oauth.refresh(rt),next=t.refresh_token || rt;
      if(next!==rt) await onRotate(next,t.scope);
      rt=next;access={token:t.access_token,expiresAt:Date.now()+(t.expires_in || 3600)*1000};return access.token;
    })();
    try{return await refreshing;}finally{refreshing=null;}
  }

  async function request(method, path, params = {}, body, retried = false) {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      for (const item of [].concat(v)) url.searchParams.append(k, String(item));
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${await accessToken(retried)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      if (e instanceof HttpError || e.code==='gone') throw e;
      throw new HttpError(502, 'Gmail est injoignable.', 'retryable');
    }
    if (res.status === 401 && !retried) return request(method, path, params, body, true);
    if(res.status===400 && path==='threads' && params.pageToken)throw new HttpError(410,'Curseur d’archive Gmail expiré.','archive_cursor_expired');
    if (res.status === 404) throw new HttpError(404, 'Introuvable dans Gmail.', 'not_found');
    if (res.status === 409) throw new HttpError(409, 'Ce libellé existe déjà dans Gmail.', 'conflict');
    if (res.status === 429 || res.status >= 500) throw new HttpError(503, `Gmail indisponible (${res.status}).`, 'retryable');
    if (!res.ok) throw new HttpError(502, `Erreur Gmail (${res.status}).`, 'gmail');
    const text = await res.text();
    try{return text?JSON.parse(text):{};}catch{throw new HttpError(502,'Réponse Gmail illisible.','retryable');}
  }

  const get = (path, params) => request('GET', path, params);

  async function contacts() {
    const records=[];let pageToken;const seen=new Set();
    do {
      if(seen.has(pageToken)) throw new HttpError(502,'Pagination Google Contacts répétée.','contacts_paging');
      seen.add(pageToken);
      const url=new URL('https://people.googleapis.com/v1/people/me/connections');
      url.search=new URLSearchParams({personFields:'names,emailAddresses,phoneNumbers,organizations,addresses,urls,birthdays,biographies,nicknames',pageSize:'1000',sources:'READ_SOURCE_TYPE_CONTACT',...(pageToken?{pageToken}:{})});
      let res;try{res=await fetchImpl(url,{headers:{authorization:`Bearer ${await accessToken()}`},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new HttpError(502,'Google Contacts est injoignable.','contacts_unreachable');}
      if(!res.ok)throw new HttpError(res.status===403?403:502,'Google Contacts a refusé la lecture : vérifie la permission Contacts et l’activation de People API.','contacts_provider');
      const data=await res.json().catch(()=>null);if(!data || !Array.isArray(data.connections || []))throw new HttpError(502,'Réponse Google Contacts invalide.','contacts_provider');
      records.push(...(data.connections || []).map(c=>({externalId:c.resourceName,name:c.names?.[0]?.displayName,fields:[...[['givenName',c.names?.[0]?.givenName],['familyName',c.names?.[0]?.familyName],['additionalName',c.names?.[0]?.middleName],['prefix',c.names?.[0]?.honorificPrefix],['suffix',c.names?.[0]?.honorificSuffix],['nickname',c.nicknames?.[0]?.value],['department',c.organizations?.[0]?.department],['organization',c.organizations?.[0]?.name],['jobTitle',c.organizations?.[0]?.title]].filter(x=>x[1]).map(([kind,value])=>({kind,value})),...(c.addresses || []).filter(x=>x.formattedValue).map(x=>({kind:'address',label:x.type || '',value:x.formattedValue,components:[x.poBox || '',x.extendedAddress || '',x.streetAddress || '',x.city || '',x.region || '',x.postalCode || '',x.country || '']})),...(c.urls || []).filter(x=>/^https?:\/\//i.test(x.value)).map(x=>({kind:'website',value:x.value})),...(c.biographies || []).filter(x=>x.value).map(x=>({kind:'notes',value:x.value.slice(0,5000)})),...(c.birthdays || []).filter(x=>x.date?.month&&x.date?.day).map(x=>({kind:'birthday',value:(x.date.year?String(x.date.year).padStart(4,'0')+'-':'--')+String(x.date.month).padStart(2,'0')+'-'+String(x.date.day).padStart(2,'0')}))],title:[c.organizations?.[0]?.title,c.organizations?.[0]?.name].filter(Boolean).join(' · '),identities:[...(c.emailAddresses || []).map(x=>({kind:'email',value:x.value})),...(c.phoneNumbers || []).map(x=>({kind:'phone',value:x.canonicalForm || x.value}))]})));
      pageToken=data.nextPageToken;
      if(records.length>20000 || seen.size>100)throw new HttpError(409,'Carnet trop volumineux pour cet import (20 000 contacts). Aucun import partiel enregistré.','contacts_limit');
    }while(pageToken);
    return records;
  }
  return {
    contacts,
    post: (path, body) => request('POST', path, {}, body),
    put: (path, body) => request('PUT', path, {}, body),
    profile: () => get('profile'),
    labels: () => get('labels'),
    listThreads: (q, pageToken) => get('threads', { q, pageToken, maxResults: 100 }),
    getThread: id => get(`threads/${encodeURIComponent(id)}`, { format: 'full' }),
    history: (startHistoryId, pageToken) => get('history', { startHistoryId, pageToken, maxResults: 500 }),
  };
}
