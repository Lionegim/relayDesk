import {HttpError} from '../http/errors.js';

export function mailboxAddress(value) {
 if(typeof value!=='string' || value.length>254 || !/^[^\s<>@]+@[^\s<>@]+$/.test(value)) throw new HttpError(400,'Adresse de boîte introuvable ou invalide.','oauth_no_email');
 return value.toLowerCase();
}

// Les anciens secrets sans étiquette restent utilisables uniquement avec le client bureau historique.
export function credentialsMatch(oauth,credential) {
 if(!credential) return false;
 if(!credential.oauthBinding) return oauth.mode!=='web';
 return !!oauth.binding && credential.oauthBinding===oauth.binding;
}
export const changedClient=()=>new HttpError(401,'Client OAuth modifié : reconnecte ce compte avec la configuration actuelle.','oauth_client_changed');
const changedAccount=()=>new HttpError(409,'Le compte a changé pendant la connexion. Recommence depuis ce compte.','account_changed');

export function prepareMailConnection({store,oauth,service,profileId,name,email,expectedAccount,expectNew=false,authorize=()=>{},assertAccountAllowed=()=>{},generation}) {
 email=email?mailboxAddress(email):null;
 if(oauth.mode==='web' && !email) throw new HttpError(400,'Identité de boîte manquante.','oauth_no_email');
 authorize();
 assertAccountAllowed(service,email);
 const validateExpected=()=>{
  if(!expectedAccount) return;
  if(!store.hasAccount(expectedAccount.id) || store.accountIdentity(expectedAccount.id)!==expectedAccount.identity) throw changedAccount();
  const current=store.getAccount(expectedAccount.id);
  if(current.profileId!==profileId || current.svc!==service || current.name!==name || (current.address && email && mailboxAddress(current.address)!==email) || generation(current.id)!==expectedAccount.generation) throw changedAccount();
 };
 const duplicate=()=>{
  const other=email && store.mailAccountForAddress(profileId,service,email);
  if(other && other.name!==name) throw new HttpError(409,'Cette boîte est déjà connectée dans ce profil. Reconnecte le compte existant.','duplicate_mailbox');
 };
 validateExpected();duplicate();
 if(expectNew && store.accountForName(profileId,name)) throw changedAccount();
 const account=store.upsertAccount(profileId,{name,channel:'email',svc:service,address:email});
 const identity=store.accountIdentity(account.id),at=generation(account.id);
 return {account,email,guard(){
  authorize();assertAccountAllowed(service,email);validateExpected();duplicate();
  if(!store.hasAccount(account.id) || store.accountIdentity(account.id)!==identity || generation(account.id)!==at) throw changedAccount();
 }};
}
