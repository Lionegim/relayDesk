// Client Microsoft Graph (courrier). Le jeton d'accès reste en mémoire ; le jeton de rafraîchissement, que Microsoft
// renouvelle, est confié à `onRotate` pour être rechiffré. Le jeton n'est envoyé qu'à graph.microsoft.com.
import { HttpError } from '../../http/errors.js';

const BASE = 'https://graph.microsoft.com/v1.0/';
const HOST = 'graph.microsoft.com';
// Corps en texte brut : Graph convertit lui-même le HTML, rien n'est rendu côté Relay.
const TEXT_BODY = 'outlook.body-content-type="text"';

export function createGraphClient({ refreshToken, oauth, fetchImpl = globalThis.fetch, onRotate = () => {} }) {
  let rt = refreshToken;
  let access = null; // { token, expiresAt }

  async function accessToken(force = false) {
    if (!force && access && access.expiresAt - 60000 > Date.now()) return access.token;
    const t = await oauth.refresh(rt);
    access = { token: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
    if (t.refresh_token && t.refresh_token !== rt) {
      rt = t.refresh_token;
      await onRotate(rt, t.scope);
    }
    return access.token;
  }

  async function request(method, pathOrUrl, { params = {}, body, mime, prefer, retried = false } = {}) {
    const url = new URL(pathOrUrl, BASE);
    if (url.protocol !== 'https:' || url.host !== HOST) throw new HttpError(502, 'Lien Graph inattendu.', 'outlook');
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${await accessToken(retried)}` };
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
    return text ? JSON.parse(text) : {};
  }

  const enc = encodeURIComponent;
  const MSG_FIELDS = 'id,conversationId,parentFolderId,subject,bodyPreview,body,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,isDraft,flag,importance,inferenceClassification,internetMessageId';

  return {
    request,
    me: () => request('GET', 'me', { params: { $select: 'mail,userPrincipalName,displayName' } }),
    // wellKnownName n'existe qu'en bêta : les dossiers système sont résolus par leur nom réservé (wellKnown).
    folders: () => request('GET', 'me/mailFolders', { params: { $top: 100, $select: 'id,displayName,parentFolderId,childFolderCount' } }),
    childFolders: id => request('GET', `me/mailFolders/${enc(id)}/childFolders`, { params: { $top: 100, $select: 'id,displayName,parentFolderId,childFolderCount' } }),
    wellKnown: name => request('GET', `me/mailFolders/${enc(name)}`, { params: { $select: 'id,displayName' } }),
    // Tous les messages d'une conversation, en-têtes de fil compris.
    conversation: async conversationId => {
      const out = [];
      let next = null;
      do {
        const page = next ? await request('GET', next, { prefer: TEXT_BODY })
          : await request('GET', 'me/messages', { prefer: TEXT_BODY, params: {
            $filter: `conversationId eq '${String(conversationId).replace(/'/g, "''")}'`, $select: `${MSG_FIELDS},internetMessageHeaders`, $top: 50,
          } });
        out.push(...(page.value || []));
        next = page['@odata.nextLink'] || null;
      } while (next && out.length < 500);
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
