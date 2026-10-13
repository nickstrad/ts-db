# `platform/sqlite_ffi/`

Deno FFI to the system `libsqlite3`. Three layers:

| File          | What it is                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `library.ts`  | Loads and validates the library; the whole native symbol table.                                  |
| `database.ts` | `Database` / `Statement`: blocking `run/get/all`, nonblocking `runAsync/getAsync/allAsync`.      |
| `errors.ts`   | The five binding error tags (`SqliteFfiError`).                                                  |
| `effect.ts`   | The Effect layer: scoped connections, Effect wrappers, the interruption bridge, statement cache. |

`mod.ts` re-exports all four. `database.ts`'s module comment is the execution contract: one execution per
connection (others fail `"busy"`), executions run to completion and reset, explicit lifetimes.

## The Effect layer (`effect.ts`)

- `openDatabase(path, options)`: `Effect<Database, SqliteFfiError, Scope>`. The scope's release runs
  `closeAsync`, which cancels an execution still in flight, waits for its step to return, finalizes every
  statement (cached ones included) and closes.
- `exec(db, sql)`, `prepare(db, sql)` (through the cache), and `run/get/all(statement, params)`: blocking
  calls on the main thread, as Effects.
- `runAsync/getAsync/allAsync(statement, params, { timeoutMs })`: each step on Deno's blocking pool.
- `Database.inTransaction` (`sqlite3_get_autocommit(db) === 0`) replaces `DatabaseSync.isTransaction`. It is
  false on a closed connection and fails `"busy"` while an execution holds the connection.

Every binding error is a typed failure. Anything else a call throws came from caller code (a parameter getter,
a proxy) and becomes a defect carrying the original value; nothing inspects or changes it.

## The interruption bridge

Each async wrapper is an `Effect.async` that starts the binding call with a fresh `AbortController`'s signal.
When the fiber is interrupted (`Fiber.interrupt`, `Effect.timeout`, a closing scope), the canceler aborts the
controller. The binding's own listener then calls `sqlite3_interrupt`, repeating until the outstanding step
returns. The canceler waits for the binding's promise, which settles only after the statement is reset and the
connection released. So an interruption is complete only when the connection is free, and the next statement
never fails `"busy"` because of an execution its fiber already abandoned.

The canceler never throws and never calls the connection itself. Only the binding's listener does.

There are two ways to bound a statement:

| Bound                                     | What the caller sees                            | What the binding reports     |
| ----------------------------------------- | ----------------------------------------------- | ---------------------------- |
| `{ timeoutMs }` on the wrapper            | typed `SqliteCancelled({ reason: "deadline" })` | same                         |
| fiber interruption (`Effect.timeout` ...) | interruption / Effect's `TimeoutException`      | `SqliteCancelled("aborted")` |

A typed deadline error (FFI-05's `StatementDeadlineError`) should come from `timeoutMs`. Fiber interruption
discards the execution's own result, as it does for any interrupted Effect.

## The statement cache (`prepareCached`)

`prepareCached(db, sql)` replaces the writer's per-call `prepare(sql.text)` and keeps the binding's
reused-statement point-read cost. On vm-1 (2026-10-13) a cached FFI point read took 8.8–9.1 µs p50, against
8.1–8.3 µs for a reused `node:sqlite` statement and 27–33 µs for `node:sqlite` preparing per call, as the
writer does today. The perf test in `tests/unit/sqlite_ffi_effect_test.ts` prints all three.

- **Per connection, keyed by SQL text, LRU, capacity 64** (`STATEMENT_CACHE_CAPACITY`). A miss beyond 64
  entries finalizes the least recently used statement. A returned statement stays valid until 64 other
  distinct texts have been prepared after it. Using an evicted statement fails
  `SqliteUsageError("finalized")`; nothing native is touched.
- **Bypassed** (`isCacheable(sql) === false`): SQL starting with `VACUUM` (including `VACUUM INTO`), `CREATE`,
  `ALTER`, `DROP` or `PRAGMA`, after leading whitespace and comments. These get a fresh statement that stays
  valid until the next `prepareCached` call on the same connection, which finalizes it. Use it at once.
- **Never finalizes under an execution.** Finalization (eviction or a bypassed statement's cleanup) is skipped
  while `db.inFlight` and done at a later call. A miss cannot evict then anyway, because `prepare` fails
  `"busy"`. A hit is served while busy, and running it fails `"busy"` as usual.
- A cached statement finalized by someone else, or by `db.close()`, is dropped and prepared again. On a closed
  connection that fails `"closed"`.
- Cached statements hold no transaction or snapshot between calls: every execution resets its statement.
