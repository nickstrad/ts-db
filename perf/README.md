# Perf: Load Scenarios

These k6 load scenarios measure the prototype's documented design: one writer connection per app and one serial reader process. The numbers are for regression detection and performance tracking, not capacity claims.

## Scenarios

### mutation_load.js

Ramping mutation load test with expected conflicts.

**Profile:**
- Ramps from 1 to 20 virtual users over 1 minute, then holds at 20 VUs for 1 minute (2 minutes total)
- Each VU creates its own game and makes moves with `expectedVersion`
- Concurrent moves on the same game produce stale-version conflicts, which are **expected and correct** — they are counted in a custom `conflicts` counter, not in `http_req_failed`

**Thresholds:**
- `checks` success rate > 99%
- `http_req_duration{expected_response:true}` p(95) < 400ms

**Run:**
```sh
# Start server with a fresh DATA_DIR
DATA_DIR=$(mktemp -d) deno task serve

# In another terminal, run the scenario
RUN_ID=$(date +%s) k6 run perf/mutation_load.js
```

**Output:**
- `logs/k6/<run-id>/raw.json` — raw k6 metrics in newline-delimited JSON format
- `logs/k6/<run-id>/summary.json` — aggregated summary with thresholds and metrics

### query_load.js

Read-heavy load test over a pre-seeded dataset, exercising the serialized reader process.

**Profile:**
- Constant arrival rate of 50 requests per second for 2 minutes
- Pre-seeds 50 games before the scenario begins
- Distributes requests across four query handlers weighted 4:2:2:1:
  - `getGame` (4) — single-document fetch
  - `listGames` (2) — filtered collection scan
  - `moveHistory` (2) — related document history
  - `winsByMark` (1) — aggregation

**Thresholds:**
- `http_req_failed` < 1% (< 0.01)
- `http_req_duration` p(95) < 500ms

**Run:**
```sh
# Start server with a fresh DATA_DIR
DATA_DIR=$(mktemp -d) deno task serve

# In another terminal, run the scenario
RUN_ID=$(date +%s) k6 run perf/query_load.js
```

**Output:**
- `logs/k6/<run-id>/raw.json` — raw k6 metrics
- `logs/k6/<run-id>/summary.json` — summary with thresholds

**Known limitation:** This scenario exercises the documented single-reader process architecture. Throughput scales with the reader's sequential execution and is not a claim of the system's true capacity under a different architecture.

### mixed.js

Mixed read/write load for regression detection.

**Profile:**
- 10 virtual users over 3 minutes
- 80% read operations, 20% write operations (random distribution per request)
- Reads query getGame, listGames, moveHistory, and winsByMark equally
- Writes create new games
- Conflicts on writes are tracked but do not fail the scenario

**Thresholds:**
- `http_req_failed` < 1%
- `http_req_duration` p(95) < 1000ms

**Run:**
```sh
# Start server with a fresh DATA_DIR
DATA_DIR=$(mktemp -d) deno task serve

# In another terminal, run the scenario
RUN_ID=$(date +%s) k6 run perf/mixed.js
```

**Output:**
- `logs/k6/<run-id>/raw.json` — raw k6 metrics
- `logs/k6/<run-id>/summary.json` — summary with thresholds

## Design notes

These scenarios measure this prototype's documented design:
- One writer connection per application (serialized mutations)
- One shared reader process with `DuckDB` attached to each application's SQLite file
- The reader serializes query handlers, so concurrent queries queue

This is not a throughput benchmark. The architecture prioritizes correctness and simplicity. Benchmark numbers are only valid for this specific design and are intended for regression detection as the code evolves, not for capacity planning.

All three scenarios expect the server to be running at `http://localhost:8080` by default. Override with `BASE_URL`, `APP_ID`, and `TOKEN` environment variables.
