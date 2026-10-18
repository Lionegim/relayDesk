export const CH = {
  email: { label: 'Email', mark: '@', tint: 'var(--core-100)', ink: 'var(--core-600)' },
  whatsapp: { label: 'WhatsApp', mark: 'W', tint: 'var(--success-muted)', ink: 'var(--success)' },
  instagram: { label: 'Instagram', mark: 'IG', tint: 'var(--engine-50)', ink: 'var(--engine-600)' },
  linkedin: { label: 'LinkedIn', mark: 'in', tint: 'var(--stream-50)', ink: 'var(--stream-700)' },
};
export const LABELS = { 'À traiter': 'action', 'Prospect': 'highlight', 'Partenariat': 'brand-subtle', 'Réseau': 'secondary', 'Client': 'brand-subtle', 'Perso': 'secondary', 'Newsletter': 'outline' };
export const ACCOUNT_COLORS = { muted: 'var(--muted-foreground)', warn: 'var(--boost-700)', info: 'var(--stream-700)', ok: 'var(--success)' };
export const NAV = [['all', 'Boîte unifiée'], ['unread', 'Non lus'], ['todo', 'Avec drapeau'], ['drafts', 'Brouillons']];
export const GROUPS = [['all', 'Tous les contacts'], ['clients', 'Clients'], ['prospects', 'Prospects'], ['presse', 'Presse'], ['partenaires', 'Partenaires'], ['equipe', 'Équipe']];
export const FREQ = ['Définir la fréquence', 'Chaque semaine', 'Chaque mois', 'Chaque trimestre'];
export const SORTS = [['recent', 'Tri : dernier échange'], ['name', 'Tri : nom']];
export const AV = [['var(--core-100)', 'var(--core-600)'], ['var(--stream-100)', 'var(--stream-700)'], ['var(--engine-100)', 'var(--engine-700)'], ['var(--success-muted)', 'var(--success)'], ['var(--boost-100)', 'var(--boost-700)']];
export const TONES = ['Cordial', 'Formel', 'Bref'];
export const STEPS = [['pick', 'Service'], ['config', 'Configuration'], ['auth', 'Autorisation'], ['sync', 'Synchronisation']];
export const WINDOWS = [7, 30, 90];
export const CONTACT_CHANNELS = ['linkedin', 'email', 'whatsapp', 'instagram'];

// Réglages d'affichage (équivalents des « Tweaks » de la maquette).
export const SETTINGS = { density: 'confortable', showTriage: true };

const svg = inner => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const ICON = {
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>'),
  people: svg('<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20a6.5 6.5 0 0 1 13 0"></path><path d="M16 4.5a3.5 3.5 0 0 1 0 7"></path><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"></path>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3 6h.01M3 12h.01M3 18h.01"></path>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>'),
  lines: svg('<path d="M4 6h16"></path><path d="M7 12h10"></path><path d="M10 18h4"></path>'),
  compose: svg('<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>'),
  reply: svg('<path d="M9 14 4 9l5-5"></path><path d="M4 9h11a5 5 0 0 1 5 5v6"></path>'),
  replyAll: svg('<path d="M7 14 2 9l5-5"></path><path d="M12 14 7 9l5-5"></path><path d="M7 9h9a5 5 0 0 1 5 5v6"></path>'),
  forward: svg('<path d="m15 14 5-5-5-5"></path><path d="M20 9H9a5 5 0 0 0-5 5v6"></path>'),
  archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"></path><path d="M10 13h4"></path>'),
  sparkle: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"></path>'),
  funnel: svg('<path d="M4 5h16l-6 7v6l-4 2v-8Z"></path>'),
  sort: svg('<path d="M7 4v16M3 8l4-4 4 4"></path><path d="M17 20V4M13 16l4 4 4-4"></path>'),
  search: svg('<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>'),
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>',
  flag: on => `<svg width="16" height="16" viewBox="0 0 24 24" fill="${on ? 'var(--engine-500)' : 'none'}" stroke="${on ? 'var(--engine-500)' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"></path><path d="M5 4h12l-2 4 2 4H5"></path></svg>`,
};
