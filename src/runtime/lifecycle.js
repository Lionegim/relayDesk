import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/index.js';
import { seedIfEmpty } from '../db/seed.js';
import { createStore } from '../store.js';
import { createVault,loadKey } from '../secrets.js';
import { createMistralClient } from '../ai/mistral.js';
import { createApp } from '../http/app.js';
import { acquireInstanceLock } from './instance-lock.js';
import { assembleProviders } from './providers.js';
import {RESTORE_HOLD} from '../ops/backup.js';
import {databaseReady,operationsHealth} from '../ops/health.js';

// Contrôler les données chiffrées AVANT toute migration, import ou nouvelle identité WhatsApp.
function verifyExistingVault(path,vault) {
  if(!existsSync(path)) return;
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    for(const table of ['secrets','whatsapp_auth']) {
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for(const row of db.prepare(`SELECT account_id,iv,tag,ciphertext FROM ${table}`).all()) vault.open(row.account_id,row);
    }
  } catch {throw new Error('La clé du coffre ne correspond pas aux données chiffrées.');}
  finally {db.close();}
}

export function createRuntime(config,{providerFactory=assembleProviders,appFactory=createApp,authFactory=null,log=console}={}) {
  const startedAt=Date.now();
  let effectiveConfig=config;
  let state='created',db,store,server,releaseLock,bundle,maintenance,startPromise,stopPromise,stopRequested=false,url,ownerAuth;
  const syncs=()=>bundle?.syncs || [];
  const requests=new Set();
  async function drainRequests() {while(requests.size) await Promise.allSettled([...requests]);}
  function trackRequests() {
    const handlers=server.listeners('request');server.removeAllListeners('request');
    server.on('request',(req,res)=>{
      for(const handler of handlers) {
        const job=Promise.resolve().then(()=>handler.call(server,req,res));requests.add(job);
        job.then(()=>requests.delete(job),()=>{requests.delete(job);res.destroy();});
      }
    });
  }
  function closeStorage() {
    try {ownerAuth?.close();ownerAuth=null;if(db) {try {db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();db=null;}}}
    finally {releaseLock?.();releaseLock=null;}
  }
  async function start() {
    if(['stopping','stopped'].includes(state)) throw new Error('Runtime déjà arrêté.');
    if(startPromise) return startPromise;
    if(state!=='created') throw new Error('Runtime déjà arrêté.');
    startPromise=(async()=>{
      state='starting';
      // Défense supplémentaire pour les appelants qui ne passent pas par readConfig.
      if(config.mode==='hosted' && !config.auth?.enabled) {
        const error=new Error('Mode hébergé refusé : une authentification OIDC complète est obligatoire.');
        error.code='hosted_not_ready';state='failed';throw error;
      }
      try {
        releaseLock=acquireInstanceLock(config.dataDir);
        const path=join(config.dataDir,'relay.db');
        const key=loadKey({envKey:config.secrets.RELAY_SECRET_KEY,keyFile:config.keyFile,allowCreate:!existsSync(path)});
        const vault=createVault(key);verifyExistingVault(path,vault);
        db=openDatabase(path);seedIfEmpty(db,{demo:config.demo});store=createStore(db);
        store.pruneReplyMemory();store.learnAvailableReplies();store.contactsBackfill();
        if(config.auth?.enabled) {
          const factory=authFactory || (await import('../auth/index.js')).createOwnerAuth;
          ownerAuth=await factory({config,db});
          if(!ownerAuth) throw new Error('Authentification indisponible.');
        }
        // Une copie restaurée reste isolée même si l'environnement demande des connecteurs actifs.
        const held=existsSync(join(config.dataDir,RESTORE_HOLD));
        effectiveConfig=held?{...config,connectorsEnabled:false,aiEnabled:false}:config;
        bundle=await providerFactory({config:effectiveConfig,store,vault,log});
        const ai=createMistralClient({apiKey:effectiveConfig.aiEnabled?config.secrets.MISTRAL_API_KEY:'',model:config.mistralModel});
        const allowedHosts=[...config.allowedHosts];
        server=appFactory({store,ai,providers:bundle.providers,gmail:bundle.gmail,push:bundle.push,ownerName:config.ownerName,allowedHosts,auth:ownerAuth,health:()=>({ok:state==='running'}),readiness:()=>({ok:state==='running'&&databaseReady(db)}),operations:()=>operationsHealth({db,dataDir:config.dataDir,config:effectiveConfig,state,startedAt})});
        trackRequests();
        server.on('request',(_req,res)=>res.once('finish',()=>{if(state==='stopping') setImmediate(()=>server.closeIdleConnections?.());}));
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.off('error',reject);resolve();});});
        const port=server.address().port;
        const actual=new URL(config.publicBaseUrl);if(config.port===0) {
          actual.port=String(port);
          allowedHosts.push(actual.host,`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`);
        }
        url=actual.origin;
        // Un signal reçu pendant la construction ne démarre aucun connecteur.
        if(!stopRequested) {
          for(const sync of syncs()) await sync.start(config.syncIntervalMs);
          maintenance=setInterval(()=>store.pruneReplyMemory(),3600000);maintenance.unref();
        }
        state='running';return {url};
      } catch(error) {
        state='failed';
        server?.closeLiveUpdates?.();
        clearInterval(maintenance);
        for(const sync of syncs()) await sync.stop?.();
        if(server?.listening) await new Promise(resolve=>server.close(resolve));
        await drainRequests();
        for(const sync of syncs()) await sync.drain?.();
        closeStorage();throw error;
      }
    })();
    return startPromise;
  }
  function stop() {
    if(stopPromise) return stopPromise;
    stopRequested=true;
    const finish=(async()=>{
      if(state==='starting') {try {await startPromise;}catch {return;}}
      if(state==='stopped') return;
      state='stopping';clearInterval(maintenance);
      server?.closeLiveUpdates?.();
      // Fermer l'entrée d'abord ; les requêtes déjà acceptées gardent leur connexion et leur issue fournisseur.
      const httpDone=server?.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
      for(const sync of syncs()) sync.pause?.();
      await httpDone;
      await drainRequests();
      for(const sync of syncs()) await sync.drain?.();
      for(const sync of syncs()) await sync.stop?.();
      for(const sync of syncs()) await sync.drain?.();
      closeStorage();state='stopped';
    })();
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
      const error=new Error('Arrêt dépassé : le résultat d’un envoi en cours peut être incertain ; aucune relance automatique.');
      error.code='shutdown_timeout';reject(error);
    },config.shutdownTimeoutMs);});
    // Sur dépassement, ne fermer ni SQLite ni le verrou tant que des tâches pourraient encore écrire.
    stopPromise=Promise.race([finish,timeout]).finally(()=>clearTimeout(timer));
    finish.catch(()=>{});
    return stopPromise;
  }
  return {start,stop,get state(){return state;},get url(){return url;},get store(){return store;},get db(){return db;}};
}
