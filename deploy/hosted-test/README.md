# Identité de TEST de Relay Desk (Keycloak 26.8.1 + PostgreSQL 17)

**Test uniquement.** Keycloak partage ici la VM de Relay Desk. C'est une dérogation au guide de production, qui place Keycloak hors de la VM : elle est acceptable pour des identités et des données de test neuves, **pas** pour des données réelles. Les identités, les mots de passe, l'OTP et les secrets sont tous générés neufs ; aucun identifiant réel n'est utilisé.

## Contrat des fichiers

`IDENTITY_SECRETS_DIR` (p. ex. `/etc/relay-desk-test/identity`, root 0700) contient des fichiers neufs, un par valeur, en mode 0400 :

| Fichier | Propriétaire | Contenu |
| --- | --- | --- |
| `postgres_password` | uid 70 (postgres Alpine) | Mot de passe de la base, p. ex. `openssl rand -base64 32` |
| `keycloak_db_password` | uid 1000 (keycloak) | **Même valeur** que `postgres_password` |
| `kc_bootstrap_admin_user` | uid 1000 | Nom de l'administrateur temporaire, p. ex. `bootstrap-admin` |
| `kc_bootstrap_admin_password` | uid 1000 | Mot de passe neuf de cet administrateur |

Les deux copies du mot de passe de base existent parce qu'un secret Compose hors Swarm garde le propriétaire et le mode du fichier hôte : chaque conteneur ne lit que sa propre copie.

Variables (`identity.env.example`, sans secret) :

| Variable | Valeur |
| --- | --- |
| `IDENTITY_DOMAIN` | Domaine d'identité, p. ex. `auth.relay.noegim.com` |
| `IDENTITY_TRUSTED_PROXIES` | Sous-réseau fixe du réseau `backend` (Caddy), seul autorisé à fournir `X-Forwarded-*` |
| `IDENTITY_SECRETS_DIR` | Répertoire ci-dessus |

## Services

`identity.compose.yaml` se combine avec la compose de Relay dans le même projet : service `keycloak`, réseau partagé `backend`.

| Service | Rôle et isolement |
| --- | --- |
| `keycloak-db` | Image `postgres:17.11-alpine3.24` épinglée par empreinte, uid 70, lecture seule, réseau interne `identity-db`, 512 Mio |
| `keycloak` | Image officielle 26.8.1 épinglée, optimisée (`keycloak.Dockerfile` : `kc.sh build` pour PostgreSQL et la santé), démarrée avec `start --optimized` (jamais `start-dev`), uid 1000, lecture seule, 1,5 Gio |

Le service `keycloak` :

- utilise un nom d'hôte strict (`https://IDENTITY_DOMAIN`), avec les en-têtes `xforwarded` acceptés seulement du sous-réseau de Caddy ;
- publie l'administration sur `127.0.0.1:18080` uniquement ;
- ne publie pas le port de gestion 9000 (santé), interrogé par le healthcheck interne.

Avant de construire, l'empreinte sur quay.io peut être comparée : `docker buildx imagetools inspect quay.io/keycloak/keycloak:26.8.1`. L'empreinte épinglée a été relevée sur l'index Docker Hub de l'organisation `keycloak`.

**Exposition publique** (`identity.caddy`, à importer dans le Caddy) :

- seuls `/realms/relay-test/*` (hors `/realms/relay-test/account*`) et `/resources/*` sont servis ;
- tout le reste répond 404 : `/admin`, realm `master`, console de compte, santé, métriques.

L'exclusion de la console de compte est dans le matcher. Un `respond @account 404` séparé ne suffit pas : `handle` passe avant `respond`, et la console restait alors accessible (200), comme la recette l'a montré.

## Commandes

```sh
docker compose --env-file /etc/relay-desk-test/identity.env -f <relay.compose.yaml> -f deploy/hosted-test/identity.compose.yaml build keycloak
docker compose --env-file /etc/relay-desk-test/identity.env -f <relay.compose.yaml> -f deploy/hosted-test/identity.compose.yaml up -d keycloak-db keycloak

# Sur la VM (boucle locale) : realm, flux MFA, client et propriétaire fictif. Secrets écrits en 0400 dans --out (absent ou vide).
node deploy/hosted-test/configure-keycloak.mjs \
  --admin-url http://127.0.0.1:18080 \
  --admin-user-file /etc/relay-desk-test/identity/kc_bootstrap_admin_user \
  --admin-password-file /etc/relay-desk-test/identity/kc_bootstrap_admin_password \
  --public-url https://relay.noegim.com \
  --issuer-base https://auth.relay.noegim.com \
  --out /etc/relay-desk-test/identity-out
```

`configure-keycloak.mjs` lit les fichiers d'administration, qui doivent donc être lisibles par l'utilisateur qui lance la commande (root). Options : `--realm relay-test`, `--client-id relay-desk`, `--owner owner-test`, `--acr relay-mfa`, `--ssl-required all`. `--recreate` supprime et recrée le realm de test, avec de nouveaux secrets.

**Sorties** (0400, répertoire 0700) :

- `relay/auth_client_id` et `relay/auth_client_secret` : à copier dans les secrets de Relay, en uid 1000, mode 0400 ;
- `relay/auth.env` : `AUTH_ISSUER`, `AUTH_OWNER_SUB`, `AUTH_MFA_ACR` ;
- `owner/username`, `owner/password`, `owner/otp-secret` et `owner/otpauth-uri` (pour une application TOTP).

Rien de secret n'est affiché.

**Preuve MFA réelle**, sans afficher de jeton ni de secret :

```sh
node deploy/hosted-test/prove-mfa.mjs \
  --issuer https://auth.relay.noegim.com/realms/relay-test \
  --redirect-uri https://relay.noegim.com/auth/callback \
  --out /etc/relay-desk-test/identity-out \
  [--relay-url https://relay.noegim.com]
```

**Contrôles de la preuve** :

- mot de passe seul, sans code délivré ;
- OTP réel (TOTP), échange du code avec PKCE ;
- id_token RS256 vérifié sur le JWKS (iss, aud, nonce, exp), `acr=relay-mfa` et `sub` du propriétaire ;
- session SSO réutilisée (mêmes cookies Keycloak), avec puis sans `acr_values` : le mot de passe est sauté mais un nouvel OTP est exigé, aucun code n'est délivré directement (le cookie ne couvre jamais le niveau 2, âge maximal 0) ;
- refus : OTP sans `acr_values` (minimum du client), grant direct, retour non déclaré, requête sans PKCE, flux implicite ;
- avec `--relay-url`, démarrage paginé sans profil imposé, première page bornée à 50 et refus d’un profil explicite inconnu ;
- avec `--relay-url`, bout en bout : `/auth/login` de Relay, Keycloak, `/auth/callback` (jeton vérifié par Relay), puis `/api/state` à 200 avec la session et 401 sans.

La preuve attend une fenêtre TOTP neuve (jusqu'à 30 s), car un code ne sert qu'une fois.

## Configuration Keycloak appliquée

**Realm `relay-test`** :

- inscription, réinitialisation du mot de passe, « se souvenir de moi » et connexion par adresse désactivés ;
- protection contre la force brute (5 échecs) ;
- mot de passe de 14 caractères au moins ;
- OTP TOTP SHA-1 à 6 chiffres, 30 s, code non réutilisable ;
- `sslRequired=all`.

**Flux navigateur `relay browser loa`** :

- Cookie, ou formulaires ;
- niveau 1 : mot de passe ;
- niveau 2 : OTP, avec âge maximal 0 (OTP à chaque authentification de niveau 2).

La correspondance de realm `acr.loa.map` vaut `{"relay-mfa": 2}`. Le claim `acr` provient du mappeur standard du scope `acr`, jamais d'une valeur fixe.

**Client `relay-desk`** :

- confidentiel, secret neuf, code d'autorisation seulement, PKCE S256 exigé ;
- retour exact `https://relay.noegim.com/auth/callback`, aucune origine web ;
- aucun grant direct, implicite, compte de service, device ni CIBA ;
- `minimum.acr.value` et `default.acr.values` valent `relay-mfa`, donc l'OTP est exigé même si le client ne demande rien.

**Propriétaire fictif `owner-test`** : mot de passe et OTP neufs, importés par `partialImport`, sans action requise.

## Recette locale réalisée (19 octobre 2026)

**Montage** : distribution officielle Keycloak 26.8.1 (SHA-1 publié vérifié) en `start --optimized`, avec les mêmes options de production. Seule différence : une base `dev-file` locale à la place de PostgreSQL. Devant Keycloak, Caddy 2.10.2 en HTTPS local avec `identity.caddy`. Relay Desk tourne en mode hébergé local, avec les fichiers produits.

**Résultats** :

- `configure-keycloak.mjs` réussi ;
- `prove-mfa.mjs --relay-url` : 26 contrôles sur 26 ;
- 25 sondes d'encodage de chemins vers `/admin`, `master` et `account` (`%252e`, `..;`, `%3b`, `%2f`, `%5c`, casse, `//`, `./`) : toutes en 404 ou 400, sans contenu.

**Non vérifié lors de cette recette locale Claude** : PostgreSQL et la compose réelle (Docker indisponible dans cet environnement), le DNS, les certificats publics et la VM. La recette OVH et les certificats publics ont ensuite été vérifiés séparément : voir [OPERATIONS.md](OPERATIONS.md). Le déploiement utilise le Caddyfile complet de cet overlay ; `identity.caddy` reste un extrait de référence.

## Limites avant toute donnée réelle

- **Emplacement** : déplacer Keycloak hors de la VM de Relay Desk, ou décider explicitement de le garder sur la même machine.
- **Sauvegarde** : prévoir la sauvegarde et la restauration de sa base, la récupération du compte propriétaire (moyens de secours MFA) et un administrateur permanent nominatif, puis supprimer l'administrateur temporaire.
- **Authentification forte** : WebAuthn ou un OTP détenu par le seul propriétaire.
- **Propriétaire réel** : remplacer le propriétaire fictif et tous les secrets de test.

Aucun de ces points n'est validé.
