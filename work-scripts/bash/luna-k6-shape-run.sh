#!/usr/bin/env bash
# Run one lx-04 scratch k6 shape against a localhost-only server and fresh DATA_DIR.
# Usage: bash work-scripts/bash/luna-k6-shape-run.sh <ramp|spike|sustained> [run-id]
set -euo pipefail

shape="${1:?usage: luna-k6-shape-run.sh <ramp|spike|sustained> [run-id]}"
case "$shape" in ramp|spike|sustained) ;; *) echo "unknown shape: $shape" >&2; exit 2 ;; esac
run_id="${2:-lx-04-$shape-$(date -u +%Y%m%dT%H%M%SZ)}"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
scratch="$(mktemp -d /tmp/lx-04-k6.XXXXXX)"
out_dir="logs/k6/$run_id"
mkdir -p "$out_dir"

BIND_HOST=127.0.0.1 PORT="$port" DATA_DIR="$scratch/data" setsid deno task serve >"$scratch/server.log" 2>&1 &
server_pid=$!
cleanup() {
  kill -TERM -- "-$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$scratch"
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 120); do
  if curl -fs "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  echo "server did not come up; log follows:" >&2
  cat "$scratch/server.log" >&2
  exit 1
fi

echo "shape=$shape run-id=$run_id port=$port data=$scratch/data" >&2
BASE_URL="http://127.0.0.1:$port" SHAPE="$shape" K6_RUN_ID="$run_id" \
  k6 run --out "json=$out_dir/raw.json" --summary-export="$out_dir/k6-summary.json" \
  work-scripts/deno/k6-load-shapes.js
