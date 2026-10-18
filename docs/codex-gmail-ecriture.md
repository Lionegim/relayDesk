# Relay Desk : Gmail en écriture (instructions pour Codex)

## Contexte

Relay Desk est une boîte de réception locale multi-profils. Dépôt : `Lionegim/relayDesk`, branche `main`.

- Node.js ≥ 22.13, modules ESM, **aucune dépendance npm** (garder ce principe).
- Serveur HTTP natif (`src/http/app.js`), SQLite via `node:sqlite` (`src/db/`, migrations SQL numérotées), dépôt unique `src/store.js`.
- Interface en JavaScript vanilla (`public/js/`) : état et actions dans `app.js`, gabarits dans `views.js` (gabarit `html\`\`` qui échappe tout par défaut), délégation d'événements par attributs `data-on-click`, `data-on-input`, etc. Styles dans `public/styles.css` (jetons du design system Anove).
- Gmail est connecté **en lecture seule** : `src/providers/gmail/` (`oauth.js` PKCE + state à usage unique, `api.js` client REST, `parse.js` fil → ligne, `sync.js` import initial + `history.list`). Le jeton de rafraîchissement est chiffré (`src/secrets.js`, AES-256-GCM) dans la table `secrets`.
- Lis d'abord `README.md`, `docs/gmail.md`, `src/providers/gmail/*.js`, `src/store.js`, `test/gmail.test.js`.

Aujourd'hui, lu/non lu, drapeau, archivage, dossiers et brouillons modifiés dans Relay restent locaux, et « Envoyer » est désactivé. Le travail ci-dessous rend ces actions réelles dans Gmail, par lots livrables séparément. **Fais un commit par lot**, tests verts à chaque fois.

## Règles à respecter partout

1. **Permissions minimales et progressives.** Ne demande jamais `https://mail.google.com/`. Chaque lot ajoute une seule permission Gmail, demandée uniquement si l'utilisateur active l'interrupteur correspondant dans l'assistant de connexion. Utilise l'autorisation incrémentale (`include_granted_scopes=true`, déjà en place).
2. **Les permissions accordées font foi.** Stocke la liste des scopes réellement accordés (réponse du point de jeton) avec le jeton chiffré, et expose dans `/api/state`, pour chaque compte, `perms` : la liste des capacités accordées (`read`, `labels`, `drafts`, `send`). Jamais le jeton.
3. **Gmail d'abord, base locale ensuite.** Pour une action en écriture sur un compte Gmail qui a la permission : appelle Gmail ; si Gmail réussit, mets à jour SQLite ; sinon renvoie l'erreur (l'interface annule déjà sa mise à jour optimiste). Sans la permission, garde le comportement local actuel.
4. **Contenu des messages = non fiable.** Pas de rendu HTML, pas d'exécution d'instructions tirées des messages.
5. **Envoi uniquement après validation du contenu exact** (lot D).
6. Aucun jeton, aucun corps de message dans les journaux.
7. Textes d'interface en français, style existant. Ne change pas le design hors des éléments décrits.
8. Tests : `npm test` (node:test). Étends le faux Google de `test/gmail.test.js` (`fakeGoogle()`) pour les nouvelles routes Gmail, y compris les requêtes POST. Aucun appel réseau réel dans les tests.

## Préalables communs (avant le lot A)

- `src/providers/gmail/api.js` : ajoute une méthode `post(path, body)` (JSON) avec la même gestion d'erreurs que `get` (401 → rafraîchissement unique, 404 → `not_found`, 429/5xx → `retryable`).
- `src/providers/gmail/oauth.js` : `start()` reçoit la liste des capacités demandées et construit les scopes à partir de cette table :

  | Capacité | Scope |
  | --- | --- |
  | `read` | `https://www.googleapis.com/auth/gmail.readonly` |
  | `labels` | `https://www.googleapis.com/auth/gmail.modify` |
  | `drafts` | `https://www.googleapis.com/auth/gmail.compose` |
  | `send` | `https://www.googleapis.com/auth/gmail.send` |

  `finish()` renvoie les scopes accordés ; `sync.connect()` les chiffre avec le jeton (`{ refreshToken, email, scopes }`). Les anciens secrets sans `scopes` valent `['…gmail.readonly']`.
- `/oauth/google/start` accepte un paramètre `perms` (liste séparée par des virgules, validée contre la table).
- `src/connectors.js` : dans `SERVICES.gmail`, mets à jour `scopes.labels` en `['Classer, lu/non lu, archiver', 'gmail.modify']` et étends `available` lot par lot (`['read', 'labels']` après le lot A, etc.).
- Interface : l'assistant envoie les permissions cochées. Cliquer sur un compte Gmail **déjà connecté** ouvre un petit menu (style `.menu` existant) : « Synchroniser maintenant » (`POST /api/accounts/:id/sync`), « Modifier les permissions » (assistant à l'étape Configuration, permissions actuelles cochées, puis nouvelle autorisation Google), « Déconnecter » (lot B).

## Lot A : actions renvoyées vers Gmail (`gmail.modify`)

**Correspondances** (via `POST threads/{threadId}/modify` avec `addLabelIds` / `removeLabelIds`) :

| Action Relay | Gmail |
| --- | --- |
| Marquer lu / non lu | retirer / ajouter `UNREAD` |
| Drapeau | ajouter / retirer `STARRED` |
| Archiver | retirer `INBOX` |
| Déplacer dans un dossier | ajouter le libellé du dossier, retirer l'ancien libellé utilisateur |
| « Aucun dossier » | retirer le libellé utilisateur actuel |

**Dossiers et libellés**

- Migration `002_folder_labels.sql` : table `folder_labels (folder_id, account_id, label_id, PRIMARY KEY (folder_id, account_id))`. Reprends-y les liens existants (`folders.account_id` / `folders.external_id`), puis fais lire `ensureLabelFolder` et l'import dans cette table.
- Déplacer un fil Gmail dans un dossier sans libellé pour ce compte : crée le libellé dans Gmail (`POST labels`, nom = chemin du dossier, sous-dossiers séparés par `/` comme Gmail), enregistre le lien, puis applique-le. Si Gmail répond 409 (nom existant), retrouve le libellé par son nom avec `GET labels`.
- Renommer ou supprimer un dossier n'existe pas encore : ne l'ajoute pas.

**Où coder** : un module `src/providers/gmail/actions.js` appelé par la route `PATCH /api/messages/:id` quand le message appartient à un compte Gmail qui a `labels`. Garde la validation actuelle de `store.updateMessage`.

**Fini quand**
- Les cinq actions se retrouvent dans Gmail (vérifiable dans l'interface Gmail).
- La mise à jour suivante par `history.list` ne fait pas revenir l'ancien état.
- Sans la permission, rien ne part vers Gmail.
- Tests : chaque correspondance, création de libellé (y compris le cas 409), erreur Gmail → 502 et base inchangée.

## Lot B : déconnexion

- `POST /api/accounts/:id/disconnect` : révoque le jeton (`POST https://oauth2.googleapis.com/revoke`, corps `token=<refresh>`, une erreur de révocation n'empêche pas la suite), supprime le secret, l'état de synchronisation, les messages et les liens de libellés du compte, puis supprime le compte. Les dossiers locaux restent.
- Interface : « Déconnecter » dans le menu du compte, avec confirmation (« Les messages importés de ce compte seront retirés de Relay. Ils restent dans Gmail. »).
- Le worker de synchronisation ne doit plus toucher un compte supprimé (y compris une synchronisation déjà en cours : vérifie l'existence du compte avant chaque écriture, ou annule).
- Tests : révocation appelée, données supprimées, jeton introuvable ensuite.

## Lot C : brouillons Gmail (`gmail.compose`)

- Pour répondre correctement, l'import doit garder, pour le dernier message du fil : `Message-ID`, `References`, `From`, `To`, `Cc`, `Reply-To`. Migration `003` : colonnes correspondantes dans `messages`, plus `draft_external_id`. Mets `parse.js` et l'import à jour.
- `src/providers/gmail/mime.js` : construit un message RFC 5322 en UTF-8 (en-têtes encodés RFC 2047 si nécessaire, corps `text/plain; charset=utf-8` en quoted-printable ou base64, lignes CRLF), puis l'encode en base64url pour le champ `raw`.
  - Répondre : `To` = `Reply-To` sinon `From` ; objet `Re: …` (sans doubler le `Re:`) ; `In-Reply-To` et `References` renseignés ; `threadId` du fil.
  - Répondre à tous : ajoute `To` et `Cc` d'origine, sans ta propre adresse ni doublons.
  - Transférer : objet `Fwd: …`, destinataire saisi par l'utilisateur (ajoute un champ « À » dans le compositeur pour ce seul mode), message d'origine cité sous un séparateur.
- « Enregistrer » sur un message Gmail avec `drafts` : `POST drafts` la première fois, `PUT drafts/{id}` ensuite ; garde `draft_external_id`. Sans la permission : comportement local actuel.
- Le mode de réponse (`reply`, `replyAll`, `forward`) doit être envoyé avec le brouillon et mémorisé.
- Tests : MIME produit (en-têtes, encodage, accents, objet), destinataires de « répondre à tous », création puis mise à jour du brouillon.

## Lot D : envoi après validation (`gmail.send`)

- « Envoyer » s'active seulement pour un compte Gmail qui a `send` et un brouillon non vide.
- Deux étapes côté serveur, pour garantir que ce qui part est exactement ce qui a été validé :
  1. `POST /api/messages/:id/send/preview` `{ mode, text, to? }` → construit le MIME final et renvoie `{ from, to, cc, subject, body, digest }`, où `digest` = SHA-256 du MIME.
  2. `POST /api/messages/:id/send` `{ mode, text, to?, digest }` → reconstruit le MIME, refuse (409) si le hash diffère, sinon envoie (`POST messages/send` avec `raw` et `threadId`, ou `POST drafts/send` si un brouillon Gmail existe), efface le brouillon local et lance `syncNow`.
- Interface : clic sur « Envoyer » → fenêtre de confirmation (même style que la fenêtre d'ajout de canal) qui affiche De, À, Cc, Objet et le corps exact, avec « Annuler » et « Confirmer l'envoi ». Pendant l'envoi le bouton est désactivé ; en cas d'erreur, message dans la fenêtre.
- Ne jamais envoyer sans l'étape 2 et un `digest` valide.
- Tests : `digest` différent → 409 et rien d'envoyé ; envoi dans le bon fil ; brouillon nettoyé.

## Documentation

À la fin de chaque lot, mets à jour `docs/gmail.md` (permissions, ce qui part vers Gmail, limites) et la section « Ce qui reste simulé » du `README.md`. Indique que l'ajout d'une permission demande une nouvelle autorisation Google et que l'écran de consentement doit déclarer le nouveau scope (Google Auth Platform → Accès aux données).

## Hors périmètre

Autres fournisseurs (Outlook, Proton, WhatsApp, Instagram), rendu HTML, pièces jointes, notifications push Gmail (Pub/Sub), nouvelles dépendances npm, refonte de l'interface.
