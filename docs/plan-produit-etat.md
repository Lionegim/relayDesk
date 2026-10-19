# Relay Desk — état du plan et suite

Mise à jour : 19 octobre 2026. Ce suivi réconcilie le plan d’implémentation initial et `docs/architecture-docker-mobile.md` avec le code et les vérifications d’exploitation. Les anciens documents de lancement décrivent un état historique ; ils ne doivent pas être interprétés comme l’état courant du produit.

## Décisions courantes

- Une application personnelle pour un propriétaire unique, hébergée chez OVH en France sur relay.noegim.com ; budget approuvé : 100 €/mois.
- Application web utilisable sur ordinateur et mobile, Docker Compose, un runtime Node 24 et SQLite persistante. Keycloak et MFA protègent l’accès.
- Le propriétaire peut choisir une vue d’origine ou **Tous les profils**. Les sources Anove, Personnel et autres restent identifiables ; les comptes ne sont pas déplacés.
- Contacts et liens sont persistants, sauvegardés et réversibles. Les suggestions ne fusionnent jamais automatiquement.
- IA Mistral à la demande ; contexte du compte/conversation d’origine. Aucun envoi autonome : aperçu exact, validation explicite, usage unique et absence de relance aveugle après résultat incertain.

## Plan initial : ce qui est réellement livré

| Chantier | État et preuve disponible |
|---|---|
| Fondations et persistance | Livré : migrations, SQLite, cycle de vie, verrou d’instance, brouillons et états persistants ; tests de redémarrage. |
| Gmail | Connecté en hébergement : lecture, classement, brouillons et envoi validé. Notifications fournisseur et actualisation du navigateur vérifiées. |
| Outlook / Microsoft 365 | Connecté en hébergement : lecture, classement, brouillons et envoi validé ; notifications Graph et actualisation du navigateur vérifiées. |
| Proton / Bridge | Non implémenté. Le choix de Keycloak concerne l’identité de connexion, pas une connexion à la messagerie Proton. |
| WhatsApp | Liaison QR réelle et synchronisation serveur ; discussions individuelles, groupes en texte/IA, réponses individuelles après aperçu. Médias, vue unique et messages éphémères exclus ; envoi aux groupes non activé. |
| Instagram | Marque intégrée, canal encore en démonstration. Le compte Business anove.ai a été indiqué mais sa connexion réelle a été suspendue au profit du travail sur contacts/historique. |
| LinkedIn | Marque intégrée, connexion désactivée faute d’adaptateur/d’accès démontré. |
| IA et mémoire | Résumé, classement proposé et réponse suggérée ; mémoire de style persistante par contexte, toujours sous validation humaine. L’import exhaustif de mémoire ancienne depuis le Mac n’est pas confirmé. |
| Contacts et doublons | Import Google/Outlook réel ; identités multiples, rapprochements explicites, recherche de doublons en arrière-plan, décisions écartées et annulation. |
| Vue unifiée / audit | Ajout courant : messages et personnes de tous les profils, liens explicites entre sources, historique durable et reprise des anciennes fusions. |
| MCP par compte | Non livré. L’usage de l’interface web et de ses fonctions IA ne constitue pas un serveur MCP par compte. |
| File générique de tâches durables | Non généralisée. Les mécanismes de synchronisation et les garde-fous d’envoi existent ; cela ne valide pas toutes les ambitions de la file générique du plan initial. |
| Pièces jointes / médias / HTML | Non pris en charge dans le parcours actuel ; chantier distinct. |

## Plan Docker/mobile : état des lots

| Lot | État |
|---|---|
| 1 Configuration/cycle de vie | Livré et testé. |
| 2 Docker/stockage | Livré et déployé. |
| 3 Authentification propriétaire | Keycloak, MFA, sessions et protections de mutations actifs. |
| 4 OAuth hébergé | Clients Google et Microsoft configurés, comptes réels reliés. |
| 5 Mobile | Interface responsive/PWA réalisée ; recette antérieure Device Hub avec données fictives. Chaque nouvelle évolution garde ses propres tests UI. |
| 6 Exploitation | HTTPS, sauvegardes chiffrées et copies Mac vérifiées ; distribution automatique hors serveur restant à compléter. |
| 7 Bascule réelle | Connexions hébergées et recette d’arrivées réelles faites. Aucune affirmation de migration exhaustive de l’ancien Mac : historique limité, ancienne mémoire/brouillons à vérifier séparément. |

## Prochains lots proposés

1. **Historique progressif et qualité des personnes.** Import complet Gmail/Outlook implémenté : tâche persistante par compte, progression, pause/reprise, déduplication et reprise après erreur ; voir `docs/import-historique-mail.md`. Imports hébergés démarrés : Gmail et Outlook terminés : 2 734 et 26 932 conversations traitées, avec vérifications de doublons à zéro. Les timelines et suggestions exploitent désormais les échanges importés par identité confirmée ; voir `docs/historique-personnes-ia.md`. Le périmètre WhatsApp reste celui disponible auprès du téléphone. Utiliser ensuite cet historique dans les timelines et la mémoire, sans analyser automatiquement tout le passé avec Mistral.
2. **Sauvegarde hors serveur automatique et recette de récupération.** Mettre en place une destination indépendante, vérifier la livraison quotidienne et tester la restauration du schéma courant avec liens, audit, brouillons et mémoire. L’envoi et les connecteurs restent arrêtés pendant la recette.
3. **Pièces jointes et médias utiles**, puis **Instagram Business** lorsque ses accès sont prêts. Définir d’abord les capacités réelles et conserver la validation exacte de chaque envoi.
4. **MCP par compte / Proton / LinkedIn**, selon leur utilité et les accès disponibles. Aucun de ces services ne doit être annoncé comme connecté avant une recette réelle.

Ces lots sont un ordre de suite, pas des travaux déclenchés par cette mise à jour du plan. Le périmètre actuel reste la vue unifiée, la conservation des rapprochements et le bilan du plan.
