import {HttpError} from '../http/errors.js';

// Exact provider identities only; no aliases, wildcards or inferred telephone country codes.
export function parseAllowedAccounts(text) {
 if(text===undefined || text==='') return null;
 if(typeof text!=='string' || text.length>4096) throw new Error('RELAY_ALLOWED_ACCOUNTS : format invalide.');
 const entries=text.split(',').map(item=>{
  const match=/^(gmail|outlook|whatsapp):(.+)$/.exec(item.trim());
  if(!match) throw new Error('RELAY_ALLOWED_ACCOUNTS : fournisseur invalide.');
  const [,service,raw]=match,value=raw.toLowerCase();
  if(service==='whatsapp' ? !/^\+[1-9]\d{6,14}$/.test(value) : !/^[^\s<>@*,]+@[^\s<>@*,]+\.[^\s<>@*,]+$/.test(value)) throw new Error('RELAY_ALLOWED_ACCOUNTS : identité invalide.');
  return `${service}:${value}`;
 });
 return Object.freeze([...new Set(entries)]);
}
export function accountPolicy(allowedAccounts,{required=false}={}) {
 if(required && !allowedAccounts?.length) throw new Error('RELAY_ALLOWED_ACCOUNTS requis pour les connecteurs hébergés.');
 const allowed=allowedAccounts ? new Set(allowedAccounts) : null;
 return (service,address)=>{
  if(allowed && (typeof address!=='string' || !allowed.has(`${service}:${address.toLowerCase()}`))) throw new HttpError(403,'Ce compte ne fait pas partie des comptes autorisés.','account_not_allowed');
 };
}
