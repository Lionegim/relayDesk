// Installation de l'application web : enregistre le service worker (interface statique seulement).
// Aucun contenu privé n'est conservé côté navigateur : ni localStorage, ni IndexedDB, ni cache de l'API.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'classic', updateViaCache: 'none' }).catch(() => {});
  });
}
