import { join } from 'node:path';
import { createApp } from './src/http/app.js';
import { createStore } from './src/store.js';
import { openDatabase } from './src/db/index.js';
import { seedIfEmpty } from './src/db/seed.js';
import { createMistralClient } from './src/ai/mistral.js';
import { loadKey, createVault } from './src/secrets.js';
import { createGoogleOAuth } from './src/providers/gmail/oauth.js';
import { createGmailSync } from './src/providers/gmail/sync.js';
import { createGmailDisconnect } from './src/providers/gmail/disconnect.js';
import { createGmailOutbox } from './src/providers/gmail/outbox.js';

import { createMicrosoftOAuth } from './src/providers/outlook/oauth.js';
import { createOutlookSync } from './src/providers/outlook/sync.js';
import { createOutlookOutbox } from './src/providers/outlook/outbox.js';
import { createOutlookDisconnect } from './src/providers/outlook/disconnect.js';
import { createWhatsAppProvider } from './src/providers/whatsapp/index.js';

const port = Number(process.env.PORT) || 4310;
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.DATA_DIR || join(import.meta.dirname, 'data');

const db = openDatabase(join(dataDir, 'relay.db'));
seedIfEmpty(db, { demo: process.env.DEMO_DATA !== '0' });
const store = createStore(db);
store.pruneReplyMemory();
store.learnAvailableReplies();
const memoryPruning = setInterval(()=>store.pruneReplyMemory(),3600000);
memoryPruning.unref();

const vault = createVault(loadKey({ envKey: process.env.RELAY_SECRET_KEY, keyFile: join(dataDir, 'secret.key') }));
const oauth = createGoogleOAuth({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET });
const sync = createGmailSync({ store, vault, oauth });
const disconnect = createGmailDisconnect({ store, vault, sync });
const outbox = createGmailOutbox({ store, sync, ownerName: process.env.OWNER_NAME || 'Jean-Hugues' });

const microsoftOAuth = createMicrosoftOAuth({ clientId: process.env.MICROSOFT_CLIENT_ID, tenant: process.env.MICROSOFT_TENANT || 'common' });
const outlookSync = createOutlookSync({ store, vault, oauth: microsoftOAuth });
const outlookOutbox = createOutlookOutbox({ store, sync: outlookSync, ownerName: process.env.OWNER_NAME || 'Jean-Hugues' });
const outlookDisconnect = createOutlookDisconnect({ store, vault, sync: outlookSync });
const providers = { outlook: { oauth: microsoftOAuth, sync: outlookSync, outbox: outlookOutbox, disconnect: outlookDisconnect, redirectUri: `http://localhost:${port}/oauth/microsoft/callback` } };
const whatsapp = await createWhatsAppProvider({ store, vault });
providers.whatsapp = whatsapp;

const ai = createMistralClient({ apiKey: process.env.MISTRAL_API_KEY || '', model: process.env.MISTRAL_MODEL || 'mistral-small-latest' });
const server = createApp({
  store, ai, providers,
  ownerName: process.env.OWNER_NAME || 'Jean-Hugues',
  gmail: { oauth, sync, disconnect, outbox, redirectUri: `http://127.0.0.1:${port}/oauth/google/callback` },
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`],
});

server.listen(port, host, () => {
  console.log(`Relay Desk sur http://127.0.0.1:${port}`);
  if (!ai.configured) console.warn('MISTRAL_API_KEY absente : l’assistant renverra une erreur.');
  if (!oauth.configured) console.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET absents : la connexion Gmail est désactivée.');
  sync.start(Number(process.env.SYNC_INTERVAL_MS) || 60000);
  outlookSync.start(Number(process.env.SYNC_INTERVAL_MS) || 60000);
  Promise.resolve(whatsapp.sync.start()).catch(() => console.error('WhatsApp : reprise différée des sessions locales.'));
});

const stop = async () => { clearInterval(memoryPruning); sync.stop(); outlookSync.stop(); await whatsapp.sync.stop(); server.close(() => { db.close(); process.exit(0); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
