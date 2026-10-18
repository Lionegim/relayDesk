# WhatsApp sur ce Mac

Relay Desk propose une liaison par QR code dans **WhatsApp → Réglages → Appareils connectés**. C’est le même parcours utilisateur que la [liaison Dex](https://getdex.com/docs/integrationsandfeatures/syncfeatures/sync-whatsapp), dont la documentation décrit les contacts et les dernières interactions. Nous ne connaissons pas l’implémentation interne de Dex.

Le connecteur de Relay Desk utilise [Baileys](https://github.com/WhiskeySockets/Baileys), une bibliothèque communautaire non officielle, sans affiliation à WhatsApp/Meta. Elle peut cesser de fonctionner ou l’accès peut être limité par WhatsApp. Cette première version ne remplace pas la plateforme officielle WhatsApp Business.

## Connecter

1. Installer les dépendances avec `npm ci --ignore-scripts`, puis lancer `npm start`.
2. Dans Relay Desk, **Ajouter un canal → WhatsApp**, choisir le profil et le nom du compte.
3. Lire les accès et limites, puis **Afficher le QR code**.
4. Dans WhatsApp sur le téléphone, **Réglages → Appareils connectés → Connecter un appareil**, puis scanner le QR en direct sur le Mac. Il se renouvelle et expire : ne pas utiliser une ancienne capture.
5. La liaison vérifie l’identité du téléphone, puis ouvre la boîte du profil choisi. L’historique peut continuer à arriver après l’ouverture. Sa disponibilité dépend de WhatsApp ; l’interface affiche les comptes et messages effectivement importés.

Le QR crée un accès en lecture et envoi pour ce Mac. L’application n’envoie qu’après aperçu exact et confirmation à usage unique. Il n’y a ni envoi automatique par l’IA, ni synchronisation du courrier vers Dex ou un agrégateur tiers.

## Portée de cette version

- Conversations individuelles en texte sur les sept derniers jours disponibles, puis réception des nouveaux messages. L’ordre et la quantité de l’historique reçu dépendent de WhatsApp.
- Groupes, statuts, diffusions, chaînes, médias et légendes exclus. Les messages à vue unique et éphémères ne sont pas conservés ; les politiques de discussion reçues sont mémorisées et les contenus déjà importés sont retirés si la discussion est identifiée comme éphémère.
- Limites : 500 discussions avec messages, 200 messages conservés par discussion, fil IA limité aux 50 messages précédant le dernier, texte importé limité à 8 000 caractères par message.
- Contacts des discussions importées : nom disponible, numéro lorsqu’il est connu et dernière interaction. Les identifiants privés `@lid` ne sont pas affichés comme des numéros de téléphone.
- Lu/non lu, drapeau, archivage, dossiers et brouillons restent **locaux**. Aucun accusé de lecture n’est envoyé par un clic de lecture dans Relay.
- Réponse texte dans une discussion existante, au plus 4 096 caractères. Pas de nouveau destinataire WhatsApp, réponse à tous, transfert, médias ou groupes dans cette version. **Nouveau message** reste réservé aux comptes email.
- Résumé, classement et proposition de réponse via l’assistant commun. L’IA n’est appelée qu’à la demande de l’utilisateur ; le panneau indique que le fil sélectionné est transmis à Mistral. Le classement WhatsApp reste local.

## Envoi

**Envoyer** ouvre l’aperçu exact du compte, du destinataire et du corps. Aucun objet email n’est envoyé sur WhatsApp. La destination vient de la discussion stockée, jamais d’un texte fourni par l’IA ou le navigateur. Une modification du corps exige un nouvel aperçu.

L’autorisation est liée au compte, à sa génération de liaison, à la discussion et au texte ; elle expire après dix minutes et n’est utilisable qu’une fois. En cas de résultat d’envoi incertain, vérifier la discussion sur le téléphone avant toute nouvelle tentative. L’application ne relance pas automatiquement un envoi.

## Session et déconnexion

Les identifiants de session et clés Signal sont chiffrés individuellement en SQLite avec le coffre local AES-256-GCM. Le QR reste en mémoire pendant la liaison et ne figure pas dans l’état global, les journaux ou les fichiers de configuration. Le journal du transport est muet ; les diagnostics libsignal qui incluent des objets de session sont masqués. Les messages et contacts importés sont conservés dans la base locale comme les emails.

Le redémarrage reprend les sessions déjà appairées. Fermer une fenêtre avant le scan annule la liaison ; la fermer après validation du téléphone ne déconnecte pas le compte. **Relier l’appareil** est proposé si la session doit être renouvelée, avec vérification du même numéro.

**Déconnecter** tente de retirer l’appareil associé, puis efface les clés et les données importées de ce compte dans Relay Desk. Si le retrait distant n’est pas confirmé, retirer aussi l’appareil dans WhatsApp sur le téléphone. Les conversations du téléphone ne sont pas supprimées. Les dossiers locaux restent disponibles.

## Vérification

Les tests utilisent des sockets fictifs : authentification, chiffrement, import filtré, politiques éphémères, reconnexion, isolation des profils, brouillons, aperçu exact et usage unique. Aucun compte réel n’est nécessaire pour ces tests. Une véritable connexion doit être vérifiée avec le scan du propriétaire ; aucun message de test réel n’est envoyé sans validation distincte.
