// Dépôt en mémoire, filtré par profil. Interface pensée pour être remplacée par SQLite (node:sqlite)
// sans toucher aux routes.
import { PROFILES, FOLDERS, MESSAGES, CONTACTS } from './demo-data.js';
import { SERVICES } from './connectors.js';
import { badRequest, notFound } from './http/errors.js';

const MESSAGE_FLAGS = ['unread', 'flagged', 'archived'];
const MAX_NAME = 80;
const MAX_DRAFT = 20000;
const FREQ_COUNT = 4;

export function createStore(seed = { PROFILES, FOLDERS, MESSAGES, CONTACTS }) {
  const db = structuredClone({ profiles: seed.PROFILES, folders: seed.FOLDERS, messages: seed.MESSAGES, contacts: seed.CONTACTS });
  db.messages.forEach(m => { m.archived ??= false; m.draft ??= null; });
  let seq = 0;

  const profile = id => db.profiles.find(p => p.id === id) || (() => { throw notFound('Profil introuvable'); })();
  const message = id => db.messages.find(m => m.id === id) || (() => { throw notFound('Message introuvable'); })();
  const name = (v, what) => {
    if (typeof v !== 'string' || !v.trim()) throw badRequest(`${what} requis`);
    if (v.trim().length > MAX_NAME) throw badRequest(`${what} trop long`);
    return v.trim();
  };

  return {
    snapshot() {
      return { profiles: db.profiles, folders: db.folders, messages: db.messages, contacts: db.contacts };
    },

    getMessage: message,

    updateMessage(id, patch) {
      const m = message(id);
      const next = {};
      for (const k of MESSAGE_FLAGS) {
        if (k in patch) {
          if (typeof patch[k] !== 'boolean') throw badRequest(`${k} doit être un booléen`);
          next[k] = patch[k];
        }
      }
      if ('folderId' in patch) {
        const f = patch.folderId;
        if (f !== null && !db.folders.some(x => x.id === f && x.p === m.p)) throw badRequest('Dossier invalide pour ce profil');
        next.folderId = f;
      }
      return Object.assign(m, next);
    },

    saveDraft(id, text) {
      const m = message(id);
      if (typeof text !== 'string' || text.length > MAX_DRAFT) throw badRequest('Brouillon invalide');
      m.draft = { text, savedAt: new Date().toISOString() };
      return m.draft;
    },

    createFolder({ profileId, name: raw, parentId = null }) {
      profile(profileId);
      if (parentId !== null && !db.folders.some(f => f.id === parentId && f.p === profileId)) throw badRequest('Dossier parent invalide');
      const folder = { id: `f${Date.now().toString(36)}${(seq++).toString(36)}`, p: profileId, name: name(raw, 'Nom du dossier'), parent: parentId };
      db.folders.push(folder);
      return folder;
    },

    updateContact(id, patch) {
      const c = db.contacts.find(x => x.id === id);
      if (!c) throw notFound('Contact introuvable');
      if (!Number.isInteger(patch.freq) || patch.freq < 0 || patch.freq >= FREQ_COUNT) throw badRequest('Fréquence invalide');
      c.freq = patch.freq;
      return c;
    },

    // Connexion simulée : enregistre le compte comme connecté dans son profil.
    connectAccount(profileId, { name: raw, svc }) {
      const p = profile(profileId);
      const def = SERVICES[svc];
      if (!def || def.disabled) throw badRequest('Service indisponible');
      const accountName = name(raw, 'Nom du compte');
      let acc = p.accounts.find(a => a.name === accountName);
      if (!acc) p.accounts.push(acc = { name: accountName, channel: def.ch, svc });
      Object.assign(acc, { status: 'Connecté', c: 'ok' });
      return acc;
    },
  };
}
