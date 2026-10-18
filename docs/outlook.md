# Connecter un compte Outlook / Microsoft 365

Relay lit et écrit le courrier Outlook par Microsoft Graph, avec OAuth (client public de bureau, PKCE, sans secret). Comptes personnels (outlook.com, hotmail.com, live.com) et professionnels ou scolaires (Microsoft 365). Aucun mot de passe n'est stocké : Relay garde un jeton de rafraîchissement, chiffré dans `data/relay.db`.

Sans client Microsoft configuré, aucune connexion n'est tentée : l'autorisation renvoie une erreur explicite (`outlook_unconfigured`).

## 1. Enregistrer l'application (une fois, environ 10 minutes)

1. Ouvre le [centre d'administration Microsoft Entra](https://entra.microsoft.com/) → **Applications → Inscriptions d'applications → Nouvelle inscription**.
2. **Types de comptes pris en charge** : « Comptes dans un annuaire d'organisation et comptes Microsoft personnels ».
3. **URI de redirection** : plateforme **Applications mobiles et de bureau**, valeur `http://localhost`. Pour `localhost`, Microsoft ignore le port : `http://localhost:4310/oauth/microsoft/callback` est accepté.
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
- **Corps** : demandés en texte brut à Graph ; rien n'est rendu en HTML. Les citations du message précédent sont retirées.
- **Jetons** : Microsoft renouvelle le jeton de rafraîchissement à chaque utilisation ; le nouveau est rechiffré aussitôt. Le jeton n'est envoyé qu'à `graph.microsoft.com` et n'apparaît ni dans l'API, ni dans les journaux.
- **Classement** (Mail.ReadWrite) : non lu marque le dernier message ; lu marque tous les messages non lus. Drapeau sur le dernier message ; retrait sur tous. Archiver déplace vers le dossier Archive les messages de la boîte de réception. Un dossier Relay sans équivalent Outlook est créé segment par segment (`Parent/Enfant`) à son premier usage, puis lié au compte.
- **Brouillons** (Mail.ReadWrite) : créés à partir du message MIME exact (en-têtes de fil compris), puis mis à jour (objet, corps, destinataires). Un brouillon supprimé dans Outlook est recréé. Un transfert ou un nouveau message sans destinataire reste local.
- **Envoi** (Mail.Send) : aperçu exact (De, À, Cc, Objet, corps), puis envoi du MIME validé par `/me/sendMail` après contrôle de l'empreinte SHA-256 et d'une validation à usage unique liée au message, au compte et à sa génération. Jamais d'envoi d'un brouillon existant, qui a pu être modifié ailleurs. Après un envoi réussi, toutes les validations de ce message sont annulées. Le brouillon Outlook lié est conservé (`draftRemoved: false`).
- **Nouveaux messages** (`kind: 'new'`) : aucune lecture distante ; destinataires saisis, sans doublon ni ta propre adresse en copie.

## 4. Déconnexion

La plateforme d'identité Microsoft ne permet pas de révoquer un seul jeton d'application. `revokeSignInSessions` existe, mais fermerait toutes tes sessions Microsoft : Relay ne l'utilise pas. La déconnexion supprime donc le jeton, les messages importés et les liens de dossiers dans Relay, et renvoie `revoked: false`. Pour retirer l'accès chez Microsoft :

- compte personnel : [account.live.com/consent/Manage](https://account.live.com/consent/Manage) ;
- compte professionnel : [myapps.microsoft.com](https://myapps.microsoft.com) (ou ton administrateur).

## 5. Limites connues

- Une suppression définitive (sans passage par Éléments supprimés) n'est vue qu'au prochain réimport complet.
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
  redirectUri: `http://localhost:${port}/oauth/microsoft/callback`,
};
// createApp({ providers: { outlook }, gmail, ... }) ; sync.start(intervalMs) au démarrage, sync.stop() à l'arrêt.
```

- `oauth.configured` : booléen. `oauth.start({ redirectUri, context, perms })` → URL ; `perms` ⊂ `read`, `labels`, `drafts`, `send` ; `context.address` sert de `login_hint`.
- `oauth.finish({ state, code })` → `{ context, email, refreshToken, accessToken, expiresIn, idToken, scopes }`. `email` est toujours renseigné (id_token, sinon `/me`) ; `scopes` sont les permissions accordées, normalisées (`mail.read`, …).
- `sync` : `connect({ profileId, name, windowDays, refreshToken, email, scopes })` → `{ account, job }`, `permissions(id)`, `progress(id)`, `syncNow(id)`, `start(ms)`, `stop()`, `updateMessage(id, patch)`, `forget(id, fn)`, `queue(id, fn)`, `exclusive(id, fn)` (fn reçoit `{ graph, email, live }`), `generation(id)`.
- `outbox` : `saveDraft(id, input)`, `preview(id, input)`, `send(id, { ...input, digest })` ; `input` = `{ mode, text, to?, cc?, subject? }` validé par `readComposeInput`. Réponses identiques à Gmail (`synced`, `sent`, `draftRemoved`, codes `digest_mismatch`, `confirmation_invalid`, `send_forbidden`, `provider`, `retryable`).
- `disconnect(id)` → `{ disconnected: true, revoked: false, consentUrls }`.
- Le compte est enregistré avec `svc: 'outlook'`, `channel: 'email'`. Le route callback doit afficher « Microsoft » et non « Google » dans ses messages d'erreur (`/oauth/*/callback` partagé).
