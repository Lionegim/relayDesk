import { createHash, randomUUID } from 'node:crypto';
import { summaryPrompt, draftPrompt, classifyPrompt, parseClassification } from '../ai/assistant.js';
import { HttpError, badRequest } from '../http/errors.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stale = () => new HttpError(409, 'Le fil ou les dossiers ont changé. Relance l’analyse avant de continuer.', 'ai_stale');

// Ne connaît aucun jeton ni API de messagerie. Toute écriture distante passe par mail.updateMessage.
export function createAssistantService({ store, ai, mail, ownerName }) {
  const pending = new Map(), applying = new Set();
  function context(id, kind) {
    const m = store.getMessage(id);
    const source = store.getMessageSource(id);
    const account = source.accountId ? store.getAccount(source.accountId) : null;
    const folders = kind === 'classify' ? store.aiFolders(m.p).slice(0, 200) : [];
    const fingerprint = digest({ version: 1, model: ai.model, ownerName, source: { accountId: source.accountId, externalId: source.externalId, svc: account?.svc, address: account?.address }, profile: m.p,
      kind: m.kind, subject: m.subject, from: m.from, handle: m.handle, body: m.body, trail: m.trail,
      count: m.count, sortAt: m.sortAt, ...(kind === 'draft' ? { draft: m.draft } : {}), folders });
    return { m, folders, fingerprint };
  }
  function currentResult(id, kind) {
    const c = context(id, kind), r = store.getAIResult(id, kind);
    return r?.fingerprint === c.fingerprint ? r : null;
  }
  return {
    results(id) { return { summary: currentResult(id, 'summary'), classify: currentResult(id, 'classify') }; },
    async run(kind, id, options = {}) {
      if (!['summary', 'draft', 'classify'].includes(kind)) throw badRequest('Action IA invalide');
      if ('regenerate' in options && typeof options.regenerate !== 'boolean') throw badRequest('Option de génération invalide');
      const c = context(id, kind);
      if (kind === 'classify' && c.m.kind === 'new') throw badRequest('Le classement concerne les messages reçus');
      if (kind !== 'draft' && !options.regenerate) {
        const cached = currentResult(id, kind);
        if (cached) return { ...cached, cached: true };
      }
      const key = digest({ id, kind, fingerprint: c.fingerprint, tone: options.tone, intent: options.intent });
      if (pending.has(key)) return pending.get(key);
      const job = (async () => {
        const prompts = kind === 'summary' ? summaryPrompt(c.m, ownerName)
          : kind === 'classify' ? classifyPrompt(c.m, ownerName, c.folders) : draftPrompt(c.m, ownerName, options);
        const text = await ai.complete(prompts, { temperature: kind === 'draft' ? 0.5 : 0.1, maxTokens: kind === 'summary' ? 400 : 1000, json: kind === 'classify' });
        if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new HttpError(502, 'Réponse IA invalide.', 'ai_invalid');
        if (context(id, kind).fingerprint !== c.fingerprint) throw stale();
        if (kind === 'draft') return { text: text.trim(), fingerprint: c.fingerprint };
        const result = kind === 'classify' ? parseClassification(text, c.folders) : { text: text.trim() };
        return { ...store.saveAIResult(id, kind, c.fingerprint, result, randomUUID()), cached: false };
      })();
      pending.set(key, job);
      try { return await job; } finally { if (pending.get(key) === job) pending.delete(key); }
    },
    async apply(id, { proposalId, folderId } = {}) {
      const result = currentResult(id, 'classify');
      if (!result || typeof proposalId !== 'string' || proposalId !== result.proposalId) throw stale();
      if (result.appliedAt) throw new HttpError(409, 'Ce classement a déjà été appliqué.', 'ai_applied');
      if (applying.has(id)) throw new HttpError(409, 'Classement en cours.', 'ai_applying');
      const target = folderId === undefined ? result.folderId : folderId;
      if (target !== null && (typeof target !== 'string' || !store.aiFolders(store.getMessage(id).p).some(f => f.id === target))) throw badRequest('Dossier invalide pour ce profil');
      const accountId = store.getMessageSource(id).accountId;
      if (target !== null && accountId && !mail.permissions(store.getAccount(accountId)).includes('labels')) {
        throw new HttpError(403, 'Le classement dans un dossier demande la permission de classement du compte. Reconnecte-le avec cet accès.', 'labels_forbidden');
      }
      applying.add(id);
      try {
        if (target !== null) await mail.updateMessage(id, { folderId: target });
        store.markAIClassified(id, proposalId, target);
        return { message: store.getMessage(id), folderId: target, applied: true, synced: target !== null && !!accountId };
      } finally { applying.delete(id); }
    },
  };
}
