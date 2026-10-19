// Usage explicite uniquement. Ne charge jamais .env et ne contacte aucun fournisseur.
import {createBackup,restoreBackup,releaseRestoreHold,readOpsKey} from '../src/ops/backup.js';
import {operationsHealth} from '../src/ops/health.js';
import {DatabaseSync} from 'node:sqlite';
import {resolve,join} from 'node:path';
const args=process.argv.slice(2),command=args.shift(),values={};
try {
  for(let i=0;i<args.length;i++) {
    const name=args[i];if(!['--data-dir','--archive','--backup-key-file','--vault-key-file','--staging-dir','--status-file','--confirm-resume'].includes(name)||Object.hasOwn(values,name))throw new Error('Option inconnue ou répétée.');
    values[name]=name==='--confirm-resume'?true:args[++i];
    if(values[name]===undefined || String(values[name]).startsWith('--'))throw new Error('Valeur manquante.');
  }
  if(!values['--data-dir'])throw new Error('--data-dir explicite est requis.');
  const dataDir=resolve(values['--data-dir']);let result;
  if(command==='status') {
    const db=new DatabaseSync(join(dataDir,'relay.db'),{readOnly:true});
    try {result=operationsHealth({db,dataDir,state:'unobserved',config:{backupStatusFile:values['--status-file']&&resolve(values['--status-file'])}});}finally {db.close();}
    if(result.status!=='ok')process.exitCode=2;
  } else if(command==='resume')result=releaseRestoreHold({dataDir,confirm:values['--confirm-resume']===true});
  else if(['create','restore'].includes(command)) {
    if(!values['--archive']||!values['--backup-key-file']||!values['--vault-key-file'])throw new Error('--archive, --backup-key-file et --vault-key-file sont requis.');
    const opts={dataDir,archive:resolve(values['--archive']),backupKey:readOpsKey(values['--backup-key-file']),vaultKey:readOpsKey(values['--vault-key-file']),stagingDir:values['--staging-dir']&&resolve(values['--staging-dir']),statusFile:values['--status-file']&&resolve(values['--status-file'])};
    result=await(command==='create'?createBackup(opts):restoreBackup(opts));
  } else throw new Error('Commande requise : create, restore, resume ou status.');
  console.log(JSON.stringify(result));
} catch {console.error(JSON.stringify({ok:false,error:'operation_failed',message:'Opération refusée ou impossible. Vérifier commande, chemins, droits, clés, état du runtime et espace disponible ; aucun secret n’est journalisé.'}));process.exitCode=1;}
