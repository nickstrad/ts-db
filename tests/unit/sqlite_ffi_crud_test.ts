/**
 * FFI SQLite binding (`platform/sqlite_ffi/`): ordinary CRUD correctness, value round-trips, and the
 * typed failure surface, through both the synchronous and the nonblocking execution modes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
