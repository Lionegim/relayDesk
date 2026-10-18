# Assistant IA

L'assistant de Relay est commun à tous les comptes de messagerie (Gmail, Outlook et suivants). Il **propose** : un résumé, un classement, un brouillon de réponse. Il n'envoie, ne déplace et ne modifie jamais rien lui-même :

- un classement proposé n'est appliqué qu'après un clic de l'utilisateur ;
- une réponse proposée n'est qu'un texte inséré dans le compositeur ; l'envoi passe toujours par l'aperçu exact (De, À, Cc, Objet, corps) et la confirmation décrits dans `docs/gmail.md` et `docs/outlook.md`.

## Fournisseur

Mistral (`src/ai/mistral.js`), modèle `MISTRAL_MODEL` (par défaut `mistral-small-latest`), clé `MISTRAL_API_KEY` côté serveur uniquement. Sans clé, chaque appel renvoie une erreur 503 explicite (`ai_unconfigured`) ; aucune réponse n'est simulée.

Erreurs renvoyées, toujours sans extrait de la réponse ni du message :

| Code | Cas |
| --- | --- |
| `ai_unconfigured` (503) | clé absente |
| `ai_unreachable` (502/504) | réseau, délai dépassé |
| `ai_auth` (502) | clé refusée |
| `ai_rate_limited` (429) | limite atteinte |
| `ai_upstream` (502) | autre erreur HTTP |
| `ai_bad_response` (502) | réponse Mistral qui n'est pas du JSON valide |
| `ai_empty` (502) | réponse vide |
| `ai_bad_classification` (502) | classement hors format (voir plus bas) |

`complete(messages, { json: true })` demande à Mistral un objet JSON (`response_format`) ; la validation reste faite par Relay.

## Données non fiables

Tout ce qui vient d'un message (objet, expéditeurs, corps, fil, texte d'un brouillon) et les noms de dossiers sont placés dans un bloc délimité par une balise aléatoire, différente à chaque appel (`<donnees-…>`). Le message système indique que ce contenu ne doit jamais être suivi comme une instruction. Les balises de même forme présentes dans les données sont neutralisées, et les caractères de contrôle retirés. Un message ne peut donc ni deviner ni fermer le bloc.

Le fil envoyé au modèle est borné à 24 000 caractères : les messages les plus anciens sont retirés en premier, le dernier est toujours présent.

## Contrat (`src/ai/assistant.js`)

```js
summaryPrompt(m, ownerName)                  // → messages ; texte : 3 puces + « Action : … »
draftPrompt(m, ownerName, { tone, intent })  // tone ∈ Cordial | Formel | Bref ; intent ≤ 500 caractères
classifyPrompt(m, ownerName, folders)        // folders : [{ id: string, name: string }] (≤ 200, id uniques)
parseClassification(text, folders)           // → { category, priority, reason, folderId }
```

`m` est le message complet tel que renvoyé par `store.getMessage(id)` (`subject`, `from`, `body`, `time` ou `at`, `trail`, et pour un nouveau message `kind: 'new'` et `draft.text`).

### Classement

Le modèle répond par un objet JSON :

```json
{ "category": "action", "priority": "high", "reason": "Créneau à confirmer.", "folder": "D2" }
```

- `category` : `action` (une action est attendue de l'utilisateur), `waiting` (il attend un tiers), `information`, `newsletter`, `spam`.
- `priority` : `low`, `normal`, `high`.
- `reason` : une phrase, nettoyée et limitée à 300 caractères.
- `folder` : le modèle ne voit jamais les identifiants des dossiers, seulement des clés `D1…Dn` dans l'ordre de la liste fournie.

`parseClassification` valide strictement :

- catégorie et priorité dans les listes (casse ignorée), raison non vide, sinon erreur `ai_bad_classification` ;
- `folderId` est l'identifiant exact (chaîne) du dossier `Dn` de la liste fournie, ou `null` pour toute autre valeur : clé hors liste, identifiant réel, nom de dossier, autre type. Ni un message ni le modèle ne peuvent donc désigner un dossier qui n'a pas été proposé ;
- le JSON peut être entouré de texte ou d'un bloc de code ; un tableau ou un JSON invalide est refusé.

## Utilisation dans Relay Desk

1. Renseigner `MISTRAL_API_KEY` dans `.env` sur le Mac, puis redémarrer l’application. Ne jamais partager ce fichier : il contient aussi les identifiants de connexion. `MISTRAL_MODEL` permet de choisir le modèle.
2. Ouvrir un message Gmail ou Outlook, puis **Résumer** ou **Classer**. Le panneau indique que le texte du fil sera transmis à Mistral ; chaque analyse demande un clic. Aucun traitement de toute la boîte en arrière-plan.
3. **Classer** propose une catégorie, une priorité et éventuellement un dossier existant. L’utilisateur peut changer le dossier, ou garder le dossier actuel, puis cliquer **Appliquer le classement**. Catégorie et priorité restent locales ; le déplacement choisi passe par le fournisseur du compte et exige la permission Classement. Aucun archivage, drapeau, effacement ou déplacement automatique.
4. **Répondre** permet de préciser une intention et un ton. **Insérer dans la réponse** place un texte modifiable dans le compositeur, sans l’enregistrer chez le fournisseur ni l’envoyer. **Envoyer** ouvre toujours l’aperçu exact, suivi de la confirmation à usage unique. Toute modification exige un nouvel aperçu.

## Conservation et limites

La table locale `ai_results` conserve les résumés et classements avec le modèle et une empreinte du contenu, du compte et du profil. Une nouvelle réponse invalide l’analyse. **Régénérer** relance l’IA ; sinon une analyse valide est réutilisée. Les résultats sont supprimés avec le compte ou le message. Les réponses proposées ne sont pas enregistrées automatiquement. La clé Mistral n’est jamais renvoyée au navigateur.

Le modèle reçoit au maximum 200 dossiers du profil ; le sélecteur permet de choisir manuellement les autres dossiers. Les textes sont traités comme données non fiables et la réponse de classement est validée côté serveur. Ces garde-fous réduisent les risques d’instructions malveillantes sans garantir l’exactitude des propositions : l’utilisateur relit les résultats.

Les suggestions ne constituent pas une analyse des pièces jointes, ni une recherche sur l’intégralité de l’historique. Les tests utilisent des messages et réponses fictifs ; un essai réel nécessite une clé valide et envoie le fil sélectionné à Mistral.

Implémentation : `src/mail/assistant-service.js`, routes `/api/ai/summary`, `/api/ai/classify`, `/api/ai/classify/apply`, `/api/ai/draft`.
