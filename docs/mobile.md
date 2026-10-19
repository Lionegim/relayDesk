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

### Device Hub — Safari iOS simulé

Recette du 19 octobre 2026 sur **iPhone 17 Pro, iOS 26.2 Simulator** dans Device Hub, avec la même base éphémère et les fournisseurs fictifs. Safari accède au serveur via `http://localhost:4313` (hôte explicitement autorisé uniquement dans le lanceur de test), sans exposition au réseau local. Liste, ouverture d’une conversation, corps du message, accès à l’historique et ouverture du compositeur observés.

**Recette partielle, parcours iOS non validé :** Safari recharge ensuite la page avec « This webpage was reloaded because a problem occurred. ». Les rapports système contemporains signalent un crash natif `com.apple.WebKit.WebContent`, `EXC_BAD_ACCESS / SIGBUS`, dans `JSC::JSRopeString::resolveToBuffer` puis `JSC::arrayProtoFuncJoin`. Cela établit le crash du moteur, sans établir sa cause ni exclure un déclencheur dans l’application. Des arrêts avaient également été observés avant le chargement de Relay Desk. La saisie, le clavier, l’aperçu, l’installation PWA et le parcours complet doivent être repris sur un runtime stable et sur appareil réel. Aucun test Android n’a été effectué via Device Hub ; les appareils disponibles sont des simulateurs Apple.

### Contournement de rendu et nouvelle recette Safari

Le rendu HTML assemble désormais les morceaux de chaque gabarit et ses tableaux imbriqués avant une unique jointure. Il évite les concaténations successives qui formaient des chaînes en arbre passées à une autre jointure. Quatre tests vérifient les valeurs/échappements, des structures imbriquées, les vues complètes email/WhatsApp et de gros volumes ; ils ne prétendent pas reproduire un crash natif dans Node. Le cache statique PWA change de version. **279 tests passent sur Mac et Linux**, ainsi que la recette Docker isolée ; la revue ne relève pas de P1/P2 dans le périmètre du correctif.

Comparaison manuelle sous iOS 26.2 : un cas réduit (200 rendus de 50 lignes synthétiques, uniquement `html`/`patch`) a reproduit le crash `resolveToBuffer` avec l’ancien code. Après modification et relance du simulateur, trois séries de 200 rendus ont terminé avec leur checkpoint serveur. Cependant, l’application complète a encore déclenché un crash natif, cette fois dans `resolveToBuffer` appelé depuis `Document.querySelectorAll`. D’autres rapports concernaient le démarrage `dyld` ou le compilateur JIT DFG. Le contournement ne constitue donc **pas une correction générale d’iOS 26.2**. Un [échange avec Apple DTS sur les défaillances du cache partagé du simulateur](https://developer.apple.com/forums/thread/837945) documente un problème similaire, sans établir la cause exacte ici.

Le runtime **iOS 27.1 fourni par Xcode 27.1** a ensuite été installé depuis les composants Apple, sans supprimer iOS 26.2 ni effacer les appareils existants. Un simulateur distinct, « Relay Desk - Safari 27.1 fictif » (modèle iPhone Duo proposé par ce runtime), utilise exclusivement `http://localhost:4313`, une base SQLite en mémoire et des transports Gmail/IA factices. Recette validée sans rechargement dû à un crash :

- Liste, lecture, historique de 50 à 70 éléments, retour ; formats fermé et ouvert du simulateur.
- Réponse au clavier logiciel, commandes accessibles, sauvegarde automatique, reprise exacte du brouillon après rechargement.
- Aperçu exact puis confirmation distincte ; le faux fournisseur a reçu un envoi de réponse, puis un nouvel email créé avec le bouton « Nouveau message ». Les deux réponses HTTP étaient 200 ; aucun transport de messagerie réel n’a été utilisé.
- Assistant : résultat simulé, proposition puis insertion dans le brouillon ; cette insertion passe encore par l’aperçu et n’envoie rien automatiquement.
- Arrêt du serveur fictif puis rechargement : écran générique « Hors ligne », sans contenu privé. Relance et « Réessayer » : retour à la liste, sans requête d’envoi rejouée.
- Ajout via Safari à l’écran d’accueil, ouverture comme Web App autonome, retour après passage à l’accueil et adaptation de l’orientation.

Les deux envois sont uniquement des événements dans le faux fournisseur en mémoire. L’authentification OIDC réelle, les retours OAuth sur domaine HTTPS, Android, les appareils physiques et la compatibilité stable d’iOS 26.2 restent en dehors de cette validation. Aucun déploiement, transfert de données réelles, mise à jour de comptes réels ou envoi réel n’a eu lieu.
