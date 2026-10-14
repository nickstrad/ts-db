# FFI-07 independent Astra review

Reviewed 2026-10-14 by `astra-ffi-07-review`, cross-family from the Claude Sonnet builder. Review target:
`3a3bcb2` (`item/ffi-07-props`), implementation `d20d683`, base `f2bf1c9`. Review branch:
`review/ffi-07-astra`. Product files were not modified.

## Verdict

**FAIL.** The normal suites and independent seed sweeps pass, but the interrupt harness does not meet the
requested hang/cleanup safety guarantee. Defects 1 and 2 require a repair; 3 and 4 are minor.

## Numbered defects

1. **P2 — The recovery probe is outside the iteration guard.** `tests/property/ffi_interrupt_test.ts:240-247`
   clears the only guard before awaiting `probe.getAsync()` without a timeout. A regression that strands this
   next execution hangs the property rather than failing at 15 seconds; the advertised bound does not cover an
   iteration. Reproduction: run `review-fault-probe.ts` below. It overrides only the probe's async method with
   a pending operation and a live timer. The test prints the injection marker, never reports `HANG` or a
   verdict, and the external 24-second timeout exits 124. Bound the entire iteration, including recovery
   checks; retain a process-level backstop for native/synchronous stalls.
2. **P2 — Cleanup can silently pass with an open database, and abandoning a promise is not native
   cancellation.** `tests/property/ffi_interrupt_test.ts:99-102` discards every close error and resolves
   normally when the one-second grace expires. The assertion that a guard must already have failed is false:
   close can fail after 200 successful iterations. Reproduction: `review-fault-close.ts` makes `closeAsync`
   reject without closing; output explicitly says `database still open: true`, yet the suite exits 0 with
   `1 passed | 0 failed`. The race also cannot dispose a native step/reinterrupt timer that remains in flight,
   and its grace timer is never cleared when close wins. Propagate close failures, make grace expiry a
   failure, clear the timer, and isolate/terminate a genuinely stuck native execution rather than letting it
   survive in the test runner. Stop shrinking against a connection whose execution has timed out.
3. **P3 — The new documentation promises deterministic timing failures.** `docs/testing.md:69` says a failing
   seed fails every time and only exit 139 is intermittent. Seeds fix generated inputs, not event-loop
   scheduling or contention. This suite intentionally permits rows or cancellation for the same generated
   case, uses wall-clock guards and coverage floors, and can therefore fail intermittently without a native
   crash. Scope the replay claim to inputs/counterexamples, and preserve timing/load in failure reports. Also
   change the introductory "all in deno task test:prop" at line 51 to accommodate the correctly documented
   unit-only classifier row. The new interrupt module's lines 19-21 claim both outcomes per mechanism, whereas
   its floors only require cancellations per mechanism; align that description with the actual assertions or
   strengthen the coverage.
4. **P3 — The committed brief fails the requested touched-file formatting check.**
   `agent-work/items/ffi-07-props/brief.md:3` and subsequent paragraphs are unformatted. Reproduce with
   `deno fmt --check agent-work/items/ffi-07-props/brief.md`; it exits 1. The four implementation files pass.
   Format the brief in the repair; do not conflate the passing implementation check with all files added at
   `3a3bcb2`.

## Independent validation

Every suite was preceded by the requested process check. No competing suite was present when started; the
shared event log also announced this sequential validation slot.

| Check                                            | Result                                 |
| ------------------------------------------------ | -------------------------------------- |
| `deno task lint`                                 | PASS                                   |
| `deno task check`                                | PASS                                   |
| `deno task test:prop`                            | 84 passed, 0 failed; 2m46s             |
| `deno task test`                                 | 686 passed, 0 failed, 1 ignored; 4m54s |
| `deno fmt --check` on four implementation files  | PASS                                   |
| Same check including added brief                 | FAIL, brief only                       |
| Round-trip seed sweep, seeds 1–20, parallelism 3 | 20 PASS, no crashes                    |
| Interrupt seed sweep, seeds 1–20, parallelism 3  | 20 PASS, no crashes                    |

Both sweeps used `work-scripts/bash/property-seed-sweep.sh`, one file at a time. Round-trip load1 was 0.54 at
start and 3.44 at end; interrupt load1 was 2.99 at start, 3.39 at end, with a sampled 3.85 during the run.
These are the reviewer's 20-seed spot checks, not an independent rerun of the builder's reported 200-seed
sweeps.

Default-seed interrupt coverage was 54 row results and 146 cancellations, with every shape and mechanism
covered and slowest iteration 51 ms. Across 20 seeds (4,000 iterations), row counts were 40–63, cancellation
counts 137–160, every mechanism had at least 24 cancellations per seed, and the slowest observed iteration was
85 ms. No known timing flake occurred in either full suite.

The report's adjacent `review-fault-*.ts` files are isolated reproduction entrypoints. Each imports the
unchanged test after installing one fault in that process; they are not product fixes or normal suite entries.
From the repo root, with Deno on PATH and no competing suite:

```sh
timeout --kill-after=2s 24s deno test -A agent-work/items/ffi-07-props/review-fault-close.ts
timeout --kill-after=2s 24s deno test -A agent-work/items/ffi-07-props/review-fault-probe.ts
timeout --kill-after=2s 30s deno test -A agent-work/items/ffi-07-props/review-fault-native.ts
```

Expected current observations: close fault exits 0 despite the live database; probe fault requires external
termination (124). With native interruption disabled, the first run required external termination at 26
seconds (124). A second run, instrumented to log entry into close, printed
`native execution still in flight: true`, then `FAILED (19s)`, then terminated with a segmentation fault
(139), before its 30-second external deadline. This is fault-injected evidence, not a crash in an unmodified
suite or a claim that the pre-existing DuckDB teardown flake occurred. The grace race neither closed that
connection nor provided safe containment of its running native call. Keep the external timeout when
reproducing, and use a disposable process for the repair's native hang test.

## Scope and semantic findings

- **Ownership and two copies:** the implementation changes exactly the two property files, `docs/testing.md`,
  and the boundary allow-list; the head also adds the authorized brief. The boundary diff is one exact-path
  entry and its justification (wrapped over two comment lines), with no other change. The only `DatabaseSync`
  open in the new round-trip suite is `:memory:`; the binding uses a distinct temporary file. The interrupt
  suite does not import `node:sqlite`.
- **Round trips:** all five SQLite value kinds have generators and fixed edge cases. Full-range int64 uses
  `readBigInts` on the binding and `setReadBigInts` on both oracle read statements. A parameter expression and
  stored STRICT ANY column must agree within each driver; the binding's async read must also agree. Text
  includes NULs and lone surrogates, doubles include subnormals, infinities, NaN and negative zero, and blobs
  include empty. Assertions check both drivers against explicit expected values rather than merely allowing
  mismatches.
- **NaN:** the NULL expectation is correct for both drivers and is visibly pinned. The plan's "NaN rejected"
  premise needs correction; inventing a binding rejection is not needed for FFI-07.
- **Negative zero:** the pin explicitly requires oracle REAL `-0` and binding INTEGER `0n`, using strict
  comparisons. A fix will fail the named assertion and the fixed edge case. I agree with the coordinator: loss
  of sign is a latent binding defect suitable for a small separately owned binding follow-up, not a reason to
  reject this item's honest parity test.
- **Integral safe numbers:** binding INTEGER versus oracle REAL is the established FFI-04 divergence. Both
  storage class and exact value are asserted, including under bigint reads.
- **INT64_MIN:** the test correctly requires the binding's typed `unsafe-integer` failure and the oracle's
  number result. The word "lossily" is technically inaccurate for this particular value: negative two to the
  power of 63 is exactly representable as binary64, although outside JavaScript's safe-integer range. This
  distinction should accompany the knowledge handoff.
- **Object/array arguments:** `PAIR` puts the invalid value in the second positional argument, avoiding the
  oracle's first-argument named-parameter overload. This correctly tests unsupported values. It documents and
  avoids that overload; it does not independently assert its semantics.
- **Cancellation predicates:** deadline requires `SqliteCancelled` with the matching timeout; abort requires
  its aborted reason; both accepts either promised reason and checks the timeout when deadline wins. Fiber
  timeout requires Effect's `TimeoutException`. Other SQLite errors fail. Successful results are compared with
  undisturbed results, and `forever` cannot return rows. No lock-waiting statements are generated.
- **Coverage:** 200 generated iterations sample six shapes and four mechanisms; this is not 200 iterations per
  combination. Fixed floors require at least 20 rows and 20 cancellations, every shape, and at least one
  cancellation per mechanism. They are non-vacuous and do not vary by seed, but do not guarantee all 24
  combinations or rows for every mechanism. The introductory claim of both outcomes per mechanism is stronger
  than the implemented assertions.
- **Classifier:** the existing unit file asserts the exact biconditional over 2,000 generated plans and writes
  bounded over 500 inputs. It does not import the property seed harness, so its fast-check seed is fresh each
  run. The documentation row accurately describes this; duplication is unnecessary.

## Coordinator handoffs and learning assessment

Preserve the five binding/oracle findings above in `docs/knowledge/gotchas.md` through an authorized unit, and
correct the plan's NaN premise. Keep ADR 0005's Storage-level NUL rejection distinct from this low-level
binding's lossless NUL read. Schedule the negative-zero binding fix with the pin updated in the same
follow-up; do not silently normalize away the difference here. None of these handoffs authorizes platform
edits in FFI-07.

The hang-safety findings and reproductions in the final report are durable test-harness knowledge; hand them
to the coordinator for the knowledge index. No reusable general-purpose script was added. The worktree is
retained for coordinator inspection and cleanup.
