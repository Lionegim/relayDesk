# Rédaction manuelle et assistant unifié

Décision du propriétaire du 19 octobre 2026 : un message rédigé directement est envoyé au clic explicite sur **Envoyer**, sans seconde fenêtre de confirmation. Le client enregistre le brouillon, obtient le message canonique et son empreinte côté serveur, puis utilise le ticket à usage unique pour cet envoi. Versions du brouillon, compte, destinataires, file du fournisseur et erreurs incertaines restent contrôlés ; aucun envoi hors ligne ni relance automatique.

Les propositions insérées depuis l’assistant conservent l’aperçu exact et sa confirmation distincte. L’indicateur de provenance est durable, reste actif après modification du texte et ne peut pas être effacé en envoyant `aiAssisted:false`. Il est revérifié dans les files Gmail, Outlook et WhatsApp juste avant la tentative d’envoi direct. Les brouillons antérieurs à ce suivi gardent la revue par précaution : leur origine n’est pas établie. Un envoi réussi efface le brouillon et son indicateur.

L’icône IA ouvre le panneau existant sans appel à Mistral. Depuis un fil : Résumer, Classer et Répondre sont dans ce panneau. Depuis Nouveau message : le même panneau propose la rédaction, avec insertion explicite dans le brouillon. Les boutons « Aider à rédiger » et « Améliorer avec l’IA » ne sont plus séparés. Fermer le panneau ou modifier/reprendre la composition invalide les générations antérieures.

Validation : 462 tests, dont envoi manuel, préservation de la revue IA, brouillons repris, files concurrentes des trois fournisseurs et génération tardive. Parcours navigateur avec comptes fictifs uniquement : un envoi simulé manuel au clic ; une proposition IA bloquée sur son aperçu ; panneau mobile 390 × 844 sans débordement. Aucun message réel envoyé pendant cette évolution.
