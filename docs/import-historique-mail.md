# Historique Gmail et Outlook en arrière-plan

Les comptes connectés peuvent importer toutes les dates, sans limite de 1 000 conversations, depuis le menu du compte : **Importer tout l’historique**. La carte dans Messages affiche les conversations traitées et la découverte en cours ; une fois l’énumération finie, elle affiche le total exact et une barre de progression. La fermeture du navigateur ne coupe pas l’import. Pause et reprise restent disponibles.

## Données et périmètre

- Gmail : toutes les pages de `threads.list`, sans filtre de date. Messages reçus, envoyés, archivés et libellés. Les brouillons seuls, la corbeille et les indésirables gardent l’exclusion existante.
- Outlook : toutes les pages delta, sans filtre de date, dans les dossiers de la boîte et leurs sous-dossiers. Messages reçus, envoyés et archivés. Les dossiers supprimés/indésirables sont suivis pour réconcilier les suppressions ; leurs messages ne sont pas affichés. Brouillons et boîte d’envoi exclus.
- Texte affichable et historique de conversation selon le parseur existant ; pas de téléchargement des pièces jointes. Les archives hors de la boîte accessible à l’API (par exemple une archive en ligne Exchange distincte) ne sont pas une promesse de couverture.
- Aucun appel Mistral ni envoi déclenché par cet import. Les brouillons locaux sont conservés ; la validation de l’aperçu exact avant chaque envoi est inchangée.

## Reprise, suivi en direct et doublons

Schéma 17 : `mail_history_imports` conserve le compte, son identité, une génération de tâche, le curseur privé, les compteurs et la reprise après erreur. `mail_history_items` conserve les identifiants de conversation avec une clé unique `(account_id,external_id)`. Chaque page et chaque lot sont validés dans une transaction. Les écritures de conversations réutilisent la clé unique fournisseur existante : un rejeu réécrit la même ligne et conserve le brouillon.

Le worker lit une page ou traite cinq conversations par compte, puis rend la file au suivi en direct et aux actions utilisateur. L’import et les mutations utilisent la même file du compte ; les générations du compte et de la tâche empêchent une réponse ancienne de réécrire après une déconnexion ou une réinitialisation. La pause est contrôlée après les lectures réseau. Les tâches reprennent automatiquement au redémarrage. Les erreurs temporaires ont un délai exponentiel ; une permission révoquée demande une reconnexion.

Gmail conserve son curseur temps réel indépendant. Outlook construit des curseurs delta complets, conserve les correspondances nécessaires aux suppressions et les adopte en fin de découverte. Les changements simultanés peuvent être rejoués sans doublon. Les dossiers profonds restent suivis. Un curseur expiré ou un dossier supprimé relance une lecture complète avec une nouvelle génération de tâche. Si le suivi en direct doit être réinitialisé, l’archive est réconciliée aussi ; une pause demandée reste respectée.

Les états publics contiennent seulement la progression, jamais les curseurs, secrets ou identifiants de tâche. L’accès aux contrôles garde l’authentification propriétaire et la protection CSRF existantes. Les progrès passent par les notifications SSE existantes, sans rafraîchissement manuel. Pendant l’import, les écrans regroupent les invalidations pendant cinq secondes pour rester sous la limite de requêtes partagée entre appareils/onglets. Le serveur regroupe aussi les notifications pendant l’import pour protéger les écrans restés ouverts sur une ancienne version ; ils reprennent la cadence habituelle ensuite.

## Validation

Tests synthétiques : plus de 1 000 conversations Gmail, reprise sur disque, absence de doublons, conservation des brouillons, pause pendant une réponse réseau, erreurs 429, changement d’identité, suppression du compte, expiration de curseur, refus des résultats d’une ancienne génération, ancien courrier Outlook, suivi de dossiers profonds et suppressions, contrôles HTTP et confidentialité des états publics. Aucun message réel envoyé.

Références API : [Gmail threads.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list), [Graph messages delta](https://learn.microsoft.com/en-us/graph/api/message-delta), [Graph list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages).
