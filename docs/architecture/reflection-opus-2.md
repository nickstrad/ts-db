# Reflection pass — code lens (Opus-2)

- **Date:** 2026-10-11
- **Branch:** `reflection/opus-2`, cut from `origin/main` at `cd669d1`
- **Lens:** code (component boundaries, data flow, Effect composition, tests, queries). The architecture/diagram lens runs separately (Astra).
- **Scope note:** This pass covers everything landed since the previous Opus reflection (`reflection/opus` at `d6e08cd`): items 23–29, 30–37, MT-01–MT-10, the segfault mitigations, and the shared event log.

## Phase 1: Diagrams & usage docs

`render.py --check` passed on arrival, but the diagram *sources* had drifted: they described the pre-supervision architecture.

**Drift found and fixed** (`docs/architecture/diagrams/c4-component-server.py`, re-rendered both formats):
- "reader-exit watch" → "reader supervision": the server no longer shuts down when the reader exits; it restarts the child with backoff (1s→2s→4s→8s), serves 502s during the window, and only gives up (shutdown, exit 1) after >5 restarts in 10 minutes.
- "scoped child shutdown" → "supervised child (restart on exit)" on the RPC→reader edge.
- NOTES extended with the supervision behavior.

**Docs fixed** (`docs.md`):
- The "Reader exited / 502" troubleshooting entry claimed "A reader exit makes the server shut down and exit 1" — now describes restart-with-backoff.

The audited-state table in `docs/architecture/README.md` covers through MT-10 (item 27). Items 28 (demos) and 29 (user guide) add no C4 surface.

## Phase 2: Tests

Full suite (`deno task ci`) run on this branch.

**Initial result: 602 passed / 2 failed / 1 ignored.**

Both failures were stale tests in `tests/unit/server_scope_test.ts` asserting the pre-supervision behavior:
1. "the reader child dies while serving: the server stops in order and fails with ReaderExitedError" — expected server death; now the supervisor restarts the reader.
2. "process: a killed reader child stops the server with exit 1 within the bound" — same.

**Fixed:** Both tests rewritten to assert the new supervision behavior (restart, 502 window, no shutdown; clean stop afterwards). Also added a `skipOrder` option to `assertProcessReleased` since the strict shutdown-order assertion doesn't account for restart events interleaved in the lifecycle log.

**Final result: 683 passed / 0 failed / 1 ignored** (unit: 604/0/1; property: 79/0/0), plus `lint`, `check`, and `fmt:check` all clean. `deno task ci` exit 0.

The two stale-test failures from the initial run are fixed and the suite is fully green.

## Phase 3: Queries

Ran the item-23 analysis catalog (`scripts/logs.ts query`) against real ingested data: 67 lines from a live server workload (document mutations, queries, 404s), ingested via `scripts/logs.ts ingest`.

| Query | Result |
|---|---|
| `handler-throughput` | Works — real per-minute request counts, status breakdown, p95 |
| `error-rate-by-handler` | Works — correctly identified my malformed requests as RouteNotFound |
| `tx-outcomes` | Works — commit counts and latency per app |
| `mutation-vs-query-latency` | Works — writer vs reader path distributions |
| `slowest-sql` | 0 rows (no slow SQL in small workload — expected) |
| `queue-depth` | 0 rows (no queue pressure — expected) |
| `trace` | Exists in catalog (I initially guessed `trace-summary`, which is not a valid name) |

No stale queries found. The catalog is healthy.

## Phase 4: Verdict

[TO BE WRITTEN]
## Phase 4: Verdict

### What's holding (evidence)

1. **Effect layer composition.** The layers form a chain with deterministic acquisition/release order (`platform/layers.ts`). The reader-supervision work slotted into `ReaderClientConfigured` without breaking layer discipline — the supervisor fiber, connection ref swap, and circuit breaker all live within the existing scoped-resource model.

2. **Error taxonomy.** `core/errors.ts` defines clean tagged unions (`TenantError`, `MutationError`, `QueryError`, `PlatformError`, etc.) with an exhaustive HTTP status mapping. The IPC layer rehydrates exact error classes across the process boundary (a query-side `SchemaError` still answers 400, not 502).

3. **Tenant isolation seams.** `TenantContext` flows through request handling, the router interface (`platform/tenants/routing.ts`) is pluggable, and tenancy-mode branches are localized (`platform/sqlite.ts:658,662,722`, `platform/layers.ts:191`, `platform/reader.ts:173`). No cross-tenant leakage in the paths examined.

4. **Type discipline.** Zero `as any`, zero `@ts-ignore`/`@ts-expect-error`, zero `console.log` in production code (`platform/`, `core/`). The codebase takes the type system seriously.

5. **Test discipline.** 600+ tests including property tests with `PROP_SEED` replay, a hermetic 7-scenario e2e suite, and the kill-reader supervision test. The suite catches real regressions (it caught the two stale tests in this pass).

### Friction found

1. **Stale tests on behavior change (fixed in this pass).** The supervision change landed without updating two tests asserting the old "reader dies → server dies" behavior, leaving `deno task ci` red on main. This is a process gap: behavior changes must update their tests in the same PR, and reviewers should check for stale assertions. Fixed here; both tests now assert restart behavior and pass.

2. **Supervision constants hardcoded** (`platform/layers.ts`: `restartDelaysMs`, `maxRestarts`, `restartWindowMs`). Per the item-08 config-table convention, these should be proper options. Tracked as follow-up.

3. **P3 follow-ups from security reviews** (not yet scheduled): MT-07 multi-membership fail-closed footgun; backups not tenant-aware (pre-existing); MT-08 per-request auth DB connections; MT-10 `main.ts` hardcoded scenario count. None block, all documented.

### Verdict: good to go, with the noted follow-ups

The architecture is sound. The abstractions are holding — the code is not fighting the Effect layer discipline, the error taxonomy, or the tenant seams. The multitenancy extension (MT-01–MT-10) integrated cleanly without compromising the single-tenant path (`tenancy.mode === "off"` branches are localized and the default). The reader-supervision change, the most architecturally significant recent work, fits the existing process model rather than fighting it.

**Recommended next steps** (for the plan, not ad-hoc):
- Promote supervision constants to config-table options (item-08 convention).
- Schedule the P3 follow-ups from MT-07/MT-08/MT-10 reviews.
- Add a review checklist item: "behavior changes must update or remove tests asserting the old behavior."
