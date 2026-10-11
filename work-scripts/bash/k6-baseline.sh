#!/usr/bin/env bash
# k6-baseline.sh — baseline harness for item 25: run the perf:smoke scenario 3x, each run against a fresh
# server (via k6-scenario-run.sh), then extract the numbers from each summary.json and print a per-run table,
# an aggregate row, and a recommended threshold table.
# Usage:  bash work-scripts/bash/k6-baseline.sh <run-id-prefix>     (works from any cwd)
# Writes: logs/k6/<prefix>-r{1,2,3}/{raw,summary}.json per run, logs/k6/<prefix>-rN/load_avg, and
# logs/k6/<prefix>/baseline.json.
# A k6 threshold failure is data, not a harness failure: each run's k6 exit code is recorded and the harness
# keeps going. The harness exits 1 only if a run left no summary.json, or if the run-id prefix was already used.
#
# Caveat: the req/s column is not a throughput measure. perf/smoke.js ends each 8-request iteration with
# sleep(1), so req/s mostly reflects that think time plus iteration latency; it moves only when iteration
# latency moves. Treat it as a sanity column, not capacity data.
#
# Each run records the host's 1/5/15-minute load averages (logs/k6/<run-id>/load_avg, and per run inside
# baseline.json). The harness warns on stderr when a run's 1-minute load exceeded the CPU count: host
# contention moves p95 2-3x, more than any regression the gate is meant to catch, so a baseline taken on a
# loaded host must be visible without reading the prose.
#
# k6's own banner and progress lines are redirected to stderr, so the harness stdout holds only the tables.
set -euo pipefail

prefix="${1:?usage: k6-baseline.sh <run-id-prefix>}"
runs=3
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
export PATH="$HOME/.deno/bin:$PATH"
# k6 0.56 leaves p(99) out of summary.json unless asked. This env var adds it without editing perf/smoke.js.
export K6_SUMMARY_TREND_STATS="avg,min,med,max,p(90),p(95),p(99)"

# Refuse to reuse run dirs: a stale summary.json from an earlier run must never pass for a fresh one.
for n in $(seq 1 "$runs"); do
  if [ -e "logs/k6/$prefix-r$n" ]; then
    echo "harness error: logs/k6/$prefix-r$n already exists; pick a new run-id prefix" >&2
    exit 1
  fi
done
if [ -e "logs/k6/$prefix" ]; then
  echo "harness error: logs/k6/$prefix already exists; pick a new run-id prefix" >&2
  exit 1
fi

pairs=()
for n in $(seq 1 "$runs"); do
  run_id="$prefix-r$n"
  echo "== run $n/$runs: $run_id" >&2
  status=0
  # k6's banner/progress lines go to stderr so this harness's stdout holds only the tables.
  bash work-scripts/bash/k6-scenario-run.sh perf:smoke "$run_id" 1>&2 || status=$?
  echo "== run $n/$runs: k6 exit=$status" >&2
  # Host load for this run: latency numbers taken under contention are not a clean baseline.
  mkdir -p "logs/k6/$run_id"
  cut -d' ' -f1-3 /proc/loadavg > "logs/k6/$run_id/load_avg"
  pairs+=("$run_id=$status")
done

k6_version="$(k6 version | awk '{print $2}')"
mkdir -p "logs/k6/$prefix"
python3 -I - "$prefix" "$repo_root" "$k6_version" "$K6_SUMMARY_TREND_STATS" "${pairs[@]}" <<'PY'
import json
import math
import os
import statistics
import sys

prefix, root, k6_version, trend_stats = sys.argv[1:5]
pairs = sys.argv[5:]

# Threshold rules, fixed before the first measurement so the numbers cannot be tuned after the fact.
HEADROOM = 1.5          # recommended limit = worst observed value across runs x HEADROOM (a convention, not derived)
ROUND_MS = 10           # ...rounded up to this many ms
P99_MAX_SPREAD = 0.25   # a p99 row is recommended only if (max - min) / mean of p99 across runs <= this


def fail(msg):
    print(f"harness error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_avg(run_id):
    """1/5/15-minute load averages recorded by the harness for this run, or None."""
    path = os.path.join(root, "logs", "k6", run_id, "load_avg")
    if not os.path.isfile(path):
        return None
    with open(path) as lfh:
        parts = lfh.read().split()
    try:
        return {"1m": float(parts[0]), "5m": float(parts[1]), "15m": float(parts[2])}
    except (ValueError, IndexError):
        return None


def load_run(pair):
    run_id, k6_exit = pair.rsplit("=", 1)
    path = os.path.join(root, "logs", "k6", run_id, "summary.json")
    if not os.path.isfile(path):
        fail(f"{path} missing (k6 exit={k6_exit}); the run produced no summary")
    with open(path) as fh:
        data = json.load(fh)
    metrics = data["metrics"]

    def vals(name):
        if name not in metrics:
            fail(f"{path}: metric '{name}' missing")
        return metrics[name]["values"]

    dur = vals("http_req_duration")
    for key in ("med", "p(95)", "p(99)"):
        if key not in dur:
            fail(f"{path}: http_req_duration has no '{key}'; check K6_SUMMARY_TREND_STATS={trend_stats}")
    checks = vals("checks")
    reqs = vals("http_reqs")
    failed = vals("http_req_failed")
    iters = vals("iterations")
    thresholds = {}
    for name, metric in metrics.items():
        for expr, verdict in (metric.get("thresholds") or {}).items():
            thresholds[f"{name} {expr}"] = bool(verdict["ok"])
    return {
        "run_id": run_id,
        "k6_exit": int(k6_exit),
        "host_load_avg": load_avg(run_id),
        "iterations": int(iters["count"]),
        "http_reqs": int(reqs["count"]),
        "throughput_rps": reqs["rate"],
        "p50_ms": dur["med"],
        "p95_ms": dur["p(95)"],
        "p99_ms": dur["p(99)"],
        "avg_ms": dur["avg"],
        "http_req_failed_rate": failed["rate"],
        # k6 Rate convention: `passes` counts the true observations, i.e. failed requests (`fails` = the rest).
        "http_req_failed_count": int(failed["passes"]),
        "checks_passes": int(checks["passes"]),
        "checks_fails": int(checks["fails"]),
        "thresholds_ok": thresholds,
    }


runs = [load_run(p) for p in pairs]

# Contention check: a 1-minute load above the CPU count means these numbers are host-influenced.
cpus = os.cpu_count() or 1
loaded = [r for r in runs if r["host_load_avg"] and r["host_load_avg"]["1m"] > cpus]
if loaded:
    names = ", ".join(f"{r['run_id']} (1m load {r['host_load_avg']['1m']:.2f})" for r in loaded)
    print(
        f"harness warning: 1-minute load exceeded {cpus} CPUs on {names}; "
        "these latency numbers are contention-influenced, not a clean baseline",
        file=sys.stderr,
    )

NUMERIC = [
    "iterations", "http_reqs", "throughput_rps", "p50_ms", "p95_ms", "p99_ms", "avg_ms",
    "http_req_failed_rate", "checks_passes", "checks_fails",
]
agg = {}
for key in NUMERIC:
    series = [r[key] for r in runs]
    agg[key] = {"min": min(series), "max": max(series), "mean": statistics.fmean(series)}


def load_cell(r):
    return f"{r['host_load_avg']['1m']:.2f}" if r["host_load_avg"] else "-"


# Per-run table.
print(f"## Per-run results (prefix {prefix}, k6 {k6_version})\n")
print("| run | k6 exit | load 1m | iters | http reqs | req/s | p50 ms | p95 ms | p99 ms | avg ms | failed rate | checks pass | checks fail | thresholds failing |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |")
for r in runs:
    failing = [k for k, ok in r["thresholds_ok"].items() if not ok] or ["none"]
    print(f"| {r['run_id']} | {r['k6_exit']} | {load_cell(r)} | {r['iterations']} | {r['http_reqs']} | {r['throughput_rps']:.2f} "
          f"| {r['p50_ms']:.2f} | {r['p95_ms']:.2f} | {r['p99_ms']:.2f} | {r['avg_ms']:.2f} "
          f"| {r['http_req_failed_rate']:.4f} | {r['checks_passes']} | {r['checks_fails']} | {', '.join(failing)} |")

# Aggregate table: min / max / mean of each metric across the runs.
print("\n## Aggregate across runs (min / max / mean)\n")
print("| metric | min | max | mean |")
print("| --- | ---: | ---: | ---: |")
for key in NUMERIC:
    a = agg[key]
    print(f"| {key} | {a['min']:.4f} | {a['max']:.4f} | {a['mean']:.4f} |")

# Recommended thresholds for item 25.
def round_up(x, step):
    return int(math.ceil(x / step) * step)


p95s = [r["p95_ms"] for r in runs]
p99s = [r["p99_ms"] for r in runs]
total_failed = sum(r["http_req_failed_count"] for r in runs)
total_reqs = sum(r["http_reqs"] for r in runs)
total_checks_fails = sum(r["checks_fails"] for r in runs)
total_checks = sum(r["checks_passes"] + r["checks_fails"] for r in runs)
rec = []
worst_p95 = max(p95s)
rec.append((
    f"http_req_duration p(95)<{round_up(worst_p95 * HEADROOM, ROUND_MS)}",
    f"observed worst p95 {worst_p95:.2f}ms over {len(runs)} runs (mean {agg['p95_ms']['mean']:.2f}ms); "
    f"x{HEADROOM} headroom (convention) rounded up to {ROUND_MS}ms; current threshold is p(95)<250",
))
p99_spread = (max(p99s) - min(p99s)) / statistics.fmean(p99s)
p99_row = None
if p99_spread <= P99_MAX_SPREAD:
    worst_p99 = max(p99s)
    p99_row = (
        f"http_req_duration p(99)<{round_up(worst_p99 * HEADROOM, ROUND_MS)}",
        f"observed worst p99 {worst_p99:.2f}ms over {len(runs)} runs; spread {p99_spread:.0%} "
        f"(<= {P99_MAX_SPREAD:.0%} rule); x{HEADROOM} headroom rounded up to {ROUND_MS}ms",
    )
    rec.append(p99_row)
rec.append((
    "http_req_failed rate<0.01 (keep)",
    f"{total_failed} failed of {total_reqs} requests across {len(runs)} runs; the current limit is kept",
))
rec.append((
    "checks rate==1.0 (keep)",
    f"{total_checks_fails} failed of {total_checks} checks across {len(runs)} runs; the current rule is kept",
))

print("\n## RECOMMENDED THRESHOLD TABLE for item 25\n")
print("| threshold | measured anchor and justification |")
print("| --- | --- |")
for expr, why in rec:
    print(f"| `{expr}` | {why} |")
if p99_row is None:
    print(f"\nNot recommended: http_req_duration p(99) spread {p99_spread:.0%} across runs exceeds the "
          f"{P99_MAX_SPREAD:.0%} rule; with ~{round(statistics.fmean(r['http_reqs'] for r in runs))} requests "
          f"per run, p99 rests on a handful of samples.")

summary = {
    "prefix": prefix,
    "task": "perf:smoke",
    "k6_version": k6_version,
    "k6_summary_trend_stats": trend_stats,
    "rules": {"headroom": HEADROOM, "round_ms": ROUND_MS, "p99_max_spread": P99_MAX_SPREAD},
    "runs": runs,
    "aggregate": agg,
    "recommended_thresholds": [{"threshold": e, "justification": w} for e, w in rec],
}
out = os.path.join(root, "logs", "k6", prefix, "baseline.json")
with open(out, "w") as fh:
    json.dump(summary, fh, indent=2)
    fh.write("\n")
print(f"\nwrote {os.path.relpath(out, root)}")
PY
