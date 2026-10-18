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

## Ce qui reste au socle

Routes, cache des résultats (avec empreinte du fil), interface et application d'un classement après clic : hors de `src/ai`.
