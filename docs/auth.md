# Authentification du propriétaire

Relay Desk n'a qu'un utilisateur : son propriétaire. En mode hébergé, chaque accès passe par un fournisseur d'identité OIDC (Keycloak prévu) avec authentification forte. Il n'y a ni inscription, ni liste d'adresses : seul le couple émetteur + `sub` configuré est accepté, et seulement avec le niveau d'authentification (`acr`) exigé.

Ce module ne configure aucun fournisseur réel. Les tests utilisent un émetteur simulé (JWKS et ID tokens fictifs signés RS256), sans réseau.

## Configuration

| Variable | Rôle |
| --- | --- |
| `AUTH_MODE` | `oidc` ou `disabled`. Défaut : `oidc` en hébergé, `disabled` en local. Le mode hébergé refuse `disabled`. |
| `AUTH_ISSUER` | URL HTTPS exacte de l'émetteur, identique au champ `issuer` de sa découverte (Keycloak : `https://idp.exemple/realms/<realm>`). |
| `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` (ou `*_FILE`) | Client Web confidentiel. |
| `AUTH_OWNER_SUB` | `sub` exact du propriétaire chez l'émetteur (identifiant stable, pas une adresse). |
| `AUTH_MFA_ACR` | Valeur `acr` exacte exigée dans l'ID token signé (p. ex. `relay-mfa`, associée au niveau LoA 2 dans Keycloak). Obligatoire en mode `oidc`. |
| `AUTH_SESSION_TTL_HOURS` | Durée absolue d'une session (défaut 12 h). |
| `AUTH_IDLE_TTL_HOURS` | Expiration après inactivité (défaut 1 h, au plus la durée absolue). |
| `AUTH_RECENT_MINUTES` | Fenêtre de « confirmation récente » pour les actions sensibles (défaut 10 min). |

`readAuthConfig({ env, mode, publicBaseUrl, secret })` (`src/auth/config.js`) produit `config.auth` :

```js
{ enabled, issuer, clientId, clientSecret, ownerSub, mfaAcr, publicBaseUrl, secureCookies,
  sessionTtlMs, idleTtlMs, recentMs, redirectUri }   // redirectUri = PUBLIC_BASE_URL + /auth/callback
```

## API (`src/auth/index.js`)

```js
const auth = await createOwnerAuth({ config, db, clock = Date.now, oidc = null, log = console });
auth.enabled                       // false en mode local désactivé
await auth.handle(req, res, url)   // true si /auth/* a été traité (réponse envoyée), false sinon
auth.requireSession(req)           // { id, csrfToken, authenticatedAt, createdAt, expiresAt, idleExpiresAt, acr, mfa } ou HttpError 401 auth_required
auth.assertMutation(req, session)  // méthodes non sûres : Sec-Fetch-Site same-origin, Origin === PUBLIC_BASE_URL, x-csrf-token ; sinon 403 csrf_rejected
auth.assertRecent(session)         // sinon 403 reauth_required → /auth/login?reauth=1
auth.close()
```

`oidc` : réservé aux tests et à l'intégration sans réseau. Soit `{ fetch }` (l'adaptateur openid-client réel fait passer découverte, JWKS et jeton par ce fetch), soit un adaptateur complet. Le serveur n'en fournit jamais.

En mode désactivé, `requireSession` renvoie `null` et `assertMutation`/`assertRecent` ne font rien. Seule `GET /auth/session` répond (`{ enabled: false, authenticated: false }`).

### Routes publiques

| Route | Effet |
| --- | --- |
| `GET /auth/login[?reauth=1]` | Crée une transaction (state, nonce, vérificateur PKCE) liée au cookie `__Host-relay_login` (HttpOnly, SameSite=Lax, Secure, 10 min), puis redirige vers l'émetteur avec `code_challenge` S256 et `acr_values`. `reauth=1` ajoute `prompt=login` et `max_age=0`. |
| `GET /auth/callback` | Transaction à usage unique. openid-client vérifie state, PKCE, émetteur, audience, **signature** (avec `enableNonRepudiationChecks`, JWKS de la découverte), expiration et nonce. Puis Relay exige `iss` et `sub` exacts et `acr === AUTH_MFA_ACR`. Pour une réauthentification, `auth_time` signé de moins de 5 min. Crée une session et redirige vers `/`. |
| `GET /auth/session` | `200 { enabled: true, authenticated: true, csrfToken, sessionId, authenticatedAt, expiresAt, mfa, recent }`, ou `401 { enabled: true, authenticated: false }`. |

### Routes authentifiées

| Route | Effet |
| --- | --- |
| `POST /auth/logout` | CSRF exigé. Révoque la session et efface le cookie. |
| `GET /auth/sessions` | Appareils actifs : `{ id, current, device, createdAt, lastSeenAt, expiresAt, authenticatedAt, mfa, recent }`. Aucun jeton. |
| `DELETE /auth/sessions/:id` | CSRF exigé. Retirer un **autre** appareil exige une confirmation récente ; retirer le sien revient à se déconnecter. |

## Sessions

- Jeton opaque de 32 octets dans le cookie `__Host-relay_session` (HttpOnly, SameSite=Lax, Secure en HTTPS). En SQLite, seule son empreinte SHA-256 est stockée (`auth_sessions`, table créée par le module).
- Jeton CSRF dérivé du jeton de session (HMAC). Il n'est ni stocké, ni valable pour une autre session.
- Rotation à chaque connexion : la session précédente du même navigateur est révoquée.
- Expiration absolue et par inactivité. Révocation par appareil.
- Chaque session est liée à l'empreinte de la configuration (émetteur, client, propriétaire, acr). Changer l'un d'eux invalide toutes les sessions au redémarrage.

## Protections

- Limite de débit sur `/auth/login` et `/auth/callback` : 10 par minute par adresse du socket et 60 par minute au total. L'adresse ne vient jamais de `X-Forwarded-For` ; derrière le proxy, la limite par adresse devient globale.
- Adresse de retour reconstruite sur `PUBLIC_BASE_URL`, jamais sur `Host` ni `X-Forwarded-*`.
- Erreurs assainies (`login_failed`, `owner_mismatch`, `mfa_required`, `login_expired`, `reauth_failed`, `idp_unavailable`) ; aucun code, jeton, cookie ni claim dans les journaux.
- Réponses `Cache-Control: no-store`, redirections `Referrer-Policy: no-referrer`.

## Keycloak (à configurer plus tard)

- Client confidentiel « OpenID Connect », flux standard seul (pas d'implicite, pas de « direct access grants »), PKCE S256 exigé, adresse de retour exacte `https://<domaine>/auth/callback`.
- Authentification par étapes : niveau LoA 2 (second facteur) associé à la valeur `acr` `relay-mfa` (« ACR to LoA mapping »), flux de navigateur conditionnel au niveau demandé.
- Vérifier sur un vrai jeton que `acr` vaut exactement `relay-mfa` après authentification forte, puis renseigner `AUTH_MFA_ACR`. Envoyer `acr_values` ne suffit pas : Relay vérifie le claim signé.
- `AUTH_OWNER_SUB` : identifiant de l'utilisateur Keycloak (UUID), pas son nom ni son adresse.


Le runtime construit ce module uniquement si `AUTH_MODE=oidc`. En mode hébergé, la configuration complète est obligatoire avant tout accès au stockage. L’instance locale historique et la démonstration Docker locale restent explicitement sans authentification ; elles ne constituent pas un hébergement sécurisé.

L’application intègre la protection à toutes les routes de contenu, mémoire, QR, messagerie et ressources JavaScript de l’application. Seuls `/login`, ses ressources nécessaires, les points de connexion OIDC et la santé minimale sont publics. Les mutations exigent la même origine et un jeton CSRF ; les connexions de fournisseurs et retraits de comptes exigent aussi une authentification récente. Sans `auth_time` signé, une session peut lire les contenus mais n’est jamais considérée comme récemment authentifiée ; une date anormalement future est refusée.

Les aperçus ajoutent un `approvalToken` aléatoire de cinq minutes, lié à la session, au message, au contenu exact et à l’empreinte fournisseur. Il est consommé avant l’appel d’envoi, même si celui-ci échoue : revenir à l’aperçu avant une nouvelle tentative. Le changement de session ou le redémarrage invalide ces approbations. Les retours OAuth de messagerie sont aussi liés à la session ayant lancé la connexion ; leur démarrage passe par POST avec CSRF.

L’interface propose « Appareils connectés », la révocation et la déconnexion. « Confirmer mon identité » demande `prompt=login` et `max_age=0`. La déconnexion retire l’accès à Relay Desk ; elle ne déconnecte pas les messageries ni la session SSO Keycloak elle-même.

Références : [sessions OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [vérification des signatures openid-client](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md), [authentification par niveaux Keycloak](https://www.keycloak.org/docs/latest/server_admin/#_step-up-flow).


## Validation du lot 3 (19 octobre 2026)

214 tests réussis sur Mac et dans l’image Linux Node 24, sans réseau sortant dans le stage de tests. L’émetteur simulé produit de vrais jetons RS256 avec JWKS fictifs ; les tests refusent mauvaise signature, audience, émetteur, nonce, état, expiration, autre propriétaire et niveau MFA insuffisant. Ils couvrent aussi CSRF, origine, Fetch Metadata, expiration inactive/absolue, rotation, révocation, confirmation récente et invalidation par changement de configuration.

Le runtime complet a été vérifié avec deux appareils fictifs : cookies de sessions persistants après redémarrage, ancien aperçu invalidé, révocation d’un autre appareil et déconnexion. Gmail, Outlook et WhatsApp utilisent des fournisseurs simulés pour les tests de liaison de l’aperçu à la session et de double clic. Le runtime Docker protégé est testé avec des paramètres OIDC fictifs, sans réseau et sans port publié. La recette Chrome utilise uniquement une base éphémère et un émetteur signé simulé injecté par un programme de test distinct de `server.js`.

Une revue indépendante a identifié le quota de polling QR partagé avec les mutations ; il a été séparé avec un test de régression. Aucun P1/P2 restant n’a été identifié lors de la revue finale. Aucun fournisseur Keycloak réel, compte, déploiement ou transfert de données réelles n’a été effectué. La recette ne valide pas encore la configuration MFA d’un véritable serveur Keycloak : ce contrôle reste nécessaire avant un usage hébergé.
