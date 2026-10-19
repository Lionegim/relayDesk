import {createWhatsAppAvatars} from './avatars.js';
import {HttpError} from '../../http/errors.js';
import {createWhatsAppMentions} from './mentions.js';
// Fournisseur WhatsApp (appareil lié par QR). Connecteur communautaire Baileys, non officiel : voir docs/whatsapp.md.
import {createWhatsAppMedia} from './media.js';
import { createWhatsAppSync } from './sync.js';
import { createWhatsAppOutbox } from './outbox.js';
import { loadBaileys, makeBaileysSocket } from './socket.js';

// makeSocket et lib sont injectables pour les tests (faux socket, aucune connexion réelle).
export async function createWhatsAppProvider({ store, vault, makeSocket = makeBaileysSocket, lib = loadBaileys, log = console, timing, assertAccountAllowed, requireLinkedIdentity=false, avatarOptions } = {}) {
  if (!store || !vault) throw new Error('createWhatsAppProvider : store et vault requis.');
  let sync;
  const media=createWhatsAppMedia({store,vault,lib,socket:id=>sync.liveSocket(id),canUpload:id=>sync.permissions(id).includes('send'),generation:id=>sync.generation(id)});
  sync = createWhatsAppSync({ media, store, vault, lib, makeSocket, log, timing, assertAccountAllowed, requireLinkedIdentity });
  const mentions=createWhatsAppMentions({store,sync});
  const avatars=createWhatsAppAvatars({store,sync,mentions,...avatarOptions});
  const outbox = createWhatsAppOutbox({ store, sync, media, mentions });
  return {
    configured: true,
    media, avatars,
    participants:async id=>{const scope=store.waConversationScope(id),members=await mentions.participants(id);if(scope!==store.waConversationScope(id))throw new HttpError(409,'La discussion a changé.','account_changed');const photoScope=store.waAvatarTarget('messages',id).scope;return {scope,members:members.map(p=>({...p,avatarUrl:`/api/messages/${id}/whatsapp-avatar?scope=${photoScope}&participant=${encodeURIComponent(p.jid)}`}))};},
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
      react: (id,input)=>outbox.react(id,input),
      saveDraft: (id, input) => outbox.saveDraft(id, input),
      preview: (id, input) => outbox.preview(id, input),
      send: (id, input) => outbox.send(id, input),
    },
    disconnect: accountId => sync.disconnect(accountId),
  };
}
