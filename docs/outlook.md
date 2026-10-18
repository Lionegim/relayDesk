# Connecter un compte Outlook / Microsoft 365

Relay lit et écrit le courrier Outlook par Microsoft Graph, avec OAuth (client public de bureau, PKCE, sans secret). Comptes personnels (outlook.com, hotmail.com, live.com) et professionnels ou scolaires (Microsoft 365). Aucun mot de passe n'est stocké : Relay garde un jeton de rafraîchissement, chiffré dans `data/relay.db`.

Sans client Microsoft configuré, aucune connexion n'est tentée : l'autorisation renvoie une erreur explicite (`outlook_unconfigured`).

## 1. Enregistrer l'application (une fois, environ 10 minutes)

1. Ouvre le [centre d'administration Microsoft Entra](https://entra.microsoft.com/) → **Applications → Inscriptions d'applications → Nouvelle inscription**.
2. **Types de comptes pris en charge** : « Comptes dans un annuaire d'organisation et comptes Microsoft personnels ».
3. **URI de redirection** : plateforme **Applications mobiles et de bureau**, valeur exacte `http://localhost:4310/oauth/microsoft/callback` (adapte le port si `PORT` change). Microsoft ignore le port d'une adresse `localhost`, mais pas le chemin : il doit être identique. Voir [Restrictions des URI de redirection](https://learn.microsoft.com/fr-fr/entra/identity-platform/reply-url).
4. **Authentification → Paramètres avancés** : « Autoriser les flux clients publics » sur **Oui**. Ne crée pas de secret client.
5. **Autorisations d'API → Microsoft Graph → Autorisations déléguées** : `User.Read`, `Mail.Read`, et selon les besoins `Mail.ReadWrite` (classement et brouillons) et `Mail.Send` (envoi). `openid`, `email` et `offline_access` sont demandés automatiquement.
6. Copie l'**ID d'application (client)**.

Dans `.env` :

```
MICROSOFT_CLIENT_ID=00000000-0000-0000-0000-000000000000
# Facultatif : common (par défaut), organizations, consumers ou l'ID d'un locataire
MICROSOFT_TENANT=common
```

Dans un locataire professionnel, un administrateur peut devoir approuver l'application avant la première connexion.

## 2. Permissions

| Interrupteur Relay | Permission Graph | Effet |
| --- | --- | --- |
| Lecture (toujours) | `Mail.Read` | Import et synchronisation |
| Libellés | `Mail.ReadWrite` | Lu/non lu, drapeau, archivage, dossiers renvoyés vers Outlook |
| Brouillons | `Mail.ReadWrite` | Brouillons Outlook réels |
| Envoi | `Mail.Send` | Envoi après validation du contenu exact |

Les permissions réellement accordées, lues sur la réponse du point de jeton, déterminent les capacités de Relay ; celles demandées ne comptent pas. Une permission supplémentaire demande une nouvelle autorisation.

## 3. Ce que fait l'adaptateur

- **Import** : conversations (regroupées par `conversationId`) reçues dans la période choisie, dans la boîte de réception, l'archive, les éléments envoyés et les dossiers personnels (jusqu'à 4 niveaux), 1 000 conversations au maximum. Les messages dans Éléments supprimés, Courrier indésirable, Brouillons et Boîte d'envoi ne sont pas affichés. Une conversation sans message dans la boîte de réception apparaît comme archivée.
- **Synchronisation** : requêtes delta Graph par dossier, toutes les 60 secondes. La corbeille et les indésirables sont suivis pour voir les messages supprimés ou déplacés. Les nouveaux dossiers sont pris en compte au passage suivant. Si un curseur expire, la période est réimportée.
- **Archivage** : une conversation reste visible tant qu'un de ses messages est dans la boîte de réception ou dans un dossier personnel (sous-dossiers de la boîte de réception compris). Elle est archivée quand ses messages ne sont plus que dans Archive ou Éléments envoyés. Archiver depuis un dossier personnel déplace ses messages vers Archive.
- **Corps** : demandés en texte brut à Graph ; rien n'est rendu en HTML. Les citations du message précédent sont retirées.
- **Jetons** : Microsoft renouvelle le jeton de rafraîchissement à chaque utilisation ; le nouveau est rechiffré aussitôt. Le jeton n'est envoyé qu'à `graph.microsoft.com` et n'apparaît ni dans l'API, ni dans les journaux.
- **Suppressions** : une entrée supprimée du delta ne porte souvent que l'identifiant du message ; Relay garde, avec les curseurs, la correspondance message → conversation des messages importés, ce qui permet d'appliquer aussi les suppressions définitives, y compris après un redémarrage.
- **Adresse du compte** : l'adresse de la boîte (`/me` → `mail`) est préférée au nom de connexion, qui peut en différer ; repli sur le nom de connexion (UPN), puis sur l'id_token.
- **Classement** (Mail.ReadWrite) : non lu marque le dernier message ; lu marque tous les messages non lus. Drapeau sur le dernier message ; retrait sur tous. Archiver déplace vers le dossier Archive les messages visibles (boîte de réception, dossiers personnels). Les messages de la corbeille, des indésirables, des brouillons et de la boîte d'envoi ne sont jamais modifiés. Graph n'offre pas d'écriture atomique sur plusieurs messages : si une erreur survient en cours de route, une partie peut déjà être appliquée dans Outlook ; Relay ne change rien localement et la synchronisation suivante reflète l'état réel. Un dossier Relay sans équivalent Outlook est créé segment par segment (`Parent/Enfant`) à son premier usage, puis lié au compte.
- **Brouillons** (Mail.ReadWrite) : créés à partir du message MIME exact (en-têtes de fil compris), puis mis à jour (objet, corps, destinataires) tant que leur rattachement au fil est inchangé. Un PATCH Graph ne modifie ni `In-Reply-To`, ni `References`, ni l'association à la conversation : si ce rattachement change (répondre → transférer, nouveau message arrivé dans le fil), le brouillon est recréé depuis le MIME exact et l'ancien brouillon Outlook est conservé (`previousDraftKept: true`), car il a pu être modifié ailleurs. Le rattachement est mémorisé par une empreinte (`draft_thread_key`, migration 005) écrite seulement lors d'une écriture Outlook ; un brouillon écrit avant cette migration est recréé une fois. Un brouillon supprimé dans Outlook est recréé. Un transfert ou un nouveau message sans destinataire reste local.
- **Envoi** (Mail.Send) : aperçu exact (De, À, Cc, Objet, corps), puis envoi du MIME validé par `/me/sendMail` après contrôle de l'empreinte SHA-256 et d'une validation à usage unique liée au message, au compte et à sa génération. Jamais d'envoi d'un brouillon existant, qui a pu être modifié ailleurs. Après un envoi réussi, toutes les validations de ce message sont annulées. Le brouillon Outlook lié est conservé (`draftRemoved: false`).
- **Nouveaux messages** (`kind: 'new'`) : aucune lecture distante ; destinataires saisis, sans doublon. Les copies que tu saisis sont conservées, y compris ta propre adresse.

## 4. Déconnexion

La plateforme d'identité Microsoft ne permet pas de révoquer un seul jeton d'application. `revokeSignInSessions` existe, mais fermerait toutes tes sessions Microsoft : Relay ne l'utilise pas. La déconnexion supprime donc le jeton, les messages importés et les liens de dossiers dans Relay, et renvoie `revoked: false`. Pour retirer l'accès chez Microsoft :

- compte personnel : [account.live.com/consent/Manage](https://account.live.com/consent/Manage) ;
- compte professionnel : [myapps.microsoft.com](https://myapps.microsoft.com) (ou ton administrateur).

## 5. Limites connues

- Une conversation dont les messages sont dans plusieurs dossiers personnels est rangée dans le dossier du message le plus récent.
- Pièces jointes et rendu HTML : non pris en charge.

## 6. Intégration (pour le socle)

Fichiers : `src/providers/outlook/{oauth,api,parse,sync,actions,outbox,disconnect}.js`.

```js
import { createMicrosoftOAuth } from './src/providers/outlook/oauth.js';
import { createOutlookSync } from './src/providers/outlook/sync.js';
import { createOutlookOutbox } from './src/providers/outlook/outbox.js';
import { createOutlookDisconnect } from './src/providers/outlook/disconnect.js';

const oauth = createMicrosoftOAuth({ clientId: process.env.MICROSOFT_CLIENT_ID, tenant: process.env.MICROSOFT_TENANT || 'common' });
const sync = createOutlookSync({ store, vault, oauth });
const outlook = {
  oauth, sync,
  outbox: createOutlookOutbox({ store, sync, ownerName }),
  disconnect: createOutlookDisconnect({ store, sync }),
  redirectUri: `http://localhost:${port}/oauth/microsoft/callback`, // identique à l'URI enregistrée
};
// createApp({ providers: { outlook }, gmail, ... }) ; sync.start(intervalMs) au démarrage, sync.stop() à l'arrêt.
```

- `oauth.configured` : booléen. `oauth.start({ redirectUri, context, perms })` → URL ; `perms` ⊂ `read`, `labels`, `drafts`, `send` ; `context.address` sert de `login_hint`.
- `oauth.finish({ state, code })` → `{ context, email, refreshToken, accessToken, expiresIn, idToken, scopes }`. `email` est toujours renseigné (id_token, sinon `/me`) ; `scopes` sont les permissions accordées, normalisées (`mail.read`, …).
- `sync` : `connect({ profileId, name, windowDays, refreshToken, email, scopes })` → `{ account, job }`, `permissions(id)`, `progress(id)`, `syncNow(id)`, `start(ms)`, `stop()`, `updateMessage(id, patch)`, `forget(id, fn)`, `queue(id, fn)`, `exclusive(id, fn)` (fn reçoit `{ graph, email, live }`), `generation(id)`.
- `outbox` : `saveDraft(id, input)`, `preview(id, input)`, `send(id, { ...input, digest })` ; `input` = `{ mode, text, to?, cc?, subject? }` validé par `readComposeInput` (`src/mail/input.js`). `saveDraft` passe `threadKey` à `store.saveDraft` et lit `composeContext(id).draftThreadKey` (migration 005). Réponses identiques à Gmail (`synced`, `sent`, `draftRemoved`, codes `digest_mismatch`, `confirmation_invalid`, `send_forbidden`, `provider`, `retryable`).
- `disconnect(id)` → `{ disconnected: true, revoked: false, consentUrls }`.
- Le compte est enregistré avec `svc: 'outlook'`, `channel: 'email'`. Le route callback doit afficher « Microsoft » et non « Google » dans ses messages d'erreur (`/oauth/*/callback` partagé).
