# Notifications Gmail et Outlook

Les notifications accélèrent la synchronisation existante : elles ne contiennent pas les corps des messages et n’appellent aucun parcours d’envoi. Le navigateur reçoit ensuite l’invalidation SSE et recharge les données autorisées. L’aperçu exact et son approbation à usage unique restent obligatoires avant tout envoi.

## Configuration hébergée

Activer séparément `GMAIL_PUSH_ENABLED=true` et `OUTLOOK_PUSH_ENABLED=true`. Ces options exigent le mode hébergé HTTPS. Les connecteurs et identités autorisés restent ceux de la configuration OAuth existante.

Gmail nécessite :

- `GMAIL_PUSH_TOPIC=projects/PROJECT/topics/TOPIC`, dans le projet du client OAuth Google.
- `GMAIL_PUSH_SUBSCRIPTION=projects/PROJECT/subscriptions/SUBSCRIPTION`.
- `GMAIL_PUSH_SERVICE_ACCOUNT=ACCOUNT@PROJECT.iam.gserviceaccount.com`.
- Topic dédié avec le rôle Pub/Sub Publisher pour `gmail-api-push@system.gserviceaccount.com`, limité à ce topic.
- Souscription push vers `PUBLIC_BASE_URL/webhooks/gmail`, authentification activée avec le compte de service dédié et audience identique à l’URL. Conserver l’enveloppe JSON (pas de payload unwrapping).
- Autoriser l’agent Pub/Sub à créer le jeton OIDC du compte de service ; aucune clé privée de compte de service n’est nécessaire.

Outlook utilise `PUBLIC_BASE_URL/webhooks/outlook` pour les notifications normales et de cycle de vie. `MICROSOFT_TENANT` doit être le GUID réel de l’annuaire : les alias OAuth `common`, `organizations` ou les domaines ne permettent pas de vérifier le tenant d’une notification. La souscription `me/messages` utilise les droits de lecture délégués existants. Aucun droit d’envoi supplémentaire n’est requis.

## Réception et renouvellement

Gmail vérifie la signature Google, l’émetteur, l’audience, l’identité de service vérifiée et le nom de souscription. Outlook vérifie l’identifiant de souscription, le secret aléatoire `clientState` et le GUID de tenant. Seul le challenge de validation Graph est public ; il renvoie le jeton opaque en texte brut. Corps limités et débit borné. Les journaux ne contiennent aucun contenu de message ou jeton.

Le signal accepté incrémente un compteur durable chiffré avec les identifiants OAuth du compte avant l’accusé 202. Les doublons Gmail sont regroupés par historique. Un signal arrivé pendant une synchronisation reste en attente pour le passage suivant. Chaque connexion possède sa génération : une ancienne tâche ne peut pas acquitter celle d’une reconnexion. Les rotations de jetons conservent cet état.

Le worker reprend `history.list` Gmail et les curseurs delta Graph existants dans leur file par compte. Les souscriptions sont renouvelées quotidiennement ; Graph expire après deux jours, Gmail selon son expiration fournie. Un renouvellement réussi déclenche aussi un rattrapage. Les événements Graph missed, subscriptionRemoved et reauthorizationRequired déclenchent récupération ou renouvellement avec un jeton d’accès frais. Au redémarrage, les souscriptions valides sont réutilisées et un rattrapage est immédiat.

Les notifications sont habituellement rapides, mais les fournisseurs peuvent les retarder ou les perdre. Une réconciliation de secours toutes les dix minutes reste active ; si la souscription n’est pas valide, le mécanisme périodique habituel reprend. Les reprises après erreur sont différées d’une minute. L’état public d’un compte expose seulement le mode push/recovery, l’attente, l’expiration et la date du dernier signal.

## Exploitation

Ne déclarer une activation réussie qu’après avoir vérifié les deux souscriptions actives et, pour Gmail, la réception authentifiée du signal initial envoyé lors de `watch`. Pour Outlook, la création confirme le challenge HTTPS ; une livraison normale doit être vérifiée séparément dès qu’un message arrive. Ne jamais envoyer un email réel pour tester sans approbation de son aperçu exact.

Les indicateurs sont désactivés par défaut. Les désactiver rétablit la récupération périodique sans migration. Les souscriptions distantes expirent ensuite, sauf la souscription Pub/Sub à nettoyer explicitement si le service est abandonné. Inclure les états chiffrés dans les sauvegardes normales. Le tarif Pub/Sub dépend de l’usage du projet ; aucune nouvelle VM n’est nécessaire.

Références : [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), [authentification Pub/Sub](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions), [webhooks Graph](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), [cycle de vie Graph](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events).
