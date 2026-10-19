// Configuration de l'authentification du propriétaire (lot 3). Lue une fois au démarrage, figée ensuite.
// Aucun drapeau ne désactive l'authentification en mode hébergé.

export class AuthConfigError extends Error {
  constructor(message) { super(`Configuration de l’authentification : ${message}`); this.code = 'auth_configuration_invalid'; }
}
const invalid = message => { throw new AuthConfigError(message); };

const HOUR = 3600000, MINUTE = 60000;
const DEFAULTS = { sessionTtlMs: 12 * HOUR, idleTtlMs: HOUR, recentMs: 10 * MINUTE };

function duration(env, name, fallback, min, max, unit) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) invalid(`${name} doit être un entier.`);
  const value = Number(raw) * unit;
  if (value < min || value > max) invalid(`${name} est hors limites.`);
  return value;
}

// Valeur de claim attendue : texte imprimable court, comparé exactement.
function claimValue(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${name} est invalide.`);
  return value;
}

/**
 * env : variables d'environnement. mode : 'local' | 'hosted'. publicBaseUrl : origine publique déjà validée.
 * secret(name) : lit NAME ou NAME_FILE (même règle que la configuration du runtime), renvoie '' si absent.
 */
export function readAuthConfig({ env = process.env, mode, publicBaseUrl, secret = name => env[name] || '' }) {
  const authMode = env.AUTH_MODE || (mode === 'hosted' ? 'oidc' : 'disabled');
  if (!['oidc', 'disabled'].includes(authMode)) invalid('AUTH_MODE doit valoir oidc ou disabled.');
  if (mode === 'hosted' && authMode !== 'oidc') invalid('le mode hébergé exige AUTH_MODE=oidc.');
  let base;
  try { base = new URL(publicBaseUrl); } catch { invalid('PUBLIC_BASE_URL est invalide.'); }
  const common = {
    publicBaseUrl: base.origin,
    secureCookies: base.protocol === 'https:',
    sessionTtlMs: duration(env, 'AUTH_SESSION_TTL_HOURS', DEFAULTS.sessionTtlMs, HOUR, 90 * 24 * HOUR, HOUR),
    idleTtlMs: duration(env, 'AUTH_IDLE_TTL_HOURS', DEFAULTS.idleTtlMs, HOUR, 30 * 24 * HOUR, HOUR),
    recentMs: duration(env, 'AUTH_RECENT_MINUTES', DEFAULTS.recentMs, MINUTE, 24 * HOUR, MINUTE),
  };
  if (authMode === 'disabled') {
    return Object.freeze({ enabled: false, issuer: null, clientId: null, clientSecret: null, ownerSub: null, mfaAcr: null, redirectUri: null, ...common });
  }
  let issuer;
  try { issuer = new URL(env.AUTH_ISSUER || ''); } catch { invalid('AUTH_ISSUER est requis (URL HTTPS de l’émetteur OIDC).'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
    invalid('AUTH_ISSUER doit être une URL HTTPS sans identifiants, requête ni fragment.');
  }
  const clientId = secret('AUTH_CLIENT_ID'), clientSecret = secret('AUTH_CLIENT_SECRET');
  if (!clientId) invalid('AUTH_CLIENT_ID est requis.');
  if (!clientSecret) invalid('AUTH_CLIENT_SECRET est requis (client Web confidentiel).');
  const ownerSub = env.AUTH_OWNER_SUB || '';
  if (!ownerSub || ownerSub.length > 255 || /[\u0000-\u001f\u007f\s]/.test(ownerSub)) invalid('AUTH_OWNER_SUB est requis (identifiant sub exact du propriétaire).');
  // Niveau d'authentification exigé (claim acr exact de l'ID token signé, p. ex. « relay-mfa » associé au LoA 2 de Keycloak).
  const mfaAcr = claimValue(env, 'AUTH_MFA_ACR');
  if (!mfaAcr) invalid('AUTH_MFA_ACR est requis (valeur acr exacte de l’authentification forte).');
  if (common.idleTtlMs > common.sessionTtlMs) invalid('AUTH_IDLE_TTL_HOURS ne peut pas dépasser AUTH_SESSION_TTL_HOURS.');
  // Émetteur exact, tel que publié dans le document de découverte (sans barre finale ajoutée).
  const issuerText = env.AUTH_ISSUER;
  return Object.freeze({
    enabled: true, issuer: issuerText, clientId, clientSecret, ownerSub,
    mfaAcr,
    redirectUri: `${base.origin}/auth/callback`, ...common,
  });
}
