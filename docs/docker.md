# Relay Desk en conteneur

Image Docker unique (Node 24, Debian slim) et deux fichiers Compose :

- `compose.dev.yaml` : mode local de **test**, données fictives, connecteurs et IA désactivés, accessible seulement sur `http://127.0.0.1:4311` ;
- `compose.yaml` : mode **hébergé, préparatoire et bloqué**. Le serveur refuse `RELAY_MODE=hosted` tant que l'authentification (lot 3) n'existe pas, et ce fichier ne démarre rien sans profil ni configuration explicites.

Aucun de ces fichiers ne lit le `.env` réel, ni les données ou secrets du Mac.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `Dockerfile` | Étapes `deps` (dépendances de production), `test` (suite complète) et `runtime` (image finale). Image de base épinglée par version et empreinte. |
| `.dockerignore` | Liste blanche : seuls `package*.json`, `server.js`, `src/`, `public/`, `test/` et la sonde de santé entrent dans le contexte. `.env*`, `*.key`, `*.pem`, `data/`, `backups/`, `exports/`, archives et bases SQLite sont exclus partout. |
| `deploy/healthcheck.mjs` | Sonde `GET /api/health` en local, avec le Host de `PUBLIC_BASE_URL`. |
| `deploy/test/compose.env` | Fichier d'environnement de Compose pour le test : il remplace la lecture automatique du `.env` du projet. Aucun secret. |
| `compose.dev.yaml` | Test local. Une clé de coffre aléatoire est générée dans un volume Docker dédié, jamais dans le dépôt. |
| `compose.yaml`, `deploy/Caddyfile` | Préparation de l'hébergement : application sans port publié, Caddy seul sur 80 et 443. Ne pas démarrer. |

## Commandes

Tests dans l'image (données fictives, aucun réseau sortant pendant les tests) :

```sh
docker build --target test -t relay-desk:test .
```

Mode local de test :

```sh
docker compose --env-file deploy/test/compose.env -f compose.dev.yaml up --build
# http://127.0.0.1:4311
docker compose --env-file deploy/test/compose.env -f compose.dev.yaml down      # arrêt, données de test conservées
docker compose --env-file deploy/test/compose.env -f compose.dev.yaml down -v   # arrêt et effacement des données et de la clé de test
```

`--env-file deploy/test/compose.env` est obligatoire : sans lui, Compose lirait le `.env` du projet pour l'interpolation. Le service `relay` ne reçoit de toute façon aucune variable de l'hôte : sa configuration est écrite en clair dans `compose.dev.yaml`.

Derrière un proxy TLS d'entreprise, l'autorité du proxy peut être fournie au seul `npm ci`, sans entrer dans l'image :

```sh
docker build --secret id=build_ca,src=/chemin/vers/ca.pem --target test .
```

## Propriétés de sécurité

| Propriété | Mise en œuvre | Vérifié |
| --- | --- | --- |
| Utilisateur non-root | `USER node` (uid 1000) ; code et dépendances appartiennent à root | `id`, écriture dans `/app` refusée |
| Système de fichiers en lecture seule | `read_only: true`, seul `/data` (volume) est inscriptible, `/tmp` en tmpfs `noexec,nosuid,nodev` | écriture dans `/app` et `/etc` refusée |
| Aucune capacité Linux | `cap_drop: ALL`, `no-new-privileges` | `CapEff: 0` |
| Aucun secret dans l'image | Liste blanche, `COPY` explicites, pas d'`ENV` secret, pas de `.env` | recherche de `.env*`, `*.key`, `*.db` dans l'image : rien |
| Contexte de construction propre | Faux `.env`, `data/relay.db`, `*.key`, `*.zip`, `*.sqlite` placés dans le dépôt puis construits : absents du contexte | test manuel |
| Port local seulement | `127.0.0.1:4311:4310` | port lié à la boucle locale |
| Clé du coffre séparée des données | Volume de secrets monté en lecture seule (`/run/relay-secrets`), fichier `0400` propriété de l'uid 1000 | permissions vérifiées |
| Arrêt propre | `init: true` (tini relaie SIGTERM), `stop_grace_period: 30s` | arrêt en moins d'une seconde, code 0 |
| Une seule instance | `container_name` fixe : Compose refuse une seconde copie. Le verrou d'écrivain unique sur `/data` (lot 1) complète cette protection. | |
| Hébergé bloqué | Profil `hosted`, variables obligatoires sans valeur par défaut, refus applicatif de `RELAY_MODE=hosted` | `up` sans profil : aucun service ; sans variables : arrêt de Compose |

## Hébergement (préparation seulement)

Sur la VM, plus tard et sur autorisation :

- secrets dans `RELAY_SECRETS_DIR` (hors dépôt, hors volume de données), un fichier par valeur : `relay_secret_key` (32 octets en base64 ou 64 caractères hexadécimaux), `mistral_api_key`, `google_client_id`, `google_client_secret`, `microsoft_client_id` ;
- hors Swarm, Compose monte ces fichiers avec leurs droits d'origine : propriétaire uid 1000, mode `0400` ;
- variables : `RELAY_IMAGE_TAG`, `PUBLIC_BASE_URL` (https), `RELAY_DOMAIN`, `ACME_EMAIL`, `RELAY_SECRETS_DIR` ;
- Caddy obtient le certificat, ajoute HSTS et quelques en-têtes, sans journal d'accès (les retours OAuth portent `code` et `state`). Son cœur ne fournit pas de limite de débit : elle relève de l'application (lot 3) ou d'un module choisi explicitement.

## Contrat attendu du runtime (lot 1)

Ces fichiers supposent que le runtime :

1. lit `RELAY_SECRET_KEY_FILE` en retirant le saut de ligne final, et ne génère **jamais** de clé dans `/data` en mode hébergé ;
2. dérive les hôtes autorisés de `PUBLIC_BASE_URL` (ici `127.0.0.1:4311` et `localhost:4311`). La sonde envoie ce Host, le même que le navigateur ;
3. répond `200` sur `GET /api/health`, sans authentification ni donnée, en local comme en hébergé ;
4. n'écrit que dans `DATA_DIR` (base, WAL, verrou) et `/tmp` ;
5. termine proprement sur SIGTERM, sans `logout()` WhatsApp ;
6. en hébergé, considère la requête comme HTTPS d'après `PUBLIC_BASE_URL`, sans faire confiance à un `X-Forwarded-*` venant d'ailleurs que du proxy.

Avant l'intégration du lot 1, le serveur actuel ignore `RELAY_SECRET_KEY_FILE` (il crée `/data/secret.key`), n'a pas de `/api/health` et n'autorise que le port 4310 : le conteneur démarre, mais la sonde reste « unhealthy » et le navigateur reçoit 403 sur le port 4311.
