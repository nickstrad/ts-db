# luna-23 — analysis catalog and logs CLI

Date: 2026-10-11. Branch: `luna/23-analysis-catalog`. Base: `001bbeb5b0f68b7fbb76a334572135e2d763186d`.

This is the blind item-23 attempt. The first session crashed in the Codex CLI before writing files; the
resumed session implemented the work. No other implementation was consulted. No merge to main or independent
review is claimed.

## Files built

- `platform/analysis/catalog.ts`: all ten named queries; descriptions and parameter metadata; shared optional
  UTC time windows; a required trace ID; typed name/parameter failures; bound values; a lazy `AnalysisLive`
  service that opens DuckDB read-only per call and releases both native handles. Native work finishes before
  interruption can close its handles. Results use the driver's JSON conversion, preserving large integers as
  strings.
- `scripts/logs.ts`: standalone reader-side Effect CLI for ingest, named queries, list and sweep;
  table/JSON/CSV output; strict argument parsing; nonzero errors on stderr. It composes the landed
  configuration, ingest, logging and retention services without importing the writer stack. Dry runs use a
  non-writing event sink, so a successful dry run does not create a CLI log file.
- `docs/observability.md`: every landed table column, each query's question and interpretation, task routes,
  parameters, real defaults, directory layout, retention limitations and trace examples.
- This findings file: explicit deliverable outside the product Owns set, including proposed tests below.

## Task routing

PASS: the frozen `deno.json` already defines `logs:ingest`, `logs:query`, `logs:sweep`, and `perf:mixed`. The
first three already point to `scripts/logs.ts`. I exercised those routes directly. No package-script
workaround was needed, so I did not edit or probe `package.json` scripts. There is no `logs:list` task; the
documented route is `deno run -A scripts/logs.ts list`. Neither config file changed.

## Acceptance assessment

All seven required queries returned real-data rows and exited 0 after the mixed workloads and ingest. The load
thresholds themselves failed, and the required persistent test additions remain outside scope.

- **PASS — real-data query row/exit assertions:** exact counts are below.
- **FAIL — mixed-load thresholds:** both full three-minute runs exited 99 for latency and dropped iterations.
  Neither had HTTP failures or failed request checks.
- **PASS — owned-file checks:** `deno fmt --check` on all four deliverables, `deno lint` on both TS files and
  direct `deno check` on both TS files passed.

| Criterion                                                    | Result  | Evidence / limit                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed ten-query catalog, parameterized SELECT/WITH SQL       | PASS    | All ten executed against a real DuckDB fixture through `AnalysisLive`; SELECT/WITH and single-statement assertions passed.                                                                                              |
| Name validation and unknown-name CLI failure                 | PASS    | `not-a-query`, `__proto__`, and `toString` exited nonzero with `UnknownAnalysisQuery` and valid names.                                                                                                                  |
| Required trace parameter and rejection of invalid parameters | PASS    | Missing trace ID, unknown parameter, duplicate CLI parameter, invalid timestamp, reversed window and invalid format all failed. An injection-shaped trace ID returned zero rows.                                        |
| Document every column, query, retention and trace workflow   | PASS    | DDL was transcribed from the landed source, including `dedupe`; the marked catalog table exactly matched exported names in an executed assertion.                                                                       |
| Checked-in doc-parity and SELECT/WITH tests                  | SKIPPED | `tests/unit/analysis_test.ts` is outside Owns. The executable equivalents passed ad hoc; proposed additions are below. Persistent regression coverage is still missing.                                                 |
| Regression suite                                             | PASS    | `deno task test`: 389 passed, 0 failed, 1 ignored, 1m40s. The ignored test is the existing real-S3 round trip.                                                                                                          |
| Sweep dry-run changes no files                               | PASS    | An older-file fixture was eligible for deletion; the reported dry-run plan included it and the before/after directory and file-content inventories were identical.                                                      |
| Full repository CI                                           | FAIL    | `deno task ci` stopped in fmt:check at unchanged `AGENTS.md`, `docs/luna-experiments.md`, and `docs/plans/effect-port-and-observability.md`. These are outside scope. Later CI stages were not reached by that command. |
| Real k6-to-platform join                                     | SKIPPED | `perf/ingest_k6.ts` is missing. Platform ingest does not populate `k6_points`; fixture join checks passed, but they are not a real k6 integration pass.                                                                 |

Additional fixture assertions covered SQL p50, execution counts, handler error fractions/tag mix,
dropped-event totals (not just report counts), backup gaps across the lower window boundary, cross-process
trace ordering, timezone-offset filtering, and scenario-specific k6/server p95. All ten queries returned
fixture rows. Fixture data was kept separate from the real workload logs.

The real sweep CLI also deleted an expired scratch file and returned valid JSON. Table output was checked on
the real queue row; CSV output round-tripped the compiled SQL texts through a CSV parser and matched the JSON
results, including delimiters inside the SQL text.

## Real workload evidence

Scratch root: `/tmp/luna23-acceptance.mGWh07`. Server: `127.0.0.1:18023`, isolated `DATA_DIR`, `LOG_DIR`,
`EVENTLOG_DUCKDB`, and local object directory, `TRACE_SQL=1`, `BACKUP_INTERVAL_MS=30000`. k6 was installed
(v0.56.0); the native DuckDB package worked. No environment-unavailable pass is claimed.

The first full three-minute `deno task perf:mixed` run used `BASE_URL=http://127.0.0.1:18023`,
`K6_RUN_ID=luna23`, and raw JSON output at `logs/k6/luna23/raw.json`. It overlapped the regression suite: exit
99, 8,792 requests, 17,584 passing checks, zero failing checks, zero HTTP failures, p95 866.04 ms, and 400
dropped iterations. Latency and dropped-iteration thresholds failed. This result is retained; the subsequent
run removes that known test-suite contention.

The CLI's initial ingest loaded 909 records; a later incremental ingest loaded 33,045 more, both with zero
rejected lines.

The second full run, `K6_RUN_ID=luna23-isolated`, ran after the regression suite had finished, using the same
server and dataset. It also exited 99: 8,882 requests, 17,764 passing checks, zero failures, zero HTTP
failures, p95 1,982.07 ms, 311 dropped iterations. Removing test-suite contention did not make the thresholds
pass. An incremental ingest ran near the beginning of this run; neither run is a controlled performance
benchmark. I did not change server/perf code or relax thresholds.

The server was stopped with SIGTERM and exited 0. The final `deno task logs:ingest` then scanned two source
files and loaded 32,242 further records / 15,057,933 bytes, rejecting zero lines (3,998 ms). Across the three
ingests, 66,196 records were ingested.

Each command below used the actual `deno task logs:query` route with `--format json`; the trace parameter was
`traceId=0-0-luna23`, from the first workload's real requests. JSON output is saved under the scratch root by
query name. Fixtures were not added to this database.

| Query                       | Exit | Real rows | Row assertion                                                              |
| --------------------------- | ---- | --------- | -------------------------------------------------------------------------- |
| `slowest-sql`               | 0    | 11        | PASS                                                                       |
| `plan-shapes`               | 0    | 23        | PASS                                                                       |
| `error-rate-by-handler`     | 0    | 7         | PASS                                                                       |
| `mutation-vs-query-latency` | 0    | 17        | PASS                                                                       |
| `handler-throughput`        | 0    | 49        | PASS                                                                       |
| `queue-depth`               | 0    | 1         | PASS                                                                       |
| `tx-outcomes`               | 0    | 3         | PASS                                                                       |
| `backup-history`            | 0    | 224       | PASS                                                                       |
| `trace`                     | 0    | 1224      | PASS for stored matching events; upstream trace propagation remains absent |
| `k6-vs-platform`            | 0    | 0         | SKIPPED real populated-join assertion: missing item-25 producer            |

The seven item-23 row assertions pass even though perf thresholds fail. The empty k6 result is not reported as
populated integration success. A separate assertion compared all nine documented SQL table definitions' column
names/types with `EVENTLOG_DDL` and passed exactly.

Evidence logs: `/tmp/luna23-test.out`, `/tmp/luna23-ci.out`, and scratch-root `perf.out` /
`perf-isolated.out`. These are local scratch evidence, not committed fixtures.

## Spec versus checkout

- `_ingest_state.dedupe BOOLEAN` is absent from plan §4.1 but present in actual DDL. The other eight table
  column lists match the plan. Backup success is the actual `outcome='ok'`, not `success`.
- Config defaults differ from §4.2: 30-day retention, gzip after 7 days and a 1 GiB budget; the plan says 14
  days, 2 days and 2 GiB. Both specify 64 MiB rotation. The actual database default is
  `<DATA_DIR>/eventlog.duckdb`, not `logs/duckdb/events.duckdb`.
- Item 23's expanded plan references later prerequisite items 30–37, but their runtime changes are absent at
  this branch's base. There is no `platform/reader_layers.ts`; the reader entrypoint still rejects ingest and
  analysis requests with placeholders. This CLI uses standalone services instead of those RPC handlers. It
  does not wire the HTTP analysis route.
- The reader generates its own trace IDs rather than preserving the client trace. The catalog returns every
  stored platform row for the requested trace, but cannot recover missing propagation. Its fixture verifies
  ordering across two roles sharing a trace; the current real runtime cannot demonstrate that same complete
  client-correlated path.
- `platform_events` already includes all typed events, so the trace query does not union typed tables and
  duplicate the timeline. Handler kinds map to query/mutation in that table. Latency/throughput queries use
  actual `http_events` server handling durations, including IPC on the reader path.
- The landed sweeper has no committed-ingest gate. It does not prune offset rows, and the ingester skips gzip.
  Documentation requires stopped producers and ingest before a real sweep; stronger concurrent guarantees need
  item 36. This CLI calls the available sweeper without inventing such a guarantee. DuckDB event pruning
  remains future `logs:compact` work.
- The k6 producer is absent, and current k6 request helpers do not attach trace IDs to point tags. The catalog
  join needs populated point trace IDs; it exposes sample counts, matches scenarios through traces and
  buckets, and documents matching limitations. Distinct client/server sample populations do not mathematically
  guarantee ordering of their p95 values.
- `deno task check` does not include the new CLI entrypoint; direct `deno check` covered both new TypeScript
  files. The global frozen task is not expanded here.

## Proposed additions — not installed (ownership question)

The conventional path is `tests/unit/analysis_test.ts`, discovered by the existing test task. Adding it would
violate the explicit Owns list. A coordinator must assign that file before these can be installed; I have not
silently expanded scope or claimed the ad hoc checks provide permanent coverage. These are the two required
minimum tests, intended to be copied to that path:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisNames, catalog } from "../../platform/analysis/catalog.ts";

test("observability catalog names match the exported catalog exactly", async () => {
  const doc = await Deno.readTextFile(new URL("../../docs/observability.md", import.meta.url));
  const section = doc.split("<!-- catalog:start -->")[1]?.split("<!-- catalog:end -->")[0];
  assert.ok(section, "missing catalog markers");
  const names = [...section.matchAll(/^\| `([^`]+)`\s*\|/gm)].map((match) => match[1]);
  assert.deepEqual(names.sort(), [...analysisNames].sort());
});

test("catalog SQL has only one SELECT or WITH statement", () => {
  for (const [name, entry] of Object.entries(catalog)) {
    assert.match(entry.sql, /^\s*(SELECT|WITH)\b/i, name);
    assert.equal(entry.sql.includes(";"), false, name);
    assert.doesNotMatch(entry.sql, /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|COPY|CALL)\b/i);
    assert.ok(entry.params.length > 0, name);
    for (const param of entry.params) assert.ok(entry.sql.includes(`$${param.name}`), name);
  }
});
```

The static SQL assertions guard this catalog's syntax; they are not a general SQL security parser.
`AnalysisLive` additionally uses the engine's read-only mode. With scope for tests I would also retain the
known-value real-DuckDB fixture, parameter/CLI failures, read-only database protection, all output formats and
the sweep dry-run inventory assertion in that test module.

## With more scope

Land the reader composition and shared database-session prerequisites, preserve trace IDs through IPC, add the
committed-ingest retention coordinator, and implement the k6 point producer. A standalone read-only analysis
process cannot share a concurrently open write connection owned by another process; the reader RPC integration
should use its coordinated database session. Add the proposed regression tests and put `scripts/logs.ts` in
the type-check graph through the configuration owner. Fix the three pre-existing formatting failures through
their owners.

## Quality scorecard

```text
Item: luna-23 (plan item 23 — Analysis query catalog and logs CLI)
Branch: luna/23-analysis-catalog (commit containing this finding; base 001bbeb5)
Date: 2026-10-11

Correctness:          [ ] matches acceptance criteria   [x] partial   [ ] fails
Test discipline:      [ ] wrote/extended required tests  [x] missing coverage
Owns-scope adherence: [x] only the three Owns files plus the explicitly required finding
Review verdict:       [ ] PASS   [ ] NITS   [ ] FAIL   (independent review pending)
Merged to main:       [ ] yes (human-approved)   [x] no

Luna-to-Sonnet conversion verdict:
[ ] indistinguishable
[ ] usable but needed meaningful correction
[ ] not acceptable

Reasoning: the independent reviewer decides conversion; fixture checks do not replace missing
checked-in tests, upstream runtime prerequisites, or the failed whole-repository CI check.
```
