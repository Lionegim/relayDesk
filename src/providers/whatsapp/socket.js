// Socket WhatsApp par défaut : Baileys (client communautaire non officiel de WhatsApp Web), chargé seulement
// quand une liaison ou une session enregistrée le demande. Journal Baileys muet : ni QR, ni clé, ni contenu.
// Les statuts, chaînes et médias sont écartés avant stockage ; les groupes texte sont autorisés.
import pino from 'pino';
import { redactSignalLogs } from './redact-signal-logs.js';

let baileys = null;
export async function loadBaileys() {
  redactSignalLogs();
  baileys ||= await import('@whiskeysockets/baileys');
  return baileys;
}

// Le profil utilisé à la liaison est conservé pour toute la vie de la session. Le téléphone peut transmettre des lots plus anciens :
// le filtre de sept jours s'applique à chaque message avant stockage dans Relay.
export async function makeBaileysSocket({ auth, historyProfile = null }) {
  const lib = await loadBaileys();
  const logger = pino({ level: 'silent' });
  return lib.default({
    auth: { creds: auth.state.creds, keys: lib.makeCacheableSignalKeyStore(auth.state.keys, logger) },
    logger,
    browser: lib.Browsers.macOS(historyProfile === 'desktop-full' ? 'Desktop' : historyProfile === 'chrome-full' ? 'Chrome' : 'Relay Desk'),
    markOnlineOnConnect: false,
    syncFullHistory: !!historyProfile,
    // Tous les types d'historique sont traités, y compris FULL (réponse à une demande bornée à 7 jours) ;
    // le filtre strict de Relay (7 jours, discussions directes, texte) s'applique ensuite à chaque message.
    shouldSyncHistoryMessage: () => true,
    enableRecentMessageCache: false,
    enableAutoSessionRecreation: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
}
