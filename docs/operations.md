# Exploitation hébergée de Relay Desk (lot 6)

Guide de **préparation**. Il décrit l'installation visée, ses contrôles et ses procédures. Rien n'a été déployé : aucune VM, aucun DNS, aucun certificat, aucun Keycloak ni aucun transfert de données réelles. La configuration a uniquement été vérifiée sur des valeurs fictives, sans démarrer de service (voir « Ce qui est validé »).

Le présent document couvre l'hébergement, l'entrée HTTPS, les secrets, le préflight, les sauvegardes planifiées, les mises à jour et le retour arrière. L'outil de sauvegarde et de restauration (`scripts/backup.mjs`) et les contrôles de santé (`/api/ready`, `/api/ops/health`) sont réalisés à part ; ce guide les appelle selon leur contrat.

## Décisions à confirmer avant le déploiement

| Sujet | Proposition | À confirmer |
| --- | --- | --- |
| Prestataire et région | VM Linux persistante dans l'UE, disque SSD local (pas de stockage réseau partagé pour SQLite) | Prestataire, région, budget |
| Dimensionnement | Point de départ indicatif : 2 vCPU, 4 Go de RAM, 40 à 80 Go de disque ; à ajuster après mesure d'un import historique WhatsApp | Mesure de l'import sur données réelles (lot 7) |
| Système | Debian stable ou Ubuntu LTS, mises à jour de sécurité automatiques, Docker Engine et le plugin Compose des dépôts Docker | Distribution |
| Domaine | Sous-domaine dédié (p. ex. `relay.<domaine>`), enregistrements A/AAAA vers la VM, CAA limité à Let's Encrypt | Nom exact, gestionnaire DNS |
| Accès d'administration | SSH par clé uniquement, limité à l'adresse de l'administrateur au pare-feu du prestataire, ou derrière un VPN (WireGuard/Tailscale) sans SSH public | Méthode et adresses autorisées |
| Keycloak | Hors de cette VM : instance gérée ou VM distincte. Console d'administration non exposée publiquement | Hébergement, realm, compte du propriétaire |
| Stockage des sauvegardes | Stockage objet chez un autre prestataire ou dans une autre région, avec versions et rétention ; écriture seule depuis la VM si possible | Prestataire, rétention |
| Supervision | Sonde externe HTTPS sur `/api/health`, alertes disque, certificat et âge de la dernière sauvegarde | Outil et destinataire des alertes |

## Organisation sur la VM

```text
/opt/relay-desk/                     dépôt à un commit précis (root, lecture seule pour les autres)
/etc/relay-desk/hosted.env           variables non secrètes (root, 0600)
/etc/relay-desk/secrets/             secrets de l'application (root, 0700) ; fichiers uid 1000, 0400
/etc/relay-desk/backup/backup.key    clé de sauvegarde (uid 1000, 0400 ; répertoire root 0700), service « backup » seulement
/srv/relay-desk/data/<génération>/   données SQLite (uid 1000, 0700) ; une génération par restauration
/srv/relay-desk/backups/             sauvegardes (uid 1000, 0700) : archives/ (chiffrées) et status/ seulement
/etc/relay-desk/offsite.env          transport hors VM, quand il sera choisi (root, 0600) ; absent aujourd'hui
```

- `compose.yaml` monte `RELAY_DATA_DIR` en *bind* avec `create_host_path: false` : un répertoire absent ou mal orthographié fait échouer le démarrage. Il ne crée jamais en silence une instance vide.
- Le répertoire de données ne contient jamais la clé du coffre ; le préflight le refuse.
- `relay` ne monte que `backups/status` en lecture seule (âge de la dernière sauvegarde) : ni les archives ni la clé de sauvegarde. Le service `backup` (profil `backup`, sans réseau) est le seul à recevoir la clé de sauvegarde ; il reçoit aussi la clé du coffre, qui n'est pas écrite dans les archives.
- `hosted.env` ne contient aucun secret (le préflight le vérifie). Chaque commande Compose passe `--env-file /etc/relay-desk/hosted.env` : le `.env` du dépôt n'est jamais lu.
- Modèles : `deploy/hosted.env.example`, liste des secrets ci-dessous, `deploy/systemd/` (sauvegarde planifiée et copie hors VM).

## Séparation de l'administration et de l'application

| Flux | Autorisé | Mise en œuvre |
| --- | --- | --- |
| Internet → 80, 443 (TCP) et 443 (UDP) | Oui | Seul le conteneur Caddy publie des ports. Le port 80 sert aux défis ACME et à la redirection HTTPS. |
| Internet → application (4310) | Non | `expose` seulement, réseau Docker interne au projet, aucun port publié. |
| Internet → SSH | Non, sauf adresse d'administration ou VPN | Pare-feu **du prestataire** (Docker contourne les règles UFW/iptables locales pour les ports publiés). |
| Administration Caddy | Non | `admin off`. |
| Console Keycloak | Non publique | Restreinte au réseau d'administration de l'hébergement Keycloak. |

Comptes :

- **Administrateur** : compte nominatif avec `sudo`, clé SSH, sans mot de passe SSH. `PermitRootLogin no` et `PasswordAuthentication no`. Le groupe `docker` équivaut à root : il est réservé à ce compte.
- **Application** : uid 1000 dans le conteneur (non-root, sans capacité, système de fichiers en lecture seule). Aucun compte hôte interactif n'est nécessaire pour cet uid ; seuls les fichiers de données et de secrets lui appartiennent.
- L'identité du propriétaire de Relay Desk (Keycloak + MFA) est distincte de l'accès SSH : un accès à l'application ne donne aucun accès au serveur, et inversement.

## Entrée HTTPS (Caddy)

`deploy/Caddyfile` sert uniquement `RELAY_DOMAIN`. Il obtient et renouvelle le certificat automatiquement et ajoute HSTS, `nosniff`, `Referrer-Policy` et `Permissions-Policy`. La CSP reste fixée par l'application.

**Journaux** : les retours OAuth portent `code` et `state` dans l'URI. Le site n'a donc pas de journal d'accès. Cela ne suffit pas : par défaut, les erreurs du proxy inverse (amont indisponible, 502) journalisent aussi l'objet `request`, avec son URI en clair. Caddy ne masque que les cookies et `Authorization`. Le journal par défaut applique donc un filtre qui supprime `request`, `uri`, `headers` et `resp_headers`. Le message d'erreur, le statut, la durée et l'identifiant d'erreur restent visibles.

Vérification reproductible avec le binaire officiel : `node deploy/caddy-logs-check.mjs /chemin/vers/caddy`. Le contrôle lance Caddy en HTTP sur 127.0.0.1 seulement, sans ACME, avec un amont fermé et de faux `code`, `state`, cookie et jeton. Il exige l'erreur 502 journalisée et l'absence de ces valeurs. Sans le filtre, le même essai montre l'URI complète dans le journal d'erreurs.

- **Première mise en route** : `ACME_CA` vise l'autorité de test de Let's Encrypt pour vérifier DNS et ports sans consommer les quotas. Il faut ensuite la retirer : la production est la valeur par défaut. Les certificats de test ne sont pas reconnus par les navigateurs.
- **CAA** : `0 issue "letsencrypt.org"` sur le domaine.
- **HSTS** : un an avec `includeSubDomains`, sans `preload`. Le sous-domaine retenu doit rester servi en HTTPS.
- **Limite de débit** : elle est appliquée par l'application ; le cœur de Caddy n'en fournit pas.
- **Image Caddy** : `caddy:2.10.2-alpine`. Il faut épingler son empreinte (`@sha256:…`) au moment du déploiement.

## Secrets

Un fichier par valeur dans `RELAY_SECRETS_DIR`, propriétaire uid 1000, mode `0400`, sans valeur de modèle :

| Fichier | Contenu |
| --- | --- |
| `relay_secret_key` | Clé du coffre : 32 octets en base64 (`openssl rand -base64 32`). **Ne jamais la changer** sur une base existante : les jetons chiffrés deviendraient illisibles. |
| `auth_client_id`, `auth_client_secret` | Client OIDC confidentiel Keycloak de Relay Desk. |
| `google_web_client_id`, `google_web_client_secret` | Client Google « Application Web » (pas le client bureau du Mac). |
| `microsoft_web_client_id`, `microsoft_web_client_secret` | Application Entra, plateforme Web, avec un secret client daté (prévoir son renouvellement). |
| `mistral_api_key` | Clé Mistral. |

Le Compose référence ces huit fichiers : tous doivent exister et être renseignés.

Création, en root, sans laisser la valeur dans l'historique du shell :

```sh
install -d -o root -g root -m 0700 /etc/relay-desk/secrets
umask 077
openssl rand -base64 32 > /etc/relay-desk/secrets/relay_secret_key
# Autres fichiers : coller la valeur dans un éditeur, jamais via « echo valeur > fichier » dans l'historique.
chown 1000:1000 /etc/relay-desk/secrets/*
chmod 0400 /etc/relay-desk/secrets/*
```

Clé de sauvegarde : `openssl rand -base64 32 > /etc/relay-desk/backup/backup.key` dans un répertoire root `0700`, puis `chown 1000:1000` et `chmod 0400` sur le fichier. Elle n'est jamais dans `secrets/`, dans les données ni dans `backups/` (copié hors VM) ; le préflight le vérifie et refuse une clé identique à celle du coffre.

Copies hors VM : la clé du coffre et la clé de sauvegarde sont conservées séparément dans le gestionnaire de mots de passe du propriétaire, avec une copie hors ligne. Sans la clé de sauvegarde, une sauvegarde est inutilisable ; sans la clé du coffre, les jetons restaurés ne se déchiffrent plus et les comptes doivent être reconnectés.

## Préflight (sans déploiement)

`deploy/preflight.mjs` contrôle la configuration côté hôte, hors ligne et sans rien démarrer :

```sh
cd /opt/relay-desk
node deploy/preflight.mjs --env-file /etc/relay-desk/hosted.env --compose
```

Il refuse (code de sortie 1) :

- un secret écrit dans le fichier d'environnement, une valeur `A_RENSEIGNER`, une variable obligatoire absente ou définie deux fois ;
- un fichier d'environnement lisible par d'autres ou situé dans le dépôt ;
- un domaine réservé aux tests, une adresse IP, ou une `PUBLIC_BASE_URL` différente de `https://RELAY_DOMAIN` ;
- une étiquette d'image mobile (`latest`) ;
- un émetteur Keycloak servi par le domaine de Relay Desk ;
- des répertoires de secrets ou de données absents, dans le dépôt, imbriqués ou trop ouverts ;
- des données qui n'appartiennent pas à l'uid 1000, ou qui contiennent `secret.key` ;
- un secret absent, vide, lien symbolique, au mauvais propriétaire ou au mode différent de `0400` ;
- une clé du coffre mal formée ;
- un répertoire de sauvegardes sans `archives/` ou `status/`, ou qui n'appartient pas à l'uid 1000 ;
- une clé de sauvegarde placée avec les secrets de l'application, dans les données, dans les sauvegardes ou dans le dépôt, au mauvais propriétaire ou mode, ou identique à la clé du coffre.

Il exécute ensuite **la validation du runtime** (`src/runtime/config.js`) avec l'environnement exact que Compose fournirait, puis, avec `--compose`, `docker compose config`. Ce dernier ne lance que le client et ne crée aucun conteneur. Il signale aussi une étiquette différente du commit présent et un dépôt modifié. Aucune valeur secrète n'est affichée.

Il ne vérifie **pas** le DNS, l'ouverture des ports, l'émission d'un certificat, la découverte Keycloak ni les clients Google/Entra : ces points relèvent de la recette sur l'hébergement réel.

Répétition sur valeurs fictives (aucun vrai domaine accepté avec `--fictif`) :

```sh
node deploy/fictif/make-hosting.mjs /tmp/relay-fictif
node deploy/preflight.mjs --env-file /tmp/relay-fictif/hosted.env --fictif --uid "$(id -u)" --compose
```

Le préflight de déploiement est distinct des contrôles du runtime : `GET /api/ready` (public, minimal, 200/503 selon le processus et la base) et `GET /api/ops/health` (protégé : processus, base, disque, âge de la sauvegarde locale, compteurs des connecteurs).

## Première mise en route (instance vide, plus tard)

Après autorisation seulement, avec une base vide et sans données réelles :

1. VM, pare-feu du prestataire, comptes et Docker installés. Le DNS pointe vers la VM et l'enregistrement CAA est posé.
2. Dépôt cloné à un commit validé dans `/opt/relay-desk`, puis `RELAY_IMAGE_TAG` réglé sur ce commit.
3. Répertoires, secrets et `hosted.env` créés, puis répertoire de données de première génération et répertoire des sauvegardes :

   ```sh
   install -d -o 1000 -g 1000 -m 0700 /srv/relay-desk/data/AAAAMMJJ-1
   install -d -o 1000 -g 1000 -m 0700 /srv/relay-desk/backups /srv/relay-desk/backups/archives /srv/relay-desk/backups/status
   ```
4. Préflight sans erreur.
5. Construction de l'image : `docker compose --env-file /etc/relay-desk/hosted.env --profile hosted build relay`. Le stage `test` peut être construit avant (`docker build --target test .`).
6. Démarrage : `docker compose --env-file /etc/relay-desk/hosted.env --profile hosted up -d`. Caddy attend que l'application soit saine.
7. Vérifications :
   - certificat de test émis, puis bascule en production ;
   - `/api/health` et `/api/ready` répondent sans détail ;
   - API, QR et contenus sont refusés sans session ;
   - la connexion Keycloak avec MFA aboutit, alors qu'une autre identité ou un niveau `acr` insuffisant est refusé ;
   - les appareils sont révocables.

Les connexions Gmail, Outlook et WhatsApp viennent ensuite, au lot 4 réel puis au lot 7.

## Keycloak : à configurer plus tard

Rien n'est créé à ce stade. Liste à suivre lors de la configuration réelle (voir aussi `docs/auth.md`) :

- **Realm** dédié : inscription désactivée, détection de force brute active, politique de mot de passe forte.
- **MFA** obligatoire pour le propriétaire (WebAuthn ou OTP), associée à un niveau LoA : la valeur `acr` `relay-mfa` correspond au niveau 2 (« ACR to LoA mapping »), avec un flux navigateur conditionné à ce niveau.
- **Client** `relay-desk` :
  - confidentiel, avec le flux « standard » (code d'autorisation) seulement et PKCE S256 exigé ;
  - flux implicite, *direct access grants* et comptes de service désactivés ;
  - URI de retour exacte `https://<domaine>/auth/callback` ;
  - Web origins limitée au domaine.
- **Propriétaire** : `AUTH_OWNER_SUB` vaut l'identifiant (UUID) de son utilisateur Keycloak, pas son nom ni son adresse.
- **Vérification** sur un vrai jeton : `acr` doit valoir exactement `AUTH_MFA_ACR` après authentification forte. Envoyer `acr_values` ne suffit pas : Relay Desk vérifie le claim signé.
- **Administration** : comptes d'administration Keycloak distincts du compte propriétaire, console non publique.

Changer l'émetteur, le client, le propriétaire ou `acr` invalide toutes les sessions Relay Desk au redémarrage.

La sauvegarde et la reprise de Keycloak lui-même ne sont **pas** couvertes par ce guide ni validées. Elles dépendront de l'hébergement Keycloak choisi : sauvegarde du realm, moyens de secours MFA du propriétaire, accès administrateur de secours. Sans Keycloak, Relay Desk reste inaccessible même si ses données sont intactes.

**Clients de messagerie, plus tard** :

- Google : URI de retour `https://<domaine>/oauth/google/callback`.
- Entra : URI de retour `https://<domaine>/oauth/microsoft/callback`.

Le statut de publication Google et les portées restreintes sont à vérifier (voir `docs/oauth-web.md`).

## Sauvegardes et restauration

Contrat de `scripts/backup.mjs` (réalisé séparément), appelé ici via le service Compose `backup` :

- **Snapshot** : cohérent de SQLite **en ligne** (API de sauvegarde de `node:sqlite`, Node 24.13 ou plus), pendant que l'application tourne. Jamais une copie de `relay.db` avec WAL actif. L'archive contient la base seulement, jamais de clé.
- **Snapshot en clair** : écrit dans le répertoire temporaire du conteneur, le tmpfs `/tmp` du service `backup`, et effacé en fin de commande. Si le conteneur est tué, le tmpfs disparaît avec lui. Il n'est jamais écrit dans `backups/`, qui ne reçoit que l'archive chiffrée publiée et l'état.
- **Chiffrement** : AES-256-GCM avec la clé de sauvegarde, distincte de la clé du coffre.
- **Restauration** :
  - uniquement vers un **nouveau** répertoire, sous verrou ;
  - une mauvaise clé est refusée ;
  - les sessions, `whatsapp_auth` et les secrets WhatsApp sont purgés, puis effacés physiquement (`secure_delete`, `VACUUM`, checkpoint) ;
  - les comptes sont marqués « à reconnecter » ;
  - un fichier `restore-hold.json` est créé : tant qu'il existe, le runtime garde connecteurs et IA **arrêtés**, même si l'environnement les active.
- **Reprise** : `resume --confirm-resume` exige que le runtime soit arrêté (verrou libre) et retire le blocage. WhatsApp doit ensuite être relié par QR.
- **État** : `status` renvoie un JSON assaini, avec le code 2 en cas d'alerte.

Préfixe commun (à lancer depuis `/opt/relay-desk`) :

```sh
DC="docker compose --env-file /etc/relay-desk/hosted.env -f /opt/relay-desk/compose.yaml --profile backup run --rm --no-deps backup"
KEYS="--backup-key-file /run/secrets/backup_key --vault-key-file /run/secrets/relay_secret_key"
```

**Dimensionnement du service `backup`** :

- **tmpfs** : `RELAY_BACKUP_TMPFS_SIZE` (défaut `1g`) doit contenir la base entière, WAL compris, avec 25 % et 64 Mio de marge.
- **Mémoire** : un tmpfs compte dans la mémoire du conteneur. `RELAY_BACKUP_MEM_LIMIT` (défaut `1536m`) doit donc dépasser le tmpfs d'au moins 256 Mio, et la VM doit disposer de cette mémoire au moment de la sauvegarde.
- **Contrôle** : le préflight refuse un tmpfs trop petit pour la base présente ou une limite mémoire insuffisante. Les deux valeurs sont à relever quand la base grossit, par exemple après l'import WhatsApp du lot 7.

**Sauvegarde** : `relay-desk-backup.service` exécute cette commande chaque jour via son timer, avec rattrapage après arrêt de la VM.

```sh
$DC create --data-dir /data --archive /backups/archives/relay-$(date -u +%Y%m%dT%H%M%SZ).rlybak $KEYS \
  --status-file /backups/status/last-backup.json
```

**État** : `$DC status --data-dir /data --status-file /backups/status/last-backup.json` (code 2 : attention).

**Restauration**, toujours dans une nouvelle génération :

1. Arrêter l'application (`docker compose --env-file /etc/relay-desk/hosted.env --profile hosted stop relay`) et confirmer qu'aucune autre instance ne tourne nulle part, y compris sur le Mac.
2. Préparer seulement le **parent** : `install -d -o 1000 -g 1000 -m 0700 /srv/relay-desk/data`. La nouvelle génération `/srv/relay-desk/data/AAAAMMJJ-n` ne doit pas exister.
3. Monter ce parent en supplément et restaurer dans un enfant absent. Le montage `/data` conserve la génération arrêtée, mais la commande ne la lit ni ne la modifie. Ne pas utiliser `/data` comme destination : un point de montage existe déjà et serait refusé.

   ```sh
   docker compose --env-file /etc/relay-desk/hosted.env -f /opt/relay-desk/compose.yaml --profile backup \
     run --rm --no-deps --volume /srv/relay-desk/data:/restore-generations backup \
     restore --data-dir /restore-generations/AAAAMMJJ-n \
     --archive /backups/archives/relay-<horodatage>.rlybak $KEYS
   ```

4. Modifier `RELAY_DATA_DIR` dans `hosted.env`, relancer le préflight, puis démarrer `relay`. Le blocage de restauration garde connecteurs et IA arrêtés.
5. Se connecter, puis vérifier les profils, les comptes, le nombre de conversations, les brouillons et la mémoire, sans exporter de contenu dans les journaux.
6. Lever le blocage explicitement, application arrêtée :

   ```sh
   docker compose --env-file /etc/relay-desk/hosted.env --profile hosted stop relay
   $DC resume --data-dir /data --confirm-resume
   docker compose --env-file /etc/relay-desk/hosted.env --profile hosted up -d relay
   ```

   Ensuite, reconnecter chaque compte et relier WhatsApp par QR. L'ancienne génération est conservée intacte jusqu'à validation.

La restauration complète doit être testée régulièrement dans un répertoire ou sur une VM jetable, jamais sur la génération en service. La rétention locale des archives (nombre conservé dans `archives/`) reste à fixer avec l'outil.

### Copie hors de la VM (préparée, non active)

Seules les archives chiffrées `archives/*.rlybak` quittent la VM. Ni la clé de sauvegarde, ni la clé du coffre, ni les données, ni `status/` ne sont copiées. Aucun transport n'est configuré aujourd'hui et rien n'a été copié.

- **rclone vers un stockage objet** (modèle `deploy/systemd/relay-desk-offsite.service`) :
  - l'unité est ignorée tant que `/etc/relay-desk/offsite.env` n'existe pas ;
  - une fois configurée, elle lance `rclone copy --checksum`, puis `rclone check --one-way --checksum`, qui relit les empreintes côté stockage ;
  - il n'y a ni `sync` ni suppression distante : la rétention se règle côté stockage (versions, verrouillage d'objets) ;
  - le jeton est limité à la lecture, la liste et l'écriture sur le conteneur dédié, nécessaires à la copie puis à la vérification.
- **Variante rsync sur SSH** vers un hôte de sauvegarde :
  - clé SSH dédiée, restreinte côté serveur (`command=` vers `rrsync` en écriture seule sur un répertoire) ;
  - `rsync --checksum --ignore-existing` sur `archives/` ;
  - vérification par `sha256sum` des deux côtés.

La sauvegarde déclenche la copie (`ExecStartPost`) sans attendre son résultat. Une archive locale ne prouve pas l'existence d'une copie hors VM. Tant qu'aucun transport n'est configuré et vérifié, l'état hors VM et le test de restauration restent **non vérifiés** dans `/api/ops/health`. Il ne faut pas les présenter comme acquis.

### Mesure synthétique de stockage

`node scripts/benchmark-storage.mjs 10000` sur le Mac (Node 24.13) : 10 000 textes, 100 conversations dont 50 groupes, base 5 296 128 octets, archive 5 296 164 octets, import 1 007 ms, sauvegarde 103 ms, restauration 58 ms, pic RSS 134 987 776 octets. Cette mesure exclut décodage de l’historique du téléphone, réseau, fournisseurs et IA. Elle ne dimensionne pas le futur serveur ; refaire une mesure sur sa base fictive puis dimensionner avec marge avant l’import réel autorisé.

## Mises à jour et retour arrière

Les migrations SQL (`src/db/migrations/`) sont appliquées **automatiquement au démarrage**. Elles vont **uniquement vers l'avant** et ne prévoient pas de migration inverse.

Le runtime refuse une base dont la version (`PRAGMA user_version`) dépasse la dernière migration connue. **Ne jamais redémarrer une version antérieure sur une génération déjà migrée.** Restaurer la sauvegarde compatible dans une nouvelle génération.

**Mise à jour :**

1. Récupérer le nouveau commit dans `/opt/relay-desk` (ou en préparer une copie à côté) et noter l'étiquette en service.
2. Lister les migrations ajoutées : `git diff --name-only <ancien>..<nouveau> -- src/db/migrations/`.
3. Construire et tester : `docker build --target test .`, puis construire l'image avec la nouvelle étiquette.
4. **Sauvegarde avant mise à jour**, obligatoire : `$DC create …` (voir « Sauvegardes »), vérifier la taille, la somme et une restauration de contrôle. `$DC status …` doit montrer `database.status=ok` et `backups.status=ok` ; son code 2 reste attendu pour `process_unobserved`, `offsite_unverified` et `restore_test_unverified`. Ces contrôles demandent leurs preuves indépendantes. Noter le nom de l'archive.
5. Mettre à jour `RELAY_IMAGE_TAG` puis lancer le préflight.
6. Exécuter `docker compose --env-file /etc/relay-desk/hosted.env --profile hosted up -d relay`. L'arrêt du conteneur précédent est propre (SIGTERM, 45 s), et WhatsApp n'est pas déconnecté.
7. Vérifier la santé, la connexion et la synchronisation. Conserver l'image précédente et sa sauvegarde jusqu'à validation.

**Retour arrière, décidé en connaissance de cause :**

| Cas | Procédure | Conséquence |
| --- | --- | --- |
| Aucune migration entre les deux versions | Remettre l'ancienne étiquette dans `RELAY_IMAGE_TAG`, préflight, `up -d relay` | Aucune perte |
| Migrations appliquées | Arrêter, restaurer la sauvegarde d'avant mise à jour dans une **nouvelle génération**, basculer `RELAY_DATA_DIR` et l'ancienne étiquette, puis démarrer | Les changements faits depuis la mise à jour sont perdus : brouillons, mémoire, états de lecture. Les messages se resynchronisent depuis les fournisseurs, dans la limite de leur historique. Les envois déjà partis restent envoyés et ne sont jamais rejoués. Les connecteurs redémarrent arrêtés. |

Une restauration ne réutilise jamais la génération migrée : elle reste intacte pour analyse.

## Disponibilité, redémarrage et supervision

- **Redémarrage automatique** : `restart: unless-stopped` relance les conteneurs au redémarrage de Docker ou de la VM. Docker doit être activé au démarrage (`systemctl enable docker`).
- **Arrêt volontaire** : un `docker compose stop` reste arrêté.
- **Pas de seconde instance** : le nom fixe du conteneur et le verrou d'instance sur les données empêchent deux instances sur la même base. Il ne faut jamais lancer une copie sur une autre machine avec la même session WhatsApp.
- **État `unhealthy`** : Compose ne relance pas un conteneur dans cet état. C'est une alerte à traiter, pas une reprise automatique.
- **Supervision** :
  - sonde HTTPS externe sur `GET /api/ready` (public, 200 ou 503 selon le processus et la base) ;
  - `GET /api/ops/health` (protégé par la session propriétaire) : processus, base, espace disque (`OPS_MIN_FREE_BYTES`, 512 Mio par défaut), âge de la sauvegarde locale (`OPS_BACKUP_MAX_AGE_HOURS`, 26 h par défaut, lu dans `BACKUP_STATUS_FILE`), connecteurs en retard (`OPS_SYNC_STALE_MINUTES`, 15 min par défaut) et comptes à reconnecter ;
  - expiration du certificat.

  Les états hors VM et test de restauration y sont explicitement « non vérifiés ». Une panne d'un fournisseur ne rend pas l'application indisponible.
- **Journaux** :
  - Docker en `json-file`, rotation 3 × 10 Mo ;
  - Caddy sans journal d'accès, journal d'erreurs filtré (ni URI, ni requête, ni en-têtes) ;
  - l'application n'écrit ni corps de message, ni QR, ni jeton.
- **Système** : mises à jour de sécurité automatiques. Les redémarrages de la VM sont planifiés, puis suivis d'une vérification de santé.

## Ce qui est validé, et ce qui ne l'est pas

**Validé localement sur valeurs fictives**, sans service public ni réseau sortant :

- le préflight et ses refus (`test/deploy-preflight.test.js`) ;
- les propriétés statiques de `compose.yaml`, du `Caddyfile` et des modèles systemd (`test/deploy-config.test.js`) ;
- l'analyse de `compose.yaml` par `docker compose config` (profils `hosted` et `backup`) avec la configuration générée par `deploy/fictif/make-hosting.mjs` : clé de sauvegarde montée seulement dans `backup`, aucun port publié hors du proxy ;
- `caddy adapt` du `Caddyfile` avec Caddy 2.10.2, et le filtre des journaux d'erreurs (`deploy/caddy-logs-check.mjs`, local uniquement, sans ACME) ;
- la syntaxe des unités systemd (`systemd-analyze verify`, hors présence de `rclone`) ;
- 311 tests sur Mac et dans l’image Linux, sans test ignoré ;
- recette Docker avec volumes éphémères : snapshot WAL actif, brouillons/mémoire/jetons restaurés, clés incorrectes et écrasement refusés, suspension des connecteurs et de l’IA, reprise à froid explicite ;
- exécution du seul service Compose `backup` avec configuration fictive et `network_mode: none`, vérification du statut et restauration dans un enfant absent monté depuis son parent ; aucun service `relay` ou `proxy` de cette configuration démarré ;
- `caddy validate` hors réseau puis test du journal 502 sur boucle locale interne au conteneur, sans port publié ni ACME.

**Non validé** :

- la VM, le DNS, l'ouverture des ports, l'émission et le renouvellement du certificat ;
- Keycloak et la MFA réels, les clients Google/Entra réels ;
- le stockage hors VM et le transport des archives (non vérifié tant qu'il n'est pas configuré) ;
- une restauration sur l'hébergement ;
- la reprise après redémarrage de la VM ;
- la sauvegarde et la reprise de Keycloak.

Ces points relèvent de la recette sur l'hébergement choisi, après autorisation.
