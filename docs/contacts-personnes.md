# Contacts et échanges par personne

Contacts > Importer des contacts importe les noms, emails, numéros et intitulés professionnels du compte sélectionné, uniquement dans son profil. Google utilise People API (`contacts.readonly`, carnet personnel uniquement) ; Outlook utilise Graph (`Contacts.Read`, carnet par défaut et sous-dossiers, sans annuaire global). Les carnets sources ne sont jamais modifiés. L'import est explicite et relançable, pas une synchronisation continue des carnets.

L'import parcourt toutes les pages avant une transaction ; un refus, une pagination invalide ou un changement de génération du compte abandonne le résultat. Limite : 20 000 fiches par compte. Une nouvelle importation actualise les fiches reconnues sans effacer leurs identifiants manuels ; une fiche absente du fournisseur reste conservée localement. Les jetons restent dans le coffre existant.

Chaque fiche conserve sa provenance. Les noms ne provoquent aucun rapprochement. Les emails sont comparés sans distinction de casse, sans supprimer points ou suffixes +. Les téléphones sans indicatif international restent affichés sans rapprochement. Un identifiant partagé entre plusieurs personnes reste signalé et ne regroupe pas automatiquement leurs échanges. L'interface permet d'ajouter un identifiant, de vérifier puis lier deux fiches, et d'annuler les liaisons dans l'ordre inverse. Les fiches d'origine sont conservées ; les ajouts manuels restent attachés à leur fiche après séparation.

La fiche personne présente les conversations déjà importées correspondant aux participants structurés (expéditeur/destinataires), jamais aux noms, signatures ou contenus. Elle ne charge aucun historique supplémentaire. Les adresses principales des comptes du profil sont exclues des rapprochements. L'association indique une correspondance d'adresse, pas une vérification d'identité de l'expéditeur. Les conversations WhatsApp utilisent uniquement les correspondances de numéro authentifiées ; les exclusions de messages éphémères restent actives.

Personnel et Anove sont isolés dans les imports, recherches, candidats, liaisons et fils d'échanges ; des contrôles en base refusent les liaisons entre profils. Aucun destinataire, compte ou message original n'est réécrit. Ouvrir un échange conserve la conversation d'origine et tous les contrôles d'aperçu exact avant envoi. Aucun envoi automatique n'est ajouté.

Migration 014 : sauvegarder avant déploiement. Un retour à une version qui ne connaît pas ce schéma exige une restauration compatible selon la procédure de récupération ; ne pas simplement relancer l'ancienne image sur la base migrée.

## Recherche de doublons

**Contacts > Doublons à vérifier** compare les fiches dans le profil courant. Un travail en arrière-plan démarre au lancement, réagit aux modifications (temporisation d'une seconde) et vérifie périodiquement les changements. Aucun carnet n'est envoyé à Mistral ou à un autre service.

Les suggestions reposent sur un email identique, un téléphone international identique, ou un nom composé identique après normalisation des accents, de la ponctuation et de l'ordre des mots. Les correspondances d'identifiants passent avant les noms. Les noms génériques ou incomplets (« Contact sans nom », un prénom seul) ne sont pas des indices. Ni l'identifiant partagé ni le nom ne prouve qu'il s'agit de la même personne.

Chaque paire affiche les identités et les comptes sources. **Comparer et fusionner** ouvre une confirmation séparée avec le choix de la fiche principale. Les sources sont conservées et la fusion peut être annulée dans « Fusions récentes ». Aucun bouton ne fusionne toutes les suggestions. **Écarter** mémorise la décision pour la version courante des fiches ; l'onglet « Écartés » permet de la rétablir. Une modification pertinente peut faire réapparaître la paire. Une fusion annulée est écartée pour éviter de la reproposer immédiatement.

La version des deux fiches est vérifiée avant fusion ou décision. Si elles ont changé, la requête est refusée et nécessite une nouvelle analyse/revue. Un scan qui voit ses données changer avant l'enregistrement abandonne ses résultats. Les comparaisons sont indexées par identifiant/nom, limitées à 1 000 paires et ignorent les regroupements de plus de 50 personnes ; l'interface indique ces limites et la liaison manuelle reste disponible. Les résultats et décisions sont persistants (migration 015).

Aucune fusion n'est automatique, ne modifie les carnets fournisseurs, ne change les destinataires des conversations ou n'autorise un envoi. Les contrôles d'aperçu exact restent inchangés. Sauvegarder avant la migration 015 ; une ancienne image exige une base compatible.
