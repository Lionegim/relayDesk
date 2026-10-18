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

// linking : nouvelle liaison par QR. Le profil « Desktop » (plateforme DARWIN) est celui des applications de bureau,
// auxquelles le téléphone envoie l'historique récent le plus large ; il ne s'applique qu'à l'appairage, une session
// déjà enregistrée garde son profil d'origine. syncFullHistory reste désactivé : pas d'historique complet sans borne.
export async function makeBaileysSocket({ auth, linking = false }) {
  const lib = await loadBaileys();
  const logger = pino({ level: 'silent' });
  return lib.default({
    auth: { creds: auth.state.creds, keys: lib.makeCacheableSignalKeyStore(auth.state.keys, logger) },
    logger,
    browser: linking ? lib.Browsers.macOS('Desktop') : lib.Browsers.macOS('Relay Desk'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Tous les types d'historique sont traités, y compris FULL (réponse à une demande bornée à 7 jours) ;
    // le filtre strict de Relay (7 jours, discussions directes, texte) s'applique ensuite à chaque message.
    shouldSyncHistoryMessage: () => true,
    enableRecentMessageCache: false,
    enableAutoSessionRecreation: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
}
