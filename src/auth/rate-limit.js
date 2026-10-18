// Limite de débit pour /auth/login et /auth/callback : seau global et seau par adresse du socket.
// L'adresse vient de req.socket uniquement (jamais de X-Forwarded-For) ; derrière le proxy, le seau par adresse
// devient de fait un second seau global, ce qui reste sûr. Table bornée.

export function createRateLimiter({ clock = Date.now, windowMs = 60000, perAddress = 10, global = 60, maxAddresses = 1000 } = {}) {
  const buckets = new Map(); // adresse -> { start, count }
  let all = { start: clock(), count: 0 };
  const fresh = (b, now) => (now - b.start >= windowMs ? { start: now, count: 0 } : b);
  return {
    take(address) {
      const now = clock();
      all = fresh(all, now);
      let b = buckets.get(address);
      b = b ? fresh(b, now) : { start: now, count: 0 };
      if (all.count >= global || b.count >= perAddress) return false;
      all.count++;
      b.count++;
      buckets.delete(address);
      buckets.set(address, b);
      // Au-delà de la borne, les adresses les plus anciennes sont oubliées.
      while (buckets.size > maxAddresses) buckets.delete(buckets.keys().next().value);
      return true;
    },
    clear() { buckets.clear(); },
  };
}
