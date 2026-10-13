/**
 * FFI SQLite binding (`platform/sqlite_ffi/`): a statement that never ends is cancelled within a
 * few milliseconds of its deadline or abort, the event loop keeps running while it executes, and the
 * connection is clean and reusable afterwards.
 *
 * Latency bounds are deliberately loose against a shared 4-vCPU VM (Fable's probe measured
 * 0.3–8.8 ms); the measured numbers are printed so a regression is visible before it fails.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, SqliteCancelled, SqliteUsageError } from "../../platform/sqlite_ffi/mod.ts";

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
