#!/bin/sh
set -eu
umask 077
cd /opt/relay-desk
archive="/backups/archives/$(date -u +%Y%m%dT%H%M%SZ).rlybak"
exec deploy/hosted-test/relayctl --profile backup run --rm --no-deps backup create --data-dir /data --archive "$archive" --backup-key-file /run/secrets/backup_key --vault-key-file /run/secrets/relay_secret_key --status-file /backups/status/last-backup.json
