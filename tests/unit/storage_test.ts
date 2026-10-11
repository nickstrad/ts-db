/**
 * Unit tests for the `Storage` service (plan item 15).
 *
 * These run the real `StorageLive` over a real `node:sqlite` file in a temp directory: the point is
 * the transaction and queue semantics, which only the real driver can show. Every dependency the
 * layer takes is a local double — `EventSink` collects into an array, `IdGen` counts `id-1`,
 * `id-2`, …, `Config` is `ConfigTest` — so each test can assert on the events it caused.
 *
 * The two behaviours the pre-port writer did not have get the most attention: an interrupted
 * mutation fiber rolls its transaction back and leaves the connection usable, and the writer queue
 * rejects job 1001 with a typed `QueueFullError` instead of an untyped rejection.
 *
 * The last section (plan item 31) shows where the U+0000 text storage contract is enforced, from the
 * events: before the statement on writes, and by a second, guarded select on reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberId,
  Layer,
  Scope,
  TestClock,
  TestContext,
} from "effect";
import type { EventRecord, QueueEventRecord, SqlEventRecord, TxEventRecord } from "../../core/events.ts";
import { withStorage } from "../../core/schema.ts";
import { ConfigTest } from "../../platform/config.ts";
import {
  Config,
  EventSink,
  IdGen,
  type LoggingConfig,
  Storage,
  type StorageService,
} from "../../platform/services.ts";
import { makeStorage, StorageLive, WRITER_QUEUE_CAP } from "../../platform/sqlite.ts";
import { defineFunctions } from "../../sdk/functions.ts";
import { v } from "../../sdk/schema.ts";
import { schema } from "../../app/schema.ts";
import { functions } from "../../app/functions.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly file: string;
  readonly events: EventRecord[];
  readonly deps: Layer.Layer<EventSink | IdGen | Config>;
}

function harness(logging: Partial<LoggingConfig> = {}): Harness & { cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-storage-"));
  const events: EventRecord[] = [];
  let id = 0;
  const deps = Layer.mergeAll(
    Layer.succeed(EventSink, { emit: (event) => Effect.sync(() => void events.push(event)) }),
    Layer.succeed(IdGen, { next: Effect.sync(() => `id-${++id}`) }),
    ConfigTest({ logging }),
  );
  return {
    file: join(dir, "app.sqlite"),
    events,
    deps,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run `program` against a fresh `StorageLive` over the app schema; the layer's scope closes after. */
async function withStorageLayer<A, E>(
  program: (storage: StorageService, h: Harness) => Effect.Effect<A, E>,
  logging: Partial<LoggingConfig> = {},
): Promise<A> {
  const h = harness(logging);
  try {
    return await Effect.runPromise(
      Effect.flatMap(Storage, (storage) => program(storage, h)).pipe(
        Effect.provide(StorageLive({ file: h.file, schema, appId: "test-app" }).pipe(Layer.provide(h.deps))),
      ),
    );
  } finally {
    h.cleanup();
  }
}

const app = defineFunctions(schema);

const inspect = app.mutation({
  args: {},
  handler: ({ db }) =>
    Effect.gen(function* () {
      return {
        games: yield* db.find("games").limit(1000).collect(),
        moves: yield* db.find("moves").limit(1000).collect(),
      };
    }),
});

const ofKind = <K extends EventRecord["kind"]>(events: EventRecord[], kind: K) =>
  events.filter((e): e is Extract<EventRecord, { kind: K }> => e.kind === kind);

/**
 * A gate for blocking handlers. Callers open it in `Effect.ensuring`, so a failed assertion cannot
 * leave a handler parked forever — closing the layer waits for in-flight work, and would hang.
 */
const openedOnExit = () => Deferred.unsafeMake<void>(FiberId.none);

const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  assert.ok(Exit.isFailure(exit), "expected a failure");
  return Cause.squash(exit.cause);
};

// ---------------------------------------------------------------------------
// Interruption: the behaviour the pre-port try/catch did not have
// ---------------------------------------------------------------------------

test("an interrupted mutation fiber rolls back and leaves the connection usable", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      const { gameId } = (yield* storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" })) as {
        gameId: string;
      };
      const wrote = yield* Deferred.make<void>();
      const hang = app.mutation({
        args: { gameId: v.string() },
        handler: ({ db }, { gameId }) =>
          Effect.gen(function* () {
            yield* db.patch("games", gameId, {
              board: ["X", null, null, null, null, null, null, null, null],
            });
            yield* db.insert("moves", { gameId, playerId: "a", mark: "X", cell: 0, moveNumber: 1 });
            yield* Deferred.succeed(wrote, undefined);
            return yield* Effect.never;
          }),
      });
      const fiber = yield* Effect.fork(storage.mutation(hang, { gameId }));
      yield* Deferred.await(wrote);
      const exit = yield* Fiber.interrupt(fiber);
      assert.ok(Exit.isInterrupted(exit), "the mutation fiber ended interrupted");

      // Rolled back: neither the patch nor the insert is visible.
      const state = (yield* storage.mutation(inspect, {})) as {
        games: { board: unknown[]; _version: number }[];
        moves: unknown[];
      };
      assert.deepEqual(state.games[0].board, Array(9).fill(null));
      assert.equal(state.games[0]._version, 1);
      assert.equal(state.moves.length, 0);

      // Still usable: a real write commits, and the writer slot was released.
      const move = (yield* storage.mutation(functions.makeMove, {
        gameId,
        playerId: "a",
        cell: 4,
        expectedVersion: 1,
      })) as { _version: number; board: unknown[] };
      assert.equal(move._version, 2);
      assert.equal(move.board[4], "X");

      const outcomes = ofKind(h.events, "tx").map((e: TxEventRecord) => e.outcome);
      assert.deepEqual(outcomes, ["commit", "commit", "interrupted", "commit", "commit"]);
      const interrupted = ofKind(h.events, "tx").find((e) => e.outcome === "interrupted")!;
      assert.equal(interrupted.operations, 2, "the patch and the insert inside the interrupted handler");
      assert.equal(interrupted.level, "warn");
    })
  );
});

// ---------------------------------------------------------------------------
// The writer queue
// ---------------------------------------------------------------------------

test(`the writer queue rejects job ${WRITER_QUEUE_CAP + 1} with a typed QueueFullError`, async () => {
  const gate = openedOnExit();
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      const blocked = app.mutation({ args: {}, handler: () => Deferred.await(gate) });
      // One job runs (and blocks on the gate); the remaining 999 wait for the permit.
      const fibers = yield* Effect.forEach(
        Array.from({ length: WRITER_QUEUE_CAP }),
        () => Effect.fork(storage.mutation(blocked, {})),
      );
      yield* Effect.sleep(Duration.millis(50)); // let every forked fiber enter the queue

      const rejected = failureOf(yield* Effect.exit(storage.mutation(blocked, {})));
      assert.equal((rejected as { _tag: string })._tag, "QueueFullError");
      assert.deepEqual(
        { ...(rejected as object) },
        { _tag: "QueueFullError", queue: "writer", depth: WRITER_QUEUE_CAP, cap: WRITER_QUEUE_CAP },
      );
      // A snapshot shares the queue; its channel is `StorageError`, with the queue failure as cause.
      const snapshot = failureOf(yield* Effect.exit(storage.snapshot(join(h.file, "..", "snap.sqlite"))));
      assert.equal((snapshot as { _tag: string })._tag, "StorageError");
      assert.equal((snapshot as { cause: { _tag: string } }).cause._tag, "QueueFullError");

      const queue = ofKind(h.events, "queue");
      assert.equal(queue.length, 2);
      assert.deepEqual(
        queue.map((e: QueueEventRecord) => [e.queue, e.event, e.depth, e.cap, e.level, e.appId]),
        [
          ["writer", "rejected", WRITER_QUEUE_CAP, WRITER_QUEUE_CAP, "warn", "test-app"],
          ["writer", "rejected", WRITER_QUEUE_CAP, WRITER_QUEUE_CAP, "warn", "test-app"],
        ],
      );

      // Open the gate: all 1000 admitted jobs commit, and the queue admits work again.
      yield* Deferred.succeed(gate, undefined);
      const exits = yield* Effect.forEach(fibers, Fiber.await);
      assert.ok(exits.every(Exit.isSuccess));
      yield* storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" });
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
  );
});

test("an interrupted waiter gives its queue slot back", async () => {
  const gate = openedOnExit();
  await withStorageLayer((storage) =>
    Effect.gen(function* () {
      const blocked = app.mutation({ args: {}, handler: () => Deferred.await(gate) });
      const head = yield* Effect.fork(storage.mutation(blocked, {}));
      const waiters = yield* Effect.forEach(
        Array.from({ length: WRITER_QUEUE_CAP - 1 }),
        () => Effect.fork(storage.mutation(blocked, {})),
      );
      yield* Effect.sleep(Duration.millis(50));
      // Full: interrupting one waiter must free exactly one slot.
      yield* Fiber.interrupt(waiters[0]);
      const admitted = yield* Effect.fork(storage.mutation(blocked, {}));
      yield* Effect.sleep(Duration.millis(10));
      const rejected = failureOf(yield* Effect.exit(storage.mutation(blocked, {})));
      assert.equal((rejected as { _tag: string })._tag, "QueueFullError");
      yield* Deferred.succeed(gate, undefined);
      assert.ok(Exit.isSuccess(yield* Fiber.await(head)));
      assert.ok(Exit.isSuccess(yield* Fiber.await(admitted)));
      yield* Effect.forEach(waiters.slice(1), Fiber.join);
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)))
  );
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

test("a defect in the handler rolls back like a failure", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      const crash = app.mutation({
        args: {},
        handler: ({ db }) =>
          Effect.gen(function* () {
            yield* db.insert("games", {
              xPlayer: "a",
              oPlayer: "b",
              board: Array(9).fill(null),
              turn: "X",
              status: "playing",
              winner: null,
            });
            return yield* Effect.sync(() => {
              throw new Error("handler bug");
            });
          }),
      });
      const failure = failureOf(yield* Effect.exit(storage.mutation(crash, {})));
      assert.match((failure as Error).message, /handler bug/);
      const state = (yield* storage.mutation(inspect, {})) as { games: unknown[] };
      assert.equal(state.games.length, 0);
      const rollback = ofKind(h.events, "tx").find((e) => e.outcome === "rollback")!;
      assert.equal(rollback.errorTag, "Defect");
    })
  );
});

test("a non-JSON result fails NonSerializableResultError before COMMIT", async () => {
  await withStorageLayer((storage) =>
    Effect.gen(function* () {
      const bad = app.mutation({
        args: {},
        handler: ({ db }) =>
          Effect.gen(function* () {
            yield* db.insert("games", {
              xPlayer: "a",
              oPlayer: "b",
              board: Array(9).fill(null),
              turn: "X",
              status: "playing",
              winner: null,
            });
            return { n: 1n };
          }),
      });
      const failure = failureOf(yield* Effect.exit(storage.mutation(bad, {})));
      assert.equal((failure as { _tag: string })._tag, "NonSerializableResultError");
      assert.equal((failure as { appId: string }).appId, "test-app");
      const state = (yield* storage.mutation(inspect, {})) as { games: unknown[] };
      assert.equal(state.games.length, 0, "the insert was rolled back");
    })
  );
});

test("a Documents handle used after its transaction fails ContextExpiredError", async () => {
  await withStorageLayer((storage) =>
    Effect.gen(function* () {
      let leaked: { find: (t: "games") => { count: () => Effect.Effect<number, unknown> } } | undefined;
      const leak = app.mutation({
        args: {},
        handler: ({ db }) =>
          Effect.sync(() => {
            leaked = db;
            return null;
          }),
      });
      yield* storage.mutation(leak, {});
      const failure = failureOf(yield* Effect.exit(leaked!.find("games").count()));
      assert.equal((failure as { _tag: string })._tag, "ContextExpiredError");
      assert.equal((failure as { context: string }).context, "mutation");
    })
  );
});

test("a forked write switched out mid-operation cannot land after COMMIT", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      let expired = 0;
      // The yield threshold decides where the forked patch is switched out: before its select,
      // between the select and the update, or between COMMIT and the release. Sweep them all.
      for (let threshold = 10; threshold <= 60; threshold++) {
        const { gameId } =
          (yield* storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" })) as {
            gameId: string;
          };
        let forked: Fiber.Fiber<unknown, unknown> | undefined;
        const leak = app.mutation({
          args: { gameId: v.string() },
          handler: ({ db }, { gameId }) =>
            Effect.gen(function* () {
              forked = yield* Effect.forkDaemon(db.patch("games", gameId, { turn: "O" }));
              return null;
            }),
        });
        const from = h.events.length;
        yield* storage.mutation(leak, { gameId }).pipe(Effect.withMaxOpsBeforeYield(threshold));
        const exit = yield* Fiber.await(forked!);
        const events = h.events.slice(from);
        const commit = events.findIndex((e) => e.kind === "tx");
        const update = events.findIndex((e) => e.kind === "sql" && e.statementKind === "update");
        const games =
          ((yield* storage.mutation(inspect, {})) as { games: { _id: string; turn: string }[] }).games;
        const turn = games.find((g) => g._id === gameId)!.turn;
        if (Exit.isSuccess(exit)) {
          // Only acceptable if the whole patch ran inside the transaction.
          assert.ok(update !== -1 && update < commit, `threshold ${threshold}: update ran after COMMIT`);
          assert.equal(turn, "O");
        } else {
          expired++;
          assert.equal(
            (failureOf(exit) as { _tag: string })._tag,
            "ContextExpiredError",
            `threshold ${threshold}`,
          );
          assert.equal(update, -1, `threshold ${threshold}: no update statement ran`);
          assert.equal(turn, "X", `threshold ${threshold}: the patch did not persist`);
        }
      }
      assert.ok(expired > 0, "some threshold switched the forked patch out past COMMIT");
    })
  );
});

test("typed handler failures keep their tag and roll back", async () => {
  await withStorageLayer((storage) =>
    Effect.gen(function* () {
      const missing = failureOf(
        yield* Effect.exit(storage.mutation(functions.makeMove, {
          gameId: "nope",
          playerId: "a",
          cell: 0,
          expectedVersion: 1,
        })),
      );
      assert.equal((missing as { _tag: string })._tag, "NotFoundError");
      const schemaFailure = failureOf(
        yield* Effect.exit(storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b", extra: 1 })),
      );
      assert.equal((schemaFailure as { _tag: string })._tag, "SchemaError");
      const patchMissing = app.mutation({
        args: {},
        handler: ({ db }) => db.patch("games", "absent", { status: "won" }),
      });
      const notFound = failureOf(yield* Effect.exit(storage.mutation(patchMissing, {})));
      assert.deepEqual({ ...(notFound as object) }, { _tag: "NotFoundError", table: "games", id: "absent" });
    })
  );
});

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

test("schema drift fails the layer with SchemaDriftError and closes the handle", async () => {
  const h = harness();
  try {
    const build = (s: typeof schema) =>
      Effect.runPromiseExit(
        Effect.scoped(Layer.build(StorageLive({ file: h.file, schema: s }).pipe(Layer.provide(h.deps)))),
      );
    assert.ok(Exit.isSuccess(await build(schema)));
    const drift = failureOf(await build(withStorage(schema, "json")));
    assert.equal((drift as { _tag: string })._tag, "SchemaDriftError");
    assert.match((drift as { detail: string }).detail, /refuses automatic migration/);
    // The failed acquire rolled back and closed: another connection can take the write lock now.
    const db = new DatabaseSync(h.file);
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
      assert.equal(
        db.prepare('SELECT definition FROM "_platform_schema"').get()!.definition,
        JSON.stringify(schema),
      );
    } finally {
      db.close();
    }
    const tx = ofKind(h.events, "tx");
    assert.deepEqual(tx.map((e) => e.outcome), ["commit", "rollback"]);
    assert.equal(tx[1].errorTag, "SchemaDriftError");
  } finally {
    h.cleanup();
  }
});

test("closing the scope waits for in-flight work, then refuses new work", async () => {
  const h = harness();
  const gate = openedOnExit();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const storage = yield* makeStorage({ file: h.file, schema }).pipe(
          Scope.extend(scope),
          Effect.provide(h.deps),
        );
        const slow = app.mutation({
          args: {},
          handler: ({ db }) =>
            Effect.gen(function* () {
              yield* Deferred.await(gate);
              return yield* db.insert("games", {
                xPlayer: "a",
                oPlayer: "b",
                board: Array(9).fill(null),
                turn: "X",
                status: "playing",
                winner: null,
              });
            }),
        });
        const inFlight = yield* Effect.fork(storage.mutation(slow, {}));
        yield* Effect.sleep(Duration.millis(10));
        const closing = yield* Effect.fork(Scope.close(scope, Exit.void));
        yield* Effect.sleep(Duration.millis(10));
        assert.equal(closing.unsafePoll(), null, "close is waiting for the in-flight mutation");
        const refused = failureOf(yield* Effect.exit(storage.mutation(inspect, {})));
        assert.deepEqual(
          [(refused as { _tag: string })._tag, (refused as { operation: string }).operation],
          ["StorageError", "close"],
        );
        yield* Deferred.succeed(gate, undefined);
        assert.equal(yield* Fiber.join(inFlight), "id-1");
        yield* Fiber.join(closing);
      }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined))),
    );
    const db = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM games").get()!.n,
        1,
        "the drained mutation committed",
      );
    } finally {
      db.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Clock and IdGen come from services
// ---------------------------------------------------------------------------

test("_creationTime comes from Clock (TestClock) and _id from IdGen", async () => {
  const h = harness();
  try {
    const game = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_700_000_000_000);
        const storage = yield* Storage;
        const { gameId } =
          (yield* storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" })) as {
            gameId: string;
          };
        const state = (yield* storage.mutation(inspect, {})) as {
          games: { _id: string; _creationTime: number }[];
        };
        assert.equal(gameId, "id-1");
        return state.games[0];
      }).pipe(
        Effect.provide(StorageLive({ file: h.file, schema }).pipe(Layer.provide(h.deps))),
        Effect.provide(TestContext.TestContext),
      ),
    );
    assert.deepEqual([game._id, game._creationTime], ["id-1", 1_700_000_000_000]);
    assert.equal(ofKind(h.events, "tx").at(-1)!.ts, new Date(1_700_000_000_000).toISOString());
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test("each statement emits a sql event; each transaction a tx event", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      const startup = ofKind(h.events, "sql").map((e) => e.statementKind);
      assert.deepEqual(startup.slice(0, 3), ["pragma", "pragma", "pragma"]);
      assert.ok(startup.includes("ddl"));
      h.events.length = 0;

      yield* storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" }).pipe(
        Effect.annotateLogs({ traceId: "trace-123" }),
      );
      const sql = ofKind(h.events, "sql");
      assert.equal(sql.length, 1);
      const insert: SqlEventRecord = sql[0];
      assert.equal(insert.engine, "sqlite");
      assert.equal(insert.statementKind, "insert");
      assert.equal(insert.tableName, "games");
      assert.equal(insert.rowCount, 1);
      assert.equal(insert.outcome, "ok");
      assert.match(insert.sqlText, /^INSERT INTO "games"/);
      assert.ok(insert.bindCount > 0);
      assert.equal(insert.bindValues, undefined, "bind values are off by default");
      assert.equal(insert.level, "debug", "SQL tracing is opt-in");
      assert.equal(insert.traceId, "trace-123");
      assert.equal(insert.appId, "test-app");
      assert.equal(typeof insert.durationMs, "number");

      const [tx] = ofKind(h.events, "tx");
      assert.deepEqual(
        [tx.outcome, tx.operations, tx.engine, tx.traceId, tx.level],
        ["commit", 1, "sqlite", "trace-123", "info"],
      );
      assert.ok(tx.queueWaitMs >= 0 && tx.durationMs >= 0);
    })
  );
});

test("LOG_INCLUDE_BIND_VALUES and TRACE_SQL change what a sql event carries", async () => {
  await withStorageLayer(
    (storage, h) =>
      Effect.gen(function* () {
        h.events.length = 0;
        yield* storage.mutation(functions.createGame, { xPlayer: "alice", oPlayer: "bob" });
        const [insert] = ofKind(h.events, "sql");
        assert.ok(insert.bindValues?.includes("alice"));
        assert.equal(insert.level, "info");
      }),
    { includeBindValues: true, traceSql: true },
  );
});

test("a failing statement emits an error sql event and a StorageError", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      // Corrupt the stored schema under the layer's feet so the next insert hits a driver error.
      const side = new DatabaseSync(h.file);
      side.exec('DROP TABLE "moves"');
      side.close();
      h.events.length = 0;
      const insertMove = app.mutation({
        args: {},
        handler: ({ db }) =>
          db.insert("moves", { gameId: "g", playerId: "a", mark: "X", cell: 0, moveNumber: 1 }),
      });
      const failure = failureOf(yield* Effect.exit(storage.mutation(insertMove, {})));
      assert.deepEqual(
        [(failure as { _tag: string })._tag, (failure as { operation: string }).operation],
        ["StorageError", "insert"],
      );
      const [sql] = ofKind(h.events, "sql");
      assert.deepEqual([sql.outcome, sql.errorTag, sql.level], ["error", "StorageError", "warn"]);
      assert.equal(ofKind(h.events, "tx")[0].outcome, "rollback");
    })
  );
});

// ---------------------------------------------------------------------------
// The text storage contract (plan item 31, docs/adr/0005-text-storage-contract.md)
//
// `tests/unit/nul_contract_test.ts` covers the contract on all four backends; these two tests read
// the live layer's events to show *where* it is enforced.
// ---------------------------------------------------------------------------

const newGame = (xPlayer: string) => ({
  xPlayer,
  oPlayer: "b",
  board: Array(9).fill(null),
  turn: "X" as const,
  status: "playing" as const,
  winner: null,
});

test("a U+0000 rejection runs no statement for the rejected write and rolls back the earlier ones", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      h.events.length = 0;
      const twoInserts = app.mutation({
        args: {},
        handler: ({ db }) =>
          Effect.gen(function* () {
            yield* db.insert("games", newGame("a"));
            return yield* db.insert("games", newGame("a\u0000b"));
          }),
      });
      const failure = failureOf(yield* Effect.exit(storage.mutation(twoInserts, {})));
      assert.deepEqual(
        { ...(failure as object) },
        {
          _tag: "SchemaError",
          reason: "type-mismatch",
          path: "xPlayer",
          expected: "text without U+0000",
          actual: "a\u0000b",
        },
      );
      // Only the first insert reached SQLite; the transaction then rolled it back.
      assert.deepEqual(ofKind(h.events, "sql").map((e) => e.statementKind), ["insert"]);
      const [tx] = ofKind(h.events, "tx");
      assert.deepEqual([tx.outcome, tx.operations, tx.errorTag], ["rollback", 2, "SchemaError"]);
      const state = (yield* storage.mutation(inspect, {})) as { games: unknown[] };
      assert.equal(state.games.length, 0);
    })
  );
});

test("a read of pre-existing U+0000 text fails StorageError via a second, guarded select", async () => {
  await withStorageLayer((storage, h) =>
    Effect.gen(function* () {
      const { gameId } = (yield* storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" })) as {
        gameId: string;
      };
      // What a pre-contract build could have committed: SQLite holds all three bytes.
      const side = new DatabaseSync(h.file);
      side.prepare('UPDATE "games" SET "xPlayer" = ? WHERE "_id" = ?').run("a\u0000b", gameId);
      side.close();
      const read = (definition: Parameters<StorageService["mutation"]>[0]) =>
        Effect.gen(function* () {
          h.events.length = 0;
          const exit = yield* Effect.exit(storage.mutation(definition, {}));
          return { exit, sql: ofKind(h.events, "sql") };
        });

      const get = app.mutation({ args: {}, handler: ({ db }) => db.get("games", gameId) });
      const { exit, sql } = yield* read(get);
      assert.deepEqual({ ...(failureOf(exit) as object) }, {
        _tag: "StorageError",
        operation: "select",
        table: "games",
        detail: 'Stored text in "xPlayer" contains U+0000, which node:sqlite truncates on read',
      });
      assert.deepEqual(sql.map((e) => [e.statementKind, e.outcome]), [["select", "ok"], ["select", "ok"]]);
      assert.match(sql[1].sqlText, /instr\(q\."xPlayer", char\(0\)\) > 0/);
      assert.equal(sql[1].rowCount, 1, "the probe found the stored NUL");
      assert.equal(ofKind(h.events, "tx")[0].errorTag, "StorageError");

      // No rows, or no text in the result: no probe.
      const none = app.mutation({ args: {}, handler: ({ db }) => db.get("games", "absent") });
      assert.deepEqual((yield* read(none)).sql.length, 1);
      const count = app.mutation({ args: {}, handler: ({ db }) => db.find("games").count() });
      const counted = yield* read(count);
      assert.ok(Exit.isSuccess(counted.exit) && counted.exit.value === 1);
      assert.equal(counted.sql.length, 1);
    })
  );
});
