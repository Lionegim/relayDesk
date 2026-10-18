import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../src/runtime/config.js';
import {loadKey} from '../src/secrets.js';

const KEY='11'.repeat(32);
const OIDC={AUTH_MODE:'oidc',AUTH_ISSUER:'https://identity.example.test/realms/relay',AUTH_CLIENT_ID:'test-client',AUTH_CLIENT_SECRET:'synthetic-only',AUTH_OWNER_SUB:'test-owner',AUTH_MFA_ACR:'relay-mfa'};
test('configuration : mode local historique et URL de retour Microsoft conservés',()=>{
 const c=readConfig({}, {cwd:'/tmp/relay-config-test'});
 assert.equal(c.mode,'local');assert.equal(c.host,'127.0.0.1');assert.equal(c.port,4310);
 assert.equal(c.googleRedirectUri,'http://127.0.0.1:4310/oauth/google/callback');
 assert.equal(c.microsoftRedirectUri,'http://localhost:4310/oauth/microsoft/callback');
 assert.equal(c.dataDir,'/tmp/relay-config-test/data');assert.equal(c.demo,true);
 const docker=readConfig({HOST:'0.0.0.0',PUBLIC_BASE_URL:'http://127.0.0.1:4311'});
 assert.ok(docker.allowedHosts.includes('localhost:4311'));assert.ok(docker.allowedHosts.includes('127.0.0.1:4311'));assert.ok(docker.allowedHosts.includes('127.0.0.1:4310'));
});
test('configuration : fichier secret, conflit, fichier absent ou vide, aucune valeur secrète dans l’erreur',t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-config-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'vault'),KEY+'\n',{mode:0o600});
 const c=readConfig({RELAY_SECRET_KEY_FILE:'vault'},{cwd:dir});assert.equal(c.secrets.RELAY_SECRET_KEY,KEY);
 writeFileSync(join(dir,'empty'),'\n');
 for(const input of [{RELAY_SECRET_KEY:KEY,RELAY_SECRET_KEY_FILE:'vault'},{MISTRAL_API_KEY_FILE:'missing'},{MISTRAL_API_KEY_FILE:'empty'}]) {
  assert.throws(()=>readConfig(input,{cwd:dir}),e=>e.code==='configuration_invalid' && !e.message.includes(KEY));
 }
});
test('configuration : hôte, URL publique, nombres et booléens stricts',()=>{
 for(const input of [
  {RELAY_MODE:'prod'},{PORT:'4310oops'},{PORT:'-1'},{PORT:'65536'},{HOST:'http://localhost'},
  {PUBLIC_BASE_URL:'http://attacker.example'},{PUBLIC_BASE_URL:'http://user:pass@localhost'},
  {PUBLIC_BASE_URL:'http://localhost/path'},{PUBLIC_BASE_URL:'http://localhost?x=1'},
  {RELAY_AI_ENABLED:'yes'},{RELAY_CONNECTORS_ENABLED:'perhaps'},{DEMO_DATA:'no'},{SYNC_INTERVAL_MS:'0'},
 ]) assert.throws(()=>readConfig(input),e=>e.code==='configuration_invalid');
 const off=readConfig({RELAY_AI_ENABLED:'false',RELAY_CONNECTORS_ENABLED:'0',DEMO_DATA:'0'});
 assert.equal(off.aiEnabled,false);assert.equal(off.connectorsEnabled,false);assert.equal(off.demo,false);
});
test('configuration hébergée : HTTPS, origine et clé explicites, sans hôte déduit de requêtes',()=>{
 for(const input of [
  {RELAY_MODE:'hosted'},
  {RELAY_MODE:'hosted',PUBLIC_BASE_URL:'http://relay.example.test',RELAY_SECRET_KEY:KEY},
  {RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://localhost',RELAY_SECRET_KEY:KEY},
  {RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test'},
 ]) assert.throws(()=>readConfig(input),e=>e.code==='configuration_invalid');
 const c=readConfig({...OIDC,RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test',RELAY_SECRET_KEY:KEY});
 assert.deepEqual(c.allowedHosts,['relay.example.test']);assert.equal(c.demo,false);
 assert.equal(c.googleRedirectUri,'https://relay.example.test/oauth/google/callback');
});
test('coffre : clés valides uniquement ; ne pas recréer une clé absente avec des données existantes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-key-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const keyFile=join(dir,'key');
 assert.throws(()=>loadKey({keyFile,allowCreate:false}),/absente/);
 const generated=loadKey({keyFile});assert.equal(generated.length,32);assert.deepEqual(loadKey({keyFile}),generated);
 assert.deepEqual(loadKey({envKey:KEY,keyFile}),Buffer.from(KEY,'hex'));
 for(const value of ['bad','!!!!'+Buffer.alloc(32).toString('base64'),'a'.repeat(42)+'==']) assert.throws(()=>loadKey({envKey:value,keyFile}));
 writeFileSync(keyFile,'broken');assert.throws(()=>loadKey({keyFile}));
});


test('authentification : OIDC complète obligatoire en hébergé, HTTPS fournisseur et paramètres fixes',()=>{
 const base={...OIDC,RELAY_MODE:'hosted',PUBLIC_BASE_URL:'https://relay.example.test',RELAY_SECRET_KEY:KEY};
 for(const patch of [{AUTH_MODE:'disabled'},{AUTH_OWNER_SUB:''},{AUTH_MFA_ACR:''},{AUTH_CLIENT_ID:''},{AUTH_ISSUER:'http://identity.example.test'},{AUTH_ISSUER:'https://user:pass@identity.example.test'},{AUTH_SESSION_TTL_HOURS:'0'}])assert.throws(()=>readConfig({...base,...patch}),e=>e.code==='configuration_invalid');
 const valid=readConfig(base);assert.equal(valid.auth.enabled,true);assert.equal(valid.auth.secureCookies,true);assert.equal(valid.auth.publicBaseUrl,base.PUBLIC_BASE_URL);
 const local=readConfig({});assert.equal(local.auth.enabled,false);
});
