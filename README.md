# Relay Desk

Boîte de réception locale multi-profils (email, WhatsApp, Instagram, LinkedIn), interface « Relay Inbox v2 » inspirée d’Apple Mail, dans le design system Anove AIMS.

Node.js (ESM, sans dépendance), serveur HTTP natif, SQLite (`node:sqlite`), interface en JavaScript vanilla.

## Démarrer

```bash
cp .env.example .env   # puis renseigner MISTRAL_API_KEY
npm start              # http://127.0.0.1:4310
npm test
```

Node 22.13 ou plus récent (`node:sqlite` sans option). Le plan vise Node 24.

Pour connecter un vrai compte Gmail : [docs/gmail.md](docs/gmail.md).

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `MISTRAL_API_KEY` | Clé de l’API Mistral pour l’assistant | aucune (l’assistant renvoie une erreur 503) |
| `MISTRAL_MODEL` | Modèle utilisé | `mistral-small-latest` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Client OAuth Google « Application de bureau » | aucun (Gmail désactivé) |
| `OWNER_NAME` | Nom utilisé pour signer les brouillons | `Jean-Hugues` |
| `DATA_DIR` | Base SQLite et clé de chiffrement | `./data` |
| `RELAY_SECRET_KEY` | Clé AES-256 des jetons (64 hex ou base64) | générée dans `data/secret.key` |
| `DEMO_DATA` | `0` pour démarrer sans exemples (avant le premier lancement) | `1` |
| `SYNC_INTERVAL_MS` | Fréquence de vérification Gmail | `60000` |
| `HOST`, `PORT` | Adresse d’écoute | `127.0.0.1`, `4310` |

## Ce qui est en place

- **Messages** : profils (Anove, Client Atlas, Personnel), favoris (boîte unifiée, non lus, avec drapeau, brouillons), filtres par canal, recherche, liste redimensionnable (280 à 720 px, double-clic pour réinitialiser, largeur mémorisée), lecture du fil, lu/non lu, drapeau, archivage, réponse/réponse à tous/transfert, brouillons enregistrés.
- **Dossiers et sous-dossiers** : création (Entrée pour valider, Échap pour annuler), repli, déplacement par glisser-déposer ou par le menu « Déplacer ».
- **Assistant (Mistral)** : résumé du fil et rédaction d’une réponse (intention + ton), insertion dans la réponse. Le navigateur n’envoie que l’identifiant du message ; le serveur construit le fil, le balise comme contenu non fiable et appelle Mistral. La clé ne quitte jamais le serveur.
- **Contacts** : groupes, recherche, tri, fréquence de suivi, sélection et « Voir les messages ».
- **Ajout d’un canal** : assistant en 4 étapes (service, configuration, autorisation, synchronisation).
- **Gmail (lecture et classement facultatif)** : autorisation OAuth réelle (PKCE, `gmail.readonly`), jeton chiffré, import des conversations de la période choisie avec progression réelle, libellés en dossiers, mise à jour toutes les 60 secondes par `history.list`, reprise après erreur et passage à « À reconnecter » si l’accès est révoqué. Avec **Libellés** (`gmail.modify`), lu/non lu, drapeau, archivage et dossiers sont renvoyés à Gmail avant la mise à jour locale. Le menu du compte permet de synchroniser et de modifier les permissions ; chaque nouvel accès exige une nouvelle autorisation Google et sa déclaration dans Google Auth Platform → Accès aux données.
- **Persistance** : SQLite (`data/relay.db`), migrations SQL, WAL.

## Ce qui reste simulé

- Les comptes d’exemple (`src/demo-data.js`) restent présents si `DEMO_DATA` vaut `1`.
- Outlook, Proton, WhatsApp et Instagram : la connexion ne contacte aucun fournisseur ; la progression est simulée.
- Gmail sans la permission **Libellés** reste en lecture seule ; seuls ces comptes conservent les changements de classement localement. Sans la permission **Brouillons**, les brouillons restent dans Relay.
- « Envoyer » reste désactivé : l’envoi exigera un compte réellement connecté et la validation du contenu exact.

## Structure

```
server.js              configuration et démarrage
src/http/app.js        routes JSON, fichiers statiques, en-têtes de sécurité, limites
src/store.js           dépôt SQLite et validation
src/db/                ouverture, migrations, données initiales
src/secrets.js         chiffrement des jetons
src/providers/gmail/   OAuth, client API, conversion des fils, synchronisation
src/triage.js          règles locales de triage
src/ai/                client Mistral et prompts
src/connectors.js      catalogue des services et permissions
public/                interface (index.html, styles.css, js/)
test/                  tests node:test (API et client Mistral)
```

## API

| Méthode | Route | Corps |
| --- | --- | --- |
| GET | `/api/state` | |
| GET | `/api/messages/:id` | |
| GET, POST | `/api/accounts/:id/sync` | (progression ; POST relance) |
| GET | `/oauth/google/start`, `/oauth/google/callback` | navigation |
| PATCH | `/api/messages/:id` | `{ unread?, flagged?, archived?, folderId? }` |
| PUT | `/api/messages/:id/draft` | `{ text }` |
| POST | `/api/folders` | `{ profileId, name, parentId }` |
| PATCH | `/api/contacts/:id` | `{ freq }` |
| POST | `/api/profiles/:id/accounts` | `{ name, svc }` |
| POST | `/api/ai/summary` | `{ messageId }` |
| POST | `/api/ai/draft` | `{ messageId, tone, intent }` |
| GET | `/api/health` | |
