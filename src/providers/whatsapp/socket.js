// Socket WhatsApp par défaut : Baileys (client communautaire non officiel de WhatsApp Web), chargé seulement
// quand une liaison ou une session enregistrée le demande. Journal Baileys muet : ni QR, ni clé, ni contenu.
// Les groupes, statuts et chaînes sont reçus normalement par Baileys (pas de refus côté protocole) et ignorés à l'import.
import pino from 'pino';
import { redactSignalLogs } from './redact-signal-logs.js';

let baileys = null;
export async function loadBaileys() {
  redactSignalLogs();
  baileys ||= await import('@whiskeysockets/baileys');
  return baileys;
}

export async function makeBaileysSocket({ auth }) {
  const lib = await loadBaileys();
  const logger = pino({ level: 'silent' });
  return lib.default({
    auth: { creds: auth.state.creds, keys: lib.makeCacheableSignalKeyStore(auth.state.keys, logger) },
    logger,
    browser: lib.Browsers.macOS('Relay Desk'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    enableRecentMessageCache: false,
    enableAutoSessionRecreation: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
}
