# Relay Desk sur mobile — lot 5

Le lot 5 prépare l’interface web mobile et son installation comme PWA. Le serveur continue à synchroniser les comptes et à construire le contexte IA. Ce développement utilise uniquement des données fictives ; aucun hébergement ni transfert des données du Mac n’est réalisé.

## Navigation tactile

Jusqu’à 1000 pixels de large, un seul panneau est affiché : liste, conversation, rédaction ou assistant. Le menu latéral devient un tiroir et le retour du navigateur suit ces panneaux. Les champs utilisent une police de 16 pixels, les commandes tactiles au moins 44 pixels, et le compositeur tient compte du viewport visuel et des marges de sécurité. Au-delà, les trois colonnes restent disponibles.

## Listes et historique

L’interface demande `/api/state?paged=1&profile=...` avec les filtres `nav`, `channel`, `folder`, `q`, une `limit` de 1 à 100 (50 par défaut) et un `cursor` facultatif. La réponse conserve les métadonnées de profils/comptes/dossiers et expose `page: {limit, total, hasMore, nextCursor}` et les compteurs complets du profil `counts: {all, unread, todo, drafts, folders}`. Les compteurs ignorent le canal et la recherche. Les dossiers comprennent leurs descendants. La recherche traite les majuscules/minuscules Unicode, sans interpréter les caractères saisis comme une expression SQL.

Les pages de conversations utilisent l’ordre décroissant `(sort_at,id)` et un curseur lié aux filtres ; un changement de filtre recommence la pagination. Les éléments d’historique gardent un identifiant stable ; deux messages identiques restent distincts lors du chargement des pages. Aucun historique stocké n’est supprimé. L’ancien `/api/state` sans pagination reste disponible pour compatibilité ; l’interface mobile utilise le parcours borné.

`GET /api/messages/:id?limit=50&before=...` renvoie le dernier message avec une page de messages précédents dans `trail` et `history: {hasMore,nextCursor}`. Une modification de la conversation rend les anciens curseurs incompatibles (`409 history_changed`) et exige un rechargement. L’assistant et les fournisseurs continuent à employer `store.getMessage(id)` sans pagination ; la taille de l’écran ne réduit pas leur contexte.

## Brouillons partagés

Chaque message possède une `draftVersion` entière ; un brouillon présent expose également `draft.version`. `PUT /api/messages/:id/draft` et `POST /api/messages/:id/send/preview` exigent `baseVersion`. Le serveur refuse une ancienne version par `409 draft_conflict`, sans écrire un ancien brouillon chez le fournisseur. Les contrôles se font dans la file du compte avant l’appel Gmail/Graph, puis avant l’enregistrement local. WhatsApp conserve ses brouillons uniquement dans Relay Desk. Pendant la saisie d’une adresse incomplète, les brouillons email restent également enregistrés dans Relay Desk ; leur copie chez le fournisseur attend des destinataires valides. L’aperçu refuse toujours les adresses invalides.

La version est persistante, monotone et distincte après suppression/recréation d’un message. Supprimer ou envoyer un brouillon invalide sa version. L’aperçu mémorise la version validée : une édition sur un autre appareil entre l’aperçu et l’envoi empêche l’envoi ancien d’effacer le nouveau texte. La confirmation reste liée au contenu exact, au compte, à sa génération et à la session propriétaire.

Le navigateur conserve les modifications non enregistrées en mémoire de la page, pas dans un stockage permanent privé sur le téléphone. Fermer la page peut perdre ce texte : l’état d’enregistrement doit être vérifié avant de quitter. Un conflit nécessite un choix explicite et aucun texte distant récent n’est remplacé silencieusement.

## Installation et confidentialité du cache

L’installation sur un domaine hébergé nécessite HTTPS. Les ressources statiques du programme peuvent être mises en cache par une liste explicite et versionnée. Les messages, brouillons, mémoire, résultats IA, QR, retours OAuth et réponses d’API ne sont jamais ajoutés au cache du service worker. L’HTML applicatif protégé est servi avec `Cache-Control: no-store`. Les fichiers statiques publics ne contiennent aucune donnée du propriétaire.

Hors ligne, aucun envoi n’est effectué ou mis en attente. Le retour du réseau ne rejoue pas une mutation. Un envoi dont le résultat est incertain exige une nouvelle vérification chez le fournisseur et un nouvel aperçu ; il n’est pas relancé automatiquement. Aucune notification affichant un extrait de message n’est ajoutée dans ce lot.

Références : [cache des PWA](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Caching), [installation depuis le navigateur](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt), [clavier et viewport visuel](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).

## Recette

Les tests de stockage et d’API emploient SQLite éphémère et de faux Gmail/Graph/WhatsApp : pages à dates égales, frontières de profil, dossiers, recherche accentuée, historique complet accessible à l’IA, sauvegardes concurrentes, ancien aperçu après édition, ancien envoi après édition et identifiants réutilisés. Validation du 19 octobre 2026 : **275 tests réussis sur Mac et dans le stage Linux Node 24**, puis recette Docker isolée sans réseau réussie. La restauration à froid conserve aussi la version du brouillon. Les revues du serveur et de l’interface ne signalent plus de P1/P2 dans leur périmètre.

La recette Chrome a utilisé une instance locale séparée et éphémère : portrait 390 × 844, paysage 844 × 390, liste et historique paginés, rédaction et reprise du brouillon, aperçu exact, conflit entre deux onglets avec choix explicite. La confirmation se désactive lors de la perte du réseau après aperçu. Après arrêt de cette instance puis rechargement, seul l’écran hors ligne générique est affiché. Le manifeste est reconnu par Chrome. Aucun envoi réel ni installation sur un téléphone n’a été effectué.

La recette Chrome à dimensions mobiles ne remplace pas les essais sur appareils physiques. Safari iPhone, Chrome Android, l’installation depuis leur menu système, le clavier matériel/virtuel, les safe areas et la reprise après fermeture devront être vérifiés sur le futur domaine HTTPS et les téléphones réels avant la bascule. Aucun résultat simulé n’est présenté comme une validation de ces appareils.
