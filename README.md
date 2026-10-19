# Relay Desk

Boîte de réception locale multi-profils (email, WhatsApp, Instagram, LinkedIn), interface « Relay Inbox v2 » inspirée d’Apple Mail, dans le design system Anove AIMS.

Node.js (ESM), serveur HTTP natif, SQLite (`node:sqlite`), interface en JavaScript vanilla. Le connecteur WhatsApp utilise Baileys et ses dépendances ; les adaptateurs email restent natifs.

## Démarrer

```bash
cp .env.example .env   # puis renseigner MISTRAL_API_KEY
npm start              # http://127.0.0.1:4310
npm test
```

Node 22.13 ou plus récent (`node:sqlite` sans option). Le plan vise Node 24.

Pour connecter tes comptes : [Gmail](docs/gmail.md), [Outlook / Microsoft 365](docs/outlook.md). L’[assistant IA](docs/ia.md) décrit sa configuration et les données transmises. Le [parcours de rédaction commun et l’architecture multi-fournisseurs](docs/messagerie.md) décrivent les nouveaux messages et l’IA.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `MISTRAL_API_KEY` | Clé de l’API Mistral pour l’assistant | aucune (l’assistant renvoie une erreur 503) |
| `MISTRAL_MODEL` | Modèle utilisé | `mistral-small-latest` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Client OAuth Google « Application de bureau » | aucun (Gmail désactivé) |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT` | Client public Microsoft Entra ; aucun secret client | aucun, tenant `common` |
| `OWNER_NAME` | Nom utilisé pour signer les brouillons | `Jean-Hugues` |
| `DATA_DIR` | Base SQLite et clé de chiffrement | `./data` |
| `RELAY_SECRET_KEY` | Clé AES-256 des jetons (64 hex ou base64) | générée dans `data/secret.key` |
| `DEMO_DATA` | `0` pour démarrer sans exemples (avant le premier lancement) | `1` |
| `SYNC_INTERVAL_MS` | Fréquence de vérification Gmail | `60000` |
| `HOST`, `PORT` | Adresse d’écoute | `127.0.0.1`, `4310` |

## Architecture prévue

Le [plan Docker et mobile](docs/architecture-docker-mobile.md), préparé avec Claude, décrit la cible : serveur hébergé personnel, accès web installé sur téléphone, authentification et migration contrôlée. Ce plan ne constitue pas un déploiement déjà réalisé.

## Ce qui est en place

- **Messages** : profils (Anove, Client Atlas, Personnel), favoris (boîte unifiée, non lus, avec drapeau, brouillons), filtres par canal, recherche, liste redimensionnable (280 à 720 px, double-clic pour réinitialiser, largeur mémorisée), lecture du fil, lu/non lu, drapeau, archivage, réponse/réponse à tous/transfert, brouillons enregistrés.
- **Dossiers et sous-dossiers** : création (Entrée pour valider, Échap pour annuler), repli, déplacement par glisser-déposer ou par le menu « Déplacer ».
- **Assistant (Mistral)** : résumé du fil, suggestion de catégorie/priorité/dossier et rédaction d’une réponse (intention + ton), pour Gmail et Outlook. Résumés et classements conservés localement, invalidés si le fil change. Le classement dans un dossier exige un clic et la permission de classement du compte. Les réponses proposées restent modifiables et passent toujours par l’aperçu exact avant chaque envoi. Le navigateur n’envoie que l’identifiant du message ; le serveur construit le fil, le balise comme contenu non fiable et appelle Mistral. La clé ne quitte jamais le serveur.
- **Contacts** : import Google/Outlook, emails et téléphones par personne, échanges associés, suggestions de doublons en arrière-plan, fusion contrôlée et annulation. **Tous les profils** réunit les comptes et personnes sans déplacer leurs données sources. **Liens et fusions** conserve les rapprochements validés et leurs annulations. Voir [contacts](docs/contacts-personnes.md) et [état du plan](docs/plan-produit-etat.md).
- **Ajout d’un canal** : assistant en 4 étapes (service, configuration, autorisation, synchronisation).
- **Gmail (lecture et classement facultatif)** : autorisation OAuth réelle (PKCE, `gmail.readonly`), jeton chiffré, import des conversations de la période choisie avec progression réelle, libellés en dossiers, mises à jour par notifications fournisseur en hébergement lorsqu’elles sont configurées, avec récupération par `history.list` et interrogation de repli, reprise après erreur et passage à « À reconnecter » si l’accès est révoqué. Avec **Libellés** (`gmail.modify`), lu/non lu, drapeau, archivage et dossiers sont renvoyés à Gmail avant la mise à jour locale. Le menu du compte permet de synchroniser et de modifier les permissions ; chaque nouvel accès exige une nouvelle autorisation Google et sa déclaration dans Google Auth Platform → Accès aux données.
- **Nouveau message** : compositeur commun avec choix du compte connecté au profil, À, Cc, Objet et texte ; brouillon fournisseur, réouverture, aperçu exact puis validation d'envoi à usage unique. Sans permission Brouillons, enregistrement local ; sans Envoi, pas d'envoi. L'assistant peut améliorer le nouveau texte après configuration IA.
- **Outlook / Microsoft 365** : adaptateur Microsoft Graph réel avec OAuth PKCE pour comptes personnels et professionnels, jetons chiffrés avec rotation, import et synchronisation delta par dossier, classement, brouillons et envoi MIME validé. L'activation exige un client Microsoft Entra et le consentement du titulaire ; une connexion réelle est vérifiée sur l’instance hébergée ; cela ne préconfigure pas les installations neuves.
- WhatsApp : liaison réelle par QR code comme appareil associé, discussions individuelles et groupes en texte sur les 7 derniers jours disponibles, identifiants de session chiffrés sur le disque de l’instance, brouillons et classement locaux. Réponses après aperçu exact uniquement ; groupes en lecture et analyse, médias et messages éphémères/vue unique exclus. Connecteur communautaire non officiel : compatibilité et accès soumis aux évolutions de WhatsApp. Voir [la configuration WhatsApp](docs/whatsapp.md).
- **Persistance** : SQLite (`data/relay.db`), migrations SQL, WAL.

## Ce qui reste simulé

- Les comptes d’exemple (`src/demo-data.js`) restent présents si `DEMO_DATA` vaut `1`.
- Proton reste à venir ; Instagram est une démonstration.
- Gmail sans la permission **Libellés** reste en lecture seule ; seuls ces comptes conservent les changements de classement localement. Sans la permission **Brouillons**, les brouillons restent dans Relay.
- « Envoyer » n’est actif que pour un compte Gmail, Outlook ou WhatsApp connecté ayant la permission **Envoi**. Les comptes d’exemple et les services sans adaptateur ne peuvent pas envoyer.
- Pas encore pris en charge : pièces jointes, rendu HTML, réponse citant le message d’origine (seul le transfert le cite).

## Structure

```
server.js              configuration et démarrage
src/http/app.js        routes JSON, fichiers statiques, en-têtes de sécurité, limites
src/store.js           dépôt SQLite et validation
src/db/                ouverture, migrations, données initiales
src/secrets.js         chiffrement des jetons
src/mail/              registre multi-fournisseurs et contrat de rédaction
src/providers/gmail/   adaptateur Google
src/providers/outlook/ adaptateur Microsoft Graph
src/providers/whatsapp/ liaison locale par QR et discussions texte
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
| POST | `/api/drafts` | `{ accountId }` → nouveau brouillon local |
| PUT | `/api/messages/:id/draft` | `{ text, mode, to?, cc?, subject? }` |
| POST | `/api/messages/:id/send/preview` | `{ text, mode, to? }` → contenu exact et `digest` |
| POST | `/api/messages/:id/send` | `{ text, mode, to?, digest }` |
| POST | `/api/accounts/:id/disconnect` | |
| POST | `/api/folders` | `{ profileId, name, parentId }` |
| PATCH | `/api/contacts/:id` | `{ freq }` |
| POST | `/api/profiles/:id/accounts` | `{ name, svc }` |
| POST | `/api/ai/summary` | `{ messageId }` |
| POST | `/api/ai/draft` | `{ messageId, tone, intent }` |
| GET | `/api/health` | |

### Historique complet des emails

Le menu de chaque compte Gmail/Outlook permet d’importer toutes les dates en arrière-plan, avec progression persistante, pause/reprise et déduplication. Les mises à jour en direct et la validation de l’aperçu exact avant envoi sont conservées. Voir [le périmètre et la reprise](docs/import-historique-mail.md).

### Historique des personnes et réponses IA

Les fiches regroupent les échanges importés avec compteurs d’activité et pagination indexée. Les suggestions peuvent s’appuyer sur des échanges anciens pertinents et les messages envoyés à cette personne, dans le profil d’envoi, avec sources visibles et validation de l’aperçu exact avant tout envoi. [Détails](docs/historique-personnes-ia.md).
