# ts-db build coordination — items 01..11

Owner: build coordinator subagent. Updated as work proceeds.

| Item | Title                                                | Model  | Batch         | Status | Builder SHA     | Review               | Landed SHA |
| ---- | ---------------------------------------------------- | ------ | ------------- | ------ | --------------- | -------------------- | ---------- |
| 01   | Dependency pins, import map, task table, lockfile    | Sonnet | 0 (SYNC)      | LANDED | eefcb53+fixups  | NITS→fixed           | 962f675    |
| 02   | Error taxonomy and service tags                      | Opus   | 1 (SYNC gate) | LANDED | e2510a8         | NITS->fixed          | b2eb019    |
| 03   | k6 install and smoke scenario                        | Sonnet | 1 (SYNC gate) | LANDED | f6384bf         | FAIL->fixed+verified | cbef086    |
| 04   | core/schema.ts total validation                      | Opus   | 2             | LANDED | dc39459         | NITS->fixed+verified | 8d47d90    |
| 05   | core/ipc/framing.ts pure decoder                     | Sonnet | 2             | LANDED | 63810f6         | NITS->fixed+verified | 0da6045    |
| 06   | core/logging/rotation.ts                             | Sonnet | 2             | LANDED | 24d48d4         | FAIL->fixed+verified | 5195a30    |
| 07   | core/events.ts taxonomy                              | Sonnet | 2             | LANDED | a222d96         | FAIL->fixed+verified | f2f8d68    |
| 08   | platform/config.ts env boundary (+extensible schema) | Sonnet | 2             | LANDED | c86a717         | NITS->fixed+verified | a7a0ae4    |
| 09   | core/compile/* pure total compiler                   | Opus   | 3 (SYNC gate) | LANDED | 3f91e9a         | NITS->fixed+verified | merged     |
| 10   | SDK Effect core                                      | Opus   | 3 (SYNC gate) | LANDED | 257c07b         | NITS->fixed+verified | merged     |
| 11   | Logger service and rotating JSONL sink               | Opus   | 4 (STOP)      | LANDED | 25201a0+60fad40 | NITS->fixed+verified | 837a73c    |

Branch naming: `item/NN-slug`. Worktrees: `/root/Software/tsdb-work/iNN`. Batches: 0:[01] 1:[02,03]
2:[04,05,06,07,08] 3:[09,10] 4:[11 only].

## Notes

- 2026-10-10: origin/main gained 41fbc9b ("Haiku experiment track", by Nick) during item 01 build. Item branch
  rebased onto it cleanly (docs-only commit, no overlap).
- Plan §1.5 pin `@duckdb/node-api@1.5.6` is wrong — that version does not exist on npm (only 1.5.6-r.N).
  Import map pins 1.5.6-r.1; platform/duckdb.ts now uses the import-mapped specifier. Plan doc line 218 fixed.
- Deferred: repo-wide `deno fmt` baseline + 4 pre-existing require-await lint fixes. Will land as a separate
  chore commit on main after item 01 (keeps item diff reviewable).
- Nick runs a parallel Haiku experiment track (haiku/* branches, items 12/14/24 + side quests; also pushing
  docs to main, e.g. 9fef93b). Out of my scope; no file overlap with items 01-11 expected. Item 01 merge
  incorporated 9fef93b cleanly.
- Item 01 review: Opus verdict NITS (3 nits, all addressed: demo/restore tasks re-added to deno.json,
  aws4fetch bare specifier, ResultOf<typeof functions["makeMove"]> annotation, plan doc pin fix).

## Item 11 heads-up (from parent 2026-10-10)

Side quest sq-01 finished a survey of Effect-TS Logger batching/backpressure patterns to de-risk item 11.
Findings: docs/haiku-experiments/findings/sq-01.md on branch haiku/sq-01 (fetch:
`git fetch origin haiku/sq-01:haiku/sq-01`). Key recommendation: size-based batching with manual threshold +
timer (not Stream.groupedWithin); 5 pitfalls (finalizer LIFO ordering, unbounded accumulator, blocking
producer, signal handlers bypassing finalizers, burst overflow). ACTION: item-11 builder brief must instruct
reading that file before implementing.

## Collision note (from parent 2026-10-10)

Haiku track branch haiku/14-k6 (plan item 14, separate track) created perf/lib/api.js, which is in ITEM 03s
Owns set. Ruling: item 03s builder implements api.js per its own spec; the Haiku copy does not affect this
track. When the Haiku track is eventually reviewed/landed (not my job), item 03s api.js must win. No action
now.

## Item 08 scope extension (from parent 2026-10-10; plan updated in e7c324c, on main)

Nick: config work must produce a dedicated, extensible config module with schema enforcement + README that
stays in sync. Item-08 builder brief MUST include: (1) every option declared once in a single options table
(name, env var, type, default, description) — adding options later is one row; (2) schema enforcement via
Effect Schema, Zod only as documented fallback; (3) README.md "Configuration" section documenting every
option, kept exactly in sync (Owns now includes the README config section). Opus reviewer for item 08 must
check README-vs-table parity per the new acceptance criterion.

## Cross-item follow-up: MIN_LIMIT/MAX_LIMIT dedup (for item 10 fix round or later)

Item 09 review nit 2: the 1..1000 limit rule is still duplicated in sdk/db.ts:34 (item 10's file).
core/plan.ts now exports MIN_LIMIT/MAX_LIMIT with a coordination comment. If item 10's review returns
nits/fail, fold in: import MIN_LIMIT/MAX_LIMIT from core/plan.ts in sdk/db.ts. Otherwise carry to a later
item.

---

# Phase 2 -- items 12..27 (coordinator: phase-2 subagent, started 2026-10-10 ~15:30 CDT)

Batches: 4:[12,13,14] 5:[15,16,17,18] 6:[19,20,21] 7:[22 SYNC] 8:[23,24,25] 9:[26,27]. Branch naming:
`item/NN-slug`. Worktrees: `/root/Software/tsdb-work/iNN`.

| Item | Title                                                   | Model  | Batch | Status    | Builder SHA     | Review                     | Landed SHA |
| ---- | ------------------------------------------------------- | ------ | ----- | --------- | --------------- | -------------------------- | ---------- |
| 12   | Property tests wave 1: schema, rules, framing, rotation | Sonnet | 4     | LANDED    | 033c0f4+491f343 | NITS->fixed+re-review PASS | 8ca489b    |
| 13   | Property tests wave 2: compiler and plan invariants     | Opus   | 4     | LANDED    | 891075c         | PASS                       | 5f3d691    |
| 14   | k6 load scenarios and output capture                    | Sonnet | 4     | LANDED    | cc6d11e+cfaa2f2 | NITS->fixed+re-review PASS | 7f8f80d    |
| 15   | Storage service (SQLite writer)                         | Opus   | 5     | in-review |                 |                            |            |
| 16   | Reader service (DuckDB) and reader process entry        | Opus   | 5     | in-review |                 |                            |            |
| 17   | ReaderClient service (IPC, parent side)                 | Opus   | 5     | building  |                 |                            |            |
| 18   | ObjectStore service (local and S3 layers)               | Sonnet | 5     | fix-round |                 |                            |            |
| 19   | Backups service                                         | Opus   | 6     | queued    |                 |                            |            |
| 20   | Test layers and Effect-ified regression suite           | Opus   | 6     | queued    |                 |                            |            |
| 21   | DuckDB append-only event log and idempotent ingest      | Opus   | 6     | queued    |                 |                            |            |
| 22   | Server on layers (SYNC)                                 | Opus   | 7     | queued    |                 |                            |            |
| 23   | Analysis query catalog and logs CLI                     | Sonnet | 8     | queued    |                 |                            |            |
| 24   | Retention sweeper                                       | Sonnet | 8     | queued    |                 |                            |            |
| 25   | End-to-end: integration port + k6->DuckDB join          | Opus   | 8     | queued    |                 |                            |            |
| 26   | Remove compatibility wrappers, enforce boundaries       | Sonnet | 9     | queued    |                 |                            |            |
| 27   | Documentation and regenerated artifacts                 | Sonnet | 9     | queued    |                 |                            |            |

## Phase-2 prerequisites (deferred from phase 1 -- land BEFORE batch 5)

- [ ] **Envelope unification** (chore/envelope-unification): re-export canonical `core/events.ts` EventRecord
      from `platform/services.ts`; retire placeholder branch of `toEventRecord` in
      `platform/logging/logger.ts`. LANDED cb8e847 (2026-10-10): canonical `core/events.ts` EventRecord
      re-exported from `platform/services.ts`; `toEventRecord` placeholder branch retired; EventKind deleted;
      Role/EventLevel re-exported; item-22 HOOK comment fixed. Opus review NITS->fixed->re-review PASS.
- [x] **deno fmt baseline + lint fixes** LANDED 2bec761 (2026-10-10): repo-wide `deno fmt`; fixed 2x
      require-await + no-unversioned-import + prefer-const; `deno task ci` green except `test:prop` (empty
      until item 12 -- expected).
- [x] Item 22 explain-verification method: verify via stdout capture + cmp (brief note only).

## Standing brief guidance for batch 5+ builders

Items 15/16/20/22 build event records with `core/events.ts` constructors and emit through `eventSink`
(envelope unification makes this the only shape).

## Haiku branches (not real items -- never merge)

haiku/12-props (FAIL), haiku/14-k6 (FAIL), haiku/24-sweeper (NITS-with-fixes). Items 12/14/24 are rebuilt
fresh per plan model assignments. Item 03's `perf/lib/api.js` wins over haiku/14's copy.

## Batch 4 dispatch (2026-10-10 ~15:50 CDT)

Items 12/13/14 builders dispatched concurrently (Sonnet / Opus / Sonnet). Briefs staged at
/tmp/brief-i{12,13,14}.txt. Item 13 briefed NOT to import tests/property/arbitraries.ts (item 12 concurrent).
Item 14 briefed NOT to create perf/lib/api.js and NOT to edit deno.json.

## Item 12 build done (2026-10-10 ~16:00 CDT)

Builder commit 033c0f4 on item/12-props, pushed. 32 properties, 200 runs, seed 20261010, test:prop ~5s. Opus
review dispatched (vacuity-strict per the failed Haiku attempt).

## Item 14 build done (2026-10-10 ~16:05 CDT)

Builder commit cc6d11e on item/14-k6, pushed. p95s: load 161.9ms, query 30.7ms, mixed 56.9ms -- all thresholds
met. Deviations flagged for reviewer: (A) raw.json needs K6_RUN_ID/K6_OUT env (k6 limitation); (B) X-Trace-Id
verified on wire, not server log (server doesn't log it until item 22); (C) conflicts are 400 not 409 until
item 22; (D) api.js setup() workaround for pre-existing __ITER bug (item 03 owns api.js). Opus review
dispatched.

## Item 14 LANDED (2026-10-10 ~16:20 CDT)

Merge 7f8f80d, pushed. k6 mutation/query/mixed scenarios, all thresholds met (p95 162/31/57ms). Opus review
NITS->fixed->re-review PASS. Deviations accepted: raw.json needs K6_RUN_ID/K6_OUT env; X-Trace-Id server-log
grep deferred to item 22; conflicts are 400 until item 22's 409. Diagram follow-up dispatched.

## Item 12 LANDED (2026-10-10 ~16:25 CDT)

Merge 8ca489b, pushed. 32 properties, 200 runs, seed 20261010, ~5s. Opus review NITS->fixed->re-review PASS
(31 scratch mutants, 30 killed; R3 boundary generator fix verified). Diagram follow-up dispatched.

## Item 13 build done (2026-10-10 ~16:40 CDT)

Builder commit 891075c on item/13-props, pushed. 19 passed, 3 ignored, ~17s. Oracle found 3 real bugs, pinned
as skipped tests (json-layout integral doubles >= 2^53, node:sqlite TEXT truncation at U+0000, schema-check
gaps) -- flagged for reviewer to rule on (follow-up vs block). Opus review dispatched (security-strict).

## Item 13 LANDED (2026-10-10 ~17:00 CDT)

Merge 5f3d691, pushed. 19 passed, 3 ignored, ~21s. Opus review PASS. Oracle found 3 REAL pre-existing bugs
(pinned as skipped tests, fail only under ORACLE_KNOWN_ISSUES=1) -- follow-ups, not blockers: (a) json-layout
integral doubles >= 2^53 silently wrong via SQLite json_extract (SQLite-vs-DuckDB drift; silently wrong
results -- priority follow-up); (b) Deno node:sqlite truncates TEXT at U+0000 on read (driver limit); (c)
schema-check gaps: defineTable({a,A}) accepted but DDL fails (case-insensitive columns); idx_<table>_<index>
names can collide across tables. Also: plan's stale `tests/core_test.ts:115` reference (now line 177) should
be fixed.

## Batch 4 COMPLETE (2026-10-10 ~17:00 CDT)

Items 11/12/13/14 all landed on main, all Opus-reviewed. Gate satisfied: logger + property suites + k6
scenarios.

## Batch 5 dispatch (2026-10-10 ~17:05 CDT)

Items 15 (Opus), 16 (Opus), 17 (Opus), 18 (Sonnet) building concurrently. Briefs at
/tmp/brief-i{15,16,17,18}.txt. Standing guidance applied: event records via core/events.ts constructors, emit
through eventSink.

## Parallel tracks (parent heads-up 2026-10-10 ~17:10 CDT)

1. **SeaweedFS local S3** (Sonnet agent): adding `docker-compose.yml` + `Makefile` at repo root with SeaweedFS
   as local S3-compatible object storage. Once on main, S3 layers can be tested against
   `http://localhost:8333` instead of mocks. Item 18's spec only requires a stub fetch (already satisfied);
   item 19's brief should mention the SeaweedFS endpoint as available for real-S3 backup testing.
2. **C4 diagram audit** (Fable agent): auditing `docs/architecture/` against items 01-14. Neither track
   touches plan item files. CONSTRAINT: when batch-5 items land, check the auditor is finished (recent commits
   under docs/architecture/, active tmux) BEFORE spawning the per-item diagram follow-up, to avoid concurrent
   edits to the same files.

## Item 18 review FAIL -> fix round (2026-10-10 ~17:20 CDT)

Opus review FAIL: dot-segment keys ('.', './', 'a/.', 'a//b', 'a/') pass validation and escape the local base
dir / target S3 bucket root (verified empirically). 2 defects + 4 nits back to builder with defect list. Fixup
dispatched.

## Item 15/16 builds done, in Opus review (2026-10-10 ~17:20 CDT)

- Item 15: commit ea8af05 on item/15-storage, pushed. 229 tests pass. Review dispatched (strict on tx
  boundaries, interruption-rollback, semaphore TOCTOU).
- Item 16: commit 8616859 on item/16-reader, pushed. 220 tests pass, integration green on real extension.
  Review dispatched.
- LANDING ORDER NOTE: item 16 changed error replies to {_tag, message, fields}; the old parent ipc.ts renders
  them as "[object Object]" until item 17 lands. Merge item 17 BEFORE item 16 (or together) to avoid degraded
  error text on main.
