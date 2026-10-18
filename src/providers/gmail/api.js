// Client Gmail REST minimal, en lecture. Le jeton d'accès reste en mémoire ; seul le jeton de rafraîchissement est stocké (chiffré).
import { HttpError } from '../../http/errors.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';

export function createGmailClient({ refreshToken, oauth, fetchImpl = globalThis.fetch, initialAccess = null }) {
  let access = initialAccess; // { token, expiresAt }

  async function accessToken(force = false) {
    if (!force && access && access.expiresAt - 60000 > Date.now()) return access.token;
    const t = await oauth.refresh(refreshToken);
    access = { token: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
    return access.token;
  }

  async function get(path, params = {}, retried = false) {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      for (const item of [].concat(v)) url.searchParams.append(k, String(item));
    }
    let res;
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${await accessToken(retried)}` }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'Gmail est injoignable.', 'retryable');
    }
    if (res.status === 401 && !retried) return get(path, params, true);
    if (res.status === 404) throw new HttpError(404, 'Introuvable dans Gmail.', 'not_found');
    if (res.status === 429 || res.status >= 500) throw new HttpError(503, `Gmail indisponible (${res.status}).`, 'retryable');
    if (!res.ok) throw new HttpError(502, `Erreur Gmail (${res.status}).`, 'gmail');
    return res.json();
  }

  return {
    profile: () => get('profile'),
    labels: () => get('labels'),
    listThreads: (q, pageToken) => get('threads', { q, pageToken, maxResults: 100 }),
    getThread: id => get(`threads/${encodeURIComponent(id)}`, { format: 'full' }),
    history: (startHistoryId, pageToken) => get('history', { startHistoryId, pageToken, maxResults: 500 }),
  };
}
