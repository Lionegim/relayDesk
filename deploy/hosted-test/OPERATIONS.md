# Relay Desk — OVH test environment

This overlay is only for synthetic data. It forces `RELAY_CONNECTORS_ENABLED=false`, `RELAY_AI_ENABLED=false`, and `DEMO_DATA=0`. It must never receive the Mac's `.env`, data directory, message databases, OAuth tokens, WhatsApp session, Mistral key, or existing credentials. Provision fresh identity and vault secrets instead. `seed.mjs` accepts an empty explicit directory and refuses any nonempty directory before opening a database.

## Infrastructure and cost

Existing OVH Public Cloud project `perso-project`, one `b3-8` instance `relay-desk-test-fr`, GRA11/Gravelines: Debian 13, 2 vCPU, 8 GiB RAM, 50 GB local NVMe. OVH creation estimate: €0.0612/hour before VAT, approximately €44.67/month before VAT at 730 hours (€53.60 with 20% VAT; €54.64 at 744 hours). No second VM, paid volume, or managed database is required by this test overlay. Budget ceiling is €100/month; review actual invoices, any domain registration/renewal and new resources before adding them.

Relay Desk, Keycloak and PostgreSQL share this VM in separate containers. This is an explicit **test-only** exception to the production identity-isolation recommendation: loss or compromise of the VM affects both app and identity. No real-data migration is authorized by these files.

## Network and identity

Live test application: `https://relay.noegim.com`; identity: `https://auth.relay.noegim.com/realms/relay-test`. Domain registration/delegation must exist in the public parent zone before enabling the proxy and requesting trusted certificates. A DNS zone listed in OVH alone does not establish registration.

Use the base `compose.yaml`, `relay.compose.yaml` and `identity.compose.yaml` together, with `/etc/relay-desk-test/hosted.env` outside the checkout. The installed `relayctl` wrapper specifies these paths and does not read the Mac's configuration. For the base preflight, project the application variables into `/etc/relay-desk-test/relay-preflight.env` (root 0600), excluding `IDENTITY_*` and `RELAY_IDENTITY_DOMAIN`; validate that file using `deploy/preflight.mjs`, and validate the full three-file Compose separately. The identity variables are checked by Compose/runtime rather than the base app-only validator.

All secret values are file mounts outside source/data; do not put them in environment text or Git. `ACME_EMAIL` remains required by the base Compose schema but the test Caddyfile deliberately omits the email directive, so no contact address is transmitted.

The overlay reserves backend subnet `172.30.40.0/24` and Caddy address `172.30.40.10`; Keycloak trusts forwarded headers only from `172.30.40.10/32`. Check host route conflicts before changing this subnet.

Only Caddy's ports 80 and 443 are intended to be public. Relay, PostgreSQL, Keycloak management and the Caddy admin API must not be published. Keycloak HTTP administration, if enabled by the identity overlay, must bind to host loopback only and be reached over SSH. Docker published ports bypass UFW rules: inspect the resolved Compose bindings and actual listeners rather than relying on UFW alone. SSH uses a dedicated key and an allow rule restricted to the administrator's current public IP; update that rule through OVH console if the Mac's address changes.

The proxy permits only the test realm OIDC discovery/protocol/login-actions and static login resources; admin, master realm, account console, health and metrics are denied publicly. Real OTP must be required by the authentication flow; the MFA `acr` must be derived from achieved LoA, never hardcoded onto every token. Relay additionally checks exact owner `sub` and `acr`.

## Backup and recovery limits

`backup.sh` uses the existing encrypted SQLite backup tool, a separate key and a networkless transient container. `relay-test-backup.timer` schedules a daily encrypted application backup. Archives and status live under `/srv/relay-desk-test/backups`, separate from data and keys. Copy only encrypted archives to independent storage and rehearse a restore into a new directory; restoring must retain the connector/AI hold. Never copy the old Mac database as a shortcut.

This application archive does not include PostgreSQL/Keycloak, TLS state or secret keys. Reprovisioning a test identity is possible from the configuration script with new credentials, but is not a full identity disaster-recovery plan. Do not label this environment ready for real messages until independent encrypted backups, separate key custody, Keycloak recovery, monitoring, domain renewal, identity isolation and a full restore have been addressed. The app operations status intentionally reports missing offsite/restore evidence.

Do not enable provider connections, import actual mail, run AI on real conversations, or send messages as part of test deployment acceptance.

## Acceptance status — 19 October 2026

On OVH, PostgreSQL 17.11 and optimized Keycloak 26.8.1 started successfully with the restricted UID/secret mounts. The fresh `relay-test` realm and fictional `owner-test` were configured through localhost administration, Relay booted healthy, and the application preflight passed. After an actual VM reboot, all three services restarted automatically and became healthy; the backup timer remained active. Anonymous checks returned 200 with only `{ "ok": true }` for readiness and 401 for state and private operations. Before opening HTTPS, external TCP checks found only SSH open among ports 22/80/443/4310/5432/9000/18080; SSH itself is limited by UFW to the administrator IP. All 320 tests passed on Mac and in the networkless Linux Docker test stage, with none skipped. Caddy configuration validated offline. Daily encrypted app backup completed successfully; its first synthetic archive restored into a new directory with connectors held. An encrypted archive copy was verified by SHA-256 on the Mac. Independent offsite restore/key custody and Keycloak backups remain unverified.

Public test HTTPS is active at `https://relay.noegim.com`, with identity at `https://auth.relay.noegim.com/realms/relay-test`. The owner chose the existing registered `noegim.com` domain after the initial `migeoncorp.fr` choice proved unregistered. Both new A records point to 151.80.173.96 with TTL 300 in the existing OVH DNS zone. Existing website, mail and other records were left unchanged; no domain was purchased. The old unregistered zone has no public delegation and is not used.

Trusted Let's Encrypt certificates were issued for both names and verified through the normal trust store (no validation bypass), expiring 17 January 2027. Caddy stores certificates and ACME state in persistent volumes with automatic renewal configured; an actual future renewal has not yet occurred. HTTP redirects to HTTPS (308), and the old `.fr` OAuth callback is rejected (400 without redirect). Public admin/master/account/health/metrics and ambiguous encoded path probes return 400/404. After public exposure, only 80/443 and administrator-restricted SSH are expected externally; app/database/identity management ports remain private.

The live public MFA proof verifies real OTP, signature/JWKS, exact issuer/audience/nonce/expiry/owner/ACR, mandatory new OTP even with reused SSO cookies, confidential client+PKCE, Relay callback and authenticated state. Chrome completed real login, read fictional conversations, saved a local fictional draft and retained it across reload, revoked the separate automated test session, logged out and required fresh OTP on the existing Keycloak SSO session. Sending remained disabled. No real provider was connected and no message was sent.

The first live browser check caught a fresh-installation defect: the UI requested a hardcoded `anove` profile before its fallback could run, causing a 400 when only `perso` existed. The corrected client starts without a profile, the paginated API resolves an existing first profile, and explicit invalid profiles remain rejected. Pagination stays bounded; HTTP and UI regressions cover an installation without `anove`. Runtime image `relay-desk:841df9c` contains this fix; 320 tests pass on Mac and in the Linux Docker test stage, zero skipped. Static cache version was renewed; this environment still contains exactly three fictional conversations and no provider secrets.

Final public restart acceptance: after a second actual VM reboot with all four services installed, Relay/PostgreSQL/Keycloak became healthy, Caddy served both names with exactly the same trusted certificate fingerprints, and the daily backup timer was active. The existing Chrome session and exact saved fictional draft survived page reload. External TCP checks found 22/80/443 open and 4310/5432/9000/18080 closed or filtered; SSH remains restricted by UFW to the administrator IP. The extended live MFA proof passed all 32 checks, including bounded paginated bootstrap without a hardcoded profile and rejection of an explicitly unknown profile.
