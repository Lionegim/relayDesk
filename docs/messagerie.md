# Messagerie commune et nouveaux messages

Relay compose un message indépendamment de son fournisseur. Chaque compte conserve son adresse, son profil, ses permissions accordées et son jeton chiffré. Un nom de compte déjà utilisé ne peut pas être réattribué silencieusement à une autre adresse ou à un autre fournisseur.

## Nouveau message

Le bouton **Nouveau message** ouvre un compositeur avec **De**, **À**, **Cc**, **Objet** et **Message**, même si aucune conversation n'est sélectionnée. Le choix De porte sur les comptes email réellement connectés au profil courant. Après le premier enregistrement, le compte du brouillon est fixé ; pour utiliser un autre compte, créer un autre message.

- **Enregistrer** crée un brouillon chez le fournisseur si la permission Brouillons est accordée, puis met à jour ce brouillon aux enregistrements suivants. Sans cette permission ou sans destinataire, le texte reste dans Relay.
- La liste **Brouillons** permet de rouvrir une composition enregistrée, avec destinataires, copie, objet et texte. Les modifications non enregistrées restent en mémoire quand on ferme et rouvre le compositeur dans la même session ; elles ne survivent pas à un rechargement de la page.
- **Vérifier avant l'envoi** enregistre la version courante, puis fait calculer par le serveur l'aperçu exact : expéditeur, destinataires, copies, objet, corps. L'envoi exige un second clic dans cette fenêtre et une validation à usage unique. Toute modification demande un nouvel aperçu.
- Un nouveau message n'ajoute ni `Re:` ni `Fwd:`, aucun en-tête de réponse et aucun fil d'origine. Le choix des destinataires vient de l'utilisateur ; l'expéditeur est toujours lu sur le compte connecté.
- Après envoi, le brouillon local est retiré. Un brouillon distant éventuellement lié est conservé, car il peut avoir été modifié directement chez le fournisseur. Relay le signale.

## Fournisseurs

`src/mail/service.js` choisit l'adaptateur depuis le compte propriétaire du message. Les routes et le compositeur utilisent ce registre plutôt qu'un appel spécifique Gmail. `src/mail/input.js` définit le contrat commun de rédaction. Les adaptateurs exposent OAuth, synchronisation, permissions, actions, brouillons, aperçu, envoi et déconnexion.

- Gmail utilise OAuth Google et l'API Gmail : [configuration](gmail.md).
- Outlook et Microsoft 365 utilisent OAuth Microsoft et Microsoft Graph : [configuration](outlook.md). Une application Microsoft Entra doit être configurée avant toute connexion réelle.
- Proton/Bridge et les autres services sans adaptateur ne deviennent pas connectables par cette abstraction. IMAP/SMTP, pièces jointes et rendu HTML constituent des évolutions distinctes. Les canaux de démonstration existants restent identifiés comme tels.

Les fournisseurs renvoient leurs capacités à partir des permissions réellement accordées. Un compte sans Envoi ne peut pas utiliser le bouton d'envoi. Les tests utilisent de faux fournisseurs ; ils n'envoient aucun email réel.

## IA commune

Le résumé et la rédaction utilisent le même service IA pour tous les fournisseurs, à partir du message conservé localement. Le compositeur propose **Améliorer avec l'IA** pour un nouveau message : le serveur fournit le brouillon et l'objet au modèle, puis l'utilisateur peut insérer/modifier le résultat avant une nouvelle validation d'envoi. Le modèle ne peut pas envoyer à la place de l'utilisateur.

L'installation actuelle nécessite `MISTRAL_API_KEY` pour activer l'assistant. Sans clé, les actions IA sont indisponibles et l'interface l'indique. Lorsqu'une action IA est déclenchée, son contenu est transmis à Mistral ; les jetons Google/Microsoft ne sont jamais inclus. Le courrier reçu reste du contenu non fiable dans les prompts.
