// Service worker de Relay Desk : uniquement l'interface statique générique, versionnée.
// Jamais d'API, d'authentification, d'OAuth, de QR WhatsApp, de page HTML privée ni de contenu de message en cache.
// Hors ligne, une navigation affiche une page générique ; aucune requête n'est mise en file ni rejouée.
const VERSION = 'relay-shell-2026-10-19-8';
const ASSETS = [
  '/styles.css',
  '/js/app.js', '/js/api.js', '/js/dom.js', '/js/views.js', '/js/constants.js', '/js/pwa.js', '/js/login.js', '/js/live.js',
  '/fonts/inter-latin-wght-normal.woff2', '/fonts/jetbrains-mono-latin-wght-normal.woff2',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
  '/icons/gmail.webp', '/icons/outlook.svg', '/icons/microsoft.svg', '/icons/google-sign-in.svg', '/icons/microsoft-sign-in.svg',
  '/icons/whatsapp-glyph-green.svg', '/icons/whatsapp-wordmark-black.svg',
  '/manifest.webmanifest', '/offline.html',
];
const OFFLINE = '/offline.html';
const ALLOWED = new Set(ASSETS);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(ASSETS.map(path => new Request(path, { cache: 'reload', credentials: 'same-origin' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('relay-') && key !== VERSION).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Réponse mise en cache seulement si elle est complète, du même site, non redirigée (pas de page de connexion).
const cacheable = response => response && response.ok && response.status === 200 && response.type === 'basic' && !response.redirected;

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return; // mutations : jamais interceptées, jamais rejouées
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Pages : toujours le réseau (et ses contrôles d'accès) ; la page générique seulement si le réseau manque.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE).then(hit => hit || Response.error())));
    return;
  }
  if (!ALLOWED.has(url.pathname) || url.search) return; // API, /auth, /oauth, QR, etc. : non gérés ici
  // Réseau d'abord : l'interface reste à jour ; le cache ne sert qu'en l'absence de réseau.
  event.respondWith(fetch(request).then(response => {
    if (cacheable(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(VERSION).then(cache => cache.put(url.pathname, copy)));
    }
    return response;
  }).catch(() => caches.match(url.pathname).then(hit => hit || Response.error())));
});
