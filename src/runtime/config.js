import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import {readAuthConfig} from '../auth/config.js';
import {parseAllowedAccounts} from '../providers/account-policy.js';

export class ConfigurationError extends Error {
  constructor(message) { super(`Configuration : ${message}`); this.code='configuration_invalid'; }
}
const invalid = message => { throw new ConfigurationError(message); };
const SECRET_NAMES=['RELAY_SECRET_KEY','MISTRAL_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','MICROSOFT_CLIENT_ID','AUTH_CLIENT_ID','AUTH_CLIENT_SECRET','GOOGLE_WEB_CLIENT_ID','GOOGLE_WEB_CLIENT_SECRET','MICROSOFT_WEB_CLIENT_ID','MICROSOFT_WEB_CLIENT_SECRET'];
function secret(env,name,cwd) {
  const value=env[name], file=env[`${name}_FILE`];
  if(value && file) invalid(`${name} et ${name}_FILE ne peuvent pas être utilisés ensemble.`);
  if(!file) return value || '';
  try {
    const content=readFileSync(resolve(cwd,file));
    if(content.length>65536) invalid(`${name}_FILE est trop volumineux.`);
    const text=content.toString('utf8').trim();
    if(!text) invalid(`${name}_FILE est vide.`);
    return text;
  } catch { invalid(`lecture de ${name}_FILE impossible.`); }
}
const boolean=(env,name,fallback)=>{
  if(env[name]===undefined) return fallback;
  if(['1','true'].includes(env[name])) return true;
  if(['0','false'].includes(env[name])) return false;
  return invalid(`${name} doit valoir true ou false.`);
};
const number=(env,name,fallback,min,max)=>{
  if(env[name]===undefined) return fallback;
  if(!/^\d+$/.test(env[name])) invalid(`${name} doit être un entier.`);
  const n=Number(env[name]);if(n<min || n>max) invalid(`${name} est hors limites.`);return n;
};
export function readConfig(env=process.env,{cwd=process.cwd()}={}) {
  const mode=env.RELAY_MODE || 'local';
  if(!['local','hosted'].includes(mode)) invalid('RELAY_MODE doit valoir local ou hosted.');
  const port=number(env,'PORT',4310,0,65535), host=env.HOST || (mode==='hosted'?'0.0.0.0':'127.0.0.1');
  if(!isIP(host) && host!=='localhost') invalid('HOST doit être une adresse IP ou localhost.');
  if(mode==='hosted' && (!env.PUBLIC_BASE_URL || port===0)) invalid('PUBLIC_BASE_URL et un port fixe sont requis en mode hébergé.');
  let base;
  try {base=new URL(env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`);} catch {invalid('PUBLIC_BASE_URL est invalide.');}
  if(base.username || base.password || base.search || base.hash || base.pathname!=='/') invalid('PUBLIC_BASE_URL doit être une origine sans chemin ni identifiants.');
  const loopback=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
  if(mode==='local' && (!loopback || !['http:','https:'].includes(base.protocol))) invalid('PUBLIC_BASE_URL doit rester locale en mode local.');
  if(mode==='hosted' && (base.protocol!=='https:' || loopback)) invalid('PUBLIC_BASE_URL doit utiliser HTTPS et un hôte externe en mode hébergé.');
  const secrets=Object.fromEntries(SECRET_NAMES.map(name=>[name,secret(env,name,cwd)]));
  if(mode==='hosted' && !secrets.RELAY_SECRET_KEY) invalid('la clé du coffre doit être fournie en mode hébergé.');
  let auth;
  try {auth=readAuthConfig({env,mode,publicBaseUrl:base.origin,secret:name=>secrets[name] || ''});}
  catch(error) {invalid(error.message);}
  if(auth.enabled && (!env.PUBLIC_BASE_URL || port===0)) invalid('OIDC exige PUBLIC_BASE_URL explicite et un port fixe.');
  const mailOAuthMode=env.MAIL_OAUTH_MODE || (mode==='hosted'?'web':'desktop');
  if(!['desktop','web'].includes(mailOAuthMode) || (mode==='hosted' && mailOAuthMode!=='web')) invalid('MAIL_OAUTH_MODE doit valoir web en hébergé, desktop ou web en local.');
  if(mailOAuthMode==='web' && (!env.PUBLIC_BASE_URL || base.protocol!=='https:')) invalid('Le mode OAuth Web exige PUBLIC_BASE_URL HTTPS explicite.');
  for(const prefix of ['GOOGLE','MICROSOFT']) {
    const id=secrets[`${prefix}_WEB_CLIENT_ID`],value=secrets[`${prefix}_WEB_CLIENT_SECRET`];
    if(mailOAuthMode==='web' && !!id!==!!value) invalid(`${prefix}_WEB_CLIENT_ID et ${prefix}_WEB_CLIENT_SECRET sont requis ensemble.`);
  }
  const connectorsEnabled=boolean(env,'RELAY_CONNECTORS_ENABLED',true);
  let allowedAccounts;
  try {allowedAccounts=parseAllowedAccounts(env.RELAY_ALLOWED_ACCOUNTS);} catch(error) {invalid(error.message);}
  if(mode==='hosted' && connectorsEnabled && !allowedAccounts?.length) invalid('RELAY_ALLOWED_ACCOUNTS requis pour les connecteurs hébergés.');
  return Object.freeze({
    backupStatusFile:env.BACKUP_STATUS_FILE?resolve(cwd,env.BACKUP_STATUS_FILE):null,
    opsMinFreeBytes:number(env,'OPS_MIN_FREE_BYTES',512*1024**2,0,Number.MAX_SAFE_INTEGER),
    opsBackupMaxAgeMs:number(env,'OPS_BACKUP_MAX_AGE_HOURS',26,1,8760)*3600000,
    opsSyncStaleMs:number(env,'OPS_SYNC_STALE_MINUTES',15,1,10080)*60000,
    mailOAuthMode,auth,mode,host,port,publicBaseUrl:base.origin,dataDir:resolve(cwd,env.DATA_DIR || 'data'),
    keyFile:resolve(cwd,env.DATA_DIR || 'data','secret.key'),secrets:Object.freeze(secrets),
    allowedHosts:[...new Set([base.host,...(mode==='local'?[port,base.port || (base.protocol==='https:'?443:80)].flatMap(p=>[`127.0.0.1:${p}`,`localhost:${p}`,`[::1]:${p}`]):[])])],
    googleRedirectUri:`${base.origin}/oauth/google/callback`,
    microsoftRedirectUri:`${env.PUBLIC_BASE_URL?base.origin:`http://localhost:${port}`}/oauth/microsoft/callback`,
    microsoftTenant:env.MICROSOFT_TENANT || 'common',ownerName:env.OWNER_NAME || 'Jean-Hugues',
    mistralModel:env.MISTRAL_MODEL || 'mistral-small-latest',
    connectorsEnabled,allowedAccounts,aiEnabled:boolean(env,'RELAY_AI_ENABLED',true),
    demo:boolean(env,'DEMO_DATA',mode==='local'),syncIntervalMs:number(env,'SYNC_INTERVAL_MS',60000,1000,86400000),
    shutdownTimeoutMs:number(env,'SHUTDOWN_TIMEOUT_MS',30000,100,300000),
  });
}
