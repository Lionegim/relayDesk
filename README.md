# Relay Desk

Boîte de réception locale multi-profils (email, WhatsApp, Instagram, LinkedIn), interface « Relay Inbox v2 » inspirée d’Apple Mail, dans le design system Anove AIMS.

Node.js (ESM, sans dépendance), serveur HTTP natif, interface en JavaScript vanilla.

## Démarrer

```bash
cp .env.example .env   # puis renseigner MISTRAL_API_KEY
npm start              # http://127.0.0.1:4310
npm test
```

Node 22.9 ou plus récent (`--env-file-if-exists`). Le plan vise Node 24 ; rien ici n’en dépend encore.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `MISTRAL_API_KEY` | Clé de l’API Mistral pour l’assistant | aucune (l’assistant renvoie une erreur 503) |
| `MISTRAL_MODEL` | Modèle utilisé | `mistral-small-latest` |
| `OWNER_NAME` | Nom utilisé pour signer les brouillons | `Jean-Hugues` |
| `HOST`, `PORT` | Adresse d’écoute | `127.0.0.1`, `4310` |

## Ce qui est en place

- **Messages** : profils (Anove, Client Atlas, Personnel), favoris (boîte unifiée, non lus, avec drapeau, brouillons), filtres par canal, recherche, liste redimensionnable (280 à 720 px, double-clic pour réinitialiser, largeur mémorisée), lecture du fil, lu/non lu, drapeau, archivage, réponse/réponse à tous/transfert, brouillons enregistrés.
- **Dossiers et sous-dossiers** : création (Entrée pour valider, Échap pour annuler), repli, déplacement par glisser-déposer ou par le menu « Déplacer ».
- **Assistant (Mistral)** : résumé du fil et rédaction d’une réponse (intention + ton), insertion dans la réponse. Le navigateur n’envoie que l’identifiant du message ; le serveur construit le fil, le balise comme contenu non fiable et appelle Mistral. La clé ne quitte jamais le serveur.
- **Contacts** : groupes, recherche, tri, fréquence de suivi, sélection et « Voir les messages ».
- **Ajout d’un canal** : assistant en 4 étapes (service, configuration, autorisation, synchronisation).

## Ce qui reste simulé

- Les données sont des exemples gardés en mémoire (`src/demo-data.js`) : elles reviennent à l’état initial à chaque redémarrage. `src/store.js` isole l’accès pour un passage à SQLite (`node:sqlite`).
- La connexion d’un canal ne contacte aucun fournisseur : la progression est simulée, puis le compte est marqué « Connecté ».
- « Envoyer » reste désactivé : l’envoi exigera un compte réellement connecté et la validation du contenu exact.

## Structure

```
server.js              configuration et démarrage
src/http/app.js        routes JSON, fichiers statiques, en-têtes de sécurité, limites
src/store.js           dépôt en mémoire et validation
src/ai/                client Mistral et prompts
src/connectors.js      catalogue des services et permissions
public/                interface (index.html, styles.css, js/)
test/                  tests node:test (API et client Mistral)
```

## API

| Méthode | Route | Corps |
| --- | --- | --- |
| GET | `/api/state` | |
| PATCH | `/api/messages/:id` | `{ unread?, flagged?, archived?, folderId? }` |
| PUT | `/api/messages/:id/draft` | `{ text }` |
| POST | `/api/folders` | `{ profileId, name, parentId }` |
| PATCH | `/api/contacts/:id` | `{ freq }` |
| POST | `/api/profiles/:id/accounts` | `{ name, svc }` |
| POST | `/api/ai/summary` | `{ messageId }` |
| POST | `/api/ai/draft` | `{ messageId, tone, intent }` |
| GET | `/api/health` | |
