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
  if (!res.ok) throw new Error(data?.error?.message || `Erreur ${res.status}`);
  return data;
}

export const api = {
  async session() {const info=await call('GET','/auth/session');csrfToken=info.csrfToken || null;return info;},
  sessions: ()=>call('GET','/auth/sessions'),
  revokeSession: id=>call('DELETE',`/auth/sessions/${encodeURIComponent(id)}`,{}),
  logout: ()=>call('POST','/auth/logout',{}),
  startOAuth: (service,input)=>call('POST',`/api/oauth/${service}/start`,input),
  startWhatsAppLink: input => call('POST', '/api/whatsapp/links', input),
  whatsAppLink: id => call('GET', `/api/whatsapp/links/${encodeURIComponent(id)}`),
  cancelWhatsAppLink: id => call('DELETE', `/api/whatsapp/links/${encodeURIComponent(id)}`, {}),
  createComposition: accountId => call('POST', '/api/drafts', { accountId }),
  state: () => call('GET', '/api/state'),
  changeReplyMemory: (id,input) => call('PATCH', `/api/messages/${id}/memory`, input),
  message: id => call('GET', `/api/messages/${id}`),
  syncProgress: accountId => call('GET', `/api/accounts/${accountId}/sync`),
  syncNow: accountId => call('POST', `/api/accounts/${accountId}/sync`, {}),
  disconnectAccount: accountId => call('POST', `/api/accounts/${accountId}/disconnect`, {}),
  previewSend: (id, input) => call('POST', `/api/messages/${id}/send/preview`, input),
  send: (id, input) => call('POST', `/api/messages/${id}/send`, input),
  updateMessage: (id, patch) => call('PATCH', `/api/messages/${id}`, patch),
  saveDraft: (id, draft) => call('PUT', `/api/messages/${id}/draft`, draft),
  createFolder: folder => call('POST', '/api/folders', folder),
  updateContact: (id, patch) => call('PATCH', `/api/contacts/${encodeURIComponent(id)}`, patch),
  connectAccount: (profileId, account) => call('POST', `/api/profiles/${encodeURIComponent(profileId)}/accounts`, account),
  summarize: (messageId, regenerate = false) => call('POST', '/api/ai/summary', { messageId, regenerate }),
  classify: (messageId, regenerate = false) => call('POST', '/api/ai/classify', { messageId, regenerate }),
  applyClassification: (messageId, proposalId, folderId) => call('POST', '/api/ai/classify/apply', { messageId, proposalId, folderId }),
  draftReply: (messageId, tone, intent) => call('POST', '/api/ai/draft', { messageId, tone, intent }),
};
