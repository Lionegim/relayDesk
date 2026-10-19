# WhatsApp sur ce Mac

Relay Desk propose une liaison par QR code dans **WhatsApp → Réglages → Appareils connectés**. C’est le même parcours utilisateur que la [liaison Dex](https://getdex.com/docs/integrationsandfeatures/syncfeatures/sync-whatsapp), dont la documentation décrit les contacts et les dernières interactions. Nous ne connaissons pas l’implémentation interne de Dex.

Le connecteur de Relay Desk utilise [Baileys](https://github.com/WhiskeySockets/Baileys), une bibliothèque communautaire non officielle, sans affiliation à WhatsApp/Meta. Elle peut cesser de fonctionner ou l’accès peut être limité par WhatsApp. Cette première version ne remplace pas la plateforme officielle WhatsApp Business.

## Connecter

1. Installer les dépendances avec `npm ci --ignore-scripts`, puis lancer `npm start`.
2. Dans Relay Desk, **Ajouter un canal → WhatsApp**, choisir le profil et le nom du compte.
3. Lire les accès et limites, puis **Afficher le QR code**.
4. Dans WhatsApp sur le téléphone, **Réglages → Appareils connectés → Connecter un appareil**, puis scanner le QR en direct sur le Mac. Il se renouvelle et expire : ne pas utiliser une ancienne capture.
5. La liaison vérifie l’identité du téléphone, puis ouvre la boîte du profil choisi. L’historique arrive par lots après l’ouverture. Le compte connecté ne signifie pas que l’import est terminé. Sa disponibilité dépend du téléphone et de WhatsApp ; l’interface affiche les conversations et messages effectivement importés.

Le QR crée un accès en lecture et envoi pour ce Mac. Les réponses IA exigent l’aperçu exact et sa confirmation à usage unique ; les réponses manuelles demandent un clic explicite sur Envoyer. Il n’y a ni envoi automatique par l’IA, ni synchronisation du courrier vers Dex ou un agrégateur tiers.

## Portée de cette version

- Conversations individuelles et groupes en texte sur les sept derniers jours disponibles, puis réception des nouveaux messages. L’ordre et la quantité de l’historique reçu dépendent de WhatsApp.
- Statuts, diffusions, chaînes, médias et légendes exclus. Les messages à vue unique et éphémères ne sont pas conservés ; les politiques de discussion reçues sont mémorisées et les contenus déjà importés sont retirés si la discussion est identifiée comme éphémère.
- La fenêtre de sept jours ne comporte plus de plafond silencieux de 500 discussions ou de 200 messages par discussion. Tous les textes importés de cette fenêtre sont consultables ; le texte importé reste limité à 8 000 caractères par message. Le contexte transmis à l’IA est borné à 24 000 caractères, en conservant les échanges les plus récents.
- Contacts des discussions importées : nom disponible, numéro lorsqu’il est connu et dernière interaction. Les identifiants privés `@lid` ne sont pas affichés comme des numéros de téléphone.
- Lu/non lu, drapeau, archivage, dossiers et brouillons restent **locaux**. Aucun accusé de lecture n’est envoyé par un clic de lecture dans Relay.
- Réponse texte dans une discussion existante, au plus 4 096 caractères. Les groupes proposent aussi les réponses citées, les réactions, les photos et GIF, avec les auteurs fournis par WhatsApp et les noms disponibles dans les contacts du même compte. Pas de nouveau destinataire WhatsApp, réponse à tous ou transfert. **Nouveau message** reste réservé aux comptes email.
- Résumé, classement et proposition de réponse via l’assistant commun. L’IA n’est appelée qu’à la demande de l’utilisateur ; le panneau indique que le fil sélectionné est transmis à Mistral. Le classement WhatsApp reste local.

## Envoi

**Envoyer** ou **Entrée** dans le compositeur envoie le message sans deuxième fenêtre de confirmation, y compris un brouillon issu de l’IA. **Maj+Entrée** ajoute une ligne. Dans les suggestions de mentions, Entrée/Tab choisit le participant ; les flèches parcourent la liste et Échap la ferme. La génération ou l’insertion d’une proposition IA n’envoie rien.

La préparation technique en arrière-plan lie toujours le contenu exact, les mentions, le média, la citation, la version du brouillon et la session à une empreinte à usage unique. Les permissions et la destination stockée restent contrôlées avant envoi ; une modification concurrente invalide la préparation. Aucun objet email n’est envoyé sur WhatsApp. Le même envoi direct au clic ou à Entrée s’applique aux emails Gmail/Outlook.

L’autorisation est liée au compte, à sa génération de liaison, à la discussion et au texte ; elle expire après dix minutes et n’est utilisable qu’une fois. En cas de résultat d’envoi incertain, vérifier la discussion sur le téléphone avant toute nouvelle tentative. L’application ne relance pas automatiquement un envoi.

## Session et déconnexion

Les identifiants de session et clés Signal sont chiffrés individuellement en SQLite avec le coffre local AES-256-GCM. Le QR reste en mémoire pendant la liaison et ne figure pas dans l’état global, les journaux ou les fichiers de configuration. Le journal du transport est muet ; les diagnostics libsignal qui incluent des objets de session sont masqués. Les messages et contacts importés sont conservés dans la base locale comme les emails.

Le redémarrage reprend les sessions déjà appairées. Fermer une fenêtre avant le scan annule la liaison ; la fermer après validation du téléphone ne déconnecte pas le compte. **Relier l’appareil** est proposé si la session doit être renouvelée, avec vérification du même numéro.

**Déconnecter** tente de retirer l’appareil associé, puis efface les clés et les données importées de ce compte dans Relay Desk. Si le retrait distant n’est pas confirmé, retirer aussi l’appareil dans WhatsApp sur le téléphone. Les conversations du téléphone ne sont pas supprimées. Les dossiers locaux restent disponibles.

## Vérification

Les tests utilisent des sockets fictifs : authentification, chiffrement, import filtré, politiques éphémères, reconnexion, isolation des profils, brouillons, aperçu exact et usage unique. Aucun compte réel n’est nécessaire pour ces tests. Une véritable connexion doit être vérifiée avec le scan du propriétaire ; aucun message de test réel n’est envoyé sans validation distincte.

## Récupérer les autres conversations

Dans la boîte WhatsApp du profil concerné, **Actualiser l’historique** demande au téléphone l’historique des sept derniers jours via la session déjà liée. Cette demande technique ne publie aucun message dans les conversations. Garder WhatsApp ouvert et le téléphone connecté facilite la récupération. Les lots d’historique sont fusionnés et dédupliqués ; les filtres de date et de confidentialité restent appliqués avant stockage.

Les compteurs indiquent uniquement ce qui est reçu sur le Mac. Une attente, une erreur ou une réception partielle ne doit pas être présentée comme une synchronisation complète. Si WhatsApp refuse la récupération avec la session existante, la reconnexion éventuelle se fera explicitement par le parcours QR, avec le même compte, sans effacer les conversations du téléphone.

## Relier à nouveau pour l’historique initial

Si le téléphone ne répond pas aux demandes sur une ancienne session, **Relier l’appareil** renouvelle seulement la liaison et conserve le compte, les messages, les brouillons, les dossiers et les drapeaux. Les anciennes validations d’envoi sont invalidées. Le nouveau QR doit être scanné par le titulaire pour le même numéro.

Les nouvelles liaisons utilisent un profil navigateur avec historique étendu, conservé avec les identifiants chiffrés pour les reprises suivantes. WhatsApp peut transmettre des lots plus anciens ; seuls les textes autorisés des sept derniers jours sont enregistrés par Relay. Le nom de l’appareil visible sur le téléphone peut être « Mac OS / Chrome ». L’ouverture de la boîte indique la connexion, pas la fin de l’historique.

## Mémoire du style

L’assistant peut maintenant utiliser une [mémoire locale propre à chaque conversation](reply-memory.md), construite uniquement à partir des textes réellement envoyés par le propriétaire. Elle se consulte, se met en pause et se réinitialise dans **Répondre → Ton style, ici**. Aucun apprentissage ne lance un appel IA ni un envoi automatique.

## Connexion QR directe

Dans le profil de destination, choisir Ajouter un canal → WhatsApp. Relay Desk ouvre directement le QR et les instructions Appareils connectés, sans formulaire de numéro, nom ou permissions. Le compte est identifié par WhatsApp après scan ; un nom libre est choisi automatiquement dans le profil courant pour permettre plusieurs comptes.

En hébergé, une session du propriétaire, l’authentification récente et les protections CSRF restent exigées. Le scan sur le téléphone autorise la liaison. L’identité est vérifiée avant import ; une reconnexion ne peut remplacer le numéro enregistré par un autre. Les sessions anciennes sans identité enregistrée ne reprennent pas automatiquement après redémarrage : une nouvelle liaison QR est nécessaire.

Les réponses et réactions sont disponibles dans les discussions individuelles et de groupe. Les brouillons WhatsApp restent locaux. Les propositions IA exigent l’aperçu exact et sa validation à usage unique ; les messages manuels demandent un clic explicite sur Envoyer. Relier uniquement un compte possédé ou expressément autorisé. Le connecteur est communautaire, non officiel ; l’historique des sept derniers jours disponible depuis le téléphone peut rester partiel. Le site de test conserve ses connecteurs désactivés jusqu’à la bascule réelle autorisée.

### Cohérence des identités de conversation

WhatsApp peut envoyer les réglages d’une conversation sous son identifiant de numéro (PN) et ses messages sous son identifiant de liaison (LID). Relay applique les mises à jour explicites du mode éphémère aux deux identités uniquement si elles sont reliées par les identifiants authentifiés du compte ou une correspondance PN/LID chiffrée et vérifiée dans les deux sens. Aucun destinataire d’envoi n’est réécrit.

Lorsqu’une correspondance devient connue, au redémarrage ou après une mise à jour d’identité, le mode éphémère actif est propagé et les messages déjà importés sont purgés selon la règle existante. Le connecteur ne déduit jamais une désactivation à partir d’une divergence ancienne : elle exige une mise à jour explicite de WhatsApp. Les messages qui portent eux-mêmes une enveloppe éphémère ou vue unique restent exclus même après désactivation du minuteur.

## Photos, GIF et emojis

Les photos JPEG/PNG/WebP/GIF et les animations WhatsApp (`videoMessage.gifPlayback`) sont importées avec leurs légendes dans les discussions individuelles et de groupe. Les médias sont chargés à l’ouverture du fil, jamais dans un répertoire public. Descripteurs, clés de média et octets téléchargés sont chiffrés par le coffre, liés au compte et inclus dans la sauvegarde SQLite chiffrée. Leur suppression suit la fenêtre WhatsApp, la déconnexion et les politiques éphémères. Les enveloppes et attributs directs `viewOnce` restent exclus.

Le compositeur propose les emojis et une photo ou un GIF par envoi (10 Mo maximum). Un GIF est converti localement par FFmpeg en vidéo silencieuse native WhatsApp, avec une limite de 30 secondes; l’aperçu porte les octets convertis exacts. Une pièce jointe en cours de rédaction est temporaire (24 h) et doit être réajoutée après une actualisation; Enregistrer conserve le texte. Aucun moteur de recherche GIF tiers n’est utilisé.

Les messages manuels partent seulement au clic explicite sur Envoyer. Un brouillon assisté par IA conserve son aperçu obligatoire, qui montre aussi la pièce jointe; le ticket lie la conversation, le compte, sa génération, le texte et l’empreinte du média. Aucun échec d’envoi incertain n’est retenté automatiquement.

Le cache réserve au plus 512 Mo de tailles médias (avant surcoût du chiffrement et de SQLite). Les téléchargements sont bornés à 10 Mo, avec au plus trois chargements simultanés; une seule conversion GIF est exécutée à la fois. Les originaux expirés chez WhatsApp affichent une indisponibilité explicite. Les messages dont les métadonnées avaient été ignorées par l’ancienne version texte nécessitent une nouvelle réponse d’historique du téléphone pour récupérer leurs médias; aucune récupération complète du passé n’est promise.

### Récupération d’un historique autrefois limité au texte

Le repli par discussion repart désormais du message connu le plus récent, puis remonte jusqu’à la limite de sept jours. Partir du plus ancien texte excluait les médias entre les textes déjà présents. Les curseurs et la taille des pages sont calculés sur les métadonnées des messages bruts, indépendamment des types importables; les contenus exclus restent exclus. Une page répétée ne relance pas la même demande. Le budget est de 100 pages de 50 messages par discussion; une limite atteinte reste annoncée comme partielle.

Les demandes de protocole au propre téléphone expirent après 15 secondes et ne contactent aucun correspondant. Les lots sans rapport ne suppriment plus le repli après une demande complète sans données. Le suivi expose le nombre de demandes, d’échecs et de pages répétées sans exposer les identifiants de messages.

Les nouvelles liaisons utilisent `Browsers.macOS('Chrome')` avec `syncFullHistory`; WhatsApp rejette actuellement les nouvelles inscriptions DARWIN/Desktop avant émission du QR ([Baileys#2677](https://github.com/WhiskeySockets/Baileys/issues/2677)). Les liaisons existantes conservent leur profil jusqu’à une reliaison explicite. La fenêtre stricte de sept jours est appliquée avant stockage, quel que soit l’historique proposé par le téléphone. Un téléphone qui ne fournit pas d’historique supplémentaire nécessite une nouvelle liaison; aucune fin complète n’est inventée à partir d’une simple absence de nouvelles données.

### Réponses citées et réactions

Dans une discussion individuelle ou de groupe, le bouton « … » de chaque message propose une réponse citée et six réactions rapides. La citation reste enregistrée avec le brouillon ; « × » permet de l’enlever. Les réactions s’ajoutent au message d’origine, se remplacent et se retirent en touchant sa propre réaction. Les mises à jour provenant du téléphone apparaissent sans rechargement, y compris pour les pages d’historique déjà ouvertes.

La citation est résolue uniquement dans la conversation et le compte conservés ; aucun contenu cité externe n’est importé. L’aperçu des réponses IA comprend le message cité et lie sa référence et son contenu à la validation. Un changement de citation ou de connexion impose une nouvelle vérification. Les réactions sont des actions manuelles explicites et ne sont jamais produites automatiquement par l’IA. Les règles de rétention, de messages éphémères et de vue unique restent appliquées. Les références de citation connues sont enrichies au prochain événement/rejeu reçu ; l’historique ancien ne contenant plus ces métadonnées ne peut pas les reconstituer.


Dans les groupes, la citation et la réaction incluent l’identité WhatsApp du participant d’origine ; le navigateur ne peut pas la fournir ni remplacer le groupe destinataire. Si l’auteur d’un ancien message n’est pas connu, Relay refuse de le citer ou d’y réagir plutôt que d’inventer une identité. Le groupe est explicitement nommé dans l’aperçu. Les citations de ses propres messages utilisent l’identité de l’appareil lié. Les restrictions du groupe appliquées par WhatsApp restent en vigueur ; un échec ne déclenche aucun nouvel essai automatique.

### Mentions de participants

Dans un groupe, taper `@` puis un nom ou un numéro ouvre les suggestions des participants actuels. Toucher une personne, ou utiliser les flèches puis Entrée/Tabulation, insère sa mention ; Échap ferme la liste. Le texte utilise l’identifiant natif WhatsApp, avec une pastille nominative pour savoir qui sera notifié. Les messages affichés dans le fil remplacent les identifiants sélectionnés par les noms disponibles.

Les mentions sont enregistrées avec le brouillon. Modifier un identifiant retire sa liaison de notification ; retirer sa pastille enlève la mention. Une proposition IA qui remplace le texte ne récupère jamais silencieusement les anciennes personnes mentionnées : sélectionnez-les dans le nouveau texte. L’aperçu exact affiche les personnes choisies ainsi que le texte natif transmis. Toute modification des mentions invalide l’approbation ; les réponses IA exigent toujours la confirmation de cet aperçu.

Les suggestions proviennent des métadonnées authentifiées du groupe, sans appel IA. Le cache privé est limité à 60 secondes et lié au compte et à l’identité non réutilisable de la conversation. L’appartenance des personnes est recontrôlée auprès de WhatsApp avant aperçu et envoi ; une personne partie du groupe, une connexion changée ou une liste indisponible bloque l’envoi mentionné. Les règles de messages éphémères et vue unique restent appliquées. Les mentions natives des anciens messages sont enrichies à la réception d’un rejeu fiable, uniquement si leur texte conservé correspond encore.

### Photos de profil des personnes et groupes

Les listes et en-têtes des discussions, fiches contacts liées à une source WhatsApp et suggestions de participants affichent la photo accessible à l’appareil lié. Les réglages de confidentialité WhatsApp restent déterminants ; une photo absente ou privée conserve les initiales. Les groupes ont leur propre photo et ne deviennent pas des personnes.

Le navigateur utilise une route privée de Relay Desk, liée à l’identité du compte et de la source. Il ne reçoit aucune URL signée du fournisseur. Les images JPEG/PNG/WebP sont limitées à 1 Mo, téléchargées uniquement depuis les domaines HTTPS WhatsApp sans redirection, avec délais et concurrence bornés. Le cache mémoire privé (16 Mo / 500 entrées maximum) expire après 6 heures, ou 15 minutes pour une photo indisponible, et est vidé à la déconnexion/reconnexion ou au redémarrage. Aucune photo de profil supplémentaire n’est enregistrée dans les sauvegardes. Les participants sont vérifiés dans les métadonnées authentifiées du groupe. Cette lecture n’envoie aucun message ni réaction.
