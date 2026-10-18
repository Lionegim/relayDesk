// Client minimal de l'API Mistral (chat completions). La clé reste côté serveur.
import { HttpError } from '../http/errors.js';

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';

export function createMistralClient({ apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  return {
    configured: !!apiKey,
    model,
    async complete(messages, { temperature = 0.3, maxTokens = 600 } = {}) {
      if (!apiKey) throw new HttpError(503, 'Assistant indisponible : MISTRAL_API_KEY n’est pas configurée.', 'ai_unconfigured');
      let res;
      try {
        res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timeout = e?.name === 'TimeoutError';
        throw new HttpError(timeout ? 504 : 502, timeout ? 'Mistral n’a pas répondu à temps.' : 'Mistral est injoignable.', 'ai_unreachable');
      }
      if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Clé Mistral refusée.', 'ai_auth');
      if (res.status === 429) throw new HttpError(429, 'Limite Mistral atteinte, réessaie dans un instant.', 'ai_rate_limited');
      if (!res.ok) throw new HttpError(502, `Erreur Mistral (${res.status}).`, 'ai_upstream');
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(502, 'Réponse Mistral vide.', 'ai_empty');
      return text.trim();
    },
  };
}
