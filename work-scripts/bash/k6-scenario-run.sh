#!/usr/bin/env bash
# k6-scenario-run.sh — run one `deno task perf:*` scenario against a throwaway server.
# Starts platform/server.ts on a free port with a fresh scratch DATA_DIR, creates logs/k6/<run-id>/,
# runs the task with K6_RUN_ID / K6_OUT wired so raw.json and summary.json both land there, then
# stops the server and exits with k6's exit code. Extra args are appended to the k6 command.
#
# Usage:  bash work-scripts/bash/k6-scenario-run.sh <perf:load|perf:query|perf:mixed|perf:smoke> [run-id] [k6 args...]
# Env:    KEEP_SCRATCH=1 keeps the scratch DATA_DIR and server log (path is printed).
# Needs:  deno on PATH (export PATH="$HOME/.deno/bin:$PATH"), k6, python3 (free-port lookup).
set -euo pipefail

task="${1:?usage: k6-scenario-run.sh <perf:task> [run-id] [k6 args...]}"
run_id="${2:-${task#perf:}-$(date -u +%Y%m%dT%H%M%SZ)}"
shift $(( $# < 2 ? $# : 2 ))

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
scratch="$(mktemp -d /tmp/k6-scenario.XXXXXX)"
out_dir="logs/k6/$run_id"

# setsid gives the server its own process group, so one kill reaps deno, the task shell and the reader.
DATA_DIR="$scratch/data" PORT="$port" setsid deno task serve >"$scratch/server.log" 2>&1 &
server_pid=$!
cleanup() {
  kill -TERM -- "-$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  if [ "${KEEP_SCRATCH:-}" = 1 ]; then echo "scratch kept: $scratch"; else rm -rf "$scratch"; fi
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "http://127.0.0.1:$port/health" >/dev/null || { echo "server did not come up; log:" >&2; cat "$scratch/server.log" >&2; exit 1; }

mkdir -p "$out_dir"
echo "run-id=$run_id port=$port data=$scratch/data" >&2
status=0
BASE_URL="http://127.0.0.1:$port" K6_RUN_ID="$run_id" K6_OUT="json=$out_dir/raw.json" \
  deno task "$task" "$@" || status=$?
ls -l "$out_dir" >&2
echo "k6 exit=$status" >&2
exit "$status"
