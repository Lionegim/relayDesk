let csrfToken=null;
async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...(body?{'content-type':'application/json'}:{}),...(!['GET','HEAD'].includes(method) && csrfToken?{'x-csrf-token':csrfToken}:{}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Compatibilité avec le processus local antérieur, qui peut rester ouvert pendant la mise à jour du code.
  // Cela ne désactive aucun contrôle serveur et ne s'applique jamais à une origine distante.
  if(res.status===404 && url==='/auth/session' && ['127.0.0.1','localhost','[::1]'].includes(location.hostname)) return {enabled:false,legacy:true};
  if(res.status===401 && url!=='/auth/session') {location.replace('/login');throw new Error('Session expirée : reconnecte-toi.');}
  if (!res.ok) {
    // Statut et code exposés à l'interface (ex. 409 draft_conflict) ; le message reste celui, assaini, du serveur.
    const error = new Error(data?.error?.message || `Erreur ${res.status}`);
    error.status = res.status;
    error.code = data?.error?.code || null;
    throw error;
  }
  return data;
}
// Paramètres de requête sans valeurs vides.
const query = params => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
};

export const api = {
  async uploadWhatsApp(id,file) {
    const res=await fetch(`/api/messages/${id}/whatsapp-media`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/octet-stream',...(csrfToken?{'x-csrf-token':csrfToken}:{})},body:file});
    const data=await res.json();if(!res.ok)throw new Error(data?.error?.message || 'Image indisponible');return data;
  },
  historyWindow:id=>call('GET',`/api/accounts/${id}/history-window`),
  previewHistoryWindow:(id,days)=>call('POST',`/api/accounts/${id}/history-window/preview`,{days}),
  saveHistoryWindow:(id,days,revision,identity)=>call('PUT',`/api/accounts/${id}/history-window`,{days,revision,identity}),
  mailDisplay:id=>call('POST',`/api/messages/${id}/display`,{}),
  network:(profile,days)=>call('GET',`/api/profiles/${encodeURIComponent(profile)}/network${query({days})}`),
  saveGroup:(profile,input,id)=>call(id?'PATCH':'POST',`/api/profiles/${encodeURIComponent(profile)}/person-groups${id?'/'+encodeURIComponent(id):''}`,input),
  groupMember:(profile,id,person,on)=>call('PUT',`/api/profiles/${encodeURIComponent(profile)}/person-groups/${encodeURIComponent(id)}/members/${encodeURIComponent(person)}`,{on}),
  async session() {const info=await call('GET','/auth/session');csrfToken=info.csrfToken || null;return info;},
  sessions: ()=>call('GET','/auth/sessions'),
  revokeSession: id=>call('DELETE',`/auth/sessions/${encodeURIComponent(id)}`,{}),
  logout: ()=>call('POST','/auth/logout',{}),
  startOAuth: (service,input)=>call('POST',`/api/oauth/${service}/start`,input),
  startWhatsAppLink: input => call('POST', '/api/whatsapp/links', input),
  whatsAppLink: id => call('GET', `/api/whatsapp/links/${encodeURIComponent(id)}`),
  cancelWhatsAppLink: id => call('DELETE', `/api/whatsapp/links/${encodeURIComponent(id)}`, {}),
  createComposition: accountId => call('POST', '/api/drafts', { accountId }),
  // Sans paramètre : instantané complet (ancien format). Avec { paged: 1, profile, nav, channel, folder, q, limit, cursor } :
  // une page filtrée côté serveur, avec page et compteurs.
  state: params => call('GET', `/api/state${query(params)}`),
  changeReplyMemory: (id,input) => call('PATCH', `/api/messages/${id}/memory`, input),
  // { limit, before } : page plus ancienne du fil.
  message: (id, params) => call('GET', `/api/messages/${id}${query(params)}`),
  importHistory: (id,action) => call('POST', `/api/accounts/${id}/history`, {action}),
  syncProgress: accountId => call('GET', `/api/accounts/${accountId}/sync`),
  syncNow: accountId => call('POST', `/api/accounts/${accountId}/sync`, {}),
  disconnectAccount: accountId => call('POST', `/api/accounts/${accountId}/disconnect`, {}),
  previewSend: (id, input) => call('POST', `/api/messages/${id}/send/preview`, input),
  send: (id, input) => call('POST', `/api/messages/${id}/send`, input),
  updateMessage: (id, patch) => call('PATCH', `/api/messages/${id}`, patch),
  saveDraft: (id, draft) => call('PUT', `/api/messages/${id}/draft`, draft),
  createFolder: folder => call('POST', '/api/folders', folder),
  contactHistory:profile=>call('GET',`/api/profiles/${encodeURIComponent(profile)}/contact-history`),
  duplicates:profile=>call('GET',`/api/profiles/${encodeURIComponent(profile)}/contact-duplicates`),
  scanDuplicates:profile=>call('POST',`/api/profiles/${encodeURIComponent(profile)}/contact-duplicates/scan`,{}),
  dismissDuplicate:(profile,id,input)=>call('POST',`/api/profiles/${encodeURIComponent(profile)}/contact-duplicates/${encodeURIComponent(id)}/dismiss`,input),
  mergeDuplicate:(profile,id,input)=>call('POST',`/api/profiles/${encodeURIComponent(profile)}/contact-duplicates/${encodeURIComponent(id)}/merge`,input),
  person:(profile,id,params)=>call('GET',`/api/profiles/${encodeURIComponent(profile)}/contacts/${encodeURIComponent(id)}${query(params)}`),
  importContacts:id=>call('POST',`/api/accounts/${id}/contacts/import`,{}),
  addContactIdentity:(profile,id,input)=>call('POST',`/api/profiles/${encodeURIComponent(profile)}/contacts/${encodeURIComponent(id)}/identities`,input),
  removeContactIdentity:(profile,id,input)=>call('DELETE',`/api/profiles/${encodeURIComponent(profile)}/contacts/${encodeURIComponent(id)}/identities`,input),
  mergeContacts:(profile,id,sourceId)=>call('POST',`/api/profiles/${encodeURIComponent(profile)}/contacts/${encodeURIComponent(id)}/merge`,{sourceId}),
  undoContactMerge:(profile,id)=>call('POST',`/api/profiles/${encodeURIComponent(profile)}/contact-merges/${encodeURIComponent(id)}/undo`,{}),
  updateContact: (id, patch) => call('PATCH', `/api/contacts/${encodeURIComponent(id)}`, patch),
  connectAccount: (profileId, account) => call('POST', `/api/profiles/${encodeURIComponent(profileId)}/accounts`, account),
  summarize: (messageId, regenerate = false) => call('POST', '/api/ai/summary', { messageId, regenerate }),
  classify: (messageId, regenerate = false) => call('POST', '/api/ai/classify', { messageId, regenerate }),
  applyClassification: (messageId, proposalId, folderId) => call('POST', '/api/ai/classify/apply', { messageId, proposalId, folderId }),
  draftReply: (messageId, tone, intent) => call('POST', '/api/ai/draft', { messageId, tone, intent }),
};
