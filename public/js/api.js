async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Erreur ${res.status}`);
  return data;
}

export const api = {
  createComposition: accountId => call('POST', '/api/drafts', { accountId }),
  state: () => call('GET', '/api/state'),
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
