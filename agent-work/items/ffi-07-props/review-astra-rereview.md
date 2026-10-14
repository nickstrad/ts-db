# FFI-07 Astra re-review after repair 1

Review target: `df8d325`, repair code `48962b7`, original implementation `d20d683`, base `f2bf1c9`. Reviewer:
`astra-ffi-07-rereview`, fresh cross-family unit on `review/ffi-07-astra-rereview`, 2026-10-14. No product
files changed.

## Verdict

**FAIL.** The four original defects are repaired, but the new watchdog leaves fixture setup unprotected. This
is the second FAIL after the allowed repair round: hand the diff and both review reports to the remaining
family's top-tier arbitrator. No further repair was attempted here.

## Numbered defects

1. **P2 — Arm the watchdog before entering fixture setup.** `tests/property/ffi_interrupt_test.ts:325-338`
   creates the worker and immediately enters `withFixture`, but sends its first heartbeat only inside the
   generated property callback. The worker installs no timer until that message (`startWatchdog`, lines
   199-214). Consequently `Database.open`, fixture seeding, and the synchronous baseline reads at line 162
   execute with neither the 15-second guard nor the 25-second backstop armed. A regression that strands one of
   these binding calls hangs the runner indefinitely, despite the new process-level liveness protection. The
   baseline reads exercise the same binding being tested; this is not an arbitrary unrelated setup hook.

   Reproduction: the scratch `fixture-stall.ts` below replaces the first synchronous `Statement.all` baseline
   read with an indefinite synchronous wait. With the unchanged reviewed test, a cached run under an external
   60-second timeout prints the baseline SQL, produces no HANG/FATAL message, and exits **124** only when that
   outer timeout terminates it. The ordinary synchronous recovery-probe stall, by contrast, gets a watchdog
   FATAL and **137**.

   Requested correction for arbitration: arm the independent watchdog before `withFixture` starts, with
   setup/seed/load context, and keep it armed through fixture cleanup, updating progress around bounded setup
   phases. This review does not require replacing SIGKILL or redesigning the iteration guard.

```ts
import { Statement } from "/root/Software/tsdb-work/ffi07-rev2/platform/sqlite_ffi/mod.ts";
const original = Statement.prototype.all;
Statement.prototype.all = function (...args) {
  console.log("FAULT: synchronous baseline result stall", this.sql);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return original.apply(this, args);
};
await import("/root/Software/tsdb-work/ffi07-rev2/tests/property/ffi_interrupt_test.ts");
```

Run from this checkout after the required idle-process check:

```sh
timeout --kill-after=2s 60s deno test -A --config "$PWD/deno.json" "$scratch/fixture-stall.ts"
```

Here `scratch` is
`/tmp/claude-0/-root-Software-ts-db/4baa5237-5a2a-4889-84ed-3eddee24e601/scratchpad/astra-rereview`. The
reproduction entrypoint and raw logs are scratch-only, not committed.

## Repair assessment

- The 15-second guard now covers outcome assertions and both recovery probes. A timeout records
  `health.stuck`; subsequent fast-check calls return without touching the poisoned connection.
- `closeWithGrace` propagates rejection and rejects a resolved close whose database remains open. Its
  `finally` clears the grace timer. The fallback synchronous `close()` is **after** an async rejection, not
  before the async close. Its own exception is caught, preserving the first close failure; body and close
  errors are retained in an `AggregateError`. Normal completion uses one async close; the binding's
  synchronous close is idempotent, so fallback does not double-free.
- SIGKILL is an acceptable last resort for the deliberately injected uninterruptible native step: the runner
  exits nonzero and cannot carry the unsafe execution into subsequent tests. It is not a normal Deno FAILED
  summary, nor graceful cleanup. This is preferable to abandoning the native promise and crashing during
  runtime teardown. It must be distinguished from the pre-existing DuckDB exit-139 flake.
- The watchdog has a wide operational margin: 25 seconds versus subsecond iterations. This is a fail-fast
  liveness threshold, not a real-time scheduling guarantee under arbitrary OS starvation. On normal
  completion, `stop()` posts stop, terminates the worker, and revokes the object URL.
- Coverage thresholds are fixed across seeds: at least 20 rows and 20 cancellations overall, every shape, and
  at least one row and one cancellation under each mechanism. They do not assert all 24 shape/mechanism
  combinations. Random coverage cannot mathematically guarantee every possible seed passes; the measured
  margins determine practical flakiness.
- The documentation now correctly separates seeded inputs from scheduling/load, distinguishes the unit-only
  classifier, and describes the strengthened floors. Brief formatting is checked below.

## Shrinking and diagnostics

The original async-probe fault fails on `["forever", {"how":"deadline","delayMs":4}]`, path `0`, with zero
shrinks. The post-timeout early returns neither mask that failure nor replace it with a candidate that was
never executed.

For the requested **mid-shrink** case, an additional injector rejects the first async recovery probe with
`original body failure before shrinking`, then stalls the second. It prints exactly two probe calls and exits
1 at the guard. Fast-check reports `["forever", {"how":"deadline","delayMs":0}]`, path `0:0`, one shrink, with
the timeout as its cause. Thus the retained counterexample is the **last actually failing (timeout-producing)
candidate**, not universally the original unshrunk candidate or earlier error. No later candidate touches the
connection. This follows fast-check's ordinary last-failing-candidate behavior (`RunnerIterator.handleResult`
/ `RunExecution.fail` in the installed 4.10.2 source); it remains a failing test. I do not count this as a
second liveness defect. Preserve explicit first-failure history separately if that stronger diagnostic policy
is desired.

The native grace-expiry report contains the seed, statement kind, mechanism and delay, phase, elapsed time,
load, and connection state. That is sufficient to reconstruct inputs, with timing replay still dependent on
load. The worker report explicitly labels its context as **iteration started**: its phase/load/inFlight fields
are snapshots from the heartbeat, not measurements at the eventual stall. The synchronous recovery fault
therefore prints phase `statement`, elapsed `0 ms`, plus the 25,000 ms no-progress interval. This is a
diagnostic limitation, not evidence that the wrong input ran.

## Fresh-eyes assessment

The full item stays in the authorized ownership set. The boundary change adds one exact path and its
justification only. The oracle opens `:memory:`; the binding opens a separate temporary file. The round-trip
tests explicitly check storage class and value, including full int64 under bigint reads, unsafe-integer
rejection, blobs including empty, NUL text, lone surrogates, NaN-to-NULL, integral number storage-class
differences, and the accepted negative-zero pin. The latter remains a separate binding follow-up, not an
FFI-07 defect. The existing classifier tests assert the intended biconditional over 2,000 generated plans plus
500 write cases, so duplication is unnecessary.

The first review's knowledge handoffs remain applicable: correct the plan's NaN premise; preserve the
binding/oracle divergences; schedule the negative-zero follow-up. The INT64_MIN comment's “lossy” wording is
imprecise: -2^63 is representable as binary64, although outside the safe-integer range. This pre-existing
review nit does not change the test's asserted behavior.

## Validation

Each suite/fault process was preceded by the requested process check; the later validation loop also matched
absolute Deno executable paths. I waited for FFI-06 CI and integration rather than running against them. The
20-seed sweep uses the prescribed script with its authorized internal parallelism of three.

| Check                                                                       | Result                                       |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| `deno task lint`                                                            | PASS, 166 files                              |
| `deno task check`                                                           | PASS                                         |
| `deno task test:prop`                                                       | PASS, 84 passed, 0 failed; 3m1s              |
| `deno task test`                                                            | PASS, 686 passed, 0 failed, 1 ignored; 4m57s |
| `deno fmt --check` on all five item files, including repair delta and brief | PASS, 5 files                                |
| Interrupt sweep, seeds 1–20                                                 | PASS, 20/20; no crashes                      |

Selected normal-run output:

```text
ok | 84 passed | 0 failed (3m1s)
ok | 686 passed | 0 failed | 1 ignored (4m57s)
Checked 5 files
interrupt coverage (seed 20261010): {"rows":54,"cancelled":146,"forever":71,"cte":26,"join":18,"scan":50,"point":17,"trivial":18,"deadline:rows":12,"deadline:cancelled":33,"abort:rows":14,"abort:cancelled":32,"both:rows":11,"both:cancelled":45,"fiber:rows":17,"fiber:cancelled":36}, slowest iteration 51 ms, load 1.25/1.48/2.21
```

All three original injectors were copied from `origin/review/ffi-07-astra`, changing only imports to this
checkout. They ran with `deno test -A --config "$PWD/deno.json"` and an external timeout in disposable
processes, with core dumps disabled. The unmodified source under review was imported; no product-file edits
were used for fault injection.

| Fault                                                   | Observed result                                                |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Original close rejection                                | Exit 1; injected error preserved; `0 passed / 1 failed`        |
| Original pending async recovery probe                   | Exit 1; 15,005 ms guard report; `0 passed / 1 failed (18s)`    |
| Original native interrupt disabled                      | Exit 137; FATAL after 15-second guard and 1-second close grace |
| Synchronous recovery probe stall                        | Exit 137; worker FATAL after 25 seconds without progress       |
| Synchronous fixture baseline stall                      | **External 60-second timeout, exit 124; no HANG/FATAL**        |
| `closeAsync` resolves while open                        | Exit 1; `closeAsync resolved but the database is open`         |
| First probe rejects, next probe stalls during shrinking | Exit 1; exactly two probe calls, path `0:0`, one shrink        |

Selected fault output:

```text
error: Error: closing the database failed: Error: injected close failure
HANG: the iteration did not finish in 15000 ms
  iteration: forever under {"how":"deadline","delayMs":4}, phase recovery (async probe), 15005 ms in, load 2.20/2.08/2.62, db.inFlight=false, seed 20261010
FATAL ffi_interrupt_test (seed 20261010, load 2.67/2.20/2.64): closeAsync did not finish within 1000 ms after: forever under {"how":"deadline","delayMs":4}, phase statement, 15005 ms in, load 2.67/2.20/2.64, db.inFlight=true, seed 20261010; db.inFlight=true, db.isOpen=true
FATAL ffi_interrupt_test watchdog: no progress for 25000 ms; iteration started: forever under {"how":"deadline","delayMs":4}, phase statement, 0 ms in, load 1.15/1.69/2.38, db.inFlight=false, seed 20261010
FAULT: synchronous baseline result stall WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 4000000) SELECT count(*) AS n, sum(n) AS s FROM c
```

The first synchronous-probe attempt had a 35-second outer limit that included fresh type checking; it exited
124 before a watchdog report. I did not count that as a watchdog failure. The cached rerun with a 60-second
outer budget produced the 25-second FATAL/137 above. The fixture-stall probe also received the full cached
60-second rerun and still required external termination.

The sweep used `work-scripts/bash/property-seed-sweep.sh tests/property/ffi_interrupt_test.ts - 1 20 3` with
`KEEP_RAW` pointing at the scratch directory's `seeds/`. Summary: `20 PASS`. Load1 was 1.58 at start, 3.72 at
end; individual coverage lines sampled 3.25–3.89. Across 4,000 iterations, rows per seed ranged 47–66 and
cancellations 134–153; the slowest iteration was 75 ms.

| Mechanism | Rows per seed, min–max | Cancellations per seed, min–max |
| --------- | ---------------------- | ------------------------------- |
| deadline  | 7–24                   | 23–43                           |
| abort     | 8–22                   | 25–43                           |
| both      | 9–18                   | 28–47                           |
| fiber     | 9–23                   | 25–43                           |

These margins support the strengthened floors and the 25-second watchdog threshold at the tested load. This is
an independent 20-seed spot check, not a rerun of the builder's entire sweep. No known timing flake appeared
in either full suite. All normal runs exited, with no leaked worker keeping the runner alive. The sweep
script's generic `coverage:` extractor does not match `interrupt coverage (seed ...)`; the table above was
parsed from its retained raw per-seed outputs.

## Learning assessment and handoff

This review's findings and evidence are preserved here within the authorized `agent-work/` scope. No reusable
general-purpose script was added. Scratch fault injectors are not committed. The coordinator owns any
`docs/knowledge/` update and worktree cleanup after inspection. Durable handoff: creating a worker does not
arm its watchdog; send the initial liveness deadline before any potentially blocking setup, not only before
generated iterations. Preserve this report alongside the first review in arbitration. The worktree remains
available for coordinator inspection.
