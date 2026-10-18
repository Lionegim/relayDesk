// Sonde de santé du conteneur : GET /api/health en local, sans corps lu ni journalisé.
// Le Host envoyé est celui de PUBLIC_BASE_URL, pour passer le même contrôle d'hôte que les vraies requêtes.
import { request } from 'node:http';

const port = Number(process.env.PORT) || 4310;
let host = `127.0.0.1:${port}`;
try {
  if (process.env.PUBLIC_BASE_URL) host = new URL(process.env.PUBLIC_BASE_URL).host;
} catch { /* URL invalide : le serveur refusera de démarrer, la sonde échouera d'elle-même */ }

const req = request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { host }, timeout: 3000 }, res => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
req.end();
