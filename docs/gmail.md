# Connecter un compte Gmail personnel

Relay lit Gmail par l’API Gmail, avec OAuth et la seule permission `gmail.readonly`. Aucun mot de passe n’est stocké : Relay garde un jeton de rafraîchissement, chiffré dans `data/relay.db`.

## 1. Créer le client Google (une fois, environ 15 minutes)

1. Ouvre la [console Google Cloud](https://console.cloud.google.com/) avec ton compte Gmail et crée un projet, par exemple « Relay ».
2. **API et services → Bibliothèque** : active **Gmail API**.
3. **Google Auth Platform → Audience** (anciennement « Écran de consentement OAuth ») :
   - Type d’utilisateur : **Externe**.
   - Renseigne le nom de l’application et ton adresse.
   - **Données d’accès** : ajoute le champ d’application `https://www.googleapis.com/auth/gmail.readonly`.
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

**+ Ajouter un canal → Gmail**, choisis le profil (par exemple Personnel), le nom du compte et l’historique (7, 30 ou 90 jours), puis **Continuer avec Google**.

Google affiche un avertissement « Google n’a pas validé cette application » : c’est attendu pour ton propre client. Clique sur **Paramètres avancés → Accéder à Relay**, puis autorise la lecture.

De retour dans Relay, l’import s’affiche en direct. Ensuite, Relay vérifie les changements toutes les 60 secondes.

## Ce que fait cette version

- Importe les conversations de la période choisie (1 000 au maximum), hors spam, corbeille et brouillons.
- Une conversation sans le libellé Boîte de réception apparaît comme archivée.
- Les libellés Gmail personnels deviennent des dossiers ; un message dans un libellé est rangé dans le dossier correspondant.
- Lu, drapeau (suivi) et archivage suivent Gmail. Comme l’accès est en lecture seule, les changements faits dans Relay restent locaux et Gmail les écrase à la prochaine modification du fil.
- Corps en texte brut : le HTML est converti en texte et n’est jamais affiché tel quel. Les citations du message précédent sont retirées.
- Si l’accès est révoqué (depuis [ton compte Google](https://myaccount.google.com/permissions) par exemple), le compte passe à « À reconnecter » : clique dessus pour relancer l’autorisation.

## Sécurité

- Le jeton est chiffré en AES-256-GCM. La clé vient de `RELAY_SECRET_KEY`, sinon d’un fichier `data/secret.key` créé au premier lancement (droits 0600). Sauvegarder `relay.db` sans la clé ne permet pas de lire le jeton.
- Le jeton n’apparaît ni dans l’API, ni dans les journaux, ni dans le navigateur.
- Autorisation avec PKCE et `state` à usage unique, valable 10 minutes.
- Le serveur n’écoute que sur 127.0.0.1 et refuse les requêtes dont l’en-tête Host n’est pas local.

## Étapes suivantes

1. `gmail.modify` : lu/non lu, drapeau, archivage et dossiers renvoyés vers Gmail.
2. `gmail.compose` : brouillons Gmail réels.
3. `gmail.send` : envoi, après un écran de validation du contenu exact.
4. Déconnexion depuis Relay (révocation du jeton et suppression des messages importés).
