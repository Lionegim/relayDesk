# Mémoire locale du style de réponse

Relay Desk apprend la manière de répondre du propriétaire **séparément pour chaque compte et chaque conversation**. Cette mémoire est utilisée uniquement pour proposer une réponse : le ton et l’intention choisis restent prioritaires. La réponse suit la langue habituelle du fil lorsqu’elle est identifiable, sauf indication explicite contraire. Aucun apprentissage ne déclenche un appel IA ni un envoi de message.

## Utilisation

Dans une conversation Gmail, Outlook ou WhatsApp, ouvrir **Aider à rédiger → Répondre**. L’encart **Ton style, ici** indique le nombre d’exemples, les tendances observées et quelques extraits consultables. Avec moins de trois exemples, l’interface indique que le style reste à affiner. Sans exemple, la rédaction reste possible avec le contexte du fil et le ton choisi.

- **Mettre en pause** arrête l’apprentissage et l’utilisation de cette mémoire, en conservant les exemples locaux.
- **Réactiver** reprend l’apprentissage sur les prochains envois ; les messages échangés pendant la pause ne sont pas réappris.
- **Réinitialiser**, puis **Effacer la mémoire**, retire les exemples. Les messages d’origine restent disponibles. La mémoire repart des prochains envois ; une resynchronisation ne fait pas revenir les anciens exemples.

La mémoire est un petit carnet d’exemples et de tendances, pas un entraînement du modèle Mistral. Elle ne mémorise pas de faits sur les interlocuteurs, ni de consignes à exécuter.

## Origine des exemples

- WhatsApp : textes importés ou envoyés avec la direction `fromMe` fournie par le protocole. Un correspondant nommé « Moi » n’est jamais identifié comme le propriétaire sur son seul nom. Les groupes utilisent uniquement les messages du propriétaire.
- Gmail : messages importés portant `SENT` et une adresse `From` égale à l’adresse du compte connecté ; brouillons, spam et corbeille exclus. Les alias non vérifiés sont ignorés.
- Outlook : messages importés depuis le dossier Éléments envoyés, avec `from` et `sender` égaux à l’adresse du compte connecté, hors brouillons et dossiers exclus. Les délégations et les messages reçus usurpant le nom du propriétaire sont ignorés.
- Gmail et Outlook : une réponse envoyée depuis Relay est ajoutée seulement après le succès confirmé par le fournisseur. L’aperçu, le brouillon et l’issue d’envoi incertaine ne créent pas d’exemple. Les nouvelles compositions seront apprises lors de leur import dans un fil fournisseur ; le transfert n’est pas appris directement depuis son fil d’origine.

Les anciennes lignes email importées avant cette fonctionnalité ne permettent pas de vérifier la provenance de tous leurs auteurs : elles ne sont pas devinées à partir du libellé « Moi ». Leur mémoire s’enrichira lors des prochains imports vérifiables et envois. Les textes WhatsApp disponibles sur ce Mac sont repris localement au démarrage et à la lecture de la mémoire.

Les citations, blocs transférés et signatures standards reconnus sont retirés avant stockage. Les empreintes des propositions IA récentes sont conservées sans leur texte : un exemple identique à une proposition connue est ignoré pour limiter le réapprentissage du style du modèle. Ce filtre exact ne permet pas de reconnaître tous les textes assistés par IA ou modifiés dans une autre application.

## Conservation et confidentialité

SQLite conserve au plus **24 extraits distincts de 1 200 caractères par conversation**, pendant **180 jours**. Les tendances (longueur, tu/vous, salutations, emojis et retours à la ligne) sont calculées localement. La déduplication du texte évite de compter deux fois un envoi et son réimport ; ce sont des exemples de style distincts, pas une mesure de fréquence de tous les envois.

Cette copie de quelques réponses peut durer plus longtemps que la fenêtre d’historique WhatsApp de sept jours. La mémoire disparaît avec le compte. Le passage d’une discussion WhatsApp en mode éphémère purge aussi sa mémoire. Les profils et les comptes ne partagent aucun exemple, même si le correspondant porte le même nom. Les variantes de JID PN/LID ne sont pas fusionnées automatiquement.

Le nettoyage des extraits expirés se fait au démarrage, toutes les heures et à la lecture de la conversation. La mémoire, comme les messages importés, reste dans la base locale ; elle n’est pas une sauvegarde distante ni un coffre de secrets.

**Lorsque l’utilisateur demande une proposition**, le fil et jusqu’à **cinq extraits de 400 caractères de cette seule conversation** sont transmis à Mistral. Les exemples sont des données non fiables dans la même délimitation aléatoire que le fil. Le prompt demande de reproduire le style sans reprendre les faits, dates, engagements ou destinataires des anciens textes. Aucun extrait n’est ajouté aux demandes Résumer ou Classer. Aucun contenu réel n’est partagé avec Claude pour développer ou tester la fonctionnalité.

Une révision aléatoire de la mémoire participe à l’empreinte de la génération : effacement, pause, nouvel exemple ou remplacement du compte invalident une proposition encore en cours. L’aperçu exact et la validation à usage unique avant envoi sont conservés.

## Vérification

Les tests utilisent SQLite en mémoire, de faux fournisseurs et un faux modèle : provenance, isolation, bornes, nettoyage des citations, absence d’apprentissage sur erreur, réinitialisation durable, confidentialité des groupes, révisions stables après réimportation et invalidation des réponses tardives. Aucun test automatisé n’envoie de message réel.
