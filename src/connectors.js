// Catalogue des services connectables. La connexion reste simulée tant que les adaptateurs
// (src/providers/) n'existent pas : aucun secret ne transite par cette description.

export const PERMISSIONS = {
  read: ['Lecture', 'Messages et fils de discussion'],
  labels: ['Libellés', 'Classer chez le fournisseur'],
  drafts: ['Brouillons', 'Préparer des réponses'],
  send: ['Envoi', 'Uniquement après ta validation'],
  mcp: ['Accès assistant (MCP)', 'Exposer ce seul compte à un assistant'],
};

// fields : [clé, libellé, valeur initiale, placeholder, type, lecture seule, pleine largeur]
export const SERVICES = {
  // `real` : connexion effective. `available` : permissions déjà prises en charge (les autres restent grisées).
  gmail: { name: 'Gmail', provider: 'Google', ch: 'email', note: 'Gmail ou Google Workspace', auth: 'oauth', btn: 'Continuer avec Google', perms: ['read', 'labels', 'drafts', 'send', 'mcp'],
    real: true, available: ['read', 'labels', 'drafts', 'send'],
    scopes: { read: ['Lire les messages', 'gmail.readonly'], labels: ['Classer, lu/non lu, archiver', 'gmail.modify'], drafts: ['Créer des brouillons', 'gmail.compose'], send: ['Envoyer des messages', 'gmail.send'] } },
  outlook: { name: 'Outlook / Microsoft 365', provider: 'Microsoft', ch: 'email', note: 'Compte personnel ou professionnel', auth: 'oauth', btn: 'Continuer avec Microsoft', perms: ['read', 'labels', 'drafts', 'send', 'mcp'],
    real: true, available: ['read', 'labels', 'drafts', 'send'],
    scopes: { read: ['Lire les messages', 'Mail.Read'], labels: ['Classer les messages', 'Mail.ReadWrite'], drafts: ['Créer des brouillons', 'Mail.ReadWrite'], send: ['Envoyer des messages', 'Mail.Send'] } },
  proton: { name: 'Proton Mail', disabled: true, state: 'À venir', provider: 'Proton Bridge', ch: 'email', note: 'Via Proton Mail Bridge sur cette machine', auth: 'fields', btn: 'Tester la connexion', perms: ['read', 'labels', 'send', 'mcp'],
    fields: [['host', 'Hôte IMAP', '127.0.0.1'], ['port', 'Port', '1143'], ['address', 'Adresse', '', 'prenom@proton.me'], ['password', 'Mot de passe Bridge', '', '••••••••', 'password']] },
  whatsapp: { name: 'WhatsApp', provider: 'WhatsApp', ch: 'whatsapp', note: 'Lier ton téléphone par QR code', auth: 'qr', btn: 'Afficher le QR code',
    real: true, available: ['read', 'drafts', 'send'], perms: ['read', 'drafts', 'send'], scopes: {}, localLabels: true,
    scopesNote: 'La liaison d’un appareil donne techniquement accès à la lecture et à l’envoi. Relay Desk exige un aperçu validé avant chaque envoi. Brouillons, dossiers et drapeaux restent sur ce Mac.' },
  instagram: { name: 'Instagram professionnel', provider: 'Meta', ch: 'instagram', note: 'Compte pro lié à une Page Facebook', auth: 'oauth', btn: 'Continuer avec Meta', perms: ['read', 'send', 'mcp'],
    scopes: { read: ['Lire les messages directs', 'instagram_manage_messages'], send: ['Répondre aux messages', 'instagram_manage_messages'] } },
  linkedin: { name: 'LinkedIn', ch: 'linkedin', note: 'Messagerie non ouverte via API', disabled: true, state: 'Accès à vérifier' },
};
