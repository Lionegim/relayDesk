// État d'authentification Baileys stocké dans SQLite, chiffré par le coffre : identifiants de session (creds) et
// chaque clé Signal séparément. Remplace useMultiFileAuthState (fichiers JSON en clair).
// Chaque valeur chiffrée porte son type et son identifiant ({ t, i, v }) : une ligne déplacée vers une autre clé
// du même compte est rejetée à la lecture. Rien n'est journalisé.

const CREDS = 'creds';

export function createAuthState({ store, vault, accountId, lib }) {
  const { BufferJSON, initAuthCreds, proto } = lib;
  const seal = (t, i, value) => vault.seal(accountId, { t, i, v: JSON.stringify(value, BufferJSON.replacer) });
  const open = (t, i) => {
    const sealed = store.waAuthGet(accountId, t, i);
    if (!sealed) return null;
    let data;
    try {
      data = vault.open(accountId, sealed);
    } catch {
      return null; // illisible (clé du coffre changée, ligne altérée) : traité comme absent
    }
    if (!data || data.t !== t || data.i !== i || typeof data.v !== 'string') return null;
    return JSON.parse(data.v, BufferJSON.reviver);
  };

  const creds = open(CREDS, '') || initAuthCreds();
  let live = true;

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = open(type, String(id));
            if (value && type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }
          return out;
        },
        // Rotation des clés : chaque écriture remplace la valeur ; null la supprime. Une session fermée n'écrit plus.
        set: async data => {
          if (!live) return;
          store.transaction(() => {
            for (const type of Object.keys(data)) {
              for (const id of Object.keys(data[type] || {})) {
                const value = data[type][id];
                store.waAuthSet(accountId, type, String(id), value ? seal(type, String(id), value) : null);
              }
            }
          });
        },
        clear: async () => { if (live) store.waAuthClear(accountId); },
      },
    },
    saveCreds: async () => { if (live) store.waAuthSet(accountId, CREDS, '', seal(CREDS, '', creds)); },
    // Après déconnexion ou changement d'appareil : les écritures tardives de l'ancienne session sont ignorées.
    close() { live = false; },
  };
}

// Session enregistrée et appairée (sans elle, aucune connexion n'est tentée au démarrage).
export function hasSession({ store, vault, accountId }) {
  const sealed = store.waAuthGet(accountId, CREDS, '');
  if (!sealed) return false;
  try {
    const data = vault.open(accountId, sealed);
    if (data?.t !== CREDS || data.i !== '') return false;
    return typeof JSON.parse(data.v)?.me?.id === 'string';
  } catch {
    return false;
  }
}
