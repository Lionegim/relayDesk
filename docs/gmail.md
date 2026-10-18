# Connecter un compte Gmail personnel

Relay utilise l’API Gmail avec OAuth : lecture seule par défaut (`gmail.readonly`), et classement dans Gmail si tu actives **Libellés** (`gmail.modify`). Aucun mot de passe n’est stocké : Relay garde un jeton de rafraîchissement, chiffré dans `data/relay.db`.

## 1. Créer le client Google (une fois, environ 15 minutes)

1. Ouvre la [console Google Cloud](https://console.cloud.google.com/) avec ton compte Gmail et crée un projet, par exemple « Relay ».
2. **API et services → Bibliothèque** : active **Gmail API**.
3. **Google Auth Platform → Audience** (anciennement « Écran de consentement OAuth ») :
   - Type d’utilisateur : **Externe**.
   - Renseigne le nom de l’application et ton adresse.
   - **Accès aux données** : déclare `https://www.googleapis.com/auth/gmail.readonly`. Pour activer le lot A, déclare aussi `https://www.googleapis.com/auth/gmail.modify`. Ne demande jamais `https://mail.google.com/`.
   - **Statut de publication : passe en « En production »**. Ne reste pas en « Test » : en test, Google révoque l’accès tous les 7 jours.
   - Ne lance pas la validation : elle n’est utile que pour une application distribuée au public. L’application non validée est limitée à 100 utilisateurs, ce qui ne te concerne pas.
4. **Clients → Créer un client** : type **Application de bureau**. Copie l’ID client et le code secret.

## 2. Configurer Relay

Dans `.env` :

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
```

Redémarre (`npm start`) et ouvre **http://127.0.0.1:4310**. Relay redirige Google vers `http://127.0.0.1:4310/oauth/google/callback` ; avec un client « Application de bureau », aucune URI n’est à déclarer.

## 3. Connecter

**+ Ajouter un canal → Gmail**, choisis le profil (par exemple Personnel), le nom du compte et l’historique (7, 30 ou 90 jours), active éventuellement **Libellés**, puis **Continuer avec Google**. Sans cet interrupteur, seule la lecture est demandée.

Google affiche un avertissement « Google n’a pas validé cette application » : c’est attendu pour ton propre client. Clique sur **Paramètres avancés → Accéder à Relay**, puis autorise la lecture.

De retour dans Relay, l’import s’affiche en direct. Ensuite, Relay vérifie les changements toutes les 60 secondes.

## Ce que fait cette version

- Importe les conversations de la période choisie (1 000 au maximum), hors spam, corbeille et brouillons.
- Une conversation sans le libellé Boîte de réception apparaît comme archivée.
- Les libellés Gmail personnels deviennent des dossiers ; un message dans un libellé est rangé dans le dossier correspondant.
- Avec **Libellés** accordé : lu/non lu, drapeau, archivage et déplacement dans un dossier sont appliqués à la conversation Gmail avant d’être enregistrés dans Relay. En cas d’erreur Gmail, Relay renvoie une erreur et conserve son état local précédent.
- Un dossier local sans libellé Gmail pour ce compte crée le libellé à son premier usage. Les sous-dossiers deviennent des chemins `Parent/Enfant`. Si le libellé existe déjà, il est réutilisé. Chaque compte possède son propre lien avec le dossier.
- Déplacer retire le libellé du dossier précédent et ajoute celui du nouveau dossier ; **Aucun dossier** retire seulement le libellé du dossier actuel. Les autres libellés personnels restent dans Gmail. Relay affiche un seul dossier par conversation : il garde le dossier choisi tant que son libellé est présent, sinon utilise un autre libellé du fil s’il en reste.
- Sans **Libellés** accordé, les changements restent locaux : une modification ultérieure du fil dans Gmail peut rétablir lu, drapeau et archivage. Les anciens comptes restent en lecture seule tant qu’ils ne sont pas réautorisés.
- Corps en texte brut : le HTML est converti en texte et n’est jamais affiché tel quel. Les citations du message précédent sont retirées.
- Si l’accès est révoqué (depuis [ton compte Google](https://myaccount.google.com/permissions) par exemple), le compte passe à « À reconnecter » : clique dessus pour relancer l’autorisation.

## Modifier les permissions ou synchroniser

Clique sur ton compte Gmail dans la barre latérale :

- **Synchroniser maintenant** relance la lecture de l’historique Gmail.
- **Modifier les permissions** ouvre la configuration avec les permissions réellement accordées cochées et la période d’import du compte conservée. Active **Libellés**, puis termine la nouvelle autorisation Google avec le même compte.

L’ajout d’une permission demande une nouvelle autorisation Google et sa déclaration préalable dans **Google Auth Platform → Accès aux données**. Les scopes réellement accordés, et non les interrupteurs demandés, déterminent les capacités de Relay. Décocher une permission déjà accordée ne la révoque pas chez Google (autorisation incrémentale).

Les opérations du même compte sont exécutées dans l’ordre pour éviter qu’une synchronisation en cours écrase une écriture. Les erreurs de modification ne changent pas SQLite ; si Gmail a créé un libellé avant qu’une modification de conversation échoue, ce libellé peut rester dans Gmail et sera réutilisé au prochain essai.

## Déconnecter un compte

Menu du compte → **Déconnecter**, puis confirmation. Relay attend la fin de la synchronisation ou de l'action en cours sur ce compte, révoque l'accès chez Google, puis supprime le compte, son jeton, son état de synchronisation, ses messages importés et ses liens de libellés. Tous les dossiers restent, y compris ceux créés à partir de ses libellés. Les messages restent dans Gmail. Si Google est injoignable, la suppression a lieu quand même : retire alors l'accès depuis [ton compte Google](https://myaccount.google.com/permissions).

## Sécurité

- Le jeton est chiffré en AES-256-GCM. La clé vient de `RELAY_SECRET_KEY`, sinon d’un fichier `data/secret.key` créé au premier lancement (droits 0600). Sauvegarder `relay.db` sans la clé ne permet pas de lire le jeton.
- Le jeton n’apparaît ni dans l’API, ni dans les journaux, ni dans le navigateur.
- Autorisation avec PKCE et `state` à usage unique, valable 10 minutes.
- Le serveur n’écoute que sur 127.0.0.1 et refuse les requêtes dont l’en-tête Host n’est pas local.

## Étapes suivantes

1. `gmail.compose` : brouillons Gmail réels.
2. `gmail.send` : envoi, après un écran de validation du contenu exact.
