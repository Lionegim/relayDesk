# OAuth de messagerie : modes desktop et web

Gmail et Outlook se connectent par OAuth 2.0 avec deux modes explicites :

- **desktop** (défaut, inchangé) : client « application de bureau » Google et client public Microsoft. Le retour se fait sur la boucle locale (`127.0.0.1`, `localhost`, `[::1]`). Utilisé sur le Mac.
- **web** : client Web **confidentiel** et adresse de retour HTTPS **fixe**. Obligatoire en mode hébergé, puisqu'un retour sur la boucle locale du téléphone ne peut pas atteindre le serveur.

Les deux modes appliquent PKCE S256, `state` et `nonce`. Les connexions en attente sont limitées à 100, expirent au bout de 10 minutes et ne servent qu'une fois, y compris après un échec.

## Variables (mode hébergé)

Les identifiants Web sont **distincts** des identifiants de bureau. On ne réutilise jamais un client de bureau en mode web.

| Variable | Rôle |
| --- | --- |
| `MAIL_OAUTH_MODE` | `desktop` ou `web` (lue par le runtime ; le mode hébergé exige `web`). |
| `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET` (ou `*_FILE`) | Client Google de type « Application Web ». |
| `MICROSOFT_WEB_CLIENT_ID`, `MICROSOFT_WEB_CLIENT_SECRET` (ou `*_FILE`) | Application Entra avec plateforme « Web » et secret client (ou certificat, non pris en charge ici). |
| `MICROSOFT_TENANT` | `consumers` pour un compte personnel, `organizations`, `common`, un identifiant de tenant ou un domaine vérifié. |
| Adresses de retour | `PUBLIC_BASE_URL/oauth/google/callback` et `PUBLIC_BASE_URL/oauth/microsoft/callback`, déclarées à l'identique chez chaque fournisseur. |

Les identifiants de bureau restent `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` et `MICROSOFT_CLIENT_ID`. Le client de bureau Microsoft n'a jamais de secret.

## Contrat

```js
createGoogleOAuth({ clientId, clientSecret, mode = 'desktop', redirectUri = null, fetchImpl, clock = Date.now })
createMicrosoftOAuth({ clientId, clientSecret = null, mode = 'desktop', redirectUri = null, tenant = 'common', fetchImpl, clock = Date.now })
```

- **Construction** :
  - en mode web avec un identifiant, il faut un secret et une `redirectUri` HTTPS absolue, sans identifiants, requête ni fragment ;
  - sinon, erreur `oauth_configuration` au démarrage ;
  - sans identifiant, `configured` vaut `false`.
- **`oauth.mode`** et **`oauth.binding`** :
  - `binding` est un SHA-256 hexadécimal du JSON canonique `{v:1, provider, mode, clientId, redirectUri, authority}` ;
  - `redirectUri` vaut la valeur fixe en mode web et `"loopback"` en desktop ;
  - `authority` vaut `https://accounts.google.com`, ou `https://login.microsoftonline.com/<tenant>/v2.0` ;
  - **jamais le secret**. Changer de client, de mode, d'adresse de retour ou de tenant change l'empreinte.
- **`start({ redirectUri?, context, perms })`** :
  - en web, toute `redirectUri` fournie doit être exactement celle de la configuration (sinon 400 `oauth_redirect`) ; sans valeur, celle de la configuration est utilisée ;
  - en desktop, l'adresse doit être sur la boucle locale ;
  - si le client n'est pas configuré, la méthode lève une 503 (`gmail_unconfigured` ou `outlook_unconfigured`).
- **`finish({ state, code })`** renvoie `{ context, email?, refreshToken, accessToken, expiresIn, idToken, scopes, mode, binding }`.
  - Google web : `email` vient de `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` (`emailAddress`) avec le jeton d'accès. Si le profil est illisible ou invalide, erreur `oauth_no_email`.
  - Google desktop : pas d'`email` ; l'application le lit dans l'id_token comme avant.
  - Microsoft : `email` vient de Graph `/me` (`mail`, puis `userPrincipalName`). En web, si Graph est illisible, erreur `oauth_no_email`, sans repli sur l'id_token. En desktop, le repli historique sur l'id_token est conservé.
  - L'appelant HTTP doit utiliser le `binding` de la fabrique, pas celui du résultat.
- **`refresh(refreshToken)`** renvoie la réponse du point de jeton. Microsoft renvoie en général un nouveau `refresh_token` : il faut le conserver.

**Secrets** : ils passent dans le corps POST au point de jeton, pour l'échange du code comme pour le rafraîchissement (Google dans les deux modes, Microsoft en mode web). Ils n'apparaissent jamais dans une URL. Le client Microsoft desktop n'envoie aucun secret.

**Erreurs** : seules des catégories connues sont reprises (`invalid_grant`, `invalid_client`, …) dans le code interne. Les messages ne contiennent ni code arbitraire, ni description du fournisseur, ni adresse.

**ID tokens** : aucun ID token n'est validé ni utilisé comme preuve d'identité en mode web. Le `nonce` est envoyé, mais l'identité repose sur l'API du fournisseur appelée avec le jeton d'accès.

## Google : points à vérifier avant usage réel

L'état réel du projet Google n'a pas été inspecté ici.

- Plusieurs portées Gmail demandées (lecture, modification, rédaction) sont classées **restreintes**. Leur usage en production relève de la vérification des portées restreintes, qui peut comprendre une évaluation de sécurité.
- Les exceptions prévues pour un usage personnel ne garantissent pas des jetons de rafraîchissement permanents.
- En statut de publication **Testing**, les jetons de rafraîchissement peuvent expirer au bout de **7 jours**.
- Le compte doit avoir accordé `access_type=offline`. `prompt=consent` est demandé pour obtenir un jeton de rafraîchissement.

Sources : [Google OAuth 2.0 pour applications web serveur](https://developers.google.com/identity/protocols/oauth2/web-server), [Vérification des portées restreintes](https://support.google.com/cloud/answer/13464325).

## Microsoft : points à vérifier

- L'inscription doit avoir une plateforme **Web**, l'adresse de retour HTTPS exacte et un secret client. Un secret a une date d'expiration : prévoir son renouvellement.
- Le flux code avec PKCE et secret est conforme à la plateforme d'identité v2. Le jeton de rafraîchissement tourne à chaque utilisation.

Source : [Microsoft identity platform, flux du code d'autorisation](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).

## Reconnexion avec un client Web

Les jetons émis pour un client de bureau ne sont pas utilisables par un client Web. Le runtime enregistre `oauthBinding` dans les identifiants chiffrés et refuse un jeton dont l'empreinte diffère, avant tout rafraîchissement. Chaque compte est alors reconnecté via le client Web, avec conservation des données (même compte, même adresse vérifiée).
