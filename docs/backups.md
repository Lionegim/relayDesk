# Sauvegarde et restauration (lot 6)

Préparation et recette **avec données fictives uniquement**. Aucune VM, destination distante ou donnée du Mac n'a été utilisée. Pour la configuration Compose, systemd et la future copie hors VM, voir [le guide d'exploitation](operations.md).

## Ce que l'archive contient

`node scripts/backup.mjs create` utilise l'[API de sauvegarde SQLite](https://www.sqlite.org/backup.html), via `node:sqlite`, pour produire un snapshot cohérent même lorsque la base source utilise WAL et reste ouverte. Une simple copie de `relay.db` en cours d'utilisation ne convient pas. Node **24.13 minimum**, image Docker Node 24 épinglée dans le Dockerfile.

Les tables SQLite comprennent messages, profils, dossiers, brouillons avec leurs versions, identités et exemples de mémoire, jetons chiffrés et état WhatsApp. Ni les fichiers de clés, ni `.env`, ni les journaux ne sont empaquetés. La base et les clés doivent être récupérables **par des chemins distincts**. Conserver les deux clés dans un coffre externe à la VM et à la destination des archives ; ne pas les mettre à côté de l'archive.

L'archive est authentifiée et chiffrée en AES-256-GCM : en-tête `RLYBAK01` (8 octets), nonce aléatoire de 12 octets, ciphertext du snapshot, tag de 16 octets. L'en-tête est authentifié comme AAD. La clé de sauvegarde doit être différente de la clé du coffre, toutes deux de 32 octets. Les fichiers de clés acceptent base64 canonique ou hexadécimal et doivent être privés (0400 ou 0600). Une somme SHA-256 externe contrôle le transport ; elle ne remplace pas l'authentification GCM.

## Création et statut

Chemins explicites obligatoires, aucune lecture automatique de `.env` et aucun appel réseau :

```sh
node scripts/backup.mjs create \
  --data-dir /data \
  --archive /backups/relay-20261019T020000Z.rlybak \
  --backup-key-file /run/secrets/backup_key \
  --vault-key-file /run/secrets/relay_secret_key \
  --status-file /backups/last-backup.json
```

L'archive doit être hors du répertoire des données. Un fichier existant n'est jamais remplacé ; les alias symboliques de chemins sont contrôlés. L'archive n'apparaît à son nom définitif qu'après chiffrement, authentification et synchronisation du fichier sur disque. Le statut contient seulement date, taille, schéma et SHA-256. Une erreur renvoie un code 1 et un message générique assaini. Le détail d'une erreur de fournisseur ou une valeur de clé ne sont jamais imprimés.

Le snapshot **en clair** est temporairement nécessaire. Par défaut il est placé dans un sous-dossier privé de `os.tmpdir()`, distinct des archives. En Docker, ce dossier doit être un **tmpfs** : sa capacité et la limite mémoire du service de sauvegarde doivent couvrir la base complète et une marge. `--staging-dir` permet un espace temporaire privé différent, toujours hors de l'arborescence des archives. Ne pas utiliser une destination distante ou un dossier synchronisé pour cet espace. Le service se nettoie à la fin ; un tmpfs disparaît avec le conteneur même après SIGKILL. Hors Docker, une interruption brutale peut laisser le dossier temporaire privé sur disque : utiliser un volume chiffré et nettoyer uniquement les anciens dossiers `.relay-snapshot-*` après vérification qu'aucune sauvegarde n'est en cours. Il ne s'agit pas d'un effacement sécurisé garanti sur SSD.

Le service de copie hors VM doit transporter **uniquement `*.rlybak`** déjà publiés, jamais les données, clés, statuts ou dossiers temporaires. Prévoir une destination indépendante de la VM et vérifier la somme depuis cette destination, puis effectuer une restauration indépendante. La recette actuelle ne réalise aucun transfert. `offsite` et `restoreTest` restent donc `unverified` dans la supervision ; une archive locale récente ne prouve pas ces deux contrôles.

## Restauration isolée

```sh
node scripts/backup.mjs restore \
  --data-dir /restore/nouvelle-instance \
  --archive /backups/relay-20261019T020000Z.rlybak \
  --backup-key-file /run/secrets/backup_key \
  --vault-key-file /run/secrets/relay_secret_key
```

Le dossier de destination **ne doit pas exister**. Le parent doit être accessible à l'uid du conteneur. Une destination existante est refusée, même arrêtée. Une clé incorrecte, une archive tronquée ou altérée, des clés de coffre incompatibles et un schéma futur sont refusés. L'outil limite par défaut l'archive à 16 Gio. Il vérifie l'intégrité SQLite, les références et le déchiffrement de tous les secrets avant de migrer la copie. Une erreur supprime uniquement le nouveau dossier qu'il vient de créer.

La restauration conserve les brouillons, leurs versions, la mémoire et les jetons mail déchiffrables. Elle invalide les anciennes sessions web ; les confirmations d'envoi sont en mémoire et ne sont jamais restaurées. Elle purge les anciennes clés WhatsApp et leurs pages SQLite (`secure_delete`, `VACUUM`, checkpoint). Les comptes sont marqués « À reconnecter ». Un fichier `restore-hold.json` désactive les adaptateurs **et l'IA**, même si l'environnement demande de les activer. Aucun jeton mail restauré ne doit être utilisé avant vérification puis reconnexion explicite. WhatsApp nécessite une nouvelle liaison QR ; aucune copie de son ancienne session ne reprend.

Inspecter d'abord le contenu restauré avec les connecteurs suspendus. Avant toute future reprise réelle, arrêter l'ancienne instance et désactiver sa reprise automatique. Arrêter également la copie restaurée, puis seulement :

```sh
node scripts/backup.mjs resume --data-dir /restore/nouvelle-instance --confirm-resume
```

La commande prend le verrou d'instance et refuse une application encore démarrée. Elle retire la suspension au prochain démarrage ; elle ne reconnecte pas les comptes, n'envoie rien et ne restaure jamais les anciennes clés WhatsApp. Ne pas retirer le fichier à la main.

## Supervision et retour arrière

`GET /api/health` est une sonde minimale du runtime. `GET /api/ready` renvoie uniquement `{ "ok": true }` (200) ou `{ "ok": false }` (503) selon le runtime et l'accès à SQLite. La sonde du conteneur utilise readiness. Un fournisseur déconnecté ne rend pas la base ni tout le service indisponibles.

`GET /api/ops/health` exige la session du propriétaire en mode hébergé. Il sépare processus, accès DB, disque disponible, âge de sauvegarde, état de restauration et nombres agrégés de comptes à reconnecter/erreurs/synchronisations périmées par fournisseur. Aucun nom, adresse, corps, QR ou erreur brute. Le statut reste `attention` tant que copie hors site et restauration indépendante n'ont pas été vérifiées ; ces éléments sont volontairement déclarés inconnus.

La commande locale `status --data-dir … --status-file …` examine le disque et la DB ; elle **ne prouve pas qu'un processus tourne** et renvoie un code 2 pour un état demandant attention. Le superviseur de disponibilité doit utiliser `/api/ready` en HTTPS, plus tard sur la VM.

Avant mise à jour : image immuable identifiée par empreinte, sauvegarde cohérente, vérification de sa somme et restauration de contrôle dans un volume neuf. Conserver l'image précédente et la sauvegarde pré-migration. Une ancienne image refuse un schéma plus récent ; **ne jamais revenir simplement à l'ancienne image sur la base migrée**. Restaurer la sauvegarde compatible dans un nouveau volume, connecteurs suspendus, vérifier puis décider de la reprise. Les changements arrivés après cette sauvegarde doivent être réconciliés ; un envoi au résultat incertain ne doit jamais être rejoué automatiquement.

## Recettes reproductibles

`npm test` utilise des bases éphémères fictives. `npm run test:docker` construit les étapes test/runtime, exécute la recette de redémarrage et la recette d'exploitation sans réseau ni port publié. Les volumes de recette sont supprimés à la fin. `node scripts/benchmark-storage.mjs 10000` mesure uniquement un import de textes synthétiques, son stockage, sa sauvegarde et sa restauration ; ce n'est ni un transfert WhatsApp ni une mesure sur le futur serveur.

Les essais HTTPS public, authentification Keycloak réelle, redémarrage de VM, copie distante et renouvellement de certificat restent des étapes futures à autoriser séparément. Ils ne sont pas déclarés validés par une recette locale.
