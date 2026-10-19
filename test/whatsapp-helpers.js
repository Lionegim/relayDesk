// Faux sockets WhatsApp : événements pilotés par le test, aucune connexion, aucun QR réel, aucun envoi.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db/index.js';
import { seedIfEmpty } from '../src/db/seed.js';
import { createStore } from '../src/store.js';
import { createVault } from '../src/secrets.js';
import { createWhatsAppProvider } from '../src/providers/whatsapp/index.js';

export const ME = '33612345678';
export const PEER = '33698765432@s.whatsapp.net';
export const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await new Promise(r => setTimeout(r, 5));
  }
}
export const closed = statusCode => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
export const msg = (id, text, { chat = PEER, fromMe = false, ago = 3600, pushName = 'Claire', extra = {} } = {}) => ({
  key: { remoteJid: chat, id, fromMe }, pushName, messageTimestamp: Math.floor(Date.now() / 1000) - ago,
  message: { conversation: text, ...extra },
});

export function fakeSockets() {
  const list = [];
  const make = async ({ auth, historyProfile }) => {
    const sock = {
      ev: new EventEmitter(), auth, historyProfile, user: undefined, sent: [], ended: false, loggedOut: false, failSend: false,
      async sendMessage(jid, content) {
        if (sock.failSend) throw new Error('réseau');
        sock.sent.push({ jid, content });
        return { key: { id: `OUT${sock.sent.length}`, remoteJid: jid, fromMe: true } };
      },
      async logout() { sock.loggedOut = true; },
      end() { sock.ended = true; },
      emit(name, data) { sock.ev.emit(name, data); },
    };
    list.push(sock);
    return sock;
  };
  return { list, make, last: () => list.at(-1) };
}

export async function setupWhatsApp({ db, vault, timing, assertAccountAllowed } = {}) {
  db ||= openDatabase(':memory:');
  seedIfEmpty(db);
  const store = createStore(db);
  vault ||= createVault(randomBytes(32));
  const sockets = fakeSockets();
  const logs = [];
  const log = { warn: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const wa = await createWhatsAppProvider({ store, vault, makeSocket: sockets.make, log, assertAccountAllowed, timing: { settleMs: 50, retryBaseMs: 20, ...timing } });
  return { db, store, vault, sockets, wa, logs };
}

// Simule la validation du QR sur le téléphone, le redémarrage demandé par WhatsApp puis la connexion.
export async function pairAndOpen(ctx, { phone = ME } = {}) {
  const first = ctx.sockets.last();
  first.auth.state.creds.me = { id: `${phone}:7@s.whatsapp.net`, name: 'Moi' };
  first.emit('creds.update', {});
  first.emit('connection.update', closed(515));
  await tick();
  const sock = ctx.sockets.last();
  sock.user = { id: `${phone}:7@s.whatsapp.net` };
  sock.emit('connection.update', { connection: 'open' });
  await tick();
  return sock;
}

export async function linkedAccount(ctx, { name = 'WhatsApp perso', profileId = 'perso', messages = [msg('A1', 'Bonjour, on se voit jeudi ?')] } = {}) {
  const { linkId, accountId } = await ctx.wa.startLink({ profileId, name, windowDays: 7 });
  await tick();
  ctx.sockets.last().emit('connection.update', { qr: 'faux-qr-de-test' });
  await tick();
  const sock = await pairAndOpen(ctx);
  sock.emit('messaging-history.set', { chats: [], contacts: [{ id: PEER, name: 'Claire Dubois' }], messages, isLatest: true });
  await tick();
  return { linkId, accountId, sock };
}
