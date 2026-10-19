# Relay Desk — OVH test environment

This overlay is only for synthetic data. It forces `RELAY_CONNECTORS_ENABLED=false`, `RELAY_AI_ENABLED=false`, and `DEMO_DATA=0`. It must never receive the Mac's `.env`, data directory, message databases, OAuth tokens, WhatsApp session, Mistral key, or existing credentials. Provision fresh identity and vault secrets instead. `seed.mjs` accepts an empty explicit directory and refuses any nonempty directory before opening a database.

## Infrastructure and cost

Existing OVH Public Cloud project `perso-project`, one `b3-8` instance `relay-desk-test-fr`, GRA11/Gravelines: Debian 13, 2 vCPU, 8 GiB RAM, 50 GB local NVMe. OVH creation estimate: €0.0612/hour before VAT, approximately €44.67/month before VAT at 730 hours (€53.60 with 20% VAT; €54.64 at 744 hours). No second VM, paid volume, or managed database is required by this test overlay. Budget ceiling is €100/month; review actual invoices, any domain registration/renewal and new resources before adding them.

Relay Desk, Keycloak and PostgreSQL share this VM in separate containers. This is an explicit **test-only** exception to the production identity-isolation recommendation: loss or compromise of the VM affects both app and identity. No real-data migration is authorized by these files.

## Network and identity

Intended application: `https://relay.migeoncorp.fr`; identity: `https://auth.relay.migeoncorp.fr/realms/relay-test`. Domain registration/delegation must exist in the public parent zone before enabling the proxy and requesting trusted certificates. A DNS zone listed in OVH alone does not establish registration.

Use the base `compose.yaml`, `relay.compose.yaml` and `identity.compose.yaml` together, with `/etc/relay-desk-test/hosted.env` outside the checkout. The installed `relayctl` wrapper specifies these paths and does not read the Mac's configuration. All secret values are file mounts outside source/data; do not put them in environment text or Git. `ACME_EMAIL` remains required by the base Compose schema but the test Caddyfile deliberately omits the email directive, so no contact address is transmitted.

Only Caddy's ports 80 and 443 are intended to be public. Relay, PostgreSQL, Keycloak management and the Caddy admin API must not be published. Keycloak HTTP administration, if enabled by the identity overlay, must bind to host loopback only and be reached over SSH. Docker published ports bypass UFW rules: inspect the resolved Compose bindings and actual listeners rather than relying on UFW alone. SSH uses a dedicated key and an allow rule restricted to the administrator's current public IP; update that rule through OVH console if the Mac's address changes.

The proxy permits only the test realm OIDC discovery/protocol/login-actions and static login resources; admin, master realm, account console, health and metrics are denied publicly. Real OTP must be required by the authentication flow; the MFA `acr` must be derived from achieved LoA, never hardcoded onto every token. Relay additionally checks exact owner `sub` and `acr`.

## Backup and recovery limits

`backup.sh` uses the existing encrypted SQLite backup tool, a separate key and a networkless transient container. `relay-test-backup.timer` schedules a daily encrypted application backup. Archives and status live under `/srv/relay-desk-test/backups`, separate from data and keys. Copy only encrypted archives to independent storage and rehearse a restore into a new directory; restoring must retain the connector/AI hold. Never copy the old Mac database as a shortcut.

This application archive does not include PostgreSQL/Keycloak, TLS state or secret keys. Reprovisioning a test identity is possible from the configuration script with new credentials, but is not a full identity disaster-recovery plan. Do not label this environment ready for real messages until independent encrypted backups, separate key custody, Keycloak recovery, monitoring, domain renewal, identity isolation and a full restore have been addressed. The app operations status intentionally reports missing offsite/restore evidence.

Do not enable provider connections, import actual mail, run AI on real conversations, or send messages as part of test deployment acceptance.
