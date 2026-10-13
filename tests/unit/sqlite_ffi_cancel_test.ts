/**
 * FFI SQLite binding (`platform/sqlite_ffi/`): a statement that never ends is cancelled within a
 * few milliseconds of its deadline or abort, the event loop keeps running while it executes, and the
 * connection is clean and reusable afterwards.
 *
 * Latency bounds are deliberately loose against a shared 4-vCPU VM (Fable's probe measured
 * 0.3–8.8 ms); the measured numbers are printed so a regression is visible before it fails.
 *
 * Cancels issued while a step is still being dispatched to the pool (immediate abort, immediate
 * `closeAsync`, `timeoutMs: 0`) run in a subprocess under an external `timeout`: the failure mode
 * they guard against is a hang, which would otherwise take the test runner down with it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Database,
  SqliteCancelled,
  SqliteError,
  SqliteUsageError,
  SqliteValueError,
} from "../../platform/sqlite_ffi/mod.ts";

/** Never terminates: an unbounded recursive CTE. */
const FOREVER = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) AS n FROM c";

/** Upper bound on any single cancel latency, and on the median across runs. */
const MAX_CANCEL_MS = 25;
const MAX_MEDIAN_CANCEL_MS = 5;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-ffi-cancel-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Counts event-loop turns via a chain of short timers and records the longest gap between them. */
function loopProbe(intervalMs = 2) {
  let ticks = 0;
  let maxGap = 0;
  let last = performance.now();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
    handle = setTimeout(tick, intervalMs);
  };
  handle = setTimeout(tick, intervalMs);
  return {
    stop() {
      clearTimeout(handle);
      return { ticks, maxGapMs: maxGap };
    },
  };
}

async function expectCancelled(
  p: Promise<unknown>,
  reason: "deadline" | "aborted",
): Promise<SqliteCancelled> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SqliteCancelled, `expected SqliteCancelled, got ${String(e)}`);
    assert.equal(e.reason, reason);
    return e;
  }
  assert.fail("the statement completed; it should have been cancelled");
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

Deno.test("deadline: a never-ending query is cancelled within a few ms while the event loop runs", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "long.db"));
  const side = Database.open(join(dir, "side.db"));
  try {
    side.exec("CREATE TABLE kv(k INTEGER PRIMARY KEY, v TEXT); INSERT INTO kv VALUES (1, 'one');");
    const point = side.prepare("SELECT v FROM kv WHERE k = ?");
    const forever = db.prepare(FOREVER);
    const latencies: number[] = [];
    for (let run = 0; run < 5; run++) {
      const timeoutMs = 200;
      const probe = loopProbe();
      const started = performance.now();
      const pending = forever.getAsync(undefined, { timeoutMs });
      // Real work on the main thread while the statement runs on a pool thread.
      let pointReads = 0;
      while (performance.now() - started < timeoutMs - 50) {
        assert.equal(point.get([1])?.v, "one");
        pointReads++;
        await new Promise((r) => setTimeout(r, 1));
      }
      const err = await expectCancelled(pending, "deadline");
      const total = performance.now() - started;
      const loop = probe.stop();
      latencies.push(err.cancelLatencyMs);
      console.log(
        `run ${run}: cancel latency ${err.cancelLatencyMs.toFixed(3)} ms, elapsed ${total.toFixed(1)} ms, ` +
          `loop ticks ${loop.ticks}, max loop gap ${loop.maxGapMs.toFixed(1)} ms, point reads ${pointReads}`,
      );
      assert.equal(err.timeoutMs, timeoutMs);
      assert.ok(err.elapsedMs >= timeoutMs - 1, `rejected before its deadline (${err.elapsedMs} ms)`);
      assert.ok(err.cancelLatencyMs < MAX_CANCEL_MS, `cancel latency ${err.cancelLatencyMs} ms`);
      assert.ok(total < timeoutMs + MAX_CANCEL_MS + 25, `total ${total} ms for a ${timeoutMs} ms deadline`);
      // A 2 ms timer chain over ~200 ms: a blocked loop would manage one or two turns, with one gap
      // as long as the deadline. The bounds leave room for a loaded shared VM.
      assert.ok(loop.ticks >= 20, `event loop starved: ${loop.ticks} ticks`);
      assert.ok(loop.maxGapMs < 100, `event loop gap ${loop.maxGapMs} ms`);
      assert.ok(pointReads >= 10, `only ${pointReads} point reads ran during the statement`);
      assert.equal(db.inFlight, false);
    }
    console.log(`median cancel latency ${median(latencies).toFixed(3)} ms over ${latencies.length} runs`);
    assert.ok(median(latencies) < MAX_MEDIAN_CANCEL_MS, `median cancel latency ${median(latencies)} ms`);
    // The connection is clean: no interrupt lingers into the next statement.
    assert.equal(db.prepare("SELECT 42 AS x").get()?.x, 42);
    assert.equal((await db.prepare("SELECT 43 AS x").getAsync())?.x, 43);
  } finally {
    await db.closeAsync();
    side.close();
    cleanup();
  }
});

Deno.test("abort: an AbortSignal cancels a never-ending query; an aborted signal never starts it", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "abort.db"));
  try {
    const forever = db.prepare(FOREVER);
    const ac = new AbortController();
    const pending = forever.allAsync(undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(db.inFlight, true);
    const tAbort = performance.now();
    ac.abort();
    const err = await expectCancelled(pending, "aborted");
    const observed = performance.now() - tAbort;
    console.log(
      `abort latency ${observed.toFixed(3)} ms (binding-reported ${err.cancelLatencyMs.toFixed(3)} ms)`,
    );
    assert.ok(observed < MAX_CANCEL_MS, `abort latency ${observed} ms`);
    assert.equal(err.timeoutMs, undefined);

    const started = performance.now();
    await expectCancelled(forever.getAsync(undefined, { signal: ac.signal }), "aborted");
    assert.ok(performance.now() - started < 5);
    assert.equal(db.prepare("SELECT 1 AS x").get()?.x, 1);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("deadline: an interrupted write inside a transaction rolls the transaction back", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "tx.db"));
  try {
    db.exec("CREATE TABLE t(n INTEGER); BEGIN; INSERT INTO t VALUES (-1);");
    const flood = db.prepare(
      "INSERT INTO t WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c",
    );
    await expectCancelled(flood.runAsync(undefined, { timeoutMs: 100 }), "deadline");
    assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()?.n, 0);
    // The transaction is gone, so the connection is back in autocommit mode.
    db.exec("BEGIN; INSERT INTO t VALUES (7); COMMIT;");
    assert.equal(db.prepare("SELECT sum(n) AS s FROM t").get()?.s, 7);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("concurrency: four never-ending queries on four connections all meet their deadlines", async () => {
  const { dir, cleanup } = scratch();
  const dbs = [0, 1, 2, 3].map((i) => Database.open(join(dir, `c${i}.db`)));
  try {
    const probe = loopProbe();
    const started = performance.now();
    const errs = await Promise.all(
      dbs.map((db, i) =>
        expectCancelled(db.prepare(FOREVER).getAsync(undefined, { timeoutMs: 100 + 20 * i }), "deadline")
      ),
    );
    const total = performance.now() - started;
    const loop = probe.stop();
    console.log(
      `4 concurrent: cancel latencies ${errs.map((e) => e.cancelLatencyMs.toFixed(2)).join(", ")} ms; ` +
        `total ${total.toFixed(1)} ms; loop ticks ${loop.ticks}, max gap ${loop.maxGapMs.toFixed(1)} ms`,
    );
    for (const e of errs) {
      assert.ok(e.cancelLatencyMs < MAX_CANCEL_MS, `cancel latency ${e.cancelLatencyMs} ms`);
    }
    assert.ok(total < 160 + MAX_CANCEL_MS + 25, `total ${total} ms`);
    assert.ok(loop.ticks >= 15, `event loop starved: ${loop.ticks} ticks`);
  } finally {
    await Promise.all(dbs.map((db) => db.closeAsync()));
    cleanup();
  }
});

Deno.test("busy: an in-flight execution owns its connection until it settles", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "busy.db"));
  try {
    const forever = db.prepare(FOREVER);
    const other = db.prepare("SELECT 1 AS x");
    const pending = forever.getAsync(undefined, { timeoutMs: 5_000 });
    const busy = (e: unknown) => e instanceof SqliteUsageError && e.reason === "busy";
    assert.throws(() => other.get(), busy);
    assert.throws(() => db.exec("SELECT 1"), busy);
    assert.throws(() => db.prepare("SELECT 2"), busy);
    assert.throws(() => db.close(), busy);
    assert.throws(() => other.finalize(), busy);
    await assert.rejects(() => other.getAsync(), busy);
    await assert.rejects(() => forever.getAsync(), busy);
    assert.equal(db.isOpen, true);

    // closeAsync cancels the execution, waits for the pool thread to return, then closes.
    const started = performance.now();
    await db.closeAsync();
    const closeMs = performance.now() - started;
    console.log(`closeAsync with a statement in flight: ${closeMs.toFixed(3)} ms`);
    assert.ok(closeMs < MAX_CANCEL_MS, `closeAsync took ${closeMs} ms`);
    await expectCancelled(pending, "aborted");
    assert.equal(db.isOpen, false);
    assert.equal(other.isFinalized, true);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("options: timeoutMs is validated; timeoutMs 0 cancels at once", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "opt.db"));
  try {
    const forever = db.prepare(FOREVER);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => forever.getAsync(undefined, { timeoutMs: bad }),
        (e: unknown) => e instanceof SqliteUsageError && e.reason === "invalid-option",
      );
    }
    const err = await expectCancelled(forever.getAsync(undefined, { timeoutMs: 0 }), "deadline");
    assert.ok(err.elapsedMs < MAX_CANCEL_MS, `elapsed ${err.elapsedMs} ms`);
    // A statement that finishes before its deadline is not affected by it.
    assert.equal((await db.prepare("SELECT 5 AS x").getAsync(undefined, { timeoutMs: 1_000 }))?.x, 5);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

const CONFIG = fileURLToPath(new URL("../../deno.json", import.meta.url));
const MOD = new URL("../../platform/sqlite_ffi/mod.ts", import.meta.url).href;

/**
 * Run `code` in a fresh `deno eval` under an external watchdog (`timeout`, then SIGKILL) with core
 * dumps off. The probe prints one JSON line last; a hang exits 124/137, a crash 128 + signal.
 */
async function probe(code: string, seconds: number) {
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      'ulimit -c 0; exec timeout -k 2 "$@"',
      "sh",
      `${seconds}s`,
      Deno.execPath(),
      "eval",
      "--config",
      CONFIG,
      "--ext=ts",
      code,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr);
  assert.equal(out.code, 0, `probe exited ${out.code} (124/137 = hung, 139 = SIGSEGV)\n${stdout}\n${stderr}`);
  return JSON.parse(stdout.split("\n").at(-1) ?? "null");
}

Deno.test("race: cancels issued before the pool thread enters sqlite3_step still stop it", async () => {
  // Each cancel below lands right after `sqlite3_step_nb` was submitted, typically before a pool
  // thread is inside SQLite, where a single `sqlite3_interrupt` is discarded. Bounded counts:
  // BOUNDED counts n = 1 .. 100000, so 100000 rows.
  const result = await probe(
    `
const { Database } = await import(${JSON.stringify(MOD)});
const FOREVER = ${JSON.stringify(FOREVER)};
const BOUNDED = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100000) " +
  "SELECT count(*) AS n FROM c";
const tag = (e) => String(e?._tag) + ":" + String(e?.reason ?? e?.codeName ?? "");
const done = () => "completed";
const out = { aborts: [], abortMs: [], reuse: [], deadline0: [], deadline0Ms: [], after: [],
  closes: [], closeMs: [], queued: [], queuedMs: 0, queuedReuse: [] };
const db = Database.open(":memory:");
const forever = db.prepare(FOREVER);
const bounded = db.prepare(BOUNDED);
for (let i = 0; i < 100; i++) {
  const ac = new AbortController();
  const p = forever.getAsync(undefined, { signal: ac.signal }).then(done, tag);
  const t0 = performance.now();
  ac.abort();
  out.aborts.push(await p);
  out.abortMs.push(performance.now() - t0);
  // No interrupt lingers into the next execution, async or sync.
  if (i % 10 === 9) out.reuse.push((await bounded.getAsync())?.n, bounded.get()?.n);
}
for (let i = 0; i < 50; i++) {
  const e = await forever.getAsync(undefined, { timeoutMs: 0 }).then(done, (e) => e);
  out.deadline0.push(tag(e));
  out.deadline0Ms.push(e.cancelLatencyMs);
}
out.after = [
  db.prepare("SELECT  42  AS  x").get()?.x,
  (await db.prepare("SELECT 43 AS x").getAsync())?.x,
  (await bounded.allAsync())[0]?.n,
];
await db.closeAsync();
for (let i = 0; i < 50; i++) {
  const d = Database.open(":memory:");
  const p = d.prepare(FOREVER).getAsync().then(done, tag);
  const t0 = performance.now();
  await d.closeAsync();
  out.closeMs.push(performance.now() - t0);
  out.closes.push((await p) + (d.isOpen ? ":open" : ":closed"));
}
// Sixteen connections cancelled in one tick, while their steps are still queued for the pool.
const dbs = Array.from({ length: 16 }, () => Database.open(":memory:"));
const ac = new AbortController();
const ps = dbs.map((d) => d.prepare(FOREVER).getAsync(undefined, { signal: ac.signal }).then(done, tag));
const t0 = performance.now();
ac.abort();
out.queued = await Promise.all(ps);
out.queuedMs = performance.now() - t0;
out.queuedReuse = await Promise.all(dbs.map(async (d) => (await d.prepare(BOUNDED).getAsync())?.n));
await Promise.all(dbs.map((d) => d.closeAsync()));
console.log(JSON.stringify(out));
`,
    60,
  );
  const stats = (xs: number[]) =>
    `median ${median(xs).toFixed(3)} ms, max ${Math.max(...xs).toFixed(3)} ms over ${xs.length}`;
  console.log(`immediate abort: ${stats(result.abortMs)}`);
  console.log(`timeoutMs 0 (binding-reported cancel latency): ${stats(result.deadline0Ms)}`);
  console.log(`immediate closeAsync: ${stats(result.closeMs)}`);
  console.log(`16 connections aborted in one tick: all settled in ${result.queuedMs.toFixed(3)} ms`);

  assert.deepEqual(result.aborts, Array(100).fill("SqliteCancelled:aborted"));
  assert.deepEqual(result.reuse, Array(20).fill(100000));
  assert.deepEqual(result.deadline0, Array(50).fill("SqliteCancelled:deadline"));
  assert.deepEqual(result.after, [42, 43, 100000]);
  assert.deepEqual(result.closes, Array(50).fill("SqliteCancelled:aborted:closed"));
  assert.deepEqual(result.queued, Array(16).fill("SqliteCancelled:aborted"));
  assert.deepEqual(result.queuedReuse, Array(16).fill(100000));
  for (const xs of [result.abortMs, result.deadline0Ms, result.closeMs] as number[][]) {
    assert.ok(Math.max(...xs) < 2 * MAX_CANCEL_MS, stats(xs));
    assert.ok(median(xs) < MAX_MEDIAN_CANCEL_MS, stats(xs));
  }
  assert.ok(result.queuedMs < 2 * MAX_CANCEL_MS, `16 aborts settled in ${result.queuedMs} ms`);
});

/** Make `signal`'s detachment throw: an overriding method, or a getter that throws on access. */
const throwingCleanup = {
  method(signal: AbortSignal) {
    signal.removeEventListener = () => {
      throw new Error("cleanup threw");
    };
  },
  getter(signal: AbortSignal) {
    Object.defineProperty(signal, "removeEventListener", {
      get() {
        throw new Error("cleanup threw");
      },
    });
  },
};

/** The rejection of `p`, which must reject. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return assert.fail("the execution resolved; it should have rejected");
}

const causeMessage = (e: unknown) => ((e as { cause?: unknown }).cause as Error | undefined)?.message;

/** `e` is the binding's own error, carrying the cleanup exception as a non-enumerable `cause`. */
function assertCleanupCause(e: unknown): void {
  const d = Object.getOwnPropertyDescriptor(e, "cause");
  assert.ok(d !== undefined, `no own cause on ${String(e)}`);
  assert.equal(d.enumerable, false);
  assert.equal((d.value as Error).message, "cleanup threw");
}

for (const [how, install] of Object.entries(throwingCleanup)) {
  Deno.test(`cleanup: a throwing signal detachment (${how}) never replaces the execution's outcome`, async () => {
    // The re-review's defect 2. Each execution below runs with a signal whose `removeEventListener`
    // throws during cleanup. The original outcome must win and carry the exception as `cause`;
    // cleanup still finishes: timers cleared (the test's timer sanitizer fails on a leaked
    // `timeoutMs` timer), connection released, `closeAsync` waiters resolved, connection reusable.
    const { dir, cleanup } = scratch();
    const db = Database.open(join(dir, "t.db"));
    const signal = () => {
      const ac = new AbortController();
      install(ac.signal);
      return ac;
    };
    const reusable = async () => {
      assert.equal(db.inFlight, false);
      assert.equal(db.prepare("SELECT 42 AS x").get()?.x, 42);
      assert.equal((await db.prepare("SELECT 43 AS x").getAsync())?.x, 43);
    };
    try {
      db.exec("CREATE TABLE t(x UNIQUE); INSERT INTO t VALUES (1);");
      const forever = db.prepare(FOREVER);

      // (a) Cancellation: by deadline, and by the signal itself.
      let e = await rejection(forever.getAsync(undefined, { signal: signal().signal, timeoutMs: 5 }));
      assert.ok(e instanceof SqliteCancelled, String(e));
      assert.equal(e.reason, "deadline");
      assert.equal(e.timeoutMs, 5);
      assertCleanupCause(e);
      await reusable();
      const ac = signal();
      const aborted = rejection(forever.allAsync(undefined, { signal: ac.signal }));
      await new Promise((r) => setTimeout(r, 5));
      ac.abort();
      e = await aborted;
      assert.ok(e instanceof SqliteCancelled, String(e));
      assert.equal(e.reason, "aborted");
      assertCleanupCause(e);
      await reusable();

      // (b) A reset error: INSERT ... RETURNING under a reader's lock fails its commit at reset.
      {
        using reader = Database.open(join(dir, "t.db"));
        reader.exec("BEGIN; SELECT * FROM t;");
        const insert = db.prepare("INSERT INTO t VALUES (?) RETURNING x");
        e = await rejection(insert.getAsync([2], { signal: signal().signal, timeoutMs: 10_000 }));
        assert.ok(e instanceof SqliteError, String(e));
        assert.equal(e.op, "reset");
        assert.equal(e.code, 5);
        assert.equal(e.extendedCode, 5);
        assert.equal(e.sqliteMessage, "database is locked");
        assertCleanupCause(e);
        reader.exec("ROLLBACK");
      }
      await reusable();

      // A step error: a duplicate UNIQUE value.
      e = await rejection(
        db.prepare("INSERT INTO t VALUES (1)").runAsync(undefined, {
          signal: signal().signal,
          timeoutMs: 10_000,
        }),
      );
      assert.ok(e instanceof SqliteError, String(e));
      assert.equal(e.op, "step");
      assert.equal(e.extendedCode, 2067);
      assert.equal(e.codeName, "SQLITE_CONSTRAINT_UNIQUE");
      assert.equal(e.sqliteMessage, "UNIQUE constraint failed: t.x");
      assertCleanupCause(e);
      await reusable();

      // A caller's own exception (a parameter getter) is the outcome too, and is left untouched.
      const own = new Error("getter threw");
      e = await rejection(
        db.prepare("SELECT :x AS x").getAsync({
          get x(): number {
            throw own;
          },
        }, { signal: signal().signal }),
      );
      assert.equal(e, own);
      assert.equal(own.cause, undefined);
      await reusable();

      // (c) Success: the statement ran, so its changes stand, but the cleanup failure is reported
      // as a typed usage error rather than lost.
      e = await rejection(
        db.prepare("INSERT INTO t VALUES (7)").runAsync(undefined, {
          signal: signal().signal,
          timeoutMs: 10_000,
        }),
      );
      assert.ok(e instanceof SqliteUsageError, String(e));
      assert.equal(e.reason, "signal-cleanup");
      assert.equal(e.sql, "INSERT INTO t VALUES (7)");
      assert.equal(causeMessage(e), "cleanup threw");
      assert.deepEqual(db.prepare("SELECT x FROM t ORDER BY x").all().map((r) => r.x), [1, 7]);
      await reusable();

      // closeAsync cancels an execution whose cleanup throws, and still resolves and closes.
      const pending = rejection(forever.getAsync(undefined, { signal: signal().signal }));
      await new Promise((r) => setTimeout(r, 5));
      await db.closeAsync();
      assert.equal(db.isOpen, false);
      e = await pending;
      assert.ok(e instanceof SqliteCancelled, String(e));
      assert.equal(e.reason, "aborted");
      assertCleanupCause(e);
    } finally {
      await db.closeAsync();
      cleanup();
    }
  });
}

for (const [how, install] of Object.entries(throwingCleanup)) {
  Deno.test(`cleanup: a throwing signal detachment (${how}) never touches an exception the caller threw`, async () => {
    // The second re-review's defect 1. Ownership of the pending error is by identity, not class:
    // an exception that came out of caller code (here a parameter getter) is rethrown as the same
    // object with unchanged own properties, even when it is a binding error class, frozen, or a
    // proxy whose every trap throws, while the binding's own errors still get the cleanup
    // exception as `cause`. Every case runs with a 10 s deadline (the test's timer sanitizer fails
    // on a leaked timer) and twice: once checking reuse, once with `closeAsync` requested from
    // inside the getter, whose waiter must settle and close the connection.
    const signal = () => {
      const ac = new AbortController();
      install(ac.signal);
      return ac.signal;
    };
    /** Run `SELECT :x` with a getter that throws `thrown()`; return the rejection, boxed. */
    const run = async (db: Database, thrown: () => unknown, close: boolean) => {
      let waiter: Promise<void> | undefined;
      const params = {
        get x(): number {
          if (close) waiter = db.closeAsync();
          throw thrown();
        },
      };
      try {
        await db.prepare("SELECT :x AS x").getAsync(params, { signal: signal(), timeoutMs: 10_000 });
      } catch (e) {
        // Boxed: returning a proxy from an async function would read its `then`.
        return { e, waiter };
      }
      return assert.fail("the execution resolved; it should have rejected");
    };
    const settle = async (db: Database, waiter: Promise<void> | undefined, close: boolean) => {
      if (close) {
        assert.ok(waiter !== undefined);
        await waiter;
        assert.equal(db.isOpen, false);
      } else {
        assert.equal(db.inFlight, false);
        assert.equal(db.prepare("SELECT 42 AS x").get()?.x, 42);
        assert.equal((await db.prepare("SELECT 43 AS x").getAsync())?.x, 43);
      }
      await db.closeAsync();
    };

    for (const close of [false, true]) {
      // A tagged binding error the caller made, frozen: the report's reproduction.
      {
        const db = Database.open(":memory:");
        const own = Object.freeze(new SqliteUsageError({ reason: "invalid-option", detail: "caller error" }));
        const before = Object.getOwnPropertyDescriptors(own);
        const { e, waiter } = await run(db, () => own, close);
        assert.equal(e, own);
        assert.equal(own.detail, "caller error");
        assert.deepEqual(Object.getOwnPropertyDescriptors(own), before);
        await settle(db, waiter, close);
      }

      // A binding error the caller caught from an earlier, nested call (extensible): still the
      // caller's, so no `cause` is added.
      {
        const db = Database.open(":memory:");
        let caught: unknown;
        let before: PropertyDescriptorMap | undefined;
        const { e, waiter } = await run(db, () => {
          try {
            db.exec("SELECT 1");
          } catch (nested) {
            caught = nested;
          }
          before = Object.getOwnPropertyDescriptors(caught);
          return caught;
        }, close);
        assert.ok(caught instanceof SqliteUsageError && Object.isExtensible(caught), String(caught));
        assert.equal(caught.reason, "busy");
        assert.equal(e, caught);
        assert.equal(Object.hasOwn(caught, "cause"), false);
        assert.deepEqual(Object.getOwnPropertyDescriptors(caught), before);
        await settle(db, waiter, close);
      }

      // A proxy whose every trap throws (`getPrototypeOf` first among them, which `instanceof`
      // would run): rethrown as itself, no trap ever invoked.
      {
        const db = Database.open(":memory:");
        const traps: string[] = [];
        const handler = new Proxy({}, {
          get(_, trap) {
            return () => {
              traps.push(String(trap));
              throw new Error(`trap ${String(trap)} replaced the caller's exception`);
            };
          },
        });
        const proxy = new Proxy(new Error("caller proxy"), handler);
        const { e, waiter } = await run(db, () => proxy, close);
        assert.ok(e === proxy, "the proxy was not rethrown by identity");
        assert.deepEqual(traps, []);
        await settle(db, waiter, close);
      }
    }

    // The binding's own errors from binding and option validation still carry the cause.
    {
      const db = Database.open(":memory:");
      const own = async (p: Promise<unknown>) => {
        const e = await rejection(p);
        assertCleanupCause(e);
        return e;
      };
      const select = db.prepare("SELECT ? AS x");
      let e = await own(select.getAsync([2n ** 70n], { signal: signal(), timeoutMs: 10_000 }));
      assert.ok(e instanceof SqliteValueError && e.reason === "integer-out-of-range", String(e));
      e = await own(select.getAsync([undefined as unknown as number], { signal: signal() }));
      assert.ok(e instanceof SqliteValueError && e.reason === "unsupported-bind-type", String(e));
      e = await own(select.getAsync([], { signal: signal() }));
      assert.ok(e instanceof SqliteUsageError && e.reason === "bind-count", String(e));
      e = await own(select.getAsync([1], { signal: signal(), timeoutMs: -1 }));
      assert.ok(e instanceof SqliteUsageError && e.reason === "invalid-option", String(e));
      e = await own(db.prepare("SELECT 9007199254740993 AS x").getAsync(undefined, { signal: signal() }));
      assert.ok(e instanceof SqliteValueError && e.reason === "unsafe-integer", String(e));
      assert.equal((await select.getAsync([1]))?.x, 1);
      await db.closeAsync();
    }
  });
}
