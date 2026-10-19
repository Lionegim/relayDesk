// État d'exploitation agrégé : aucun corps, adresse, QR, jeton ni erreur fournisseur brute.
import {existsSync,readFileSync,statfsSync} from 'node:fs';
import {join} from 'node:path';
import {RESTORE_HOLD} from './backup.js';

export function databaseReady(db) {
  try {return !!db && db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n>0;}
  catch {return false;}
}
export function operationsHealth({db,dataDir,config={},state='running',startedAt=Date.now(),clock=Date.now,disk=statfsSync}) {
  const now=clock(),dbOK=databaseReady(db),warnings=[];
  const restoreHeld=existsSync(join(dataDir,RESTORE_HOLD));
  const process={state,uptimeSeconds:Math.max(0,Math.floor((now-startedAt)/1000))};
  let storage={status:'unknown'};
  try {const info=disk(dataDir),availableBytes=Number(info.bavail)*Number(info.bsize),totalBytes=Number(info.blocks)*Number(info.bsize);storage={status:availableBytes<(config.opsMinFreeBytes??512*1024**2)?'low':'ok',availableBytes,totalBytes};}
  catch {warnings.push('storage_unavailable');}
  if(storage.status==='low')warnings.push('storage_low');
  let backups={status:config.backupStatusFile?'missing':'unconfigured',offsite:'unverified',restoreTest:'unverified'};
  if(config.backupStatusFile)try {
    const bytes=readFileSync(config.backupStatusFile);if(bytes.length>4096)throw new Error();
    const value=JSON.parse(bytes.toString('utf8'));
    if(value.version!==1 || !Number.isSafeInteger(value.createdAt) || value.createdAt<=0 || value.createdAt>now+60000 || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes<1)throw new Error();
    const ageSeconds=Math.max(0,Math.floor((now-value.createdAt)/1000));
    backups={status:now-value.createdAt>(config.opsBackupMaxAgeMs??26*3600000)?'stale':'ok',ageSeconds,createdAt:value.createdAt,offsite:'unverified',restoreTest:'unverified'};
  } catch {backups={...backups,status:existsSync(config.backupStatusFile)?'invalid':'missing'};}
  if(backups.status!=='ok')warnings.push('backup_'+backups.status);
  // Une archive locale ne prouve ni sa copie hors site ni une restauration indépendante.
  warnings.push('offsite_unverified','restore_test_unverified');
  let connectors=[];
  if(dbOK)try {
    const rows=db.prepare(`SELECT a.svc,a.status,s.status AS sync_status,s.last_sync_at FROM accounts a LEFT JOIN sync_state s ON s.account_id=a.id WHERE a.svc IN ('gmail','outlook','whatsapp') AND (s.account_id IS NOT NULL OR EXISTS(SELECT 1 FROM secrets v WHERE v.account_id=a.id) OR EXISTS(SELECT 1 FROM whatsapp_auth w WHERE w.account_id=a.id))`).all();
    connectors=['gmail','outlook','whatsapp'].map(provider=>{
      const group=rows.filter(r=>r.svc===provider),enabled=config.connectorsEnabled!==false&&!restoreHeld;
      const needsReconnect=group.filter(r=>r.status==='À reconnecter').length;
      const errors=group.filter(r=>r.sync_status==='error').length;
      const stale=enabled?group.filter(r=>r.status!=='À reconnecter'&&(!r.last_sync_at||!Number.isFinite(Date.parse(r.last_sync_at))||now-Date.parse(r.last_sync_at)>(config.opsSyncStaleMs??15*60000))).length:0;
      if(enabled&&(needsReconnect||errors||stale))warnings.push('connector_'+provider+'_attention');
      return {provider,enabled,accounts:group.length,needsReconnect,errors,stale};
    });
  }catch {warnings.push('connector_status_unavailable');}
  if(restoreHeld)warnings.push('restore_hold');
  if(state!=='running'&&!['stopped','failed'].includes(state))warnings.push('process_unobserved');
  if(!dbOK)warnings.push('database_unavailable');
  return {status:['stopped','failed'].includes(state)||!dbOK?'unavailable':warnings.length?'attention':'ok',process,database:{status:dbOK?'ok':'unavailable'},storage,backups,restoreHeld,connectors,warnings};
}
