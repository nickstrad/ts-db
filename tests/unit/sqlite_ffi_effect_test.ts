/**
 * The Effect layer over the FFI SQLite binding (`platform/sqlite_ffi/effect.ts`): scoped
 * connections, typed failures, fiber interruption reaching `sqlite3_interrupt`, `inTransaction`,
 * busy handling, and the per-connection statement cache, including its point-read cost against
 * `node:sqlite`.
 *
 * Every never-ending statement also carries a 10 s binding deadline as a backstop: if a cancel path
 * regressed, the test fails with `reason: "deadline"` after 10 s instead of hanging the runner.
 * `node:sqlite` only ever opens its own files (two SQLite copies must never share a file in one
 * process: `docs/knowledge/gotchas.md`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import {
  all,
  allAsync,
  type BindParams,
  Database,
  exec,
  get,
  getAsync,
  isCacheable,
  openDatabase,
  prepare,
  prepareCached,
  run,
  runAsync,
  SqliteCancelled,
  SqliteError,
  SqliteUsageError,
  SqliteValueError,
  Statement,
  STATEMENT_CACHE_CAPACITY,
} from "../../platform/sqlite_ffi/mod.ts";

/** Never terminates: an unbounded recursive CTE. */
const FOREVER = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) AS n FROM c";
/** Backstop deadline on every never-ending execution (see the module comment). */
const BACKSTOP = { timeoutMs: 10_000 };

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-ffi-effect-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Records the binding promise behind each `allAsync` / `runAsync` call on `st`, settled to its
 * value or rejection, so a test can see what the binding reported after the fiber was interrupted
 * (the interrupted Effect itself only reports the interruption). The wrappers call the binding's
 * methods from `Statement.prototype`, never through the instance, so the spy wraps the prototype
 * for the life of the returned handle (`using`).
 */
function spy(st: Statement): { outcomes: Promise<unknown>[] } & Disposable {
  const proto = Statement.prototype;
  const original = { allAsync: proto.allAsync, runAsync: proto.runAsync };
  const outcomes: Promise<unknown>[] = [];
  const recorded = <F extends (this: Statement, ...args: never[]) => Promise<unknown>>(f: F) =>
    function (this: Statement, ...args: Parameters<F>) {
      const p = f.apply(this, args);
      if (this === st) outcomes.push(p.then((v) => v, (e: unknown) => e));
      return p;
    };
  proto.allAsync = recorded(original.allAsync) as typeof proto.allAsync;
  proto.runAsync = recorded(original.runAsync) as typeof proto.runAsync;
  return { outcomes, [Symbol.dispose]: () => void Object.assign(proto, original) };
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  assert.ok(Exit.isFailure(exit), "expected a failure");
  const failure = Cause.failureOption(exit.cause);
  assert.ok(Option.isSome(failure), `expected a typed failure, got ${Cause.pretty(exit.cause)}`);
  return failure.value;
}

// ---------------------------------------------------------------------------
// Scope, interruption, deadlines
// ---------------------------------------------------------------------------

Deno.test("scope: closing the scope cancels a pending async execution and closes within 50 ms", async () => {
  const { dir, cleanup } = scratch();
  try {
    // The execution runs on a daemon fiber, so only the connection's release can stop it: the
    // release's closeAsync cancels it ("aborted"), waits for its step, finalizes and closes.
    let db!: Database;
    let daemon!: Fiber.RuntimeFiber<unknown, unknown>;
    let bodyDone = 0;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      db = yield* openDatabase(join(dir, "daemon.db"));
      const st = yield* prepare(db, FOREVER);
      daemon = yield* Effect.forkDaemon(allAsync(st, undefined, BACKSTOP));
      yield* Effect.sleep(30);
      assert.equal(db.inFlight, true);
      bodyDone = performance.now();
    })));
    const closeMs = performance.now() - bodyDone;
    console.log(`scope close with a daemon-held execution: ${closeMs.toFixed(3)} ms`);
    assert.ok(closeMs < 50, `scope close took ${closeMs} ms`);
    assert.equal(db.isOpen, false);
    const err = failureOf(await Effect.runPromise(Fiber.await(daemon)));
    assert.ok(err instanceof SqliteCancelled, `expected SqliteCancelled, got ${String(err)}`);
    assert.equal(err.reason, "aborted");

    // The execution runs on a fiber of the same scope: the scope interrupts it first (the bridge
    // aborts the execution and waits for it), then releases the connection.
    let scoped!: Database;
    let outcomes!: Promise<unknown>[];
    let fiber!: Fiber.RuntimeFiber<unknown, unknown>;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      scoped = yield* openDatabase(join(dir, "scoped.db"));
      const st = yield* prepare(scoped, FOREVER);
      using spied = spy(st);
      outcomes = spied.outcomes;
      fiber = yield* Effect.forkScoped(allAsync(st, undefined, BACKSTOP));
      yield* Effect.sleep(30);
      assert.equal(scoped.inFlight, true);
      bodyDone = performance.now();
    })));
    const scopedMs = performance.now() - bodyDone;
    console.log(`scope close with a scoped fiber's execution: ${scopedMs.toFixed(3)} ms`);
    assert.ok(scopedMs < 50, `scope close took ${scopedMs} ms`);
    assert.equal(scoped.isOpen, false);
    assert.ok(Exit.isInterrupted(await Effect.runPromise(Fiber.await(fiber))));
    const inner = await outcomes[0];
    assert.ok(inner instanceof SqliteCancelled && inner.reason === "aborted", String(inner));
  } finally {
    cleanup();
  }
});

Deno.test("interrupt: interrupting the fiber aborts the execution and waits until it has settled", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "interrupt.db"));
  try {
    const st = db.prepare(FOREVER);
    using spied = spy(st);
    const { outcomes } = spied;
    const fiber = Effect.runFork(allAsync(st, undefined, BACKSTOP));
    await delay(30);
    assert.equal(db.inFlight, true);
    const started = performance.now();
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    const latency = performance.now() - started;
    // `Fiber.interrupt` returns only after the binding released the connection.
    assert.equal(db.inFlight, false);
    assert.ok(Exit.isInterrupted(exit));
    const inner = await outcomes[0];
    assert.ok(inner instanceof SqliteCancelled, `expected SqliteCancelled, got ${String(inner)}`);
    assert.equal(inner.reason, "aborted");
    console.log(
      `fiber interrupt: ${latency.toFixed(3)} ms (binding cancel latency ${
        inner.cancelLatencyMs.toFixed(3)
      } ms)`,
    );
    assert.ok(latency < 50, `interrupt took ${latency} ms`);
    // No interrupt lingers: the connection answers on both paths.
    assert.equal(Effect.runSync(get(db.prepare("SELECT 42 AS x")))?.x, 42);
    assert.equal((await Effect.runPromise(getAsync(db.prepare("SELECT 43 AS x"))))?.x, 43);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("timeout: Effect.timeout and timeoutMs both stop the statement and free the connection", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "timeout.db"));
  try {
    const st = db.prepare(FOREVER);
    using spied = spy(st);
    const { outcomes } = spied;

    // Effect.timeout: the fiber is interrupted, so the Effect reports Effect's TimeoutException;
    // the binding underneath was cancelled ("aborted") and had settled before timeout returned.
    let started = performance.now();
    const timedOut = await Effect.runPromiseExit(Effect.timeout(allAsync(st, undefined, BACKSTOP), 30));
    let elapsed = performance.now() - started;
    assert.equal(db.inFlight, false);
    assert.ok(Cause.isTimeoutException(failureOf(timedOut)));
    const inner = await outcomes[0];
    assert.ok(inner instanceof SqliteCancelled && inner.reason === "aborted", String(inner));
    console.log(`Effect.timeout(30 ms): returned after ${elapsed.toFixed(3)} ms`);
    assert.ok(elapsed >= 29 && elapsed < 30 + 50, `Effect.timeout returned after ${elapsed} ms`);
    assert.equal(Effect.runSync(get(db.prepare("SELECT 42 AS x")))?.x, 42);

    // timeoutMs: the binding enforces the deadline and the typed failure is SqliteCancelled.
    started = performance.now();
    const err = failureOf(await Effect.runPromiseExit(allAsync(st, undefined, { timeoutMs: 30 })));
    elapsed = performance.now() - started;
    assert.ok(err instanceof SqliteCancelled, `expected SqliteCancelled, got ${String(err)}`);
    assert.equal(err.reason, "deadline");
    assert.equal(err.timeoutMs, 30);
    console.log(`timeoutMs 30: SqliteCancelled after ${elapsed.toFixed(3)} ms`);
    assert.ok(elapsed < 30 + 50, `deadline returned after ${elapsed} ms`);
    assert.equal(db.inFlight, false);
    assert.equal((await Effect.runPromise(getAsync(db.prepare("SELECT 43 AS x"))))?.x, 43);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

Deno.test("failures: binding errors are typed failures; caller exceptions are defects, untouched", async () => {
  const { dir, cleanup } = scratch();
  try {
    const open = failureOf(
      await Effect.runPromiseExit(Effect.scoped(openDatabase(join(dir, "missing", "x.db")))),
    );
    assert.ok(open instanceof SqliteError && open.op === "open", String(open));
    assert.equal(open.codeName, "SQLITE_CANTOPEN");

    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* openDatabase(join(dir, "f.db"));
      yield* exec(db, "CREATE TABLE t(x UNIQUE); INSERT INTO t VALUES (1)");
      const insert = yield* prepare(db, "INSERT INTO t VALUES (?)");

      const sync = yield* Effect.flip(run(insert, [1]));
      assert.ok(sync instanceof SqliteError && sync.extendedCode === 2067, String(sync));
      const nb = yield* Effect.flip(runAsync(insert, [1]));
      assert.ok(nb instanceof SqliteError && nb.extendedCode === 2067, String(nb));

      const thrown = new Error("caller getter");
      const params = {
        get x() {
          throw thrown;
        },
      } as unknown as BindParams;
      const named = yield* prepare(db, "SELECT :x AS x");
      for (const effect of [all(named, params), allAsync(named, params)]) {
        const exit = yield* Effect.exit(effect);
        assert.ok(Exit.isFailure(exit));
        const defect = Cause.dieOption(exit.cause);
        assert.ok(Option.isSome(defect) && defect.value === thrown, Cause.pretty(exit.cause));
      }

      // One execution per connection: another statement while one is in flight fails "busy".
      const forever = yield* prepare(db, FOREVER);
      const fiber = yield* Effect.fork(allAsync(forever, undefined, BACKSTOP));
      yield* Effect.sleep(20);
      const busy = yield* Effect.flip(get(named, { x: 1 }));
      assert.ok(busy instanceof SqliteUsageError && busy.reason === "busy", String(busy));
      yield* Fiber.interrupt(fiber);
      assert.deepEqual({ ...(yield* get(named, { x: 1 })) }, { x: 1 });
    })));
  } finally {
    cleanup();
  }
});

/**
 * The value in the defect channel, asserting there is no typed failure beside it. Messages are built
 * only on failure: rendering the cause would inspect the defect, which may be a throwing proxy.
 */
function defectOf<A, E>(exit: Exit.Exit<A, E>): unknown {
  if (!Exit.isFailure(exit)) assert.fail("expected a failure");
  if (Option.isSome(Cause.failureOption(exit.cause))) {
    assert.fail(`typed failure: ${Cause.pretty(exit.cause)}`);
  }
  const defect = Cause.dieOption(exit.cause);
  if (Option.isNone(defect)) assert.fail(`expected a defect, got ${Cause.pretty(exit.cause)}`);
  return defect.value;
}

Deno.test("provenance: a caller-thrown binding error is a defect, by identity and untouched", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "provenance.db"));
  try {
    const named = db.prepare("SELECT :x AS x");
    const one = db.prepare("SELECT 1 AS one");
    // The reviewer's case (frozen) and an extensible one, where an added `cause` would show.
    const errors = [
      Object.freeze(new SqliteUsageError({ reason: "busy", detail: "caller-owned, frozen" })),
      new SqliteUsageError({ reason: "busy", detail: "caller-owned, extensible" }),
    ];
    for (const thrown of errors) {
      const before = Object.getOwnPropertyDescriptors(thrown);
      const hadCause = Object.hasOwn(thrown, "cause");
      const params = {
        get x() {
          throw thrown;
        },
      } as unknown as BindParams;
      const throwingTimeout = {
        get timeoutMs(): number {
          throw thrown;
        },
      };
      const cases: [string, Exit.Exit<unknown, unknown>][] = [
        ["sync parameter getter", Effect.runSyncExit(get(named, params))],
        ["async parameter getter", await Effect.runPromiseExit(getAsync(named, params))],
        ["async timeoutMs getter", await Effect.runPromiseExit(getAsync(one, undefined, throwingTimeout))],
        // Inside a span `Effect.die` would hand back a span-recording proxy instead of the value.
        ["sync, inside a span", Effect.runSyncExit(Effect.withSpan(get(named, params), "read"))],
        [
          "async, inside a span",
          await Effect.runPromiseExit(Effect.withSpan(getAsync(named, params), "read")),
        ],
      ];
      for (const [name, exit] of cases) {
        assert.equal(defectOf(exit), thrown, name);
        assert.equal(db.inFlight, false, name);
      }
      assert.deepEqual(Object.getOwnPropertyDescriptors(thrown), before);
      assert.equal(Object.hasOwn(thrown, "cause"), hadCause);
      // The connection is reusable on both paths.
      assert.deepEqual({ ...Effect.runSync(get(named, { x: 1 })) }, { x: 1 });
      assert.deepEqual({ ...(await Effect.runPromise(getAsync(named, { x: 2 }))) }, { x: 2 });
    }

    // A thrown proxy whose every trap throws is the defect itself; nothing ran a trap on it.
    const trapped: string[] = [];
    const opaque = new Proxy({}, {
      get: (_t, trap) => () => {
        trapped.push(String(trap));
        throw new Error(`trap ${String(trap)}`);
      },
    });
    const thrownProxy = new Proxy({}, opaque);
    const proxyParams = {
      get x() {
        throw thrownProxy;
      },
    } as unknown as BindParams;
    assert.equal(defectOf(Effect.runSyncExit(get(named, proxyParams))), thrownProxy);
    assert.equal(defectOf(await Effect.runPromiseExit(getAsync(named, proxyParams))), thrownProxy);
    assert.deepEqual(trapped, []);

    // The parameter container itself a proxy: its traps run in the snapshot, so their throws are defects.
    const thrown = Object.freeze(new SqliteUsageError({ reason: "bind-count", detail: "from a trap" }));
    const keysTrap = new Proxy({ x: 1 }, {
      ownKeys() {
        throw thrown;
      },
    }) as BindParams;
    const elementTrap = new Proxy([1], {
      get(target, key, receiver) {
        if (key === "0") throw thrown;
        return Reflect.get(target, key, receiver);
      },
    }) as BindParams;
    const positional = db.prepare("SELECT ? AS v");
    assert.equal(defectOf(Effect.runSyncExit(get(named, keysTrap))), thrown);
    assert.equal(defectOf(await Effect.runPromiseExit(getAsync(named, keysTrap))), thrown);
    assert.equal(defectOf(Effect.runSyncExit(get(positional, elementTrap))), thrown);
    assert.equal(defectOf(await Effect.runPromiseExit(getAsync(positional, elementTrap))), thrown);
    // A well-behaved proxy reads through.
    assert.deepEqual({ ...Effect.runSync(get(positional, new Proxy([7], {}))) }, { v: 7 });

    // timeoutMs rendered by the binding's own message: the object's toString runs in the snapshot.
    const rendered = { toString: () => "soon" } as unknown as number;
    const invalid = failureOf(await Effect.runPromiseExit(getAsync(one, undefined, { timeoutMs: rendered })));
    assert.ok(invalid instanceof SqliteUsageError && invalid.reason === "invalid-option", String(invalid));
    assert.equal(invalid.detail, "timeoutMs must be a finite number >= 0, got soon");
    const unrendered = {
      toString() {
        throw thrown;
      },
    } as unknown as number;
    assert.equal(
      defectOf(await Effect.runPromiseExit(getAsync(one, undefined, { timeoutMs: unrendered }))),
      thrown,
    );

    // Open options are read once in the snapshot too.
    const openOptions = {
      get busyTimeoutMs(): number {
        throw thrown;
      },
    };
    assert.equal(
      defectOf(await Effect.runPromiseExit(Effect.scoped(openDatabase(join(dir, "o.db"), openOptions)))),
      thrown,
    );
    assert.equal(db.inFlight, false);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("provenance: the binding runs no caller code after the snapshot", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "receiver.db"));
  try {
    const thrown = Object.freeze(new SqliteUsageError({ reason: "busy", detail: "caller-owned" }));
    const thrower = () => {
      throw thrown;
    };

    // A look-alike statement or connection is a defect (the binding's private-field TypeError); its
    // methods never run.
    const fake = {
      get: thrower,
      getAsync: thrower,
      parameterCount: 0,
      sql: "SELECT 1",
    } as unknown as Statement;
    const fakeDefect = defectOf(Effect.runSyncExit(get(fake)));
    assert.ok(fakeDefect instanceof TypeError, String(fakeDefect));
    assert.ok(defectOf(await Effect.runPromiseExit(getAsync(fake))) instanceof TypeError);
    const fakeDb = { exec: thrower, prepare: thrower, inFlight: false } as unknown as Database;
    assert.ok(defectOf(Effect.runSyncExit(exec(fakeDb, "SELECT 1"))) instanceof TypeError);
    assert.ok(defectOf(Effect.runSyncExit(prepare(fakeDb, "SELECT 1"))) instanceof TypeError);

    // Methods and getters shadowed on a real instance are ignored: the binding's own run.
    const st = db.prepare("SELECT ? AS v");
    Object.defineProperty(st, "get", { value: thrower });
    Object.defineProperty(st, "getAsync", { value: thrower });
    Object.defineProperty(st, "parameterCount", { get: thrower });
    assert.deepEqual({ ...Effect.runSync(get(st, [1])) }, { v: 1 });
    assert.deepEqual({ ...(await Effect.runPromise(getAsync(st, [2]))) }, { v: 2 });

    // `sql` (the one public property the binding reads) is pinned on first use; one already turned
    // into an accessor is a defect, and the accessor never runs.
    assert.throws(() => Object.defineProperty(st, "sql", { get: thrower }), TypeError);
    assert.equal(st.sql, "SELECT ? AS v");
    const tampered = db.prepare("SELECT 4 AS v");
    Object.defineProperty(tampered, "sql", { get: thrower });
    assert.ok(defectOf(Effect.runSyncExit(get(tampered))) instanceof TypeError);

    // Views are read through their internal slots, never their (shadowable) properties.
    const hex = db.prepare("SELECT hex(?) AS h");
    const bytes = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4);
    for (const key of ["buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(bytes, key, { get: thrower });
    }
    const view = new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2);
    for (const key of ["buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(view, key, { get: thrower });
    }
    assert.deepEqual({ ...Effect.runSync(get(hex, [bytes])) }, { h: "010203" });
    assert.deepEqual({ ...(await Effect.runPromise(getAsync(hex, [view]))) }, { h: "0807" });
    assert.deepEqual({ ...Effect.runSync(get(hex, [new Uint8Array(0)])) }, { h: "" });

    // A getter that closes the connection runs before the binding starts: the binding then reports
    // its own typed "closed", not a caller exception.
    const scratchDb = Database.open(join(dir, "closing.db"));
    const closing = scratchDb.prepare("SELECT :x AS x");
    const closer = {
      get x() {
        scratchDb.close();
        return 1;
      },
    } as unknown as BindParams;
    const closed = failureOf(Effect.runSyncExit(get(closing, closer)));
    assert.ok(closed instanceof SqliteUsageError && closed.reason === "closed", String(closed));

    // Last, since it disables `db.prepare` for the rest of the test: the cache goes through the
    // binding's prototypes too.
    Object.defineProperty(db, "prepare", { value: thrower });
    Object.defineProperty(db, "inFlight", { get: thrower });
    const cached = Effect.runSync(prepare(db, "SELECT 3 AS v"));
    Object.defineProperty(cached, "isFinalized", { get: thrower });
    assert.equal(Effect.runSync(prepare(db, "SELECT 3 AS v")), cached);
    assert.deepEqual({ ...Effect.runSync(get(cached)) }, { v: 3 });
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("provenance: the binding's own errors stay typed failures", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "typed.db"));
  try {
    const positional = db.prepare("SELECT ? AS v");
    const named = db.prepare("SELECT :x AS x");
    for (
      const [params, reason] of [
        [[], "bind-count"],
        [[1, 2], "bind-count"],
        [{ y: 1 }, "bind-name"],
      ] as const
    ) {
      const st = Array.isArray(params) ? positional : named;
      for (
        const exit of [Effect.runSyncExit(get(st, params)), await Effect.runPromiseExit(getAsync(st, params))]
      ) {
        const err = failureOf(exit);
        assert.ok(err instanceof SqliteUsageError && err.reason === reason, String(err));
      }
    }
    // A list whose length the binding rejects is not read at all.
    let reads = 0;
    const long = new Proxy([1, 2, 3], {
      get(target, key, receiver) {
        if (key !== "length") reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const count = failureOf(Effect.runSyncExit(get(positional, long)));
    assert.ok(
      count instanceof SqliteUsageError && count.detail === "expected 1 parameter(s), got 3",
      String(count),
    );
    assert.equal(reads, 0);

    // Values the binding cannot bind, a proxy among them (decided by `typeof`, no trap runs).
    const trapped: string[] = [];
    const proxyValue = new Proxy({}, {
      get(_t, key) {
        trapped.push(String(key));
        return undefined;
      },
    });
    for (const value of [{}, proxyValue, undefined, Symbol("s")]) {
      const params = [value] as unknown as BindParams;
      for (
        const exit of [
          Effect.runSyncExit(get(positional, params)),
          await Effect.runPromiseExit(getAsync(positional, params)),
        ]
      ) {
        const err = failureOf(exit);
        assert.ok(err instanceof SqliteValueError && err.reason === "unsupported-bind-type", String(err));
      }
    }
    assert.deepEqual(trapped, []);
    const range = failureOf(Effect.runSyncExit(get(positional, [2n ** 64n])));
    assert.ok(range instanceof SqliteValueError && range.reason === "integer-out-of-range", String(range));

    // Cancellation and SQLite's own errors.
    const forever = db.prepare(FOREVER);
    const deadline = failureOf(await Effect.runPromiseExit(allAsync(forever, undefined, { timeoutMs: 10 })));
    assert.ok(deadline instanceof SqliteCancelled && deadline.reason === "deadline", String(deadline));
    const syntax = failureOf(Effect.runSyncExit(exec(db, "SELEC 1")));
    assert.ok(syntax instanceof SqliteError && syntax.op === "exec", String(syntax));
    const negative = failureOf(await Effect.runPromiseExit(getAsync(positional, [1], { timeoutMs: -1 })));
    assert.ok(negative instanceof SqliteUsageError && negative.reason === "invalid-option", String(negative));
    assert.equal(db.inFlight, false);
    assert.deepEqual({ ...Effect.runSync(get(positional, [5])) }, { v: 5 });
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// inTransaction, busy timeout
// ---------------------------------------------------------------------------

Deno.test("inTransaction: flips across BEGIN / COMMIT / ROLLBACK and follows SQLite's own rollback", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "tx.db"));
  try {
    db.exec("CREATE TABLE t(n INTEGER)");
    assert.equal(db.inTransaction, false);
    db.exec("BEGIN");
    assert.equal(db.inTransaction, true);
    db.exec("INSERT INTO t VALUES (1); COMMIT");
    assert.equal(db.inTransaction, false);
    db.exec("BEGIN IMMEDIATE");
    assert.equal(db.inTransaction, true);
    db.exec("ROLLBACK");
    assert.equal(db.inTransaction, false);

    // An interrupted write inside BEGIN: SQLite rolls the transaction back itself.
    db.exec("BEGIN; INSERT INTO t VALUES (2)");
    const flood = db.prepare(
      "INSERT INTO t WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c",
    );
    const fiber = Effect.runFork(runAsync(flood, undefined, BACKSTOP));
    await delay(20);
    // While a pool thread holds the connection the answer could change under the read: "busy".
    assert.throws(() => db.inTransaction, (e) => e instanceof SqliteUsageError && e.reason === "busy");
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(db.inTransaction, false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()?.n, 1);

    db.close();
    assert.equal(db.inTransaction, false);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("busy: BEGIN IMMEDIATE on a second connection fails SQLITE_BUSY after busyTimeoutMs", async () => {
  const BUSY_MS = 100;
  const { dir, cleanup } = scratch();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const file = join(dir, "ffi.db");
      const a = yield* openDatabase(file, { busyTimeoutMs: BUSY_MS });
      const b = yield* openDatabase(file, { busyTimeoutMs: BUSY_MS });
      yield* exec(a, "PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER)");
      yield* exec(a, "BEGIN IMMEDIATE");
      const started = performance.now();
      const err = yield* Effect.flip(exec(b, "BEGIN IMMEDIATE"));
      const waited = performance.now() - started;
      console.log(`FFI: BEGIN IMMEDIATE failed after ${waited.toFixed(1)} ms (busyTimeoutMs ${BUSY_MS})`);
      assert.ok(err instanceof SqliteError, String(err));
      assert.equal(err.code, 5);
      assert.equal(err.op, "exec");
      assert.ok(waited >= BUSY_MS * 0.9 && waited < BUSY_MS + 2000, `waited ${waited} ms`);
      assert.equal(a.inTransaction, true);
      assert.equal(b.inTransaction, false);
      yield* exec(a, "COMMIT");
      yield* exec(b, "BEGIN IMMEDIATE");
      assert.equal(b.inTransaction, true);
      yield* exec(b, "ROLLBACK");
    })));

    // The same sequence through node:sqlite, on its own file: the behaviour the binding replaces.
    const file = join(dir, "node.db");
    const a = new DatabaseSync(file, { timeout: BUSY_MS });
    const b = new DatabaseSync(file, { timeout: BUSY_MS });
    try {
      a.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER); BEGIN IMMEDIATE");
      const started = performance.now();
      // Deno's node:sqlite reports SQLITE_BUSY by message only (code ERR_SQLITE_ERROR, no errcode).
      assert.throws(() => b.exec("BEGIN IMMEDIATE"), /database is locked/);
      const waited = performance.now() - started;
      console.log(`node:sqlite: BEGIN IMMEDIATE failed after ${waited.toFixed(1)} ms`);
      assert.ok(waited >= BUSY_MS * 0.9, `waited ${waited} ms`);
      assert.equal(b.isTransaction, false);
      a.exec("COMMIT");
    } finally {
      a.close();
      b.close();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Statement cache
// ---------------------------------------------------------------------------

Deno.test("cache: isCacheable bypasses VACUUM and DDL only", () => {
  for (
    const sql of [
      "VACUUM INTO ?",
      "  vacuum",
      'CREATE TABLE IF NOT EXISTS "t" (x)',
      "create index i on t(x)",
      "ALTER TABLE t ADD COLUMN y",
      "DROP TABLE t",
      "PRAGMA journal_mode=WAL",
      "-- leading comment\nPRAGMA user_version",
      "/* leading */ CREATE TABLE u(x)",
    ]
  ) assert.equal(isCacheable(sql), false, sql);
  for (
    const sql of [
      "SELECT 1",
      'INSERT INTO "created" VALUES (1)',
      "BEGIN IMMEDIATE",
      "COMMIT",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "CREATED",
      "-- PRAGMA in a comment only\nSELECT 1",
    ]
  ) assert.equal(isCacheable(sql), true, sql);
});

Deno.test("cache: hits reuse the statement; LRU eviction finalizes, never more than 64 live", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "cache.db"));
  try {
    assert.equal(STATEMENT_CACHE_CAPACITY, 64);
    const HOT = "SELECT 'hot' AS v";
    const hot = prepareCached(db, HOT);
    assert.equal(prepareCached(db, HOT), hot);
    const issued = new Set<Statement>([hot]);
    const live = () => [...issued].filter((st) => !st.isFinalized).length;
    let maxLive = 0;
    for (let i = 0; i < 500; i++) {
      const st = prepareCached(db, `SELECT ${i} AS n`);
      issued.add(st);
      assert.equal(st.get()?.n, i);
      // Touching HOT on every round keeps it most recently used: it is never evicted.
      assert.equal(prepareCached(db, HOT), hot);
      maxLive = Math.max(maxLive, live());
    }
    // 1 hot + 500 distinct texts, every statement this connection has came from the cache.
    assert.equal(issued.size, 501);
    console.log(`cache: max live statements ${maxLive} over ${issued.size} prepared`);
    assert.ok(maxLive <= STATEMENT_CACHE_CAPACITY, `max live ${maxLive}`);
    assert.equal(live(), STATEMENT_CACHE_CAPACITY);
    assert.equal(hot.isFinalized, false);
    // The newest 63 texts are cached, the rest were finalized.
    assert.equal(prepareCached(db, "SELECT 499 AS n").isFinalized, false);
    const evicted = [...issued].find((st) => st.sql === "SELECT 0 AS n")!;
    assert.equal(evicted.isFinalized, true);
    // An evicted statement fails typed, without touching native memory; the text is prepared anew.
    const err = failureOf(Effect.runSyncExit(get(evicted)));
    assert.ok(err instanceof SqliteUsageError && err.reason === "finalized", String(err));
    const again = prepareCached(db, "SELECT 0 AS n");
    assert.notEqual(again, evicted);
    assert.equal(again.get()?.n, 0);

    // A statement finalized behind the cache's back is dropped and prepared again.
    hot.finalize();
    const hot2 = prepareCached(db, HOT);
    assert.notEqual(hot2, hot);
    assert.equal(hot2.get()?.v, "hot");
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

Deno.test("cache: uncached statements are finalized at the next idle call; close finalizes all", async () => {
  const { dir, cleanup } = scratch();
  let issued: Statement[] = [];
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* openDatabase(join(dir, "oneshot.db"));
      const p1 = yield* prepare(db, "PRAGMA user_version");
      assert.deepEqual({ ...(yield* get(p1)) }, { user_version: 0 });
      const p2 = yield* prepare(db, "PRAGMA user_version");
      assert.notEqual(p2, p1);
      assert.equal(p1.isFinalized, true);
      assert.equal(p2.isFinalized, false);
      const sel = yield* prepare(db, "SELECT 1 AS x");
      assert.equal(p2.isFinalized, true);

      // An uncached statement with an execution in flight is not finalized by the next call.
      const create = yield* prepare(
        db,
        "CREATE TABLE big AS WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c",
      );
      const fiber = yield* Effect.fork(runAsync(create, undefined, BACKSTOP));
      yield* Effect.sleep(20);
      assert.equal(db.inFlight, true);
      assert.equal(prepareCached(db, "SELECT 1 AS x"), sel);
      assert.equal(create.isFinalized, false);
      yield* Fiber.interrupt(fiber);
      assert.equal(create.isFinalized, false);
      yield* prepare(db, "SELECT 1 AS x");
      assert.equal(create.isFinalized, true);
      issued = [sel, yield* prepare(db, "PRAGMA user_version")];
      assert.ok(issued.every((st) => !st.isFinalized));
    })));
    // The scope's release (closeAsync) finalized the cached and the pending uncached statement.
    assert.ok(issued.every((st) => st.isFinalized));
  } finally {
    cleanup();
  }
});

Deno.test("cache: eviction never finalizes a statement while an execution is in flight", async () => {
  const { dir, cleanup } = scratch();
  const db = Database.open(join(dir, "inflight.db"));
  try {
    // FOREVER is the least recently used entry of a full cache.
    const forever = prepareCached(db, FOREVER);
    for (let i = 1; i < STATEMENT_CACHE_CAPACITY; i++) prepareCached(db, `SELECT ${i} AS n`);
    const fiber = Effect.runFork(allAsync(forever, undefined, BACKSTOP));
    await delay(20);
    assert.equal(db.inFlight, true);
    // A miss would evict FOREVER, but preparing needs the connection: it fails "busy" and evicts
    // nothing. A hit is served from the cache.
    for (let i = 0; i < 10; i++) {
      assert.throws(
        () => prepareCached(db, `SELECT 'miss ${i}'`),
        (e) => e instanceof SqliteUsageError && e.reason === "busy",
      );
    }
    assert.equal(prepareCached(db, FOREVER), forever);
    assert.equal(forever.isFinalized, false);
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(forever.isFinalized, false);
    // Once idle, a miss evicts the least recently used entry, which is now `SELECT 1`.
    prepareCached(db, "SELECT 'after'");
    assert.equal(forever.isFinalized, false);
    assert.equal(prepareCached(db, FOREVER), forever);
  } finally {
    await db.closeAsync();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Point-read cost through the cache
// ---------------------------------------------------------------------------

const ROWS = 1000;
const ROUNDS = 6;
const READS_PER_ROUND = 4000;
/** Cached FFI p50 may be at most this multiple of node:sqlite's reused-statement p50. */
const MAX_P50_RATIO = 1.3;

function pct(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const SETUP =
  "PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT NOT NULL, n REAL);";
/** Two texts, alternated, so every cached read also pays the LRU reorder. */
const QUERIES = ["SELECT id, body, n FROM docs WHERE id = ?", "SELECT id, body, n FROM docs WHERE id = ?1"];
const body = (i: number) => JSON.stringify({ id: i, title: `doc ${i}`, pad: "x".repeat(180) });

Deno.test("perf: point reads through prepareCached are at parity with node:sqlite", async () => {
  const { dir, cleanup } = scratch();
  const nodeDb = new DatabaseSync(join(dir, "node.db"));
  const ffiDb = Database.open(join(dir, "ffi.db"));
  try {
    nodeDb.exec(SETUP + "BEGIN;");
    ffiDb.exec(SETUP + "BEGIN;");
    const nIns = nodeDb.prepare("INSERT INTO docs VALUES (?, ?, ?)");
    const fIns = ffiDb.prepare("INSERT INTO docs VALUES (?, ?, ?)");
    for (let i = 1; i <= ROWS; i++) {
      nIns.run(i, body(i), i / 3);
      fIns.run([i, body(i), i / 3]);
    }
    nodeDb.exec("COMMIT");
    ffiDb.exec("COMMIT");
    // A realistically populated cache: the writer's other statements sit beside the reads.
    for (let i = 0; i < 40; i++) prepareCached(ffiDb, `SELECT body FROM docs WHERE id = ? + ${i}`);

    // Baseline: node:sqlite with reused statements (stricter than today's per-call prepare).
    const nGet = QUERIES.map((q) => nodeDb.prepare(q));
    const ids = Array.from({ length: READS_PER_ROUND }, (_, i) => 1 + ((i * 7919) % ROWS));
    const nodeRead = (k: number) => nGet[k & 1].get(ids[k]);
    const ffiRead = (k: number) => prepareCached(ffiDb, QUERIES[k & 1]).get([ids[k]]);

    for (let k = 0; k < 50; k++) assert.deepEqual({ ...ffiRead(k) }, { ...nodeRead(k) });

    for (let k = 0; k < ids.length; k++) {
      nodeRead(k);
      ffiRead(k);
    }
    const nodeUs: number[] = [];
    const ffiUs: number[] = [];
    let sink = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 === 0 ? ["node", "ffi"] : ["ffi", "node"];
      for (const which of order) {
        const out = which === "node" ? nodeUs : ffiUs;
        for (let k = 0; k < ids.length; k++) {
          const t = performance.now();
          const row = which === "node" ? nodeRead(k) : ffiRead(k);
          out.push((performance.now() - t) * 1000);
          sink += (row?.body as string).length;
        }
      }
    }
    assert.ok(sink > 0);

    // Context only: today's writer pattern, node:sqlite preparing per call.
    const perCallUs: number[] = [];
    for (let k = 0; k < 2000; k++) {
      const t = performance.now();
      nodeDb.prepare(QUERIES[k & 1]).get(ids[k]);
      perCallUs.push((performance.now() - t) * 1000);
    }

    const [load1, load5, load15] = Deno.loadavg();
    const report = {
      node_sqlite_reused: { p50: pct(nodeUs, 0.5), p99: pct(nodeUs, 0.99), n: nodeUs.length },
      ffi_prepare_cached: { p50: pct(ffiUs, 0.5), p99: pct(ffiUs, 0.99), n: ffiUs.length },
      node_sqlite_prepare_per_call: {
        p50: pct(perCallUs, 0.5),
        p99: pct(perCallUs, 0.99),
        n: perCallUs.length,
      },
      loadavg: [load1, load5, load15],
    };
    console.log(`point read µs: ${JSON.stringify(report)}`);
    assert.ok(
      report.ffi_prepare_cached.p50 <= report.node_sqlite_reused.p50 * MAX_P50_RATIO,
      `cached FFI p50 ${report.ffi_prepare_cached.p50} µs vs node:sqlite ${report.node_sqlite_reused.p50} µs`,
    );
  } finally {
    nodeDb.close();
    await ffiDb.closeAsync();
    cleanup();
  }
});
