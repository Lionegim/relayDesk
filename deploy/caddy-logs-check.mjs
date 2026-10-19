// Contrôle des journaux de Caddy avec le Caddyfile réel : aucune URI (code/state OAuth) ni en-tête dans les erreurs.
// Lance Caddy en HTTP sur 127.0.0.1 seulement, sans ACME, avec un amont volontairement fermé ; arrête Caddy à la fin.
//   node deploy/caddy-logs-check.mjs /chemin/vers/caddy   (binaire officiel, version de compose.yaml)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const caddy = process.argv[2];
if (!caddy) { console.error('Usage : node deploy/caddy-logs-check.mjs <binaire caddy>'); process.exit(2); }
const port = 18000 + Math.floor(Math.random() * 1000);
const dir = mkdtempSync(join(tmpdir(), 'relay-caddy-'));
const config = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8')
  .replace(/^\temail .*\n/m, '').replace(/^\tacme_ca .*\n/m, '')
  .replace('{$RELAY_DOMAIN} {', `http://127.0.0.1:${port} {`)
  .replace('reverse_proxy relay:4310', 'reverse_proxy 127.0.0.1:9');
assert.match(config, /log default/);
writeFileSync(join(dir, 'Caddyfile'), config);
const child = spawn(caddy, ['run', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], { env: { PATH: process.env.PATH, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir } });
let logs = '';
child.stdout.on('data', d => { logs += d; });
child.stderr.on('data', d => { logs += d; });
try {
  let status = 0;
  for (let i = 0; i < 50 && !status; i++) {
    await new Promise(r => setTimeout(r, 100));
    status = await fetch(`http://127.0.0.1:${port}/oauth/google/callback?code=FICTIVE-CODE&state=FICTIVE-STATE`, { headers: { cookie: '__Host-relay_session=FICTIVE-COOKIE', authorization: 'Bearer FICTIVE-TOKEN' } }).then(r => r.status, () => 0);
  }
  assert.equal(status, 502, 'amont fermé : erreur du proxy');
  await new Promise(r => setTimeout(r, 300));
  assert.match(logs, /"logger":"http\.log\.error".*"status":502/, 'l’erreur reste journalisée');
  for (const secret of ['FICTIVE-CODE', 'FICTIVE-STATE', 'FICTIVE-COOKIE', 'FICTIVE-TOKEN', '/oauth/google/callback']) assert.ok(!logs.includes(secret), `${secret} absent des journaux`);
  console.log('Journaux Caddy : erreur 502 journalisée sans URI, requête ni en-têtes.');
} finally {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
