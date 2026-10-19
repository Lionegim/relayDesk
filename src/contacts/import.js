import {HttpError,badRequest} from '../http/errors.js';
// Read-only address-book requests use the existing encrypted account credentials and account queue.
export async function importAddressBook({store,provider,accountId}) {
 const account=store.getAccount(accountId);
 if(!['gmail','outlook'].includes(account.svc))throw badRequest('Ce compte ne possède pas de carnet importable');
 if(!provider?.sync.permissions(accountId).includes('contacts'))throw new HttpError(403,'Autorise la lecture des contacts de ce compte avant l’import.','contacts_permission');
 const identity=store.accountIdentity(accountId),profile=account.profileId;
 return provider.sync.exclusive(accountId,async c=>{
  const records=await (c.gmail || c.graph).contacts();
  if(!c.live() || !store.hasAccount(accountId) || store.accountIdentity(accountId)!==identity || store.getAccount(accountId).profileId!==profile)throw new HttpError(409,'Le compte a changé pendant l’import.','account_changed');
  return store.importContacts(accountId,records);
 });
}
