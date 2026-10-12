#!/usr/bin/env bash
# lang-switch-poc.sh: build and run every proof-of-concept behind docs/architecture/lang-switch-fable.md,
# one after another so they do not perturb each other, and write one JSON file per experiment.
#
#   c.json          C + sqlite3_interrupt floor (work-scripts/c/sqlite-interrupt-floor.c)
#   mattn.json      Go, cgo driver          (work-scripts/go/sqlite-poc/cmd/mattn)
#   modernc.json    Go, transpiled driver   (work-scripts/go/sqlite-poc/cmd/modernc)
#   ncruces.json    Go, wasm2go driver      (work-scripts/go/sqlite-poc/cmd/ncruces)
#   deno-lane.json  Deno child-process lane kill/restart cost (work-scripts/deno/lane-kill-latency.ts)
#   deno-ffi.json   Deno FFI nonblocking step + sqlite3_interrupt (work-scripts/deno/ffi-sqlite-interrupt.ts)
#   deno-ffi-read.json  point-read cost: node:sqlite vs FFI blocking vs FFI nonblocking
#   load.txt        host load average before and after
#
# Usage: bash work-scripts/bash/lang-switch-poc.sh [out-dir]      (repo root; default out-dir is a temp dir)
# Env:   LONG_ROWS (default 60000000) sizes the long statement; it is always cancelled, never finished.
# Needs: go (/usr/local/go), gcc, deno, and the mattn module in the Go module cache (go mod download).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PATH="/usr/local/go/bin:$HOME/.deno/bin:$PATH"
export GOFLAGS=-buildvcs=false
OUT="${1:-$(mktemp -d /tmp/lang-switch-poc.XXXXXX)}"
mkdir -p "$OUT"
BIN="$(mktemp -d /tmp/lang-switch-bin.XXXXXX)"
trap 'rm -rf "$BIN"' EXIT
LONG_ROWS="${LONG_ROWS:-60000000}"
export LONG_ROWS

echo "building Go drivers"
(cd work-scripts/go/sqlite-poc && go mod download && go vet ./... &&
  go build -o "$BIN/mattn" ./cmd/mattn &&
  go build -o "$BIN/modernc" ./cmd/modernc &&
  go build -o "$BIN/ncruces" ./cmd/ncruces)
AM="$(go env GOMODCACHE)/github.com/mattn/go-sqlite3@v1.14.52"
echo "building C floor (amalgamation from $AM)"
gcc -O2 -DSQLITE_THREADSAFE=2 -DSQLITE_OMIT_LOAD_EXTENSION -I"$AM" \
  work-scripts/c/sqlite-interrupt-floor.c "$AM/sqlite3-binding.c" -lpthread -ldl -lm \
  -o "$BIN/c-floor" 2>/dev/null

echo "load before: $(cut -d' ' -f1-3 /proc/loadavg)" | tee "$OUT/load.txt"
run() { # name, command...
  local name="$1"; shift
  echo "== $name  ($(date -u +%H:%M:%S), load $(cut -d' ' -f1 /proc/loadavg))"
  "$@" > "$OUT/$name.json"
}
run c       "$BIN/c-floor" "$LONG_ROWS"
run mattn   "$BIN/mattn"
run modernc "$BIN/modernc"
run ncruces "$BIN/ncruces"
run deno-lane     deno run --allow-run --allow-env work-scripts/deno/lane-kill-latency.ts
run deno-ffi      deno run --allow-ffi --allow-env work-scripts/deno/ffi-sqlite-interrupt.ts
run deno-ffi-read deno run --allow-ffi --allow-env --allow-read --allow-write work-scripts/deno/ffi-sqlite-read-cost.ts
echo "load after: $(cut -d' ' -f1-3 /proc/loadavg)" | tee -a "$OUT/load.txt"

python3 - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
def load(n):
    with open(os.path.join(out, n + ".json")) as f: return json.load(f)
print("\n%-9s %7s %13s  %s" % ("driver", "fds/conn", "cancel ms", "reads on other tenants p50/p99 ms while K=1,2,4,8 long statements run"))
for n in ["c", "mattn", "modernc", "ncruces"]:
    d = load(n)
    reads = "  ".join("%.3f/%.2f" % (w["reads_on_other_tenants"]["p50_ms"], w["reads_on_other_tenants"]["p99_ms"]) for w in d["windows"])
    print("%-9s %7.1f %13.3f  %s" % (n, d["fds_per_open_connection"], d["single_cancel_latency_ms"], reads))
l = load("deno-lane"); print("\ndeno lane: spawn->ready %.1f ms, SIGKILL->exit %.1f ms, restart->ready %.1f ms" % (l["spawn_to_ready_ms_median"], l["kill_to_exit_ms"], l["restart_to_ready_ms"]))
f = load("deno-ffi"); print("deno ffi:  event loop ticks during step %d, interrupt latency %.2f ms, rc %d" % (f["event_loop_ticks_during_step"], f["interrupt_latency_ms"], f["rc"]))
r = load("deno-ffi-read"); print("deno read: node:sqlite %.1f/%.1f us, ffi blocking %.1f/%.1f us, ffi nonblocking %.1f/%.1f us (p50/p99)" % (
    r["node_sqlite_sync_us"]["p50_us"], r["node_sqlite_sync_us"]["p99_us"], r["ffi_blocking_us"]["p50_us"], r["ffi_blocking_us"]["p99_us"], r["ffi_nonblocking_us"]["p50_us"], r["ffi_nonblocking_us"]["p99_us"]))
print("\nresults in", out)
PY
