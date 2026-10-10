# k6 perf scripts

## Install

k6 is installed at `/usr/local/bin/k6` from the official Grafana Linux amd64 tarball:

```sh
curl -fsSL -o /tmp/k6.tar.gz \
  https://github.com/grafana/k6/releases/download/v0.56.0/k6-v0.56.0-linux-amd64.tar.gz
tar -xzf /tmp/k6.tar.gz -C /tmp
install -m 0755 /tmp/k6-v0.56.0-linux-amd64/k6 /usr/local/bin/k6
k6 version   # k6 v0.56.0 (commit/50afb99947, go1.23.4, linux/amd64)
```

Pinned version: **v0.56.0**, source URL above. This recipe is also recorded in the knowledge store
(`kb search "k6"`) since the droplet had no k6 install before this item.

## `smoke.js`

1 VU for 30s, replaying the same call order as `scripts/demo.ts` against the `tic-tac-toe` app: `createGame` →
`getGame` → 5x `makeMove` → `winsByMark`. Each iteration creates a fresh game, so iterations never collide.
Thresholds: `http_req_failed` rate < 1%, `http_req_duration` p(95) < 250ms, `checks` rate == 100%. Each
request carries `X-Trace-Id: <vu>-<iter>-<run-id>`.

A down or unreachable server makes every request fail (`http_req_failed` always counts connection-level
failures, and `perf/lib/api.js`'s `http.setResponseCallback` also counts non-200 responses), which fails the
thresholds and makes k6 exit non-zero — the script never reports a vacuous pass when it can't actually reach
the API.

## Run it

Start the server with a scratch data directory so test data doesn't collide with real app data:

```sh
DATA_DIR=$(mktemp -d) deno task serve
```

In another terminal, from the repo root:

```sh
deno task perf:smoke
```

The task creates `logs/k6/<run-id>/` itself (k6 does not create missing directories for its own output files,
and `handleSummary` in `perf/smoke.js` writes `summary.json` into that directory), then runs k6 with
`--out json=logs/k6/<run-id>/raw.json` — so both artifacts land under `logs/k6/<run-id>/` on every run. Set
`K6_RUN_ID` to choose the run id (e.g. `K6_RUN_ID=2026-10-10-smoke deno task perf:smoke`); it defaults to
`k6-smoke`. `perf/lib/api.js` reads the same variable, so the run id in the console summary and the directory
always agree.

To run k6 directly without the task wrapper, create the directory first (same pre-created directory for both
outputs):

```sh
export K6_RUN_ID=my-run; mkdir -p "logs/k6/$K6_RUN_ID"
k6 run --out json="logs/k6/$K6_RUN_ID/raw.json" perf/smoke.js
```

Both files land under `logs/k6/<run-id>/`, which is gitignored — this is local/CI run output, not something to
commit. A later workstream joins these files for analysis (see `docs/adr/0003-k6-perf.md`).

Override target/auth with environment variables if needed: `BASE_URL` (default `http://127.0.0.1:8000`),
`APP_ID` (default `tic-tac-toe`), `TOKEN` (default `dev-only`, matching the server's dev default).

## Not a benchmark

As the repo README states under "Deliberate limits": this is a local, trusted-application prototype with one
writer connection per app and one shared serial reader process, "enough to expose the design, not to establish
capacity." Treat `smoke.js` as a functional/regression check against the live HTTP surface, not as a capacity
or performance claim about this system.
