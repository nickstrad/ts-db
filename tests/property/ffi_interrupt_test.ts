/**
 * FFI-07, work 2: interrupt totality. A nonblocking statement (`allAsync`, and the Effect layer's
 * `allAsync`) given a random statement and a random interrupt delay of 0-50 ms ALWAYS terminates, with
 * exactly one of
 *
 * - its rows (the statement finished first, and the rows are the ones the same statement returns
 *   undisturbed), or
 * - the cancellation its mechanism promises: `SqliteCancelled` (`reason: "deadline"` for `timeoutMs`,
 *   `"aborted"` for an `AbortSignal`, either when both are armed) or, for fiber interruption through
 *   `Effect.timeout`, Effect's `TimeoutException`.
 *
 * It never hangs, and it never leaves the connection unusable: the very next statement, blocking and
 * nonblocking, answers, and `db.inFlight` is false. Each iteration is bounded by a hard wall-clock
 * guard (`GUARD_MS`) that FAILS the test when hit; cleanup then abandons a stuck close after a second
 * grace instead of hanging the runner.
 *
 * Statements (one prepared set, reused across all iterations, so a cancelled statement is also reused):
 * `forever` (an unbounded recursive CTE: must be cancelled), `cte` and `join` (a few hundred ms of CPU
 * on this VM: either outcome is valid), `scan` (a few ms), and `point` and `trivial` (microseconds:
 * almost always rows, but a delay of 0 may legitimately cancel them first). The generators hit both
 * outcomes; the test asserts it saw both, per mechanism family.
 *
 * Deliberately NOT generated: statements that wait on a lock. `sqlite3_interrupt` does not cut a
 * `busy_timeout` wait (`docs/knowledge/gotchas.md`, FFI-05), so a blocked statement ends with
 * `SQLITE_BUSY` after the whole timeout rather than `SqliteCancelled`. There is one connection on one
 * temp file here, so `SQLITE_BUSY` cannot occur, and any `SqliteError` fails the property.
 *
 * `numRuns: 200` (the plan's 200 iterations), seed from `PROP_SEED` (default 20261010). Sweep:
 * `bash work-scripts/bash/property-seed-sweep.sh tests/property/ffi_interrupt_test.ts - 1 200`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import fc from "fast-check";
import {
  allAsync as allAsyncEffect,
  Database,
  type Row,
  SqliteCancelled,
  type Statement,
} from "../../platform/sqlite_ffi/mod.ts";
import { SEED, titled } from "./arbitraries.ts";
import { runs } from "./compiler_arbitraries.ts";

const ITERATIONS = 200;
/** Hard bound on one iteration. Far above the slowest statement; hitting it means a hang. */
const GUARD_MS = 15_000;
const CLOSE_GRACE_MS = 1_000;
/** Backstop deadline for the fiber mechanism: if interruption failed, this would end the statement. */
const FIBER_BACKSTOP_MS = 8_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATEMENTS = {
  forever: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) AS n FROM c",
  cte: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 4000000) " +
    "SELECT count(*) AS n, sum(n) AS s FROM c",
  join: "SELECT count(*) AS n FROM big a JOIN big b ON a.grp = b.grp WHERE a.id <= 4000",
  scan: "SELECT count(*) AS n, sum(length(pad)) AS s FROM big WHERE grp % 7 = 3",
  point: "SELECT id, grp, pad FROM big WHERE id = 4242",
  trivial: "SELECT 1 AS n",
} as const;
type Kind = keyof typeof STATEMENTS;
const KINDS = Object.keys(STATEMENTS) as Kind[];

const SEED_ROWS = 100_000;

type Fixture = {
  db: Database;
  statements: Record<Kind, Statement>;
  /** The undisturbed result of every statement that ends. */
  expected: Record<Exclude<Kind, "forever">, Row[]>;
  probe: Statement;
};

const plain = (rows: readonly Row[]) => rows.map((r) => ({ ...r }));

async function withFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-ffi-interrupt-"));
  const db = Database.open(join(dir, "interrupt.db"));
  try {
    db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, pad TEXT NOT NULL)");
    db.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) " +
        "INSERT INTO big SELECT i, i % 50, printf('row-%08d-padding', i) FROM n",
    ).run([SEED_ROWS]);
    const statements = Object.fromEntries(
      KINDS.map((k) => [k, db.prepare(STATEMENTS[k])]),
    ) as Fixture["statements"];
    const expected = {} as Fixture["expected"];
    for (const k of KINDS) if (k !== "forever") expected[k] = plain(statements[k].all());
    assert.equal(expected.point.length, 1, "the point read finds its row");
    assert.ok(Number(expected.join[0].n) > 1_000_000, "the join is big enough to run for a while");
    return await fn({ db, statements, expected, probe: db.prepare("SELECT 42 AS x") });
  } finally {
    // A stuck close is a finding, but the guard already failed the test; do not hang the runner.
    await Promise.race([db.closeAsync().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

type Mechanism =
  | { how: "deadline"; delayMs: number }
  | { how: "abort"; delayMs: number }
  | { how: "both"; deadlineMs: number; abortMs: number }
  | { how: "fiber"; delayMs: number };

const delayArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 50 }) },
);

const mechanismArb: fc.Arbitrary<Mechanism> = fc.oneof(
  delayArb.map((delayMs): Mechanism => ({ how: "deadline", delayMs })),
  delayArb.map((delayMs): Mechanism => ({ how: "abort", delayMs })),
  fc.tuple(delayArb, delayArb).map(([deadlineMs, abortMs]): Mechanism => ({
    how: "both",
    deadlineMs,
    abortMs,
  })),
  delayArb.map((delayMs): Mechanism => ({ how: "fiber", delayMs })),
);

/** `forever` is common enough to see many cancellations; the fast ones check the rows branch. */
const kindArb: fc.Arbitrary<Kind> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Kind>("forever") },
  { weight: 2, arbitrary: fc.constantFrom<Kind>("cte", "join") },
  { weight: 2, arbitrary: fc.constant<Kind>("scan") },
  { weight: 2, arbitrary: fc.constantFrom<Kind>("point", "trivial") },
);

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

type Outcome = { kind: "rows"; rows: Row[] } | { kind: "cancelled"; error: unknown };

/** Starts the statement under `mechanism` and settles with its rows or its failure. */
function execute(statement: Statement, mechanism: Mechanism): { done: Promise<Outcome>; cleanup(): void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const settle = (p: Promise<Row[]>): Promise<Outcome> =>
    p.then((rows): Outcome => ({ kind: "rows", rows }), (error): Outcome => ({ kind: "cancelled", error }));
  const cleanup = () => timers.forEach(clearTimeout);
  switch (mechanism.how) {
    case "deadline":
      return { done: settle(statement.allAsync(undefined, { timeoutMs: mechanism.delayMs })), cleanup };
    case "abort": {
      const ac = new AbortController();
      timers.push(setTimeout(() => ac.abort(), mechanism.delayMs));
      return { done: settle(statement.allAsync(undefined, { signal: ac.signal })), cleanup };
    }
    case "both": {
      const ac = new AbortController();
      timers.push(setTimeout(() => ac.abort(), mechanism.abortMs));
      return {
        done: settle(statement.allAsync(undefined, { timeoutMs: mechanism.deadlineMs, signal: ac.signal })),
        cleanup,
      };
    }
    case "fiber": {
      // Interruption through the Effect layer: `Effect.timeout` interrupts the fiber, whose canceler
      // aborts the binding call and waits for the statement to return.
      const run = Effect.runPromiseExit(
        Effect.timeout(
          allAsyncEffect(statement, undefined, { timeoutMs: FIBER_BACKSTOP_MS }),
          mechanism.delayMs,
        ),
      ).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value as Row[];
        throw Option.getOrElse(Cause.failureOption(exit.cause), () => exit.cause);
      });
      return { done: settle(run), cleanup };
    }
  }
}

/** The ways `mechanism` is allowed to end a statement early. */
function isPromisedCancellation(error: unknown, mechanism: Mechanism): boolean {
  if (mechanism.how === "fiber") return Cause.isTimeoutException(error);
  if (!(error instanceof SqliteCancelled)) return false;
  if (mechanism.how === "deadline") {
    return error.reason === "deadline" && error.timeoutMs === mechanism.delayMs;
  }
  if (mechanism.how === "abort") return error.reason === "aborted";
  return error.reason === "deadline" ? error.timeoutMs === mechanism.deadlineMs : error.reason === "aborted";
}

Deno.test(
  titled(
    `ffi interrupt: a nonblocking step always ends in rows or its promised cancellation (${ITERATIONS} runs)`,
  ),
  async () => {
    const tally: Record<string, number> = { rows: 0, cancelled: 0 };
    for (const k of KINDS) tally[k] = 0;
    for (const m of ["deadline", "abort", "both", "fiber"]) tally[`${m}:cancelled`] = tally[`${m}:rows`] = 0;
    let slowest = 0;
    await withFixture(async ({ db, statements, expected, probe }) => {
      await fc.assert(
        fc.asyncProperty(kindArb, mechanismArb, async (kind, mechanism) => {
          const started = performance.now();
          const { done, cleanup } = execute(statements[kind], mechanism);
          let guard: ReturnType<typeof setTimeout> | undefined;
          try {
            const outcome = await Promise.race([
              done,
              new Promise<never>((_, reject) => {
                guard = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `HANG: ${kind} under ${JSON.stringify(mechanism)} did not end in ${GUARD_MS} ms`,
                      ),
                    ),
                  GUARD_MS,
                );
              }),
            ]);
            slowest = Math.max(slowest, performance.now() - started);
            tally[kind]++;
            tally[outcome.kind]++;
            tally[`${mechanism.how}:${outcome.kind}`]++;
            if (outcome.kind === "rows") {
              assert.notEqual(kind, "forever", "a statement that never ends returned rows");
              assert.deepStrictEqual(plain(outcome.rows), expected[kind as Exclude<Kind, "forever">]);
            } else {
              assert.ok(
                isPromisedCancellation(outcome.error, mechanism),
                `${kind} under ${JSON.stringify(mechanism)} failed with ${String(outcome.error)} ` +
                  `(${JSON.stringify(outcome.error)}), not its promised cancellation`,
              );
            }
          } finally {
            clearTimeout(guard);
            cleanup();
          }
          // The connection is reusable at once: released, no interrupt left over for the next statement.
          assert.equal(db.inFlight, false, "the connection is still held after the step settled");
          assert.equal(probe.get()?.x, 42);
          assert.equal((await probe.getAsync())?.x, 42);
          assert.equal(statements.point.get()?.pad, "row-00004242-padding");
        }),
        runs(ITERATIONS),
      );
    });
    console.log(
      `interrupt coverage (seed ${SEED}): ${JSON.stringify(tally)}, slowest iteration ${
        slowest.toFixed(0)
      } ms`,
    );
    // Both outcomes occurred, for the families that can produce both (seed-independent lower bounds).
    assert.ok(tally.rows >= 20, `too few completions: ${JSON.stringify(tally)}`);
    assert.ok(tally.cancelled >= 20, `too few cancellations: ${JSON.stringify(tally)}`);
    for (const m of ["deadline", "abort", "both", "fiber"]) {
      assert.ok(tally[`${m}:cancelled`] > 0, `${m} never cancelled: ${JSON.stringify(tally)}`);
    }
    for (const k of KINDS) assert.ok(tally[k] > 0, `${k} never ran`);
  },
);
