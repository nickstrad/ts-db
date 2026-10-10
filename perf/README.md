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

## Load scenarios

Three scenarios sit beside `smoke.js`. They share `perf/lib/scenarios.js` (seeding, the weighted read mix,
conflict-aware writes, artifact paths, `handleSummary`) and call the API only through `perf/lib/api.js`.

| task                   | script             | shape                                                                                                                                         | thresholds                                                                                            |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `deno task perf:load`  | `mutation_load.js` | `ramping-vus` 1 → 20 over 1 min, hold 1 min; each iteration plays its own game                                                                | `checks` rate > 0.99; `http_req_duration{expected_response:true}` p(95) < 400; `http_req_failed` < 1% |
| `deno task perf:query` | `query_load.js`    | `constant-arrival-rate` 50 rps for 2 min over 30 seeded games; `getGame`/`listGames`/`moveHistory`/`winsByMark` 4:2:2:1                       | `http_req_failed` < 1%; `http_req_duration` p(95) < 500; `checks` rate > 0.99; no dropped iterations  |
| `deno task perf:mixed` | `mixed.js`         | `constant-arrival-rate` 50 rps for 3 min, 80% reads (same mix) / 20% writes (one move of the VU's own game, or `createGame` when it finished) | same as `perf:query`; **the default scenario for regression comparison**                              |

**Conflicts are a success.** `mutation_load.js` deliberately sends a stale-`expectedVersion` move before every
third move of a game. The server must reject it; the run records that in the custom `conflicts` counter and a
check, and the request is declared an expected status (`400` today, `409` once the server maps
`ConflictError`), so it does not count in `http_req_failed`. A stale write that is _accepted_ fails a check.

**Seeding** happens in k6's `setup()`: `query_load.js` and `mixed.js` create 30 games (X wins, O wins, draws,
in-progress) through the API before the timed phase, so a fresh `DATA_DIR` needs no preparation. Seed requests
appear in `raw.json` under the `::setup` group with trace id `0-0-<run-id>`.

### Running a scenario with artifacts

The `perf:*` tasks are plain `k6 run <script>`; k6 only writes `raw.json` when given `--out`, and it creates
no directories. So set the run id, create the directory, and pass `K6_OUT`:

```sh
export K6_RUN_ID=2026-10-10-mixed
mkdir -p "logs/k6/$K6_RUN_ID"
K6_OUT="json=logs/k6/$K6_RUN_ID/raw.json" deno task perf:mixed
```

Both `logs/k6/<run-id>/raw.json` (newline-delimited JSON; filter `type = 'Point'` before `read_json_auto`, see
`docs/haiku-experiments/findings/sq-04.md`) and `summary.json` (written by the scenario's `handleSummary`,
with `run_id` and `scenario` added) land there. `K6_RUN_ID` also feeds the `X-Trace-Id` suffix, so trace ids
in the server's events match the directory name. If you forget it the run id falls back to `k6-smoke`, which
is smoke's directory — always set it.

`work-scripts/bash/k6-scenario-run.sh <perf:task> [run-id] [k6 args]` does all of the above against a
throwaway server on a free port with a fresh scratch `DATA_DIR`:

```sh
bash work-scripts/bash/k6-scenario-run.sh perf:mixed 2026-10-10-mixed
```

Thresholds are enforced by k6: a crossed threshold makes the task exit 99 (verified by temporarily changing
`query_load.js` to `p(95)<1`). `BASE_URL`, `APP_ID` and `TOKEN` work as for `smoke.js`.

### What these numbers mean

These scenarios measure this prototype's documented design: **one writer connection per app and one serial
reader process** shared by every query. `perf:load` is bounded by the single writer, `perf:query` by the
serial reader — that is the known capacity limit in the repo README, and `query_load.js` is the scenario that
exercises it. The thresholds and the numbers they produce are for **regression detection** — compare a run to
an earlier run of the same scenario on the same machine — not capacity claims.

Reference run on the dev droplet (2026-10-10, one run each, before items 12–22 land): `perf:load` p(95) 162 ms
with ~4k conflicts counted; `perf:query` p(95) 31 ms; `perf:mixed` p(95) 57 ms.

## Not a benchmark

As the repo README states under "Deliberate limits": this is a local, trusted-application prototype with one
writer connection per app and one shared serial reader process, "enough to expose the design, not to establish
capacity." Treat `smoke.js` as a functional/regression check against the live HTTP surface, not as a capacity
or performance claim about this system.
