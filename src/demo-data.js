// Données de démonstration. Remplacées par la synchronisation réelle des comptes dans les lots suivants.

export const PROFILES = [
  { id: 'anove', name: 'Anove', kind: 'Profil professionnel', initials: 'AN',
    accounts: [
      { name: 'Anove', channel: 'email', status: 'Exemple', c: 'muted' },
      { name: 'WhatsApp pro', channel: 'whatsapp', svc: 'whatsapp', status: 'À configurer', c: 'warn' },
      { name: 'Instagram', channel: 'instagram', svc: 'instagram', status: 'À configurer', c: 'warn' },
      { name: 'LinkedIn', channel: 'linkedin', svc: 'linkedin', status: 'Accès à vérifier', c: 'info' },
    ] },
  { id: 'atlas', name: 'Client Atlas', kind: 'Profil client', initials: 'CA',
    accounts: [{ name: 'Atlas', channel: 'email', status: 'Exemple', c: 'muted' }] },
  { id: 'perso', name: 'Personnel', kind: 'Profil personnel', initials: 'JH',
    accounts: [
      { name: 'Proton perso', channel: 'email', status: 'Exemple', c: 'muted' },
      { name: 'Gmail perso', channel: 'email', status: 'Exemple', c: 'muted' },
    ] },
];

export const FOLDERS = [
  { id: 'f1', p: 'anove', name: 'Presse', parent: null },
  { id: 'f2', p: 'anove', name: 'Commercial', parent: null },
  { id: 'f3', p: 'anove', name: 'Démos', parent: 'f2' },
  { id: 'f4', p: 'anove', name: 'Partenariats', parent: 'f2' },
  { id: 'f5', p: 'atlas', name: 'Ateliers', parent: null },
  { id: 'f6', p: 'perso', name: 'Famille', parent: null },
];

// `trail` liste les messages précédents du fil, du plus récent au plus ancien.
export const MESSAGES = [
  { id: 1, p: 'anove', from: 'Marina Volgina', initials: 'MV', handle: 'marina@anove.ai', channel: 'email', account: 'Anove', time: '16:08', unread: true, flagged: true, folderId: 'f1', label: 'À traiter',
    subject: 'Validation du communiqué de presse', preview: 'Tu peux valider la version finale avant envoi ?',
    body: 'Bonjour Jean-Hugues,\n\nJ’ai intégré les dernières modifications du communiqué. Peux-tu valider la version finale avant que je l’envoie au Progrès ?\n\nMerci,\nMarina',
    triage: 'Action requise : validation avant l’envoi au Progrès.',
    trail: [
      { from: 'Jean-Hugues Migeon', initials: 'JH', time: 'Mer. 11:20', body: 'Merci Marina. Peux-tu raccourcir le deuxième paragraphe et ajouter la citation de Claire ?' },
      { from: 'Marina Volgina', initials: 'MV', time: 'Mar. 17:45', body: 'Voici le premier jet du communiqué pour le lancement d’insAIght. Le Progrès attend une version d’ici vendredi.' },
    ] },
  { id: 2, p: 'anove', from: 'Thomas R.', initials: 'TR', handle: '+33 6 •• •• 21', channel: 'whatsapp', account: 'WhatsApp pro', time: '15:19', unread: true, flagged: false, folderId: 'f3', label: 'Prospect',
    subject: 'Question sur insAIght', preview: 'Peut-on déplacer la démo à jeudi matin ?',
    body: 'Bonjour,\n\nPeut-on déplacer la démo insAIght à jeudi matin ? Mercredi ne fonctionne plus de notre côté.\n\nThomas',
    triage: 'Demande de reprogrammation : à confirmer dans l’agenda.',
    trail: [{ from: 'Jean-Hugues Migeon', initials: 'JH', time: 'Lun. 09:02', body: 'Parfait, je vous confirme la démo mercredi 14h.' }] },
  { id: 3, p: 'anove', from: 'atelier.urbain', initials: 'AU', handle: '@atelier.urbain', channel: 'instagram', account: 'Instagram', time: '14:21', unread: false, flagged: false, folderId: 'f4', label: 'Partenariat',
    subject: 'Nouveau message Instagram', preview: 'Nous aimerions échanger au sujet d’un partenariat…',
    body: 'Bonjour l’équipe Anove,\n\nNous aimerions échanger au sujet d’un partenariat autour de votre prochain événement. Seriez-vous disponibles la semaine prochaine ?',
    triage: 'Proposition de partenariat : pas d’échéance détectée.', trail: [] },
  { id: 4, p: 'anove', from: 'Sophie Martin', initials: 'SM', handle: 'linkedin.com/in/sophiemartin', channel: 'linkedin', account: 'LinkedIn', time: 'Hier', unread: false, flagged: false, folderId: null, label: 'Réseau',
    subject: 'Message sur la page Anove', preview: 'Échanger au sujet de votre publication sur l’IA…',
    body: 'Bonjour,\n\nJ’ai lu votre publication sur la gouvernance de l’IA. J’aimerais échanger à ce sujet si vous avez un moment.\n\nSophie',
    triage: 'Prise de contact réseau : aucune action urgente.', trail: [] },
  { id: 5, p: 'anove', from: 'La Lettre IA', initials: 'LI', handle: 'news@lettre-ia.fr', channel: 'email', account: 'Anove', time: 'Mer.', unread: false, flagged: false, folderId: null, label: 'Newsletter',
    subject: 'Cette semaine : AI Act, calendrier', preview: 'Les nouvelles échéances de mise en conformité…',
    body: 'Les nouvelles échéances de mise en conformité, et ce qu’elles changent pour les équipes produit.',
    triage: 'Newsletter : classée automatiquement, aucune revue nécessaire.', trail: [] },
  { id: 6, p: 'atlas', from: 'Claire Dubois', initials: 'CD', handle: 'claire@atlas.fr', channel: 'email', account: 'Atlas', time: '15:42', unread: true, flagged: true, folderId: 'f5', label: 'Client',
    subject: 'Atelier de cadrage — créneaux', preview: 'Le créneau de mardi fonctionne pour notre équipe.',
    body: 'Bonjour,\n\nLe créneau de mardi 10h fonctionne pour notre équipe. Pouvez-vous envoyer l’invitation ?\n\nClaire',
    triage: 'Action requise : envoyer l’invitation pour mardi 10h.',
    trail: [{ from: 'Jean-Hugues Migeon', initials: 'JH', time: 'Hier 18:10', body: 'Bonjour Claire, voici trois créneaux possibles pour l’atelier : lundi 14h, mardi 10h ou jeudi 16h.' }] },
  { id: 7, p: 'perso', from: 'Daria', initials: 'D', handle: 'daria@proton.me', channel: 'email', account: 'Proton perso', time: '14:56', unread: true, flagged: false, folderId: null, label: 'Perso',
    subject: 'Pour ce week-end', preview: 'J’ai réservé le restaurant pour samedi soir…',
    body: 'J’ai réservé le restaurant pour samedi soir, 20h. Ça te va ?',
    triage: 'Message personnel : aucune action automatique.', trail: [] },
];

export const CONTACTS = [
  { id: 'c1', p: 'anove', name: 'Marina Volgina', title: 'Responsable communication, Anove', freq: 1, ch: ['email', 'whatsapp'], last: 'Aujourd’hui', g: ['equipe', 'presse'], order: 0 },
  { id: 'c2', p: 'anove', name: 'Thomas R.', title: 'Directeur risques, Banque Rhône', freq: 2, ch: ['whatsapp', 'linkedin'], last: 'Aujourd’hui', g: ['prospects'], order: 1 },
  { id: 'c3', p: 'anove', name: 'atelier.urbain', title: '', freq: 0, ch: ['instagram'], last: 'Aujourd’hui', g: ['partenaires'], order: 2 },
  { id: 'c4', p: 'anove', name: 'Sophie Martin', title: 'DPO, Groupe Hélios', freq: 0, ch: ['linkedin', 'email'], last: 'Hier', g: ['prospects'], order: 3 },
  { id: 'c5', p: 'anove', name: 'Claire Dubois', title: 'Head of Compliance, Atlas', freq: 1, ch: ['email', 'linkedin'], last: 'Hier', g: ['clients'], order: 4 },
  { id: 'c6', p: 'anove', name: 'Yuri Bobbert', title: 'Founder & CEO, Anove', freq: 3, ch: ['email', 'whatsapp', 'linkedin'], last: 'Hier', g: ['equipe'], order: 5 },
  { id: 'c7', p: 'anove', name: 'Paul Odon', title: '', freq: 0, ch: ['email'], last: 'Il y a 2 j', g: [], order: 6 },
  { id: 'c8', p: 'anove', name: 'Anne-Laure Chansard', title: 'Head of Marketing, Philips France', freq: 0, ch: ['linkedin'], last: 'Il y a 2 j', g: ['prospects'], order: 7 },
  { id: 'c9', p: 'anove', name: 'Martin Mohr', title: 'Partner, AP Moller Capital', freq: 2, ch: ['email', 'linkedin'], last: 'Il y a 3 j', g: ['clients'], order: 8 },
  { id: 'c10', p: 'anove', name: 'Nadjima Hassani', title: 'Journaliste, Le Progrès', freq: 0, ch: ['email'], last: 'Il y a 4 j', g: ['presse'], order: 9 },
  { id: 'c11', p: 'anove', name: 'Gael Alexander', title: 'Développeur fullstack', freq: 3, ch: ['whatsapp', 'linkedin'], last: 'Il y a 5 j', g: ['equipe'], order: 10 },
  { id: 'c12', p: 'anove', name: 'Sonny Massaar', title: 'Account manager, Revolut', freq: 0, ch: ['email'], last: 'La semaine dernière', g: ['partenaires'], order: 11 },
  { id: 'c13', p: 'atlas', name: 'Claire Dubois', title: 'Head of Compliance, Atlas', freq: 1, ch: ['email'], last: 'Aujourd’hui', g: ['clients'], order: 0 },
  { id: 'c14', p: 'atlas', name: 'Hugo Lambert', title: 'CISO, Atlas', freq: 2, ch: ['email', 'linkedin'], last: 'Il y a 3 j', g: ['clients'], order: 1 },
  { id: 'c15', p: 'perso', name: 'Daria', title: '', freq: 0, ch: ['email', 'whatsapp'], last: 'Aujourd’hui', g: [], order: 0 },
  { id: 'c16', p: 'perso', name: 'Maison', title: '', freq: 0, ch: ['whatsapp'], last: 'Hier', g: [], order: 1 },
];
