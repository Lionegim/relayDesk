import {directJid} from './parse.js';
// État d'authentification Baileys stocké dans SQLite, chiffré par le coffre : identifiants de session (creds) et
// chaque clé Signal séparément. Remplace useMultiFileAuthState (fichiers JSON en clair).
// Chaque valeur chiffrée porte son type et son identifiant ({ t, i, v }) : une ligne déplacée vers une autre clé
// du même compte est rejetée à la lecture. Rien n'est journalisé.

const CREDS = 'creds';

export function createAuthState({ store, vault, accountId, lib, onAliasesChanged=()=>{} }) {
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

  function jidAliases(value) {
    const jid=directJid(value);
    if(!jid)return [value]; // Groups have no phone/LID alias.
    const ownPhone=directJid(creds.me?.id),ownLid=directJid(creds.me?.lid);
    if(ownPhone?.endsWith('@s.whatsapp.net') && ownLid?.endsWith('@lid') && [ownPhone,ownLid].includes(jid))return [ownPhone,ownLid];
    const [user,domain]=jid.split('@');
    try {
      if(domain==='lid') {
        const phone=open('lid-mapping',`${user}_reverse`);
        if(typeof phone==='string' && /^\d{5,20}$/.test(phone) && open('lid-mapping',phone)===user)return [jid,`${phone}@s.whatsapp.net`];
      } else {
        const lid=open('lid-mapping',user);
        if(typeof lid==='string' && /^\d{5,20}$/.test(lid) && open('lid-mapping',`${lid}_reverse`)===user)return [jid,`${lid}@lid`];
      }
    } catch { /* An unreadable or inconsistent mapping never changes another identity's policy. */ }
    return [jid];
  }

  return {
    jidAliases,
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
          if(data['lid-mapping'])onAliasesChanged();
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
