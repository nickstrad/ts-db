# FFI-07 arbitration (Muse Wonder Full, third family)

Arbitrated 2026-10-14 by `muse-ffi-07-arbiter` (Muse Code, `muse-wonder-full-1.0`), fresh unit on
`review/ffi-07-arbitration`, under the global three-CLI protocol's arbitration rule: a second FAIL goes to the
remaining family's top seat with the diff and both verdicts; this verdict is final, subject to the human
gates. Target: `df8d325` (`item/ffi-07-props`; implementation `d20d683`, repair `48962b7`, base `f2bf1c9`).
Builder: Claude Sonnet; both reviews: Codex Astra (FAIL at `3a3bcb2`, FAIL at `df8d325`). This unit
arbitrates; it does not fix. No product files were modified.

## Verdict

**NITS.** The item is sound and landable after the single, precisely specified fixup below. The re-review's
new finding is real and is upheld on its technical merit, but it is downgraded from P2/FAIL to a nit: it does
not violate the plan's acceptance criteria. No further family review round is required; the coordinator
verifies the fixup mechanically against the checks named under "Required correction".

## Answers to the arbitration questions

### a. The new finding: real, but not a plan-acceptance defect

The plan's interrupt-totality requirement (`docs/plans/ffi-implementation.md` §4, FFI-07 work 2) predicates
"never hangs" over the thing under test: for random statements and 0–50 ms interrupt delays, a **nonblocking
step** always terminates with rows or `SQLITE_INTERRUPT`, and the connection answers the next statement, over
200 iterations. The brief's guard is likewise iteration-scoped ("bound each iteration"). The unarmed window
contains no generated iteration and no nonblocking step: it is fixture setup — `Database.open`, the 100
000-row seed insert, statement preparation, and the synchronous baseline `all()` reads
(`ffi_interrupt_test.ts:148-165`) that compute the expected rows. A stall there cannot produce a false green,
weaken any assertion, or falsify the totality evidence; it worsens only the failure _latency and diagnosis_ of
a hypothetical future regression in the synchronous step path (indefinite CI hang instead of a 25 s FATAL with
seed, phase, and load context). That is hardening, not acceptance.

It is nevertheless a genuine defect **of the repair's own advertised guarantee**, and cheap to close, which is
why it is a required nit rather than waived:

- The repaired header promises three layers of "hang safety", with the Worker backstop as "the only layer that
  covers a synchronous stall" (`ffi_interrupt_test.ts:15-28`). As written, that claim is false for the one
  stretch of the test that runs the heaviest synchronous binding calls outside any iteration: the baseline
  reads step the same recursive-CTE and self-join statements the property tests. The re-review is right that
  these are not "an arbitrary unrelated setup hook".
- The worker already exists at that point (`startWatchdog()`, line 325); it is merely never beaten until the
  first generated iteration (line 338), and `startWatchdog` installs no timer until the first beat (lines
  199-214). The gap was introduced by the repair's own new mechanism, not inherited from the original.
- Contrast with review 1's two P2s, which justified FAIL: the unguarded recovery probe sat _inside_ the
  acceptance predicate ("the connection answers the next statement"), and the swallowed close error could
  report a passing suite with a broken cleanup — a false green. The setup gap can do neither. That difference
  is the line between FAIL and NITS, and the re-review graded it on the wrong side.

### b. Process: within the protocol, over-graded

- **In scope, no protocol breach.** A re-review of a repair delta must be able to fault the repair's own new
  code; the watchdog did not exist at `3a3bcb2`, so "review 1 could have found this" is only half true. The
  _window_ (unguarded synchronous setup) existed then, but the defect as stated — a watchdog that is created
  and left unarmed across it — is the repair's. Review 1 in fact named the class ("retain a process-level
  backstop for native/synchronous stalls"); review 2 is the follow-through verifying that the backstop
  actually covers, and a reviewer who noticed the gap and stayed silent for round-economy reasons would be
  certifying a guarantee it knew to be incomplete. Raising it was correct, and review 2 correctly attempted no
  repair itself and escalated.
- **Over-graded.** The escalation cost came from the FAIL grade, not from raising the finding. All four
  original defects were confirmed repaired, every acceptance gate was green, and the sole new issue was
  hardening beyond the plan's stated property, fixable in a few lines inside one already-owned file — the
  textbook profile of NITS ("land after a fixup"), which would have closed the item in one mechanical round
  instead of consuming arbitration. This ruling corrects the grade only; it is not a rebuke of the review's
  diligence, whose fault-injection method (importing the unchanged test into a disposable process with one
  injected fault) both rounds used well and which this arbitration reused.

### c. Landability

The item otherwise meets the plan, on evidence confirmed thrice (builder, both reviews) and re-verified here:
round-trip equality against a separate `node:sqlite` `:memory:` oracle with the U+0000 difference and the
other four divergences pinned explicitly; interrupt totality over 200 generated iterations across six shapes
and four mechanisms with seed-independent floors (≥20 rows, ≥20 cancellations, ≥1 of each outcome per
mechanism, every shape seen); the classifier property correctly left in `tests/unit/ffi_classify_test.ts` and
documented rather than duplicated; `docs/testing.md` rows; exactly one exact-path allow-list entry in
`tests/unit/boundaries_test.ts`. Scope is confined to the item's Owns set (verified:
`git diff --stat f2bf1c9
df8d325` — the two property files, `docs/testing.md`, the boundary entry, the brief).
The plan's "NaN rejected" premise is wrong (both drivers bind NULL); the test pins the truth and the plan
correction is a coordinator handoff, not an item defect. The `-0` sign loss is likewise an honestly pinned
latent binding defect for a separately owned follow-up, as both reviews held.

## Required correction (the fixup)

One fixup commit on `item/ffi-07-props`, confined to `tests/property/ffi_interrupt_test.ts`:

1. Beat the watchdog **before** `withFixture` is entered — immediately after `startWatchdog()` (currently
   line 325) — with setup context (phase, seed, load, in the existing report style), so `Database.open` is
   covered.
2. Pass the watchdog (or its `beat`) into `withFixture` and beat at the bounded phase boundaries: after the
   seed insert / before the baseline `all()` loop, after the baselines / before invoking `fn`, and once before
   `closeWithGrace` ("cleanup"), so cleanup stays armed until the existing `watchdog.stop()` in the `finally`.
3. Amend the header's layer-3 sentence so it no longer scopes the backstop to "the iteration" (e.g. "if the
   test — fixture setup, iterations, cleanup — makes no progress for `BACKSTOP_MS`").

Nothing else changes: no new thresholds (`GUARD_MS`/`BACKSTOP_MS`/`CLOSE_GRACE_MS` stay), no SIGKILL redesign,
no generator, floor, fixture-size, or documentation changes. Soundness note: `postMessage` to the worker
thread does not depend on the main thread yielding afterwards, so beating immediately before a synchronous
call arms the timer even if that call then blocks the event loop — the same property the iteration beats
already rely on.

**No further family review.** The builder/reviewer repair round and this arbitration are the protocol's full
course for an item; a third top-tier review of heartbeat placement would be disproportionate and risks another
new-finding loop over a mechanical change whose acceptance is fully command-checkable. The coordinator lands
the item once each of these is observed on the fixup head (each preceded by the standing idle-suite process
check):

- The review-2 `fixture-stall.ts` injection (synchronous stall in the first baseline `all()`) now ends with
  the watchdog FATAL and exit **137** within ~25 s, without an external timeout.
- The unmodified file passes alone: `deno test -A tests/property/ffi_interrupt_test.ts`.
- `deno task lint`, `deno task check`, and `deno fmt --check tests/property/ffi_interrupt_test.ts` pass.
- `deno task test:prop` passes (84).
- A 50-seed interrupt sweep
  (`work-scripts/bash/property-seed-sweep.sh tests/property/ffi_interrupt_test.ts -
  1 50 3`, matching the
  repair round's standard) is clean — this is also the check that arming the backstop across setup introduced
  no false SIGKILL under load.
- `git diff df8d325 <fixup-head>` touches only `tests/property/ffi_interrupt_test.ts` (plus any `agent-work/`
  brief bookkeeping). If the fixup exceeds this scope or changes any semantics beyond heartbeat placement and
  the header sentence, it returns to the coordinator's/human's discretion rather than landing under this
  ruling.

## Independent evidence (this unit)

Every suite and fault process was preceded by `ps -eo pid,args | grep -E "^ *[0-9]+ deno (test|task)"` (idle
each time). Fault injectors were copied to the scratchpad (`ffi07-arb/`), pointed at this checkout's
unmodified test, run with `deno test -A --config "$PWD/deno.json"` under an external timeout in disposable
processes; none is committed.

| Check                                                                            | Observed                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review-2 fixture stall (sync stall, first baseline `all()`)                      | **Exit 124** at the external 40 s timeout (> `BACKSTOP_MS` = 25 s); only the `FAULT:` line for the recursive-CTE baseline printed; no HANG/FATAL — finding **reproduced**            |
| Review-1 probe fault (pending async recovery probe)                              | Exit 1; `HANG: the iteration did not finish in 15000 ms`, phase `recovery (async probe)`, 15 004 ms in; `0 passed / 1 failed (19s)` — repair **confirmed**                           |
| Review-1 close fault (`closeAsync` rejects, DB open)                             | Exit 1; `closing the database failed: Error: injected close failure`; `0 passed / 1 failed` — repair **confirmed**                                                                   |
| `deno task lint`                                                                 | PASS (Checked 166 files)                                                                                                                                                             |
| `deno task check`                                                                | PASS                                                                                                                                                                                 |
| `deno fmt --check` (round-trip, interrupt, `docs/testing.md`, boundaries, brief) | PASS (Checked 5 files)                                                                                                                                                               |
| `deno task test:prop`                                                            | PASS: **84 passed, 0 failed** (3m50s); interrupt coverage (seed 20261010): rows 50, cancelled 150, every shape and mechanism covered both ways, slowest iteration 73 ms at load 3.65 |

## Handoffs and learning assessment

Unchanged from the reviews, for coordinator-owned units: correct the plan's NaN premise; preserve the five
binding/oracle divergences in `docs/knowledge/`; schedule the `-0` binding fix with the pinned assertion
updated in the same follow-up; soften the `INT64_MIN` "lossy" wording (`-2^63` is exactly representable as
binary64, though outside the safe-integer range — a wording nit in both reviews that needs no separate commit
and is **not** part of the required fixup). The durable lesson for the knowledge index is the re-review's:
creating a watchdog worker does not arm it — the first heartbeat must precede the first potentially blocking
call, setup included. No reusable script resulted; the scratch injectors duplicate the reviews' and stay
uncommitted. This worktree is retained for coordinator inspection and cleanup.
