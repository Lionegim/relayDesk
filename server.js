import { fileURLToPath } from 'node:url';
import { readConfig } from './src/runtime/config.js';
import { createRuntime } from './src/runtime/lifecycle.js';

let runtime,stopping=false;
async function stop() {
  if(stopping) return;
  stopping=true;
  try {await runtime?.stop();process.exitCode=0;}
  catch(error) {
    console.error(error.code==='shutdown_timeout'?error.message:'Arrêt interrompu : vérifie l’issue des envois avant toute nouvelle tentative.');
    process.exit(1);
  }
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
  const config=readConfig(process.env,{cwd:fileURLToPath(new URL('./',import.meta.url))});
  runtime=createRuntime(config);
  const {url}=await runtime.start();
  if(!stopping) console.log(`Relay Desk sur ${url}`);
} catch(error) {
  const safe=['configuration_invalid','instance_locked','hosted_not_ready'].includes(error.code);
  console.error(safe?error.message:'Démarrage refusé : vérifie la configuration, la clé du coffre et la disponibilité du répertoire et du port.');
  process.exitCode=1;
}
