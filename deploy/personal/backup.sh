#!/bin/bash
set -euo pipefail
umask 077
cd /opt/relay-desk
stamp=$(date -u +%Y%m%dT%H%M%SZ)
deploy/personal/relayctl --profile backup run --rm --no-deps backup create --data-dir /data --archive "/backups/archives/$stamp.rlybak" --backup-key-file /run/secrets/backup_key --vault-key-file /run/secrets/relay_secret_key --status-file /backups/status/last-backup.json
# Publish only after BOTH pg_dump and encryption succeed. Failed producers cannot leave a final archive.
identity_stage=$(mktemp -d /srv/relay-desk-personal/identity-backups/.identity-XXXXXX)
trap 'rm -rf "$identity_stage"' EXIT
chown 1000:1000 "$identity_stage"
# Dump only through a pipe; the operator container writes ciphertext, never plaintext to host disk.
if ! docker exec relay-desk-keycloak-db-1 sh -c 'export PGPASSWORD="$(cat /run/secrets/postgres_password)"; exec pg_dump -h 127.0.0.1 -U keycloak -d keycloak -Fc' |
 docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000 \
 -v /opt/relay-desk/deploy/personal/identity-archive.mjs:/tool.mjs:ro \
 -v /etc/relay-desk-personal/backup/backup_key:/run/backup-key:ro \
 -v "$identity_stage":/identity-stage \
 --entrypoint node relay-desk:4b8e257 /tool.mjs encrypt --key-file /run/backup-key --out /identity-stage/dump.kcbak; then
 exit 1
fi
ln "$identity_stage/dump.kcbak" "/srv/relay-desk-personal/identity-backups/$stamp.kcbak"
printf 'Encrypted application and identity backup complete: %s\n' "$stamp"
