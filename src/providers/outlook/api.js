// Client Microsoft Graph (courrier). Le jeton d'accès reste en mémoire ; le jeton de rafraîchissement, que Microsoft
// renouvelle, est confié à `onRotate` pour être rechiffré. Le jeton n'est envoyé qu'à graph.microsoft.com.
import { HttpError } from '../../http/errors.js';

const BASE = 'https://graph.microsoft.com/v1.0/';
const HOST = 'graph.microsoft.com';
// HTML source for safe display; parsers separately derive plain text for AI.
const HTML_BODY = 'outlook.body-content-type="html"';

export function createGraphClient({ refreshToken, oauth, fetchImpl = globalThis.fetch, onRotate = () => {} }) {
  let rt = refreshToken;
  let refreshing=null;
  let access = null; // { token, expiresAt }

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

  async function request(method, pathOrUrl, { params = {}, body, mime, prefer, retried = false, forceRefresh = false } = {}) {
    const url = new URL(pathOrUrl, BASE);
    if (url.protocol !== 'https:' || url.host !== HOST) throw new HttpError(502, 'Lien Graph inattendu.', 'outlook');
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${await accessToken(retried || forceRefresh)}` };
    if (prefer) headers.prefer = prefer;
    let payload;
    if (mime !== undefined) { headers['content-type'] = 'text/plain'; payload = Buffer.from(mime, 'utf8').toString('base64'); }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'Microsoft Graph est injoignable.', 'retryable');
    }
    if (res.status === 401 && !retried) return request(method, pathOrUrl, { params, body, mime, prefer, retried: true });
    if (res.status === 404) throw new HttpError(404, 'Introuvable dans Outlook.', 'not_found');
    if (res.status === 409) throw new HttpError(409, 'Cet élément existe déjà dans Outlook.', 'conflict');
    if (res.status === 410) throw new HttpError(410, 'Curseur de synchronisation expiré.', 'gone_cursor');
    if (res.status === 429 || res.status >= 500) throw new HttpError(503, `Outlook indisponible (${res.status}).`, 'retryable');
    // Refus net (4xx) : le message d'erreur Graph n'est pas repris (il peut citer le contenu).
    if (!res.ok) throw new HttpError(502, `Erreur Outlook (${res.status}).`, 'provider');
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Jamais d'extrait de la réponse dans l'erreur ni dans les journaux.
      throw new HttpError(502, 'Réponse Outlook illisible.', 'retryable');
    }
  }

  const enc = encodeURIComponent;
  // Listes paginées (@odata.nextLink) lues en entier, avec une borne de sécurité.
  async function all(path, params) {
    const out = [];
    let page = await request('GET', path, { params });
    out.push(...(page.value || []));
    while (page['@odata.nextLink'] && out.length < 5000) {
      page = await request('GET', page['@odata.nextLink']);
      out.push(...(page.value || []));
    }
    if(page['@odata.nextLink'])throw new HttpError(409,'Trop de dossiers Outlook pour cet import.','folder_limit');
    return { value: out };
  }
  const MSG_FIELDS = 'id,conversationId,parentFolderId,subject,bodyPreview,body,from,sender,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,isDraft,flag,importance,inferenceClassification,internetMessageId';

  async function contacts() {
    // A newly consented Contacts.Read grant may not be reflected in a mail access token
    // already cached by Graph. Refresh once before this explicit, read-only import.
    await accessToken(true);
    const records=new Map(),folders=[],seen=new Set();let pages=0;
    async function collect(path,params,accept) {
      let next=path;
      while(next) {
        if(seen.has(next) || ++pages>500)throw new HttpError(409,'Pagination du carnet Outlook interrompue. Aucun import partiel enregistré.','contacts_limit');
        seen.add(next);const page=await request('GET',next,{params:next===path?params:{}});
        if(!Array.isArray(page.value))throw new HttpError(502,'Réponse du carnet Outlook invalide.','contacts_provider');
        for(const c of page.value)accept(c);
        if(records.size>20000 || folders.length>1000)throw new HttpError(409,'Carnet Outlook trop volumineux. Aucun import partiel enregistré.','contacts_limit');
        next=page['@odata.nextLink'];
      }
    }
    const accept=c=>{if(c.id)records.set(c.id,{externalId:c.id,name:c.displayName,fields:[...[['givenName',c.givenName],['familyName',c.surname],['additionalName',c.middleName],['department',c.department],['organization',c.companyName],['jobTitle',c.jobTitle],['notes',c.personalNotes?.slice(0,5000)],['website',/^https?:\/\//i.test(c.businessHomePage || '')?c.businessHomePage:null],['birthday',c.birthday?.slice(0,10)]].filter(x=>x[1]).map(([kind,value])=>({kind,value})),...['businessAddress','homeAddress','otherAddress'].filter(k=>c[k]&&Object.values(c[k]).some(Boolean)).map(k=>({kind:'address',label:k.replace('Address',''),value:['street','city','state','postalCode','countryOrRegion'].map(f=>c[k][f]).filter(Boolean).join('\n'),components:['','',c[k].street || '',c[k].city || '',c[k].state || '',c[k].postalCode || '',c[k].countryOrRegion || '']}))],title:[c.jobTitle,c.companyName].filter(Boolean).join(' · '),identities:[...(c.emailAddresses || []).map(x=>({kind:'email',value:x.address})),...[...(c.businessPhones || []),...(c.homePhones || []),c.mobilePhone].filter(Boolean).map(value=>({kind:'phone',value}))]});};
    const params={$top:100,$select:'id,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName,jobTitle,givenName,surname,middleName,department,birthday,businessAddress,homeAddress,otherAddress,businessHomePage,personalNotes'};
    await collect('me/contacts',params,accept);
    await collect('me/contactFolders',{$top:100,$select:'id'},c=>{if(c.id)folders.push(c.id);});
    const visited=new Set();
    for(let i=0;i<folders.length;i++) {const id=folders[i];if(visited.has(id))continue;visited.add(id);
      await collect(`me/contactFolders/${enc(id)}/contacts`,params,accept);
      await collect(`me/contactFolders/${enc(id)}/childFolders`,{$top:100,$select:'id'},c=>{if(c.id)folders.push(c.id);});
    }
    return [...records.values()];
  }
  return {
    contacts,
    request,
    me: () => request('GET', 'me', { params: { $select: 'mail,userPrincipalName,displayName' } }),
    // wellKnownName n'existe qu'en bêta : les dossiers système sont résolus par leur nom réservé (wellKnown).
    folders: () => all('me/mailFolders', { $top: 100, $select: 'id,displayName,parentFolderId,childFolderCount' }),
    childFolders: id => all(`me/mailFolders/${enc(id)}/childFolders`, { $top: 100, $select: 'id,displayName,parentFolderId,childFolderCount' }),
    wellKnown: name => request('GET', `me/mailFolders/${enc(name)}`, { params: { $select: 'id,displayName' } }),
    // Tous les messages d'une conversation, en-têtes de fil compris.
    conversation: async conversationId => {
      const out = [];
      let next = null;const seen=new Set();
      do {
        const page = next ? await request('GET', next, { prefer: HTML_BODY })
          : await request('GET', 'me/messages', { prefer: HTML_BODY, params: {
            $filter: `conversationId eq '${String(conversationId).replace(/'/g, "''")}'`, $select: `${MSG_FIELDS},internetMessageHeaders`, $top: 50,
          } });
        out.push(...(page.value || []));
        next = page['@odata.nextLink'] || null;
        if(next && seen.has(next))throw new HttpError(502,'Pagination de conversation répétée.','retryable');
        if(next)seen.add(next);
      } while (next);
      return out;
    },
    // Suivi incrémental par dossier ; `link` est le deltaLink ou nextLink précédent.
    // Premier appel borné à la fenêtre d'import (seul filtre accepté par delta : receivedDateTime).
    delta: (folderId, link, sinceIso) => request('GET', link || `me/mailFolders/${enc(folderId)}/messages/delta`, {
      prefer: 'odata.maxpagesize=100',
      params: link ? {} : { $select: 'id,conversationId,parentFolderId', ...(sinceIso ? { $filter: `receivedDateTime ge ${sinceIso}` } : {}) },
    }),
    patchMessage: (id, body) => request('PATCH', `me/messages/${enc(id)}`, { body }),
    move: (id, destinationId) => request('POST', `me/messages/${enc(id)}/move`, { body: { destinationId } }),
    createFolder: (displayName, parentId) => request('POST', parentId ? `me/mailFolders/${enc(parentId)}/childFolders` : 'me/mailFolders', { body: { displayName } }),
    // Brouillon créé à partir du MIME exact (en-têtes de fil compris), puis mis à jour champ par champ.
    createDraftMime: mime => request('POST', 'me/messages', { mime }),
    patchDraft: (id, fields) => request('PATCH', `me/messages/${enc(id)}`, { body: fields }),
    // Envoi du MIME exact validé ; jamais l'envoi d'un brouillon existant.
    sendMime: mime => request('POST', 'me/sendMail', { mime }),
  };
}
