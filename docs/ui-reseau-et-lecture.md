# Lecture, dossiers et réseau — 19 octobre 2026

## Références observées

Apple Mail : favoris distincts des comptes, « All Inboxes » dépliable par compte, triangles de sous-dossiers, compteurs non lus. Dans le compte professionnel, Projects contient plusieurs enfants ; « LoadMaster / RST » est un seul nom de dossier, son slash ne doit pas devenir un niveau artificiel.

Dex : Network présente les groupes, une liste de contacts non groupés et une commande de création. La fenêtre de création demande un nom et une description et propose un parent. Relay Desk reprend le regroupement manuel durable et la sélection des membres ; le premier lot ne comprend pas de sous-groupes ni de déplacement libre des nœuds.

Claude Desktop a été consulté dans « Relay Desk unified messaging interface design » uniquement avec le brief produit, sans messages ni carnet privé. Principes retenus : papier/encre/vert profond, cercles d’activité absolus, légende explicite et liste complète accessible sur mobile. La fréquence n’est pas une mesure d’importance relationnelle.

## Dossiers

Les dossiers importés apparaissent sous leur compte, y compris dans la vue unifiée. Gmail utilise la hiérarchie des libellés existants ; Outlook utilise les vrais identifiants parents. Les noms contenant un slash sont préservés chez Outlook. Les dossiers locaux et leurs enfants restent ensemble, même si un enfant est lié à un fournisseur. Les dossiers vides et renommages se synchronisent avec les métadonnées sans attendre un nouveau message. Les états dépliés sont des préférences locales sans contenu de message.

Les badges comptent les conversations non lues, sous-dossiers compris. L’ouverture d’un dossier Gmail retrouve aussi les conversations portant ce libellé hors boîte de réception. Le menu global existant et le mécanisme d’archivage restent inchangés ; ceci n’est pas une reproduction exhaustive de toutes les boîtes système Apple Mail.

## Lecture des emails

La mise en forme est récupérée à l’ouverture d’une conversation, pour l’historique déjà importé comme pour les nouveaux messages. Elle est mise en cache sur le serveur par révision de contenu. Le dernier message et les anciens développés gardent paragraphes, titres, listes, tableaux et liens. La version texte reste disponible. Les contenus du dernier message et de son en-tête sont vérifiés ensemble ; une réponse fournisseur plus récente ne remplace pas silencieusement le corps sous un ancien expéditeur.

Le serveur utilise sanitize-html avec une liste d’éléments et attributs autorisés. Aucun script, style source, événement, formulaire, identifiant DOM ou image distante n’est inséré. Les liens http/https/mailto exigent un clic et ouvrent une autre page avec noopener/noreferrer. La lecture et l’IA conservent des représentations séparées : le HTML n’entre pas dans les instructions IA ni dans les champs des brouillons.

Références techniques : [OWASP XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html), [sanitize-html officiel](https://github.com/apostrophecms/sanitize-html). Le choix est une mise en forme sémantique nettoyée, et non la reproduction des styles marketing de l’expéditeur. Les images intégrées et pièces jointes ne sont pas ajoutées dans ce lot.

## Réseau et groupes

Contacts offre Réseau et Liste. Le propriétaire est au centre ; les contacts actifs se répartissent sur trois anneaux selon les messages datés des 30, 90 ou 365 derniers jours. Chaque message perd la moitié de son poids après un tiers de la période ; seuils absolus 12 et 3. Les messages sans date fiable, identifiants ambigus et groupes WhatsApp sont exclus. Les conversations directes WhatsApp classiques et LID sont prises en compte. Le graphe est limité pour rester lisible ; la liste contient tous les contacts, même inactifs.

Ce score compte les messages associés, y compris des emails reçus seuls ou collectifs, sans prétendre mesurer des échanges réciproques. L’historique disponible et les rapprochements explicites conditionnent le résultat. Aucun classement émotionnel n’est inféré.

Les groupes manuels sont stockés dans Relay Desk par portée (Tous les profils, Personnel, Anove). Créer/Gérer un groupe permet de rechercher puis cocher ses membres ; chaque fiche propose aussi des boutons d’appartenance. Les liens pointent sur les fiches sources pour conserver les appartenances après réimport, liaison, annulation et redémarrage. Les carnets Google/Outlook ne sont pas modifiés. Le nom est modifiable. Les sous-groupes et la suppression de groupe sont hors de ce premier lot.

## Validation

Tests : nettoyage HTML, absence de suivi/événements/scripts, cache lié au contenu, refus d’un nouveau corps Gmail sous un ancien en-tête, compatibilité des anciens imports Outlook texte, conservation des brouillons, dates réelles, LID/direct versus groupe, portées, persistance des groupes avec fusion/annulation, parents réels et slash littéral, dossier Gmail archivé et compteurs non lus, dossiers vides et renommages sans nouveau message. Les tests existants d’envoi et d’approbation de l’aperçu exact restent exécutés.

Vérifications Chrome avec données fictives : email avec tableau/liste/lien, carte, création du groupe Atelier design et ajout d’Alex Morgan, liste mobile par défaut et carte allégée, absence de débordement horizontal à 390 px. Aucun message envoyé et aucune analyse de messages privés transmise à Claude.
