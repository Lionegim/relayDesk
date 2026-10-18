import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAuthConfig } from '../src/auth/index.js';

const OK = { AUTH_ISSUER: 'https://idp.test/realms/relay', AUTH_CLIENT_ID: 'c', AUTH_CLIENT_SECRET: 's', AUTH_OWNER_SUB: 'sub-1', AUTH_MFA_ACR: 'relay-mfa' };
const read = (env, mode = 'hosted', publicBaseUrl = 'https://relay.test') => readAuthConfig({ env, mode, publicBaseUrl });

test('configuration : forme et valeurs par défaut', () => {
  const c = read(OK);
  assert.deepEqual(Object.keys(c).sort(), ['clientId', 'clientSecret', 'enabled', 'idleTtlMs', 'issuer', 'mfaAcr', 'ownerSub', 'publicBaseUrl', 'recentMs', 'redirectUri', 'secureCookies', 'sessionTtlMs']);
  assert.equal(c.enabled, true);
  assert.equal(c.redirectUri, 'https://relay.test/auth/callback');
  assert.equal(c.secureCookies, true);
  assert.equal(c.sessionTtlMs, 7 * 24 * 3600000);
  assert.equal(c.idleTtlMs, 24 * 3600000);
  assert.equal(c.recentMs, 15 * 60000);
  assert.ok(Object.isFrozen(c));
  assert.equal(read({}, 'local', 'http://127.0.0.1:4310').enabled, false, 'local : désactivé par défaut');
  assert.equal(read({ ...OK, AUTH_MODE: 'oidc' }, 'local', 'http://127.0.0.1:4310').secureCookies, false);
});

test('configuration : refus explicites, sans contournement en hébergé', () => {
  const bad = [
    [{ ...OK, AUTH_MODE: 'disabled' }, /exige AUTH_MODE=oidc/],
    [{ ...OK, AUTH_MODE: 'off' }, /oidc ou disabled/],
    [{ ...OK, AUTH_ISSUER: 'http://idp.test/realms/relay' }, /HTTPS/],
    [{ ...OK, AUTH_ISSUER: 'https://idp.test/realms/relay?x=1' }, /HTTPS/],
    [{ ...OK, AUTH_ISSUER: '' }, /AUTH_ISSUER est requis/],
    [{ ...OK, AUTH_CLIENT_ID: '' }, /AUTH_CLIENT_ID/],
    [{ ...OK, AUTH_CLIENT_SECRET: '' }, /AUTH_CLIENT_SECRET/],
    [{ ...OK, AUTH_OWNER_SUB: '' }, /AUTH_OWNER_SUB/],
    [{ ...OK, AUTH_OWNER_SUB: 'a b' }, /AUTH_OWNER_SUB/],
    [{ ...OK, AUTH_MFA_ACR: '' }, /AUTH_MFA_ACR est requis/],
    [{ ...OK, AUTH_SESSION_TTL_HOURS: '0' }, /hors limites/],
    [{ ...OK, AUTH_IDLE_TTL_HOURS: 'x' }, /entier/],
    [{ ...OK, AUTH_IDLE_TTL_HOURS: '48', AUTH_SESSION_TTL_HOURS: '24' }, /ne peut pas dépasser/],
  ];
  for (const [env, msg] of bad) assert.throws(() => read(env), msg, JSON.stringify(env));
});

test('configuration : secrets lus par la fonction fournie (NAME ou NAME_FILE)', () => {
  const asked = [];
  const c = readAuthConfig({ env: { ...OK, AUTH_CLIENT_ID: undefined, AUTH_CLIENT_SECRET: undefined }, mode: 'hosted', publicBaseUrl: 'https://relay.test',
    secret: name => { asked.push(name); return `${name}-lu`; } });
  assert.deepEqual(asked, ['AUTH_CLIENT_ID', 'AUTH_CLIENT_SECRET']);
  assert.equal(c.clientSecret, 'AUTH_CLIENT_SECRET-lu');
});
