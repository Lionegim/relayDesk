# WhatsApp

> **Connecteur non officiel.** Relay relie WhatsApp comme un appareil connecté (WhatsApp > Appareils connectés > Connecter un appareil), au moyen de la bibliothèque communautaire [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys` 7.0.0-rc14, version exacte). Baileys n'est ni fourni ni soutenu par WhatsApp ou Meta. Son usage peut être contraire aux conditions d'utilisation de WhatsApp, et WhatsApp peut restreindre ou bannir un numéro utilisé ainsi. Le protocole peut changer sans préavis et interrompre le connecteur. Pour un usage professionnel à volume, la voie officielle reste la WhatsApp Business Platform (API Cloud), qui ne donne pas accès aux conversations personnelles existantes.
>
> D'autres applications (par exemple Dex) proposent aussi une liaison par QR depuis Appareils connectés. Nous ne connaissons pas leur implémentation : rien ici ne décrit leur fonctionnement.

## Ce que fait la V1

- Liaison locale par QR, affiché seulement dans la fenêtre de liaison ouverte par l'utilisateur.
- Import du **texte** des **conversations directes** des 7 derniers jours (1 à 30 configurable), puis des nouveaux messages tant que la session est ouverte.
- Ignorés : groupes, statuts, diffusions, chaînes, messages éphémères (et discussions en mode éphémère), messages à vue unique, réactions, messages système. Les médias ne sont pas téléchargés ; seule leur légende est importée.
- Contacts : nom (carnet du téléphone, nom public ou numéro), numéro et date de dernière interaction, rattachés au compte et supprimés avec lui.
- Une ligne de la boîte par discussion. Lu, drapeau, archive et dossiers sont **locaux** : rien n'est modifié sur le téléphone.
- Brouillons **locaux** seulement (WhatsApp n'a pas de brouillon partagé).
- Réponse texte dans la discussion, uniquement après l'aperçu exact et sa confirmation. Pas de nouveau message, de réponse à tous ni de transfert.
- Assistant IA commun (`docs/ia.md`) : résumé, classement et proposition de réponse comme pour le courrier, toujours sans envoi automatique.

Permissions : `read`, `drafts` (locaux), `send`.

## Contrat (`src/providers/whatsapp/index.js`)

```js
const wa = await createWhatsAppProvider({ store, vault }); // options de test : makeSocket, lib, log, timing
wa.configured                                   // true
await wa.startLink({ profileId, name, windowDays = 7, accountId? }) // → { linkId, accountId }
wa.linkStatus(linkId)  // → { status, accountId, qrDataUrl?, error?, threads?, messages? }
wa.cancelLink(linkId)  // → { cancelled: boolean, status? }
wa.sync.permissions(accountId)   // ['read', 'drafts', 'send'] si une session est enregistrée, sinon []
wa.sync.progress(accountId)      // { status, total, done, error, threads, messages, todo } ou null
await wa.sync.syncNow(accountId) // reconstruit les fils locaux, relance une session tombée ; → progress
wa.sync.updateMessage(id, patch) // local : unread, flagged, archived, folderId ; → message
wa.sync.generation(accountId)
await wa.sync.start()            // au démarrage : reprend seulement les sessions enregistrées
wa.sync.stop()
await wa.outbox.saveDraft(id, { text, mode: 'reply' })  // → brouillon local, synced: false
await wa.outbox.preview(id, { text, mode: 'reply' })    // → { channel: 'whatsapp', from, to: [nom (numéro)], cc: [], subject, body, digest }
await wa.outbox.send(id, { text, mode: 'reply', digest }) // → { sent: true, draftRemoved: true }
await wa.disconnect(accountId)   // → { disconnected: true, revoked: boolean }
```

`subject` de l'aperçu est interne (`WhatsApp · Nom`) et n'est pas affiché. Tout autre mode que `reply` est refusé (400).

### Statuts de liaison

| `status` | Sens |
| --- | --- |
| `starting` | socket en cours d'ouverture |
| `qr` | `qrDataUrl` (PNG en data URL, en mémoire) à scanner ; renouvelé par WhatsApp, masqué après 60 s sans renouvellement |
| `syncing` | téléphone validé et identité vérifiée (ou en cours) ; import en cours ; `threads` et `messages` comptent les fils importés |
| `connected` | import initial terminé (fin d’historique signalée, ou 8 s après la connexion) |
| `error` | `error` explique : annulée, QR expiré, délai de 5 min dépassé, liaison refusée, numéro différent, numéro déjà relié |

Une liaison terminée reste consultable 10 minutes, puis `linkStatus` répond 404.

### Liaison et reconnexion

- Sans `accountId`, un compte provisoire est créé (statut « En attente du QR »). Il est supprimé si la liaison est annulée ou échoue avant validation. Si un compte WhatsApp déjà relié porte ce nom dans le profil : 409 `whatsapp_exists` (reconnexion explicite attendue).
- Avec `accountId` : le compte doit être WhatsApp, du même profil et du même nom (sinon 400). Un compte connecté renvoie 409 `whatsapp_connected`. L'ancienne session est effacée avant le nouveau QR.
- Une seule liaison en cours par compte (409 `link_in_progress`). Identifiants de liaison : UUID v4 aléatoires.
- `cancelLink` n'annule qu'un QR non validé. Dès que le téléphone a validé, fermer la fenêtre n'a aucun effet : seule `disconnect(accountId)` retire le compte.

### Identité

À chaque ouverture de session, le numéro du téléphone (JID de l'appareil) est comparé au compte :

- compte sans numéro : le numéro est enregistré (`address`, format `+33…`) ;
- numéro différent : refus, l'appareil qui vient d'être lié est retiré du téléphone (au mieux), rien n'est importé, le compte garde son numéro et ses données ;
- numéro déjà relié à un autre compte WhatsApp du même profil : refus (le compte provisoire est retiré).

### Redémarrage

`await wa.sync.start()` ouvre une session seulement pour les comptes dont la session enregistrée est appairée. Aucun QR ni connexion pour un compte jamais relié (statut « À reconnecter »). Si WhatsApp redemande un QR pour une session enregistrée, ce QR n'est jamais affiché : la session est effacée et le compte passe « À reconnecter ». Coupure réseau : nouvelles tentatives automatiques (5 s, doublées jusqu'à 5 min). Appareil retiré depuis le téléphone : session effacée, « À reconnecter ».

## Secrets

- L'état d'authentification Baileys (identifiants de session et chaque clé Signal) est stocké dans SQLite (`whatsapp_auth`), chiffré par le coffre (AES-256-GCM, AAD du compte). Chaque valeur porte son type et son identifiant, vérifiés à la lecture. Pas de `useMultiFileAuthState` ni de fichier en clair.
- Les clés renouvelées par le protocole remplacent les anciennes ; une session fermée n'écrit plus rien.
- Le QR n'existe qu'en mémoire, dans la liaison en cours : jamais en base, dans l'état de l'application ni dans les journaux. Le journal Baileys est muet ; les messages d'erreur de Relay ne contiennent ni contenu ni numéro de contact.

## Envoi

1. `preview` vérifie la permission, le texte (non vide, 4 096 caractères au plus) et renvoie l'aperçu exact et une empreinte SHA-256 liée au compte, à sa génération, au JID de la discussion et au texte.
2. `send` recalcule l'empreinte et exige la validation correspondante (usage unique, 10 minutes). Le destinataire est **toujours** le JID enregistré de la discussion : aucun champ de la requête ni proposition de l'assistant ne peut le changer.
3. Compte hors ligne : 409 `whatsapp_offline`, rien n'est tenté et la validation reste utilisable.
4. La validation est consommée avant l'envoi. Échec pendant l'envoi : 502 `send_uncertain`, aucun nouvel essai automatique ; l'utilisateur vérifie sur le téléphone puis refait un aperçu.
5. Succès : le message est ajouté à la discussion, le brouillon local effacé, toutes les validations du message purgées.

## Déconnexion

`disconnect(accountId)` invalide la génération du compte et ses validations, retire l'appareil lié si la session est ouverte (`revoked: true`), puis efface session, messages importés, contacts et compte. Sans session ouverte, `revoked` vaut `false` : retirer « Relay Desk » dans WhatsApp > Appareils connectés.

## Limites connues

- Un même contact peut apparaître sous un identifiant de numéro et sous un identifiant masqué (`@lid`) : deux discussions distinctes en V1.
- L'import initial dépend de ce que le téléphone transmet à un nouvel appareil ; il n'y a pas de relevé à la demande.
- Messages modifiés ou supprimés sur le téléphone : non répercutés.
- Bornes : 500 discussions par compte, 200 messages par discussion, 8 000 caractères par message importé.

## Tests

`test/whatsapp.test.js` utilise un faux socket (`test/whatsapp-helpers.js`) : aucune connexion à WhatsApp, aucun QR réel, aucun message envoyé.
