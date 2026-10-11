#!/usr/bin/env bash
# Run a command with a private Postgres 17. Never uses the developer Compose project.
set -euo pipefail
if (($# == 0)); then set -- deno task ci; fi
container_id=
cleanup() {
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container_id=$(docker run -d --rm --memory=384m --cpus=1   -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:17)
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$container_id" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "Private Postgres failed readiness" >&2; exit 1; }
address=$(docker port "$container_id" 5432/tcp)
[[ "$address" =~ ^127\.0\.0\.1:[0-9]+$ ]] || exit 1
export TSDB_DISPOSABLE_POSTGRES=1
export DATABASE_URL="postgres://postgres@$address/postgres"
# Eliminate inherited deployment modes/object-store credentials.
export TENANCY=off S3_BASE_URL= BACKUP_INTERVAL_MS=0
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
echo "Isolated Postgres ready on $address; command: $*"
"$@"
