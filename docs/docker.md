# Relay Desk en conteneur

Image Docker unique (Node 24, Debian slim) et deux fichiers Compose :

- `compose.dev.yaml` : mode local de **test**, données fictives, connecteurs et IA désactivés, accessible seulement sur `http://127.0.0.1:4311` ;
- `compose.yaml` : mode **hébergé, préparatoire**. Le proxy attend une application saine. Le serveur exige une configuration OIDC complète pour le propriétaire, et ce fichier ne démarre rien sans profil ni configuration explicites.

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
| Arrêt propre | `init: true` (tini relaie SIGTERM), `stop_grace_period: 45s` | arrêt en moins d'une seconde, code 0 |
| Une seule instance | `container_name` fixe : Compose refuse une seconde copie. Le verrou d'écrivain unique sur `/data` (lot 1) complète cette protection. | |
| Hébergé protégé | Profil `hosted`, configuration OIDC obligatoire, proxy après santé applicative | Sans configuration OIDC : démarrage refusé ; API privées sans session |

## Hébergement (préparation seulement)

Sur la VM, plus tard et sur autorisation :

- secrets dans `RELAY_SECRETS_DIR` (hors dépôt, hors volume de données), un fichier par valeur : `relay_secret_key` (32 octets en base64 ou 64 caractères hexadécimaux), `mistral_api_key`, `google_client_id`, `google_client_secret`, `microsoft_client_id` ;
- hors Swarm, Compose monte ces fichiers avec leurs droits d'origine : propriétaire uid 1000, mode `0400` ;
- variables : `RELAY_IMAGE_TAG`, `PUBLIC_BASE_URL` (https), `RELAY_DOMAIN`, `ACME_EMAIL`, `RELAY_SECRETS_DIR`, `AUTH_ISSUER`, `AUTH_OWNER_SUB`, `AUTH_MFA_ACR` ; secrets OIDC `auth_client_id` et `auth_client_secret` séparés ;
- Caddy obtient le certificat, ajoute HSTS et quelques en-têtes, sans journal d'accès (les retours OAuth portent `code` et `state`). Son cœur ne fournit pas de limite de débit : elle relève de l'application (lot 3) ou d'un module choisi explicitement.

## Contrat du runtime intégré (lots 1 et 2)

Le runtime :

1. lit les secrets `*_FILE` en retirant les espaces et sauts de ligne de bord, refuse une valeur directe et un fichier simultanés, ainsi que les fichiers absents ou vides ; le mode local de test utilise uniquement la clé du volume dédié et ne crée pas `/data/secret.key` ;
2. dérive les URL de retour OAuth et l'hôte public autorisé de `PUBLIC_BASE_URL`. Ici, le navigateur et la sonde utilisent `127.0.0.1:4311` ; les alias locaux du port public (dont `localhost:4311`) et du port interne 4310 restent également autorisés ;
3. répond `200` avec seulement `{ "ok": true }` sur `GET /api/health` lorsque le runtime local fonctionne ;
4. conserve la base, son WAL et une base SQLite distincte pour le verrou de processus dans `DATA_DIR`. Le verrou reste détenu pendant toute la vie du runtime et le noyau le libère après un crash ;
5. ferme l'entrée HTTP sur SIGTERM, attend les traitements HTTP et les tâches des connecteurs, puis ferme le stockage et libère le verrou, sans déconnecter l'appareil WhatsApp. Si le délai d'arrêt est dépassé, la commande termine en erreur sans relancer automatiquement un envoi ;
6. refuse le mode hébergé sans configuration OIDC complète ; en mode hébergé configuré, protège tous les contenus par une session propriétaire. Les ressources de connexion et la santé minimale seules restent publiques.

Le mode local de test désactive la construction des connecteurs et laisse Mistral non configuré. Les accès réels aux fournisseurs et le déploiement hébergé restent hors de cette recette.


## Recette reproductible sur données fictives

```sh
npm run test:docker
```

Cette commande construit le stage de tests sans réseau sortant, construit l’image finale puis exécute `scripts/check-docker.mjs`. La recette utilise des noms de volumes et conteneurs aléatoires, une clé de test aléatoire et `--network none`, sans port publié. Elle ne charge aucun `.env` et nettoie uniquement ses propres conteneurs et volumes en fin de test.

Elle vérifie les droits non-root, la lecture seule, l’absence de capacités, la clé externe non modifiable, les connecteurs/IA désactivés, le refus d’une seconde instance sur le même stockage, l’arrêt SIGTERM avec code 0, la reprise après SIGKILL, puis la persistance et la restauration d’un brouillon, d’une identité de mémoire et de jetons OAuth et identifiants WhatsApp entièrement fictifs. La copie de restauration se fait à froid, après arrêt et checkpoint SQLite ; les connecteurs restent désactivés pendant toute la recette.

Validation initiale des lots 1 et 2 du 19 octobre 2026 : **191 tests réussis sur Mac et dans le stage Linux Node 24**, puis recette Docker réussie. Un audit du contexte de construction (97 fichiers autorisés) a aussi confirmé l’exclusion de faux fichiers `.env`, clés, archives, bases, sauvegardes et exports placés sous un répertoire source de test. Le contexte réel n’inclut que les sources et ressources autorisées.

La conservation d’identifiants WhatsApp est vérifiée avec de fausses valeurs chiffrées et de faux sockets. Aucune session WhatsApp réelle n’a été reprise dans Docker. Le lot 3 ajoute l’accès propriétaire via OIDC (voir `docs/auth.md`). La configuration Keycloak réelle, les lots 4 à 7, le déploiement et la migration restent à réaliser.


## Configuration locale

| Variable | Comportement |
| --- | --- |
| `RELAY_MODE` | `local` par défaut ; `hosted` exige une configuration OIDC complète et une origine HTTPS. |
| `HOST`, `PORT` | `127.0.0.1:4310` par défaut ; dans Docker, `0.0.0.0:4310` derrière le port publié localement. |
| `PUBLIC_BASE_URL` | Origine explicite sans chemin ; locale en mode local. Fixe les retours OAuth et les hôtes autorisés, indépendamment des en-têtes transmis. |
| `DATA_DIR` | Répertoire de stockage, `data/` par défaut, `/data` dans Docker. Un seul runtime, disque local uniquement. |
| `RELAY_SECRET_KEY_FILE` | Clé de 32 octets encodée en base64 canonique ou en 64 caractères hexadécimaux. La clé existante est obligatoire si une base existe ; clé incorrecte refusée avant migration. |
| `RELAY_CONNECTORS_ENABLED`, `RELAY_AI_ENABLED` | `true` en local historique ; `false` pour tous les tests Docker. |
| `DEMO_DATA` | Données fictives si `1` sur une base vide ; aucun ajout de démonstration à une base existante. |
| `SHUTDOWN_TIMEOUT_MS` | 30 000 par défaut ; délai Docker 45 s pour laisser l’arrêt applicatif terminer ou signaler une issue incertaine. |

Les secrets pris en charge sous forme directe ou `*_FILE` sont `RELAY_SECRET_KEY`, `MISTRAL_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et `MICROSOFT_CLIENT_ID`. Ne pas fournir les deux formes simultanément. Les commandes Docker n’utilisent pas `npm start` et ne chargent jamais le `.env` local. Le démarrage local historique reste disponible avec `npm start`.


## Accès propriétaire (lot 3)

Le Compose hébergé n’accepte pas `AUTH_MODE=disabled`. Il exige un émetteur Keycloak HTTPS précis, un client OIDC et le sujet stable du propriétaire (`AUTH_OWNER_SUB`), ainsi qu’un niveau `AUTH_MFA_ACR` explicitement configuré pour représenter l’authentification MFA dans Keycloak. L’adresse email ne sert pas de preuve d’identité. Les valeurs réelles de ces paramètres et le client Keycloak n’ont pas été créés pendant ce développement.

Le Compose local de démonstration garde volontairement `AUTH_MODE=disabled` et uniquement des données fictives sur un port loopback. Pour tester la protection, `npm run test:docker` lance aussi un runtime hébergé configuré avec un émetteur fictif, sans réseau et sans port publié : les API, messages et QR sont inaccessibles sans session. Les parcours de connexion et de révocation complets sont testés avec un émetteur OIDC simulé, des jetons signés et de faux appareils. Aucun mode de connexion de test n’existe dans le serveur de production.


Validation après lot 3 : **214 tests réussis sur Mac et Linux**, puis recette `npm run test:docker` réussie, y compris le refus d’un hébergement sans OIDC et le refus d’accès aux API/QR/contenus sans session dans un runtime protégé isolé. La configuration du Compose hébergé a été analysée avec des valeurs fictives uniquement ; le proxy n’a pas été démarré.
