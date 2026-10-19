// Fournisseur WhatsApp (appareil lié par QR). Connecteur communautaire Baileys, non officiel : voir docs/whatsapp.md.
import { createWhatsAppSync } from './sync.js';
import { createWhatsAppOutbox } from './outbox.js';
import { loadBaileys, makeBaileysSocket } from './socket.js';

// makeSocket et lib sont injectables pour les tests (faux socket, aucune connexion réelle).
export async function createWhatsAppProvider({ store, vault, makeSocket = makeBaileysSocket, lib = loadBaileys, log = console, timing, assertAccountAllowed, requireLinkedIdentity=false } = {}) {
  if (!store || !vault) throw new Error('createWhatsAppProvider : store et vault requis.');
  const sync = createWhatsAppSync({ store, vault, lib, makeSocket, log, timing, assertAccountAllowed, requireLinkedIdentity });
  const outbox = createWhatsAppOutbox({ store, sync });
  return {
    configured: true,
    startLink: input => sync.startLink(input),
    relink: input => sync.relink(input),
    linkStatus: linkId => sync.linkStatus(linkId),
    cancelLink: linkId => sync.cancelLink(linkId),
    sync: {
      permissions: id => sync.permissions(id),
      progress: id => sync.progress(id),
      syncNow: id => sync.syncNow(id),
      updateMessage: (id, patch) => sync.updateMessage(id, patch),
      generation: id => sync.generation(id),
      start: () => sync.start(),
      pause: () => sync.pause(),
      drain: () => sync.drain(),
      stop: () => sync.stop(),
    },
    outbox: {
      saveDraft: (id, input) => outbox.saveDraft(id, input),
      preview: (id, input) => outbox.preview(id, input),
      send: (id, input) => outbox.send(id, input),
    },
    disconnect: accountId => sync.disconnect(accountId),
  };
}
