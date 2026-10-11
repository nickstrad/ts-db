#!/usr/bin/env bash
# server-acceptance.sh — item 22's process-level acceptance checks against a throwaway server.
# Starts platform/server.ts on a free port with scratch DATA_DIR / LOG_DIR / LOCAL_OBJECT_DIR, then:
#   1. `deno task demo` and `deno task demo tic-tac-toe-json` against it;
#   2. three requests with caller-supplied X-Trace-Id values (echo checked);
#   3. SIGTERM, then: exit code 0, each trace id present in the server's JSONL log, and the log's
#      last line a `lifecycle` `shutdown` event;
#   4. `deno task explain` stdout cmp'd byte-identical against the committed GENERATED_SQL.txt.
# Exits non-zero on the first failed check.
#
# Usage:  bash work-scripts/bash/server-acceptance.sh        (from the repo root)
# Env:    KEEP_SCRATCH=1 keeps the scratch dir (path is printed).
# Needs:  deno on PATH (export PATH="$HOME/.deno/bin:$PATH"), curl, python3.
set -euo pipefail

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
scratch="$(mktemp -d /tmp/server-acceptance.XXXXXX)"
base="http://127.0.0.1:$port"

DATA_DIR="$scratch/data" LOG_DIR="$scratch/logs" LOCAL_OBJECT_DIR="$scratch/objects" PORT="$port" \
  EVENT_FLUSH_MS=50 S3_BASE_URL="" setsid deno run -A platform/server.ts >"$scratch/server.out" 2>&1 &
server_pid=$!
cleanup() {
  kill -KILL -- "-$server_pid" 2>/dev/null || true
  if [ "${KEEP_SCRATCH:-}" = 1 ]; then echo "scratch kept: $scratch"; else rm -rf "$scratch"; fi
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

for _ in $(seq 1 120); do
  curl -fs "$base/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fs "$base/health" >/dev/null || { cat "$scratch/server.out" >&2; fail "server did not come up"; }

# 1. Demos.
BASE_URL="$base" deno task demo >"$scratch/demo-columns.txt" 2>&1 || { cat "$scratch/demo-columns.txt" >&2; fail "demo"; }
BASE_URL="$base" deno task demo tic-tac-toe-json >"$scratch/demo-json.txt" 2>&1 ||
  { cat "$scratch/demo-json.txt" >&2; fail "demo tic-tac-toe-json"; }
grep -q "Won games:" "$scratch/demo-columns.txt" || fail "demo output incomplete"
grep -q "Won games:" "$scratch/demo-json.txt" || fail "demo tic-tac-toe-json output incomplete"
echo "ok: deno task demo, deno task demo tic-tac-toe-json"

# 2. Caller-supplied trace ids.
trace_ids=()
for i in 1 2 3; do
  id="acceptance-$(date +%s)-$RANDOM-$i"
  trace_ids+=("$id")
  echoed="$(curl -fs -o /dev/null -D - -X POST "$base/apps/tic-tac-toe/mutation/createGame" \
    -H "authorization: Bearer dev-only" -H "x-trace-id: $id" -d '{"xPlayer":"a","oPlayer":"b"}' |
    tr -d '\r' | awk -F': ' 'tolower($1)=="x-trace-id"{print $2}')"
  [ "$echoed" = "$id" ] || fail "X-Trace-Id not echoed for $id (got '$echoed')"
done
echo "ok: X-Trace-Id echoed"

# 3. SIGTERM, exit code, log contents.
kill -TERM "$server_pid"
code=0
wait "$server_pid" || code=$?
[ "$code" = 0 ] || { cat "$scratch/server.out" >&2; fail "server exited $code after SIGTERM"; }
logs=$(find "$scratch/logs/server" -name "*-$server_pid-*.jsonl" | sort)
[ -n "$logs" ] || fail "no server log for pid $server_pid"
for id in "${trace_ids[@]}"; do
  # shellcheck disable=SC2086
  grep -q "\"traceId\":\"$id\"" $logs || fail "trace id $id not in the server log"
done
echo "ok: all ${#trace_ids[@]} caller trace ids found in the server JSONL log"
last="$(tail -n 1 "$(echo "$logs" | tail -n 1)")"
echo "$last" | grep -q '"kind":"lifecycle"' && echo "$last" | grep -q '"phase":"shutdown"' ||
  fail "last log line is not the lifecycle shutdown event: $last"
echo "ok: SIGTERM exit 0; last log line is lifecycle shutdown"

# 4. Explain output is byte-identical to the committed file.
deno task explain >"$scratch/explain.txt" 2>/dev/null
cmp "$scratch/explain.txt" GENERATED_SQL.txt || fail "deno task explain differs from GENERATED_SQL.txt"
echo "ok: deno task explain stdout == GENERATED_SQL.txt"
echo "PASS"
