/**
 * FFI SQLite binding (`platform/sqlite_ffi/`): ordinary CRUD correctness, value round-trips, and the
 * typed failure surface, through both the synchronous and the nonblocking execution modes.
 *
 * Reentrancy probes (caller getters that finalize, close or execute mid-call) run in subprocesses
 * under an external `timeout`: the failure mode they guard against is a native crash, which would
 * otherwise take the test runner down with it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Database,
  loadLibrary,
  type Row,
  SqliteError,
  SqliteLibraryError,
  SqliteUsageError,
  SqliteValueError,
} from "../../platform/sqlite_ffi/mod.ts";

/** Rows are null-prototype objects; compare them as plain records. */
const plain = (row: Row | undefined) => row === undefined ? undefined : { ...row };

function withDb(fn: (db: Database, dir: string) => void | Promise<void>, options = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-ffi-"));
    const db = Database.open(join(dir, "t.db"), options);
    try {
      await fn(db, dir);
    } finally {
      await db.closeAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const SCHEMA =
  "PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
  "score REAL, data BLOB);";

Deno.test("library: loads the system libsqlite3 and reports its version", () => {
  const lib = loadLibrary();
  assert.match(lib.version, /^3\.\d+\.\d+/);
  assert.ok(lib.versionNumber >= 3_037_000);
});

Deno.test("library: a missing library fails SqliteLibraryError load-failed", () => {
  assert.throws(() => loadLibrary("/nonexistent/libsqlite3.so"), (e: unknown) => {
    assert.ok(e instanceof SqliteLibraryError);
    assert.equal(e.reason, "load-failed");
    assert.deepEqual(e.paths, ["/nonexistent/libsqlite3.so"]);
    return true;
  });
});

for (const readOnly of [false, true]) {
  Deno.test(
    `defaults: unknown quoted columns fail on a ${readOnly ? "read-only" : "read-write"} open`,
    withDb((writer, dir) => {
      writer.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
      using db = Database.open(join(dir, "t.db"), { readOnly });
      for (const sql of ['SELECT "nope"', 'SELECT id FROM t WHERE "nope" = ?']) {
        assert.throws(() => db.prepare(sql), (e: unknown) => {
          assert.ok(e instanceof SqliteError);
          assert.equal(e.op, "prepare");
          assert.match(e.sqliteMessage, /no such column/);
          return true;
        });
      }
      assert.equal(db.prepare('SELECT "id" FROM t').get(), undefined);
      assert.equal(db.prepare("SELECT 'nope' AS value").get()?.value, "nope");
    }),
  );

  Deno.test(
    `defaults: foreign keys enabled on a ${readOnly ? "read-only" : "read-write"} open`,
    withDb((writer, dir) => {
      // A setting on one connection must not determine the default on the next.
      writer.exec("PRAGMA foreign_keys=OFF; CREATE TABLE t(id INTEGER PRIMARY KEY)");
      using db = Database.open(join(dir, "t.db"), { readOnly });
      assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    }),
  );
}

Deno.test(
  "defaults: DDL rejects double-quoted string literals",
  withDb((db) => {
    assert.throws(() => db.exec('CREATE TABLE t(id INTEGER CHECK(id <> "nope"))'), (e: unknown) => {
      assert.ok(e instanceof SqliteError);
      assert.match(e.sqliteMessage, /no such column/);
      return true;
    });
    db.exec('CREATE TABLE t("id" INTEGER CHECK("id" > 0))');
  }),
);

Deno.test(
  "defaults: orphan inserts fail with SQLITE_CONSTRAINT_FOREIGNKEY",
  withDb((db) => {
    db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id))");
    const insert = db.prepare("INSERT INTO child VALUES (?)");
    assert.throws(() => insert.run([1]), (e: unknown) => {
      assert.ok(e instanceof SqliteError);
      assert.equal(e.code, 19);
      assert.equal(e.extendedCode, 787);
      assert.equal(e.codeName, "SQLITE_CONSTRAINT_FOREIGNKEY");
      return true;
    });
    assert.equal(db.prepare("SELECT count(*) AS n FROM child").get()?.n, 0);
    db.exec("INSERT INTO parent VALUES (1)");
    assert.equal(insert.run([1]).changes, 1);
  }),
);

Deno.test(
  "crud (sync): insert, select, update, delete with positional and named parameters",
  withDb((db) => {
    db.exec(SCHEMA);
    const insert = db.prepare("INSERT INTO docs(name, score) VALUES (?, ?)");
    assert.deepEqual(insert.run(["a", 1.5]), { changes: 1, lastInsertRowid: 1 });
    assert.deepEqual(insert.run(["b", 2]), { changes: 1, lastInsertRowid: 2 });
    const named = db.prepare("INSERT INTO docs(name, score) VALUES (:name, @score)");
    assert.deepEqual(named.run({ name: "c", score: 3 }), { changes: 1, lastInsertRowid: 3 });
    assert.deepEqual(named.run({ ":name": "d", "@score": null }), { changes: 1, lastInsertRowid: 4 });

    const byId = db.prepare("SELECT id, name, score FROM docs WHERE id = ?");
    assert.deepEqual(plain(byId.get([1])), { id: 1, name: "a", score: 1.5 });
    assert.deepEqual(plain(byId.get([4])), { id: 4, name: "d", score: null });
    assert.equal(byId.get([99]), undefined);

    const all = db.prepare("SELECT name FROM docs ORDER BY id").all();
    assert.deepEqual(all.map((r) => r.name), ["a", "b", "c", "d"]);

    const update = db.prepare("UPDATE docs SET score = score * 10 WHERE score IS NOT NULL");
    assert.equal(update.run().changes, 3);
    assert.deepEqual(plain(byId.get([2])), { id: 2, name: "b", score: 20 });

    assert.equal(db.prepare("DELETE FROM docs WHERE id > $min").run({ min: 2 }).changes, 2);
    assert.deepEqual(db.prepare("SELECT count(*) AS n FROM docs").get()?.n, 2);
    // A statement is reusable after every kind of execution.
    assert.deepEqual(plain(byId.get([1])), { id: 1, name: "a", score: 15 });
  }),
);

Deno.test(
  "crud (async): the nonblocking methods give the same results as the sync ones",
  withDb(async (db) => {
    db.exec(SCHEMA);
    const insert = db.prepare("INSERT INTO docs(name, score) VALUES (?, ?)");
    for (let i = 1; i <= 50; i++) {
      assert.deepEqual(await insert.runAsync([`n${i}`, i]), { changes: 1, lastInsertRowid: i });
    }
    const list = db.prepare("SELECT id, name FROM docs WHERE score > ? ORDER BY id");
    const rows = await list.allAsync([40]);
    assert.deepEqual(rows.map(plain), list.all([40]).map(plain));
    assert.equal(rows.length, 10);
    assert.deepEqual(plain(await list.getAsync([40])), { id: 41, name: "n41" });
    assert.equal(await list.getAsync([1000]), undefined);
    assert.equal((await db.prepare("DELETE FROM docs WHERE id % 2 = 0").runAsync()).changes, 25);
    assert.equal(db.prepare("SELECT count(*) AS n FROM docs").get()?.n, 25);
  }),
);

Deno.test(
  "transactions: commit and rollback through exec",
  withDb((db) => {
    db.exec(SCHEMA);
    const insert = db.prepare("INSERT INTO docs(name) VALUES (?)");
    db.exec("BEGIN");
    insert.run(["kept"]);
    db.exec("COMMIT");
    db.exec("BEGIN IMMEDIATE");
    insert.run(["dropped"]);
    db.exec("ROLLBACK");
    assert.deepEqual(db.prepare("SELECT name FROM docs").all().map((r) => r.name), ["kept"]);
  }),
);

Deno.test(
  "values: every storage class round-trips, including NUL text, empty text and empty blobs",
  withDb((db) => {
    db.exec("CREATE TABLE v(x)");
    const put = db.prepare("INSERT INTO v(x) VALUES (?)");
    const get = db.prepare("SELECT x, typeof(x) AS t FROM v WHERE rowid = ?");
    const cases: [unknown, unknown, string][] = [
      [null, null, "null"],
      [0, 0, "integer"],
      [-1, -1, "integer"],
      [2 ** 31, 2 ** 31, "integer"],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "integer"],
      [Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, "integer"],
      [-(2 ** 31), -(2 ** 31), "integer"],
      [0.5, 0.5, "real"],
      [1e300, 1e300, "real"],
      [123n, 123, "integer"],
      [true, 1, "integer"],
      [false, 0, "integer"],
      ["", "", "text"],
      ["héllo wörld ✓ 𝄞", "héllo wörld ✓ 𝄞", "text"],
      ["a\u0000b\u0000", "a\u0000b\u0000", "text"],
      [new Uint8Array([0, 1, 2, 255]), new Uint8Array([0, 1, 2, 255]), "blob"],
      [new Uint8Array(0), new Uint8Array(0), "blob"],
      [new Uint16Array([1, 2]).subarray(1), new Uint8Array([2, 0]), "blob"],
    ];
    for (const [input, expected, type] of cases) {
      const { lastInsertRowid } = put.run([input as never]);
      const row = get.get([lastInsertRowid]);
      assert.deepEqual(row?.x, expected, `round-trip of ${String(input)}`);
      assert.equal(row?.t, type, `storage class of ${String(input)}`);
    }
  }),
);

Deno.test(
  "values: integers beyond 2^53 fail SqliteValueError unless readBigInts",
  withDb((db, dir) => {
    db.exec("CREATE TABLE b(x INTEGER)");
    db.prepare("INSERT INTO b VALUES (?), (?), (?)").run([2n ** 53n, -(2n ** 63n), 2n ** 63n - 1n]);
    assert.throws(() => db.prepare("SELECT x FROM b").all(), (e: unknown) => {
      assert.ok(e instanceof SqliteValueError);
      assert.equal(e.reason, "unsafe-integer");
      assert.equal(e.at, "x");
      return true;
    });
    assert.throws(() => db.prepare("SELECT ?").get([2n ** 63n]), (e: unknown) => {
      assert.ok(e instanceof SqliteValueError);
      assert.equal(e.reason, "integer-out-of-range");
      assert.equal(e.at, 1);
      return true;
    });
    db.close();
    using big = Database.open(join(dir, "t.db"), { readBigInts: true });
    assert.deepEqual(
      big.prepare("SELECT x FROM b ORDER BY rowid").all().map((r) => r.x),
      [2n ** 53n, -(2n ** 63n), 2n ** 63n - 1n],
    );
    assert.equal(big.prepare("SELECT 1 AS one").get()?.one, 1n);
  }),
);

Deno.test(
  "errors: constraint violations are SqliteError with extended codes",
  withDb(async (db) => {
    db.exec(SCHEMA);
    const insert = db.prepare("INSERT INTO docs(id, name) VALUES (?, ?)");
    insert.run([1, "a"]);
    const check = (code: string, extended: number) => (e: unknown) => {
      assert.ok(e instanceof SqliteError, String(e));
      assert.equal(e.op, "step");
      assert.equal(e.code, 19);
      assert.equal(e.codeName, code);
      assert.equal(e.extendedCode, extended);
      assert.match(e.sqliteMessage, /constraint failed/);
      assert.equal(e.sql, insert.sql);
      return true;
    };
    assert.throws(() => insert.run([1, "b"]), check("SQLITE_CONSTRAINT_PRIMARYKEY", 1555));
    assert.throws(() => insert.run([2, "a"]), check("SQLITE_CONSTRAINT_UNIQUE", 2067));
    await assert.rejects(() => insert.runAsync([3, null]), check("SQLITE_CONSTRAINT_NOTNULL", 1299));
    // The statement is still usable after a failed execution.
    assert.equal(insert.run([2, "b"]).changes, 1);
  }),
);

Deno.test(
  "errors: prepare and exec failures are SqliteError; open failures are SqliteError op open",
  withDb((db, dir) => {
    assert.throws(() => db.prepare("SELEKT 1"), (e: unknown) => {
      assert.ok(e instanceof SqliteError);
      assert.equal(e.op, "prepare");
      assert.equal(e.codeName, "SQLITE_ERROR");
      assert.match(e.sqliteMessage, /syntax error/);
      return true;
    });
    assert.throws(() => db.exec("CREATE TABLE x(a); CREATE TABLE x(a);"), (e: unknown) => {
      assert.ok(e instanceof SqliteError);
      assert.equal(e.op, "exec");
      assert.match(e.sqliteMessage, /already exists/);
      return true;
    });
    assert.throws(() => Database.open(join(dir, "missing", "x.db")), (e: unknown) => {
      assert.ok(e instanceof SqliteError);
      assert.equal(e.op, "open");
      assert.equal(e.code, 14);
      return true;
    });
    assert.throws(() => Database.open(join(dir, "absent.db"), { create: false }), SqliteError);
    using ro = Database.open(join(dir, "t.db"), { readOnly: true });
    assert.throws(() => ro.exec("CREATE TABLE y(a)"), (e: unknown) => {
      assert.ok(e instanceof SqliteError);
      assert.equal(e.code, 8); // SQLITE_READONLY
      return true;
    });
  }),
);

Deno.test(
  "usage: parameter count, names and types are checked before the statement runs",
  withDb((db) => {
    const st = db.prepare("SELECT ?1 + ?2 AS s");
    assert.equal(st.parameterCount, 2);
    const reason = (r: string) => (e: unknown) => {
      assert.ok(e instanceof SqliteUsageError || e instanceof SqliteValueError, String(e));
      assert.equal(e.reason, r);
      return true;
    };
    assert.throws(() => st.get(), reason("bind-count"));
    assert.throws(() => st.get([1]), reason("bind-count"));
    assert.throws(() => st.get([1, 2, 3]), reason("bind-count"));
    assert.throws(() => st.get([1, undefined as never]), reason("unsupported-bind-type"));
    assert.throws(() => st.get([1, {} as never]), reason("unsupported-bind-type"));
    assert.equal(st.get([1, 2])?.s, 3);

    const named = db.prepare("SELECT :a AS a, :b AS b");
    assert.throws(() => named.get({ a: 1 }), reason("bind-count"));
    assert.throws(() => named.get({ a: 1, c: 2 }), reason("bind-name"));
    assert.deepEqual(plain(named.get({ a: 1, b: "x" })), { a: 1, b: "x" });
    // A reused name is one parameter.
    assert.equal(db.prepare("SELECT :a + :a AS s").get({ a: 2 })?.s, 4);
  }),
);

Deno.test(
  "usage: prepare takes exactly one statement",
  withDb((db) => {
    const reason = (r: string) => (e: unknown) => {
      assert.ok(e instanceof SqliteUsageError);
      assert.equal(e.reason, r);
      return true;
    };
    assert.throws(() => db.prepare(""), reason("empty-statement"));
    assert.throws(() => db.prepare("  -- only a comment\n"), reason("empty-statement"));
    assert.throws(() => db.prepare("SELECT 1; SELECT 2"), reason("multiple-statements"));
    // A second statement that does not compile is still rejected, and the first is not leaked.
    assert.throws(() => db.prepare("SELECT 1; SELEKT 2"), SqliteError);
    assert.throws(() => db.prepare("SELECT 1\u0000; DROP TABLE t"), reason("nul-in-sql"));
    assert.throws(() => db.exec("SELECT 1;\u0000 DROP TABLE t"), reason("nul-in-sql"));
    assert.equal(db.prepare("SELECT 'é' AS x;  -- trailing comment\n").get()?.x, "é");
    assert.equal(db.prepare("SELECT 1 AS x;").get()?.x, 1);
  }),
);

Deno.test(
  "lifetimes: close finalizes statements; use after close or finalize is a typed error",
  withDb((db, dir) => {
    const other = Database.open(join(dir, "other.db"));
    const st = other.prepare("SELECT 1 AS x");
    const fin = other.prepare("SELECT 2 AS x");
    fin.finalize();
    fin.finalize(); // idempotent
    assert.throws(() => fin.get(), (e: unknown) => e instanceof SqliteUsageError && e.reason === "finalized");
    other.close();
    other.close(); // idempotent
    assert.equal(other.isOpen, false);
    assert.equal(st.isFinalized, true);
    assert.throws(() => st.get(), (e: unknown) => e instanceof SqliteUsageError && e.reason === "closed");
    assert.throws(() => other.prepare("SELECT 1"), (e: unknown) => e instanceof SqliteUsageError);
    assert.throws(() => other.exec("SELECT 1"), (e: unknown) => e instanceof SqliteUsageError);
    other.interrupt(); // a no-op on a closed connection, never a crash
    assert.equal(db.isOpen, true);
  }),
);

Deno.test(
  "column names follow the current schema, not the one at prepare time",
  withDb((db) => {
    db.exec("CREATE TABLE s(a); INSERT INTO s VALUES (1);");
    const star = db.prepare("SELECT * FROM s");
    assert.deepEqual(plain(star.get()), { a: 1 });
    db.exec("ALTER TABLE s RENAME COLUMN a TO b");
    assert.deepEqual(plain(star.get()), { b: 1 });
    db.exec("ALTER TABLE s ADD COLUMN c DEFAULT 'z'");
    assert.deepEqual(plain(star.get()), { b: 1, c: "z" });
  }),
);

Deno.test(
  "reset errors: a RETURNING row whose commit fails SQLITE_BUSY is an error, never a result",
  withDb(async (a, dir) => {
    // Default rollback-journal mode: a writer's commit needs an EXCLUSIVE lock, which a reader's
    // open transaction (SHARED lock) blocks. The INSERT's first step yields the RETURNING row; the
    // commit happens in the reset that follows `get`'s first row, fails SQLITE_BUSY (5) and rolls
    // the insert back.
    a.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);");
    using b = Database.open(join(dir, "t.db"));
    const xs = () => a.prepare("SELECT x FROM t ORDER BY x").all().map((r) => r.x);
    const busy = (e: unknown) => {
      assert.ok(e instanceof SqliteError, String(e));
      assert.equal(e.op, "reset");
      assert.equal(e.code, 5);
      assert.equal(e.codeName, "SQLITE_BUSY");
      assert.equal(e.sql, insert.sql);
      return true;
    };
    const insert = a.prepare("INSERT INTO t VALUES (?) RETURNING x");

    b.exec("BEGIN; SELECT * FROM t;");
    assert.throws(() => insert.get([2]), busy);
    await assert.rejects(() => insert.getAsync([2]), busy);
    // Without RETURNING the commit happens in the last step: the same lock fails it there.
    assert.throws(() => a.prepare("INSERT INTO t VALUES (2)").run(), (e: unknown) => {
      assert.ok(e instanceof SqliteError && e.op === "step" && e.code === 5, String(e));
      return true;
    });
    assert.deepEqual(xs(), [1], "the rolled-back inserts are gone");
    assert.equal(a.inFlight, false);
    b.exec("ROLLBACK");

    // Statement and connection are reusable once the reader lets go.
    assert.deepEqual(plain(insert.get([2])), { x: 2 });
    assert.deepEqual(plain(await insert.getAsync([3])), { x: 3 });
    assert.deepEqual(xs(), [1, 2, 3]);
  }),
);

const CONFIG = fileURLToPath(new URL("../../deno.json", import.meta.url));
const MOD = new URL("../../platform/sqlite_ffi/mod.ts", import.meta.url).href;

/**
 * Run `code` in a fresh `deno eval` under an external watchdog (`timeout`, then SIGKILL) with core
 * dumps off, assert a clean exit, and return the JSON the probe prints last. A crash exits
 * 128 + signal (139 for SIGSEGV), a hang 124/137.
 */
async function probe(code: string, seconds = 20) {
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
      `const { Database } = await import(${JSON.stringify(MOD)});\n` +
      `const tag = (e) => String(e?._tag ?? "throw") + ":" + String(e?.reason ?? e?.message ?? "");\n` +
      code,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr);
  assert.equal(out.code, 0, `probe exited ${out.code} (139 = SIGSEGV, 124/137 = hung)\n${stdout}\n${stderr}`);
  return JSON.parse(stdout.split("\n").at(-1) ?? "null");
}

Deno.test("reentrancy: a parameter getter that finalizes its own statement gets a typed error", async () => {
  // The review's first probe, plus what happens next: the statement was not finalized and still runs.
  const result = await probe(`
const db = Database.open(":memory:");
const st = db.prepare("SELECT :x AS x");
let outer;
try {
  st.get({ get x() { st.finalize(); return 1; } });
  outer = "returned";
} catch (e) {
  outer = tag(e);
}
const next = st.get({ x: 5 })?.x;
console.log(JSON.stringify({ outer, finalized: st.isFinalized, inFlight: db.inFlight, next }));
`);
  assert.deepEqual(result, { outer: "SqliteUsageError:busy", finalized: false, inFlight: false, next: 5 });
});

Deno.test("reentrancy: an option getter that closes the connection gets a typed error", async () => {
  // The review's second probe: `timeoutMs` is read while the async execution holds the connection.
  const result = await probe(`
const db = Database.open(":memory:");
const st = db.prepare("SELECT 1 AS x");
let outer;
try {
  await st.getAsync(undefined, { get timeoutMs() { db.close(); return 100; } });
  outer = "returned";
} catch (e) {
  outer = tag(e);
}
const next = (await st.getAsync())?.x;
db.close();
console.log(JSON.stringify({ outer, open: db.isOpen, next }));
`);
  assert.deepEqual(result, { outer: "SqliteUsageError:busy", open: false, next: 1 });
});

Deno.test("reentrancy: nested calls from any caller getter are refused, never overlapping", async () => {
  // Every way caller code runs inside an execution (named and positional-accessor parameters, sync
  // and async; the async option getters) crossed with every nested call on the same connection.
  // The getter swallows the nested call's error and returns 7, so the outer call completes with
  // x = 7; then the statement runs again with x = 9 to show it was neither freed nor left active.
  const result = await probe(`
const shapes = {
  syncNamed: (st, act) => st.get({ get x() { act(); return 7; } }),
  syncPositional: (st, act) => st.get(Object.defineProperty([0], 0, { get() { act(); return 7; } })),
  asyncNamed: (st, act) => st.getAsync({ get x() { act(); return 7; } }),
  asyncPositional: (st, act) => st.getAsync(Object.defineProperty([0], 0, { get() { act(); return 7; } })),
  asyncTimeoutGetter: (st, act) => st.getAsync({ x: 7 }, { get timeoutMs() { act(); return 1000; } }),
  asyncSignalGetter: (st, act) => st.getAsync({ x: 7 }, { get signal() { act(); return undefined; } }),
};
const actions = {
  finalizeSelf: (db, st) => st.finalize(),
  finalizeOther: (db, st, other) => other.finalize(),
  close: (db) => db.close(),
  closeAsync: (db) => db.closeAsync(),
  prepare: (db) => db.prepare("SELECT 2"),
  exec: (db) => db.exec("SELECT 2"),
  getSelf: (db, st) => st.get({ x: 1 }),
  getOther: (db, st, other) => other.get(),
  getAsyncSelf: (db, st) => st.getAsync({ x: 1 }),
  allAsyncOther: (db, st, other) => other.allAsync(),
  interrupt: (db) => db.interrupt(),
};
const out = {};
for (const [shape, call] of Object.entries(shapes)) {
  for (const [name, action] of Object.entries(actions)) {
    const db = Database.open(":memory:");
    const st = db.prepare("SELECT :x AS x");
    const other = db.prepare("SELECT 3 AS y");
    let nested = "not-called";
    let pending;
    const act = () => {
      try {
        const r = action(db, st, other);
        if (r instanceof Promise) pending = r.then(() => "ok", tag);
        else nested = "ok";
      } catch (e) {
        nested = tag(e);
      }
    };
    let outer;
    try {
      outer = (await call(st, act))?.x;
    } catch (e) {
      outer = tag(e);
    }
    if (pending) nested = await pending;
    const after = db.isOpen ? st.get({ x: 9 })?.x : "closed";
    out[shape + "/" + name] = [nested, outer, after];
    await db.closeAsync();
  }
}
console.log(JSON.stringify(out));
`);
  const busy = "SqliteUsageError:busy";
  const expected: Record<string, unknown[]> = {};
  for (const shape of ["syncNamed", "syncPositional", "asyncNamed", "asyncPositional"]) {
    for (const name of ["finalizeSelf", "finalizeOther", "close", "prepare", "exec", "getSelf", "getOther"]) {
      expected[`${shape}/${name}`] = [busy, 7, 9];
    }
    // The async nested calls reject rather than throw; the rejection is the same busy error.
    expected[`${shape}/getAsyncSelf`] = [busy, 7, 9];
    expected[`${shape}/allAsyncOther`] = [busy, 7, 9];
    // No statement is running while parameters are bound, so the interrupt is a no-op (SQLite's
    // documented semantics) and does not touch the step that follows.
    expected[`${shape}/interrupt`] = ["ok", 7, 9];
  }
  for (const shape of ["asyncTimeoutGetter", "asyncSignalGetter"]) {
    for (const name of Object.keys(expected).filter((k) => k.startsWith("asyncNamed/"))) {
      expected[`${shape}/${name.slice("asyncNamed/".length)}`] = expected[name];
    }
  }
  // closeAsync waits for the execution: a sync one completes first, an async one is cancelled
  // (it never submits its step), and the connection is closed afterwards either way.
  for (const shape of ["syncNamed", "syncPositional"]) expected[`${shape}/closeAsync`] = ["ok", 7, "closed"];
  for (const shape of ["asyncNamed", "asyncPositional", "asyncTimeoutGetter", "asyncSignalGetter"]) {
    expected[`${shape}/closeAsync`] = ["ok", "SqliteCancelled:aborted", "closed"];
  }
  assert.deepEqual(result, expected);
});

Deno.test("cleanup: signal detachment that closes or reuses the connection sees a finished reset error", async () => {
  // The re-review's defect 1. An async `get` of INSERT ... RETURNING under a reader's lock fails at
  // reset (SQLITE_BUSY, extended code 5, "database is locked"). The caller's `removeEventListener`
  // (an overriding method, or a getter) runs during cleanup and closes the connection, runs a sync
  // statement (one that fails, overwriting the connection's error state), or starts an async one.
  // The execution must have read its reset error and released the connection before that hook:
  // the hook sees `inFlight: false`, its nested call succeeds (or fails on its own terms), and the
  // outer error is the reset's, not "bad parameter or other API misuse" from a freed handle.
  const result = await probe(`
const tagOf = (e) => String(e?._tag) + ":" + String(e?.reason ?? e?.codeName ?? e?.message);
const hooks = {
  none: () => {},
  close: (a) => a.close(),
  closeAsync: (a) => a.closeAsync(),
  syncGet: (a) => a.prepare("SELECT count(*) AS n FROM t").get().n,
  syncError: (a) => a.exec("SELECT * FROM missing"),
  asyncGet: (a) => a.prepare("SELECT count(*) AS n FROM t").getAsync().then((r) => r.n),
  sameStatementAsync: (a, st) => st.getAsync([3]),
};
const installs = {
  method: (signal, fn) => { signal.removeEventListener = function () { fn(); }; },
  getter: (signal, fn) => Object.defineProperty(signal, "removeEventListener", {
    get() { fn(); return () => {}; },
  }),
};
const out = {};
for (const [how, install] of Object.entries(installs)) {
  for (const [name, hook] of Object.entries(hooks)) {
    const dir = Deno.makeTempDirSync();
    const a = Database.open(dir + "/t.db");
    const b = Database.open(dir + "/t.db");
    a.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1)");
    b.exec("BEGIN; SELECT * FROM t");
    const st = a.prepare("INSERT INTO t VALUES (?) RETURNING x");
    const ac = new AbortController();
    let seen = { inFlight: "not-called", nested: "not-called" };
    install(ac.signal, () => {
      const inFlight = a.inFlight;
      let nested;
      try {
        const r = hook(a, st);
        nested = r instanceof Promise ? r.then((v) => v ?? "ok", tagOf) : (r ?? "ok");
      } catch (e) {
        nested = tagOf(e);
      }
      seen = { inFlight, nested };
    });
    let outer;
    try {
      await st.getAsync([2], { signal: ac.signal });
      outer = "returned";
    } catch (e) {
      outer = [e._tag, e.op, e.code, e.extendedCode, e.codeName, e.sqliteMessage];
    }
    const nested = await seen.nested;
    b.exec("ROLLBACK");
    const after = a.isOpen ? [st.get([4]).x, a.prepare("SELECT x FROM t ORDER BY x").all().map((r) => r.x)] : "closed";
    out[how + "/" + name] = [outer, seen.inFlight, nested, after];
    b.close();
    await a.closeAsync();
    Deno.removeSync(dir, { recursive: true });
  }
}
console.log(JSON.stringify(out));
`);
  const reset = ["SqliteError", "reset", 5, 5, "SQLITE_BUSY", "database is locked"];
  // After the reader rolls back: the failed inserts (2, and 3 from the nested execution) were
  // rolled back with their commits, so a fresh insert of 4 leaves [1, 4].
  const reused = [4, [1, 4]];
  const expected: Record<string, unknown[]> = {};
  for (const how of ["method", "getter"]) {
    expected[`${how}/none`] = [reset, false, "ok", reused];
    expected[`${how}/close`] = [reset, false, "ok", "closed"];
    expected[`${how}/closeAsync`] = [reset, false, "ok", "closed"];
    // The reader's SHARED lock does not block a read: the row count is 1 (2 was rolled back).
    expected[`${how}/syncGet`] = [reset, false, 1, reused];
    expected[`${how}/syncError`] = [reset, false, "SqliteError:SQLITE_ERROR", reused];
    expected[`${how}/asyncGet`] = [reset, false, 1, reused];
    // The same statement runs again at once and fails the same way, as its own execution.
    expected[`${how}/sameStatementAsync`] = [reset, false, "SqliteError:SQLITE_BUSY", reused];
  }
  assert.deepEqual(result, expected);
});
