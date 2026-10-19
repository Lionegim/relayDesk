# Historique des personnes et suggestions de réponse

L’historique Gmail/Outlook importé alimente les identités structurées des conversations à chaque écriture. Les fiches de personnes utilisent ces liens pour retrouver les échanges anciens et nouveaux, avec pagination et déduplication des conversations qui correspondent à plusieurs emails ou téléphones liés.

## Fiches de personnes

Le parcours Contacts → fiche affiche le nombre total de conversations et messages, la première date connue, la répartition par canal, puis les échanges datés avec leur compte source. La première page d’une fiche ouverte se met à jour pendant l’import. La lecture des pages plus anciennes reste préservée. Les liaisons et fusions explicites restent durables et réversibles.

Le calcul utilise une union des index d’identités et des clés fournisseur. Il ne parcourt plus tous les corps de message pour construire une fiche. Les identifiants partagés et les adresses/numéros des comptes du propriétaire n’associent pas tous les messages à une personne par erreur. Les noms et signatures ne créent jamais une identité implicite.

## Réponses IA

Une demande de suggestion peut compléter le fil actuel avec au plus six autres conversations pertinentes/récentes de cette personne dans **le profil d’envoi**. Les fiches unifiées restent disponibles ; elles n’élargissent pas automatiquement le contexte IA entre Personnel et Anove. Le contexte est daté, partiel et borné à 12 000 caractères d’extraits. Le modèle reçoit les avertissements qu’un ancien fait ou engagement n’est pas une situation actuelle et que le fil courant et l’intention explicite priment.

L’identité doit être unique. Un groupe WhatsApp, une adresse partagée, un correspondant inconnu ou un fil avec d’autres participants non résolus n’obtient pas d’historique privé supplémentaire. Les correspondances reposent exclusivement sur les participants structurés et les liens confirmés. Aucun contact n’est fusionné automatiquement.

Pour le style, les exemples de la conversation actuelle priment. S’ils sont insuffisants, les exemples déjà appris des messages **envoyés par le propriétaire**, avec cette personne dans le même profil et canal, complètent la sélection jusqu’à cinq exemples. Les textes reçus et les brouillons ne servent pas d’exemples de style. La rétention de 180 jours, les exclusions de suggestions IA, les pauses et les dates de réinitialisation restent respectées. Les extraits historiques sont filtrés individuellement après une réinitialisation, y compris lorsqu’un ancien fil reçoit une nouvelle réponse. Les textes sans date fiable ne sont pas réintroduits après une réinitialisation.

La pause mémoire de la conversation désactive également le contexte supplémentaire pour sa suggestion. Les conversations sources en pause ou exclues par leur date de réinitialisation ne contribuent pas. Les données anciennes restent dans les timelines ; il s’agit de contrôles de leur utilisation par l’assistant.

La suggestion affiche les sujets, comptes et dates des conversations utilisées. Les sources sont des données non fiables dans un bloc délimité, jamais des instructions. Si le contexte retenu change pendant la génération, la réponse tardive est refusée plutôt qu’appliquée à un ancien état.

## Appels et envois

L’import et l’enrichissement des timelines restent locaux à Relay Desk. **Aucune analyse en masse de l’archive par Mistral.** Les extraits sélectionnés ne sont transmis à Mistral que lors d’une demande de suggestion. La proposition n’enregistre ni n’envoie un brouillon automatiquement. Chaque envoi Gmail, Outlook ou WhatsApp conserve l’approbation de l’aperçu exact et son autorisation liée à la session.

Validation : tests synthétiques de pagination et compteurs, déduplication, contexte ancien pertinent, exemples de style envoyés, absence d’effet sur les brouillons, participants ambigus/groupes, isolation du profil d’envoi, pause/réinitialisation par composant, bornes et délimitation du prompt, rejet d’une réponse périmée et priorité du style de la conversation.
