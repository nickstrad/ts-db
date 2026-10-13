/**
 * Opening a SQLite file from a test, through the same FFI binding the server uses
 * (`platform/sqlite_ffi/`, the system `libsqlite3`).
 *
 * Why tests may not use another driver here: a test process that runs the server in-process, or
 * that opens a file the server (or the document reader) also has open, would otherwise hold that
 * file through two copies of SQLite. POSIX advisory locks belong to the process, so a close through
 * one copy silently drops the locks the other holds (FFI plan §1.2, `docs/knowledge/gotchas.md`
 * "Two SQLite copies in one process must not share a file"). One copy per file, always: this one.
 *
 * ```ts
 * const db = inspect(file);                       // read-only
 * try {
 *   assert.equal(db.get("SELECT count(*) AS n FROM games")?.n, 1);
 * } finally {
 *   db.close();
 * }
 * const fixture = inspect(file, { write: true }); // read-write, creates the file
 * fixture.run("INSERT INTO t VALUES (?)", ["x"]);
 * ```
 *
 * Every call prepares, runs and finalizes its own statement on the binding's blocking path, so
 * nothing stays prepared between calls and `close` never fails `"busy"`. Parameters are an array
 * (or a named-parameter object), never variadic. Rows are null-prototype objects; INTEGER columns
 * read as `number` (or `bigint` everywhere with `readBigInts`), as the server reads them.
 *
 * The library is the binding's default list, which is what the server uses under `ConfigTest` and
 * under `ConfigLive` with `SQLITE_LIBRARY` unset. A test that sets `Config.sqlite.library` to a
 * different copy must not inspect a file that server has open.
 */
import {
  type BindParams,
  Database,
  type Row,
  type RunResult,
  type Statement,
} from "../../platform/sqlite_ffi/mod.ts";

export interface InspectOptions {
  /** Open read-write (creating the file if missing). Default false: read-only. */
  readonly write?: boolean;
  /** Read every INTEGER column as `bigint`, as the document reader does. Default false. */
  readonly readBigInts?: boolean;
}

/** A connection for looking at (or, with `write`, preparing) a database file in a test. */
export interface Inspection {
  /** The first row of `sql`, or `undefined`. */
  get(sql: string, params?: BindParams): Row | undefined;
  /** Every row of `sql`. */
  all(sql: string, params?: BindParams): Row[];
  /** Run one statement and report its changes. */
  run(sql: string, params?: BindParams): RunResult;
  /** Run zero or more `;`-separated statements without parameters or results. */
  exec(sql: string): void;
  /** Close the connection. Idempotent. */
  close(): void;
  [Symbol.dispose](): void;
}

/** Open `path` through the FFI binding: read-only unless `options.write`. */
export function inspect(path: string, options: InspectOptions = {}): Inspection {
  const db = Database.open(path, { readOnly: !options.write, readBigInts: options.readBigInts });
  const once = <A>(sql: string, use: (statement: Statement) => A): A => {
    const statement = db.prepare(sql);
    try {
      return use(statement);
    } finally {
      statement.finalize();
    }
  };
  return {
    get: (sql, params) => once(sql, (s) => s.get(params)),
    all: (sql, params) => once(sql, (s) => s.all(params)),
    run: (sql, params) => once(sql, (s) => s.run(params)),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    [Symbol.dispose]: () => db.close(),
  };
}
