# Personal deployment — relay.noegim.com

19 October 2026. Direct WhatsApp QR UI is deployed with app image `relay-desk:4b8e257` on the existing OVH instance. The personal overlay replaces the test app/proxy configuration, with a fresh empty data directory and vault/backup keys. Test data remains in its original directory. The new owner realm is `relay` (test realm stays separate). Existing Keycloak/Postgres containers, shared database credentials, Caddy certificate volumes and networks are preserved.

## Enrolment gate

The new owner receives only a temporary password and must personally choose a permanent password, enrol OTP and complete the Keycloak profile. Agent-known test credentials cannot authenticate to the new Relay owner configuration. Owner enrolment is complete: required actions cleared, password+OTP enrolled, and a new authenticated browser session reached Relay. After refreshed recovery checks, the connector runtime is enabled for WhatsApp. No phone has been linked yet. The operator does not enter or request the owner's permanent password or authenticator codes.

The user explicitly requested real hosted WhatsApp linking. No Mac database, existing WhatsApp session, email OAuth credential or Mistral key is transferred. Gmail/Outlook/AI credential mounts are deliberately omitted, their file variables blank and AI disabled. At activation, only WhatsApp can connect. Existing exact-preview, session/content binding and single-use send approval remain in force; no test message may be sent without the owner's exact-preview approval.

## Operation

The operator may enable hosted mail clients with `/etc/relay-desk-personal/mail.compose.yaml`, loaded last by `relayctl`. This private override mounts the four dedicated Web client files in addition to the three owner/vault files, and sets the verified Microsoft tenant. AI defaults to disabled; after explicit owner authorization, the private override can mount `mistral_api_key`, set `MISTRAL_API_KEY_FILE` and enable `RELAY_AI_ENABLED`. Client secrets, account tokens and real messages remain outside Git. Before enabling mail or AI, validate the composed configuration and runtime client readiness; connect each mailbox from the recently authenticated owner session and confirm its destination profile and import window. Verify AI with fictional text first. AI actions run on request and provider consent does not approve any message send.

Use `deploy/personal/relayctl` with `/etc/relay-desk-personal/hosted.env`; never use the test wrapper for the personal runtime. The environment file stays root0600 outside source. Data is `/srv/relay-desk-personal/data/initial`, secrets `/etc/relay-desk-personal/secrets` (root0700; files UID1000/0400), and backup key `/etc/relay-desk-personal/backup/backup_key` (distinct from vault key). The same four services share one existing VM; app and identity are **not isolated across hosts**. A root operator or Keycloak administrator can access/reset server-side credentials. No production isolation or operator-blind security is claimed. This uses no additional paid resource, retaining the existing approximately€54/month including20%VAT estimate under the€100 ceiling.

The proxy exposes only the `relay` realm discovery, protocol, login actions and resources. Admin/master/test realm, account console, health/metrics management remain private. Keycloak admin remains host-loopback18080, database internal, app unpublished. TLS state persists in the existing Caddy volumes; HTTPS and anonymous private API denial are checked after cutover.

## Backup and recovery

`backup.sh` creates an existing-format AES256GCM app archive plus a PostgreSQL custom dump encrypted by `identity-archive.mjs`, with the backup key distinct from the vault key. The dump passes through a pipe, never a plaintext host file. A unique encrypted staging directory is published by exclusive link only after both pg_dump and encryption succeed. A failed dump cannot leave a final archive. Decryption authenticates into the operator container's tmpfs before emitting data to a disposable restore; never pipe unverified plaintext into the live database.

`relay-personal-backup.service/timer` runs daily server-side, alongside the preserved test timer. Archives stay under personal backup/identity-backup paths; keys are outside both paths. These scheduled server copies are **not automatic off-server backups**. One encrypted application+identity baseline was copied to the Mac with matching SHA256; new server recovery keys are held separately in a private0700/0600 Mac folder. The identity archive authenticated using that independent key copy. The app archive restored on the Mac with connector/AI hold; the identity archive restored into a disposable networkless Postgres17 tmpfs container and three realms were verified. The temporary restore container was removed.

The baseline was refreshed after owner password/OTP setup, restored again in the isolated PostgreSQL checker and copied/authenticated on the Mac. Refresh again after actual linking. Future copies off the VM, retention and disaster-recovery drills require ongoing operational attention; none are claimed automated. Live SQLite message content is not database-encrypted; secrets and archives are encrypted, and file permissions restrict active data. HTTPS certificates renew via Caddy; a future actual renewal is not yet observed.

## Verified status and pending work

- 345 app tests passed in a networkless build on OVH before deploying; 346 tests pass locally and in networkless Docker after adding the authenticated-backup regression.
- Personal Compose and Caddy validated; independent review found no remaining P1/P2 after fixing encrypted-dump publication on producer failure.
- Personal app is healthy, public readiness200, unauthenticated private API401, personal OIDC discovery reachable with trusted HTTPS.
- Owner handoff completed and server-side enrolment metadata verified. The spent temporary password was removed. Recovery copies were refreshed and verified; WhatsApp is enabled while mail/AI credentials remain absent. The next step is the live QR in Personnel; the user scans and approves from their phone. Never substitute the saved synthetic screenshot for a live QR.
