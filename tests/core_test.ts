/**
 * The regression net (plan item 20): the original 20 tests, the `StorageLive`/`StorageTest`
 * conformance suite, and smoke tests for the test doubles themselves.
 *
 * Every test is an effect run by `tests/helpers/run.ts`'s `runTest` under `node:test`, with the
 * in-memory `TestLayer` (ids, events, object store, `TestClock`, config) provided.
 *
 * - The storage-dependent originals run against the real `StorageLive` over a real `node:sqlite`
 *   file: competing moves, rollback, quoting, WAL snapshots and schema drift are what only the real
 *   driver can show. Argument validation runs against `StorageTest`; the compiler tests are pure.
 * - The conformance suite runs one scripted sequence against `StorageLive` and against
 *   `StorageTest`, in both physical layouts, and asserts deep equality of every step's outcome and
 *   of the final contents. It is what keeps `StorageTest` honest.
 *
 * Failures are typed now, so the original message regexes became assertions on the tagged error
 * that carries the same fact: `/Unknown field/` is `SchemaError({ reason: "unknown-field" })`,
 * `/expected integer/` is `SchemaError({ expected: "integer" })`, `/Array predicates/` is
 * `CompileError({ reason: "array-predicate" })`, `/refuses automatic migration/` is the
 * `SchemaDriftError` detail.
 *
 * Tests that need the real file are skipped when write permission is denied, so the fast,
 * no-I/O subset can be proven with
 * `deno test --allow-read --allow-env --deny-write --deny-run tests/core_test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Deferred, Effect, Either, Exit, Fiber, Option, TestClock } from "effect";
import {
  CompileError,
  ContextExpiredError,
  HandlerKindMismatch,
  type MutationError,
  ObjectStoreError,
  QueryWriteAttemptError,
  RuleError,
  SchemaDriftError,
  SchemaError,
  StorageError,
} from "../core/errors.ts";
import { sqlEvent, txEvent } from "../core/events.ts";
import { compileDDL } from "../core/compile/ddl.ts";
import { compileSelect } from "../core/compile/select.ts";
import { decode } from "../core/compile/decode.ts";
import { makeStorage } from "../platform/sqlite.ts";
import { EventSink, IdGen, ObjectStore, Reader, Storage, type StorageService } from "../platform/services.ts";
import { defineFunctions } from "../sdk/functions.ts";
import { Documents, type SelectPlan, type WriteDB } from "../sdk/db.ts";
import {
  defineSchema,
  defineTable,
  type Schema,
  type Storage as Layout,
  v,
  withStorage,
} from "../sdk/schema.ts";
import { schema } from "../app/schema.ts";
import { functions } from "../app/functions.ts";
import type { ArgsOf, Names, ResultOf } from "../sdk/functions.ts";
import { runTest } from "./helpers/run.ts";
import {
  DocumentStoreTest,
  eventsOfKind,
  eventsWhere,
  IdGenTest,
  makeIdGenTest,
  makeMemoryStore,
  makeStorageTest,
  MemoryStore,
  ObjectStoreTestControl,
  StorageTest,
} from "./layers/index.ts";

// ===========================================================================
// Harness
// ===========================================================================

/** The pre-port fixture's fixed clock reading. */
const T0 = 1_700_000_000_000;

/** `StorageLive` needs a real file. Under `--deny-write` (the fast, layer-only run) those tests skip. */
const LIVE = Deno.permissions.querySync({ name: "write" }).state === "granted";
const needsSqlite = LIVE ? false : "needs write permission for a real node:sqlite file";

/** A temp directory, removed when the test's scope closes (after the storage handle, which opens later). */
const tempDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "document-db-test-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

/**
 * The real `StorageLive` service over a fresh file, with its own `id-1`, `id-2`, … counter (as the
 * pre-port fixture had one per writer) and the clock at `T0`. Closed with the test's scope.
 */
function openLive(layout: Layout, appSchema: Schema = schema) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const dir = yield* tempDir;
    const file = join(dir, "app.sqlite");
    const storage = yield* makeStorage({ file, schema: withStorage(appSchema, layout) }).pipe(
      Effect.provideServiceEffect(IdGen, makeIdGenTest()),
    );
    return { storage, dir, file };
  });
}

/** `StorageTest` over its own store and id counter, with the clock at `T0`. */
function openTest(layout: Layout, appSchema: Schema = schema) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const store = yield* makeMemoryStore(withStorage(appSchema, layout));
    const storage = yield* makeStorageTest().pipe(
      Effect.provideService(MemoryStore, store),
      Effect.provideServiceEffect(IdGen, makeIdGenTest()),
    );
    return { storage, store };
  });
}

// Handlers are Effects since item 10, so the ad-hoc definitions in this file are `Effect.gen` bodies.
const inspector = defineFunctions(schema).mutation({
  args: {},
  handler: ({ db }) =>
    Effect.gen(function* () {
      return {
        games: yield* db.find("games").limit(1000).collect(),
        moves: yield* db.find("moves").sort("moveNumber").limit(1000).collect(),
        wins: yield* db.find("games", { status: "won" }).countBy("winner"),
        count: yield* db.find("games").count(),
      };
    }),
});

type MutationName = Names<typeof functions, "mutation">;

/** The app's mutations and the inspector, as effects over one storage. */
function caller(storage: StorageService) {
  return {
    call: <N extends MutationName>(name: N, args: ArgsOf<typeof functions[N]>) =>
      storage.mutation(functions[name], args) as Effect.Effect<ResultOf<typeof functions[N]>, MutationError>,
    inspect: storage.mutation(inspector, {}) as Effect.Effect<ResultOf<typeof inspector>, MutationError>,
  };
}

/** What `effect` failed with: its typed error, or the defect's thrown value. Fails the test on success. */
function failureOf<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<unknown, never, R> {
  return Effect.flatMap(
    Effect.exit(effect),
    (exit) =>
      Exit.isSuccess(exit)
        ? Effect.sync(() => assert.fail(`expected a failure, got ${JSON.stringify(exit.value)}`))
        : Effect.succeed(Cause.squash(exit.cause)),
  );
}

function assertRule(error: unknown, rule: string, detail: string): void {
  assert.ok(error instanceof RuleError, `expected a RuleError, got ${String(error)}`);
  assert.equal(error.rule, rule);
  assert.equal(error.detail, detail);
}

function assertSchemaError(
  error: unknown,
  fields: Partial<Pick<SchemaError, "reason" | "path" | "expected">>,
) {
  assert.ok(error instanceof SchemaError, `expected a SchemaError, got ${String(error)}`);
  for (const [key, value] of Object.entries(fields)) assert.equal(error[key as keyof SchemaError], value);
}

// ===========================================================================
// The original 20 tests
// ===========================================================================

for (const layout of ["columns", "json"] as const) {
  runTest(
    `${layout}: create, complete game, aggregate wins, delete`,
    Effect.gen(function* () {
      const { call, inspect } = caller((yield* openLive(layout)).storage);
      const { gameId } = yield* call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      let version = 1;
      for (
        const [playerId, cell] of [["alice", 0], ["bob", 3], ["alice", 1], ["bob", 4], ["alice", 2]] as const
      ) {
        const game = yield* call("makeMove", { gameId, playerId, cell, expectedVersion: version++ });
        assert.equal(game!._version, version);
      }
      const state = yield* inspect;
      assert.equal(state.games[0].status, "won");
      assert.equal(state.games[0].winner, "X");
      assert.deepEqual(state.wins, [{ value: "X", count: 1 }]);
      assert.equal(state.moves.length, 5);
      assert.equal(state.count, 1);
      assertRule(
        yield* failureOf(call("makeMove", { gameId, playerId: "bob", cell: 5, expectedVersion: 6 })),
        "game-over",
        "Game is over",
      );
      yield* call("deleteGame", { gameId });
      assert.equal((yield* inspect).count, 0);
      assert.equal((yield* inspect).moves.length, 0);
    }),
    { skip: needsSqlite },
  );

  runTest(
    `${layout}: two competing moves cannot both commit`,
    Effect.gen(function* () {
      const { call, inspect } = caller((yield* openLive(layout)).storage);
      const { gameId } = yield* call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      const results = yield* Effect.all(
        [0, 1].map((cell) =>
          Effect.either(call("makeMove", { gameId, playerId: "alice", cell, expectedVersion: 1 }))
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Either.isRight).length, 1);
      const state = yield* inspect;
      assert.equal(state.games[0].board.filter((x) => x !== null).length, 1);
      assert.equal(state.moves.length, 1);
      assert.equal(state.games[0]._version, 2);
    }),
    { skip: needsSqlite },
  );

  runTest(
    `${layout}: rollback restores board, version, and move history`,
    Effect.gen(function* () {
      const { storage } = yield* openLive(layout);
      const { call, inspect } = caller(storage);
      const { gameId } = yield* call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      const broken = defineFunctions(schema).mutation({
        args: { gameId: v.string() },
        handler: ({ db }, { gameId }) =>
          Effect.gen(function* () {
            yield* db.patch("games", gameId, {
              board: ["X", null, null, null, null, null, null, null, null],
            });
            yield* db.insert("moves", { gameId, playerId: "alice", mark: "X", cell: 0, moveNumber: 1 });
            return yield* Effect.fail(new Error("Injected failure after both writes"));
          }),
      });
      const failure = yield* failureOf(storage.mutation(broken, { gameId }));
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /Injected failure/);
      const state = yield* inspect;
      assert.deepEqual(state.games[0].board, Array(9).fill(null));
      assert.equal(state.games[0]._version, 1);
      assert.equal(state.moves.length, 0);
    }),
    { skip: needsSqlite },
  );

  // Argument validation needs no driver: it runs against the in-memory double.
  runTest(
    `${layout}: invalid arguments and illegal moves are rejected`,
    Effect.gen(function* () {
      const storage = yield* Storage;
      const { call, inspect } = caller(storage);
      assertSchemaError(
        yield* failureOf(storage.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b", extra: true })),
        { reason: "unknown-field", path: "extra" },
      );
      const { gameId } = yield* call("createGame", { xPlayer: "a", oPlayer: "b" });
      assertRule(
        yield* failureOf(call("makeMove", { gameId, playerId: "b", cell: 0, expectedVersion: 1 })),
        "not-your-turn",
        "Not your turn",
      );
      assertRule(
        yield* failureOf(call("makeMove", { gameId, playerId: "a", cell: 10, expectedVersion: 1 })),
        "invalid-move",
        "Invalid move",
      );
      assertSchemaError(
        yield* failureOf(call("makeMove", { gameId, playerId: "a", cell: 0.5, expectedVersion: 1 })),
        { reason: "type-mismatch", path: "cell", expected: "integer" },
      );
      assert.equal((yield* inspect).games[0]._version, 1);
    }),
    { layer: StorageTest({ schema: withStorage(schema, layout) }) },
  );

  runTest(
    `${layout}: quote-bearing strings stay data, not SQL`,
    Effect.gen(function* () {
      const { storage } = yield* openLive(layout);
      const { call } = caller(storage);
      const value = "O'Reilly'); DROP TABLE games; --";
      yield* call("createGame", { xPlayer: value, oPlayer: "bob" });
      const find = defineFunctions(schema).mutation({
        args: { xPlayer: v.string() },
        handler: ({ db }, { xPlayer }) => db.find("games", { xPlayer }).collect(),
      });
      const rows = (yield* storage.mutation(find, { xPlayer: value })) as ResultOf<typeof find>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].xPlayer, value);
    }),
    { skip: needsSqlite },
  );

  runTest(
    `${layout}: standalone backup includes uncheckpointed WAL commits`,
    Effect.gen(function* () {
      const { storage, dir, file } = yield* openLive(layout);
      yield* caller(storage).call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      assert.ok(existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0);
      const backup = join(dir, "backup.sqlite");
      yield* storage.snapshot(backup);
      const db = new DatabaseSync(backup, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get()!.n, 1);
        assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
      } finally {
        db.close();
      }
    }),
    { skip: needsSqlite },
  );

  runTest(
    `${layout}: schema drift fails rather than silently migrating`,
    Effect.gen(function* () {
      const { file } = yield* openLive(layout);
      const changed = withStorage(schema, layout === "json" ? "columns" : "json");
      const failure = yield* failureOf(Effect.scoped(makeStorage({ file, schema: changed })));
      assert.ok(failure instanceof SchemaDriftError, `expected SchemaDriftError, got ${String(failure)}`);
      assert.match(failure.detail ?? "", /refuses automatic migration/);
    }),
    { skip: needsSqlite },
  );
}

runTest(
  "each app file has its own data, even when IDs collide",
  Effect.gen(function* () {
    const a = caller((yield* openLive("columns")).storage);
    const b = caller((yield* openLive("columns")).storage);
    const first = yield* a.call("createGame", { xPlayer: "a", oPlayer: "b" });
    const second = yield* b.call("createGame", { xPlayer: "c", oPlayer: "d" });
    assert.equal(first.gameId, second.gameId);
    assert.equal((yield* a.inspect).games[0].xPlayer, "a");
    assert.equal((yield* b.inspect).games[0].xPlayer, "c");
  }),
  { skip: needsSqlite },
);

runTest(
  "same logical plan generates both dialects and both storage layouts",
  Effect.gen(function* () {
    let plan: SelectPlan | undefined;
    const db = new Documents<typeof schema>((op) =>
      Effect.sync(() => {
        assert.equal(op.kind, "select");
        plan = op as SelectPlan;
        return [];
      })
    );
    yield* db.find("games", { status: "playing" }).sort("_creationTime", "desc").limit(20).collect();
    const columnSQL = yield* compileSelect(schema, plan!, "duckdb");
    const jsonSQL = yield* compileSelect(withStorage(schema, "json"), plan!, "duckdb");
    const sqliteSQL = yield* compileSelect(withStorage(schema, "json"), plan!, "sqlite");
    assert.match(columnSQL.text, /FROM "app"\."games" WHERE "status" = \$p1/);
    assert.match(jsonSQL.text, /json_extract_string\("doc", '\$\.status'\)/);
    assert.match(sqliteSQL.text, /json_extract\("doc", '\$\.status'\)/);
    assert.deepEqual(columnSQL.values, ["playing", 20]);
    assert.deepEqual(jsonSQL.values, columnSQL.values);
  }),
);

runTest(
  "array predicates and unknown fields fail instead of falling back to JS scans",
  Effect.gen(function* () {
    const base = { kind: "select" as const, table: "games", limit: 20 };
    const array = yield* Effect.flip(
      compileSelect(schema, { ...base, filters: [{ field: "board", op: "eq", value: [] }] }, "duckdb"),
    );
    assert.ok(array instanceof CompileError);
    assert.equal(array.reason, "array-predicate");
    const unknown = yield* Effect.flip(
      compileSelect(schema, { ...base, filters: [{ field: "notAField", op: "eq", value: "x" }] }, "sqlite"),
    );
    assert.ok(unknown instanceof CompileError);
    assert.equal(unknown.reason, "unknown-field");
    assert.equal(unknown.field, "notAField");
  }),
);

runTest(
  "JSON numeric queries cast extracted values; null uses IS NULL",
  Effect.gen(function* () {
    const json = withStorage(schema, "json");
    const numeric = yield* compileSelect(json, {
      kind: "select",
      table: "moves",
      limit: 9,
      filters: [{ field: "moveNumber", op: "gt", value: 3 }],
    }, "duckdb");
    assert.match(numeric.text, /CAST\(json_extract_string\("doc", '\$\.moveNumber'\) AS BIGINT\) > \$p1/);
    const nullable = yield* compileSelect(json, {
      kind: "select",
      table: "games",
      limit: 20,
      filters: [{ field: "winner", op: "eq", value: null }],
    }, "duckdb");
    assert.match(nullable.text, /IS NULL/);
    assert.deepEqual(nullable.values, [20]);
  }),
);

runTest(
  "decoder normalizes DuckDB BIGINT results to safe JS numbers",
  Effect.gen(function* () {
    const plan = { kind: "select" as const, table: "games", filters: [], limit: 20 };
    const rows = (yield* decode(schema, plan, [{
      _id: "g",
      _creationTime: 1700000000000n,
      _version: 1n,
      xPlayer: "alice",
      oPlayer: "bob",
      board: JSON.stringify(Array(9).fill(null)),
      turn: "X",
      status: "playing",
      winner: null,
    }])) as { _creationTime: number; board: unknown[] }[];
    assert.equal(typeof rows[0]._creationTime, "number");
    assert.equal(rows[0].board.length, 9);
  }),
);

runTest(
  "schema compiler emits indexes for either physical layout",
  Effect.gen(function* () {
    assert.match((yield* compileDDL(schema)).join("\n"), /"status" TEXT NOT NULL/);
    const json = (yield* compileDDL(withStorage(schema, "json"))).join("\n");
    assert.match(json, /"doc" TEXT NOT NULL CHECK/);
    assert.match(json, /CREATE INDEX.*json_extract/);
  }),
);

// ===========================================================================
// Conformance: StorageLive and StorageTest agree on a scripted sequence
// ===========================================================================

/** A schema that exercises every node kind, nullability, both text orders and an index. */
const conformanceSchema = defineSchema({
  items: defineTable({
    name: v.string(),
    rank: v.integer(),
    score: v.nullable(v.number()),
    active: v.boolean(),
    kind: v.enum("alpha", "beta", "gamma"),
    tags: v.array(v.string()),
    parent: v.nullable(v.string()),
  }).index("by_kind", ["kind", "rank"]),
  notes: defineTable({
    itemId: v.string(),
    body: v.string(),
    seq: v.integer(),
  }),
});
type CS = typeof conformanceSchema;
const cs = defineFunctions(conformanceSchema);

/** An untyped view of `db`, for the steps that deliberately go outside the schema. */
const loose = (db: WriteDB<CS>) => db as unknown as WriteDB<Schema>;

/** A step's observable outcome, normalized so two implementations can be compared with `deepEqual`. */
type Outcome =
  | { readonly ok: unknown }
  | { readonly fail: Readonly<Record<string, unknown>> }
  | { readonly die: string }
  | { readonly interrupted: true };

/**
 * A typed error, as its tag plus its structured fields. `cause` is dropped (it holds the driver's
 * exception), and a `StorageError` keeps only `operation` and `table`: its `detail` is the
 * driver's text, which the double can only approximate.
 */
function normalizeError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof StorageError) {
    return { _tag: error._tag, operation: error.operation, table: error.table };
  }
  if (error instanceof Error && "_tag" in error) {
    const fields = Object.fromEntries(Object.entries(error).filter(([key]) => key !== "cause"));
    return { _tag: (error as { _tag: unknown })._tag, ...fields };
  }
  return { untagged: String(error) };
}

function outcome(effect: Effect.Effect<unknown, unknown>): Effect.Effect<Outcome> {
  return Effect.map(Effect.exit(effect), (exit): Outcome => {
    if (Exit.isSuccess(exit)) return { ok: exit.value };
    if (Cause.isInterruptedOnly(exit.cause)) return { interrupted: true };
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) return { fail: normalizeError(failure.value) };
    const defect = Cause.squash(exit.cause);
    return { die: defect instanceof Error ? defect.message : String(defect) };
  });
}

interface Step {
  readonly name: string;
  readonly run: (storage: StorageService) => Effect.Effect<unknown, unknown>;
}

/**
 * The script. Built fresh per run, because one pair of steps shares a leaked `db` handle. Ids are
 * deterministic (`IdGenTest`), so later steps name documents by id; a double that spent ids in a
 * different order would diverge at the first such step.
 */
function conformanceScript(): readonly Step[] {
  const mutate = <A, E>(handler: (db: WriteDB<CS>) => Effect.Effect<A, E>) => {
    const definition = cs.mutation({ args: {}, handler: ({ db }) => handler(db) });
    return (storage: StorageService) => storage.mutation(definition, {});
  };
  const step = (name: string, run: Step["run"]): Step => ({ name, run });
  const tick = (name: string, ms: number) => step(name, () => TestClock.adjust(ms));
  const item = (
    name: string,
    rank: number,
    score: number | null,
    active: boolean,
    kind: "alpha" | "beta" | "gamma",
    tags: string[],
    parent: string | null,
  ) => ({ name, rank, score, active, kind, tags, parent });
  const getItem = (id: string) => mutate((db) => db.get("items", id));
  let leaked: WriteDB<CS> | undefined;
  const withArgs = cs.mutation({
    args: { n: v.integer(), label: v.nullable(v.string()) },
    handler: ({ db }, { n, label }) => db.insert("notes", { itemId: "id-1", body: label ?? "none", seq: n }),
  });
  const query = cs.query({ args: {}, handler: ({ db }) => db.find("items").count() });

  return [
    // --- inserts: ids id-1.., timestamps with a tie on id-2/id-3 ---
    step(
      "insert alpha",
      mutate((db) => db.insert("items", item("alpha", 3, 1.5, true, "alpha", ["x"], null))),
    ),
    tick("tick 1s", 1000),
    step("insert beta", mutate((db) => db.insert("items", item("beta", 1, null, false, "beta", [], "id-1")))),
    step(
      "insert accented (same timestamp)",
      mutate((db) => db.insert("items", item("Émile", 2, -2.25, true, "gamma", ["a", "b"], "id-1"))),
    ),
    tick("tick 1s", 1000),
    step(
      "insert quote-bearing, max safe integer",
      mutate((db) =>
        db.insert(
          "items",
          item(
            "O'Reilly'); DROP TABLE items; --",
            9007199254740991,
            0.1,
            false,
            "alpha",
            ["'", '"', ";--"],
            null,
          ),
        )
      ),
    ),
    step(
      "insert supplementary-plane name",
      mutate((db) => db.insert("items", item("\u{1F600} grin", -5, 1e21, true, "beta", [], null))),
    ),
    step(
      "insert U+FFFF name",
      mutate((db) => db.insert("items", item("￿ high", 0, null, false, "gamma", [], "id-4"))),
    ),
    step(
      "three notes in one mutation",
      mutate((db) =>
        Effect.all([
          db.insert("notes", { itemId: "id-1", body: "first", seq: 1 }),
          db.insert("notes", { itemId: "id-1", body: "second", seq: 2 }),
          db.insert("notes", { itemId: "id-2", body: "other", seq: 1 }),
        ])
      ),
    ),
    // --- reads: order, filters, aggregates ---
    step("find all (by _id)", mutate((db) => db.find("items").collect())),
    step("sort name asc (code-point order)", mutate((db) => db.find("items").sort("name").collect())),
    step("sort rank desc limit 3", mutate((db) => db.find("items").sort("rank", "desc").limit(3).collect())),
    step("sort score asc (nulls first)", mutate((db) => db.find("items").sort("score").collect())),
    step("sort score desc (nulls last)", mutate((db) => db.find("items").sort("score", "desc").collect())),
    step("sort boolean", mutate((db) => db.find("items").sort("active").collect())),
    step(
      "sort _creationTime desc (ties by _id)",
      mutate((db) => db.find("items").sort("_creationTime", "desc").collect()),
    ),
    step("eq enum", mutate((db) => db.find("items", { kind: "alpha" }).collect())),
    step(
      "gt + eq boolean + sort",
      mutate((db) => db.find("items", { active: true }).gt("rank", 1).sort("rank").collect()),
    ),
    step("eq null", mutate((db) => db.find("items", { parent: null }).collect())),
    step(
      "gt on a nullable number",
      mutate((db) => loose(db).find("items").gt("score" as never, 0).collect()),
    ),
    step("count with filter", mutate((db) => db.find("items", { active: false }).count())),
    step("countBy enum", mutate((db) => db.find("items").countBy("kind"))),
    step("countBy nullable number", mutate((db) => db.find("items").countBy("score"))),
    step("countBy boolean, limit 1", mutate((db) => db.find("items").limit(1).countBy("active"))),
    step("countBy nullable string", mutate((db) => db.find("items").countBy("parent"))),
    step("first", mutate((db) => db.find("notes").sort("seq", "desc").first())),
    step("get existing", getItem("id-3")),
    step("get missing", getItem("id-404")),
    // --- patches ---
    step(
      "patch one field",
      mutate((db) => Effect.zipRight(db.patch("items", "id-2", { rank: 10 }), db.get("items", "id-2"))),
    ),
    step(
      "patch three fields",
      mutate((db) =>
        Effect.zipRight(
          db.patch("items", "id-2", { score: 4.5, tags: ["y", "z"], parent: null }),
          db.get("items", "id-2"),
        )
      ),
    ),
    step("patch missing document", mutate((db) => db.patch("items", "id-404", { rank: 1 }))),
    step("patch unknown field", mutate((db) => loose(db).patch("items", "id-1", { nope: 1 }))),
    step("patch wrong type", mutate((db) => db.patch("items", "id-1", { rank: 1.5 }))),
    step("patch reserved field", mutate((db) => loose(db).patch("items", "id-1", { _version: 7 }))),
    // --- rejected inserts (each still spends an id) ---
    step("insert missing field", mutate((db) => loose(db).insert("items", { name: "partial" }))),
    step("insert unknown table", mutate((db) => loose(db).insert("ghosts", {}))),
    step(
      "insert after rejections (id gap)",
      mutate((db) => db.insert("notes", { itemId: "id-3", body: "gap", seq: 3 })),
    ),
    // --- rejected reads ---
    step("array predicate", mutate((db) => loose(db).find("items", { tags: [] as never }).collect())),
    step("gt on text", mutate((db) => loose(db).find("items").gt("name" as never, "m" as never).collect())),
    step(
      "filter value of the wrong type",
      mutate((db) => loose(db).find("items", { rank: "3" as never }).collect()),
    ),
    step("unknown field", mutate((db) => loose(db).find("items", { missing: 1 } as never).collect())),
    step("limit out of range (a defect)", mutate((db) => db.find("items").limit(0).collect())),
    // --- rollback, three ways, each followed by a read of what it touched ---
    step(
      "typed failure after writes rolls back",
      mutate((db) =>
        Effect.gen(function* () {
          yield* db.patch("items", "id-1", { rank: 100 });
          yield* db.insert("notes", { itemId: "id-1", body: "doomed", seq: 9 });
          return yield* new RuleError({ rule: "injected", detail: "after writes" });
        })
      ),
    ),
    step(
      "defect after writes rolls back",
      mutate((db) =>
        Effect.gen(function* () {
          yield* db.delete("items", "id-1");
          return yield* Effect.die(new Error("boom"));
        })
      ),
    ),
    step("untyped failure is a defect", mutate(() => Effect.fail(new Error("plain error")))),
    step(
      "interruption after writes rolls back",
      mutate((db) =>
        Effect.gen(function* () {
          yield* db.patch("items", "id-1", { name: "interrupted" });
          return yield* Effect.interrupt;
        })
      ),
    ),
    step(
      "non-serializable result rolls back",
      mutate((db) =>
        Effect.gen(function* () {
          yield* db.insert("notes", { itemId: "id-1", body: "bigint", seq: 10 });
          return 10n;
        })
      ),
    ),
    step("state after rollbacks", getItem("id-1")),
    step("notes after rollbacks", mutate((db) => db.find("notes").collect())),
    // --- results go through JSON ---
    step(
      "result shaping",
      mutate(() => Effect.succeed({ u: undefined, d: new Date(0), n: null, a: [undefined, 1], nan: NaN })),
    ),
    step("undefined result", mutate(() => Effect.void)),
    // --- the db handle expires with its transaction ---
    step("leak the db handle", mutate((db) => Effect.sync(() => void (leaked = db)))),
    step(
      "leaked handle cannot write",
      mutate(() => leaked!.insert("notes", { itemId: "x", body: "late", seq: 0 })),
    ),
    step("leaked handle cannot read", mutate(() => leaked!.get("items", "id-1"))),
    // --- deletes ---
    step("delete", mutate((db) => Effect.zipRight(db.delete("items", "id-5"), db.get("items", "id-5")))),
    step("delete again is a no-op", mutate((db) => db.delete("items", "id-5"))),
    step("delete from unknown table", mutate((db) => loose(db).delete("ghosts", "id-1"))),
    // --- serialization: the second of two racing optimistic updates conflicts ---
    step("racing optimistic updates", (storage) => {
      const bump = cs.mutation({
        args: { expected: v.integer() },
        handler: ({ db }, { expected }) =>
          Effect.gen(function* () {
            const doc = yield* db.get("items", "id-3");
            if (doc!._version !== expected) {
              return yield* new RuleError({ rule: "conflict", detail: "stale" });
            }
            yield* Effect.yieldNow();
            yield* db.patch("items", "id-3", { rank: doc!.rank + 1 });
            return (yield* db.get("items", "id-3"))!._version;
          }),
      });
      return Effect.all([1, 1, 2].map((expected) => outcome(storage.mutation(bump, { expected }))), {
        concurrency: "unbounded",
      });
    }),
    // --- the handler boundary ---
    step("argument parsing", (storage) =>
      Effect.all([
        outcome(storage.mutation(withArgs, { n: 1, label: "ok" })),
        outcome(storage.mutation(withArgs, { n: "1", label: null })),
        outcome(storage.mutation(withArgs, { n: 1, label: null, extra: true })),
        outcome(storage.mutation(withArgs, null)),
      ])),
    step("a query is not a mutation", (storage) => storage.mutation(query, {})),
    // --- the end state, through the API ---
    step("final count", mutate((db) => db.find("items").count())),
    step("final countBy", mutate((db) => db.find("items").countBy("kind"))),
  ];
}

/** The final contents through the public API: every table, by `_id`. */
const finalContents = cs.mutation({
  args: {},
  handler: ({ db }) =>
    Effect.all({
      items: db.find("items").limit(1000).collect(),
      notes: db.find("notes").limit(1000).collect(),
    }),
});

interface ScriptRun {
  readonly steps: readonly { readonly name: string; readonly outcome: Outcome }[];
  readonly contents: unknown;
}

/** Runs the script from `T0`, recording every step's outcome, then reads the final contents. */
function runScript(storage: StorageService): Effect.Effect<ScriptRun> {
  return Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const steps: { name: string; outcome: Outcome }[] = [];
    for (const { name, run } of conformanceScript()) {
      steps.push({ name, outcome: yield* outcome(run(storage)) });
    }
    const contents = yield* Effect.orDie(storage.mutation(finalContents, {}));
    return { steps, contents };
  });
}

/** Deep equality, step by step (so a failure names the first divergent step), then of the contents. */
function assertConforms(actual: ScriptRun, expected: ScriptRun, label: string): void {
  assert.equal(actual.steps.length, expected.steps.length);
  for (let i = 0; i < expected.steps.length; i++) {
    assert.deepStrictEqual(
      actual.steps[i],
      expected.steps[i],
      `${label}: step ${i + 1} "${expected.steps[i].name}" diverged`,
    );
  }
  assert.deepStrictEqual(actual.contents, expected.contents, `${label}: final contents diverged`);
}

for (const layout of ["columns", "json"] as const) {
  runTest(
    `conformance (${layout}): StorageTest matches StorageLive step for step`,
    Effect.gen(function* () {
      const live = yield* runScript((yield* openLive(layout, conformanceSchema)).storage);
      const { storage, store } = yield* openTest(layout, conformanceSchema);
      const double = yield* runScript(storage);
      assert.ok(live.steps.length >= 30);
      assertConforms(double, live, `StorageTest vs StorageLive (${layout})`);
      // The double's raw store agrees with what its own API reported.
      assert.deepStrictEqual(yield* store.dump, live.contents);
    }),
    { skip: needsSqlite },
  );
}

/** A `Storage` whose results all claim `_version: 1` — a double that forgot to bump versions. */
function forgetsVersions(storage: StorageService): StorageService {
  const flatten = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(flatten) : value && typeof value === "object"
      ? Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, k === "_version" ? 1 : flatten(v)]),
      )
      : value;
  return {
    ...storage,
    mutation: (definition, args) => Effect.map(storage.mutation(definition, args), flatten),
  };
}

runTest(
  "conformance: the script is deterministic and a divergent double is caught",
  Effect.gen(function* () {
    const first = yield* runScript((yield* openTest("columns", conformanceSchema)).storage);
    const second = yield* runScript((yield* openTest("columns", conformanceSchema)).storage);
    assertConforms(second, first, "StorageTest vs itself");
    const broken = yield* runScript(forgetsVersions((yield* openTest("columns", conformanceSchema)).storage));
    assert.throws(() => assertConforms(broken, first, "mutant"), /diverged/);
  }),
);

// ===========================================================================
// The doubles themselves
// ===========================================================================

runTest(
  "StorageTest: ids from IdGen, _creationTime from TestClock",
  Effect.gen(function* () {
    const { call, inspect } = caller(yield* Storage);
    yield* TestClock.setTime(T0);
    yield* call("createGame", { xPlayer: "a", oPlayer: "b" });
    yield* TestClock.adjust("1 minute");
    yield* call("createGame", { xPlayer: "c", oPlayer: "d" });
    const { games } = yield* inspect;
    assert.deepEqual(games.map((g) => [g._id, g._creationTime]), [["id-1", T0], ["id-2", T0 + 60_000]]);
  }),
  { layer: StorageTest({ schema }) },
);

const getGame = functions.getGame;

runTest(
  "ReaderTest: reads what StorageTest committed, never what it has not",
  Effect.gen(function* () {
    const storage = yield* Storage;
    const reader = yield* Reader;
    const { gameId } = yield* caller(storage).call("createGame", { xPlayer: "a", oPlayer: "b" });
    const game = (yield* reader.query(getGame, { gameId })) as { xPlayer: string; _version: number };
    assert.equal(game.xPlayer, "a");
    assert.equal(game._version, 1);
    assert.deepEqual(yield* reader.query(functions.winsByMark, {}), []);

    // A mutation parked mid-transaction: its write is invisible until it commits.
    const parked = yield* Deferred.make<void>();
    const written = yield* Deferred.make<void>();
    const slow = defineFunctions(schema).mutation({
      args: {},
      handler: ({ db }) =>
        Effect.gen(function* () {
          yield* db.patch("games", gameId, { xPlayer: "pending" });
          yield* Deferred.succeed(written, undefined);
          yield* Deferred.await(parked);
        }),
    });
    const fiber = yield* Effect.fork(storage.mutation(slow, {}));
    yield* Deferred.await(written);
    const during = (yield* reader.query(getGame, { gameId })) as { xPlayer: string };
    assert.equal(during.xPlayer, "a");
    yield* Deferred.succeed(parked, undefined);
    yield* Fiber.join(fiber);
    const after = (yield* reader.query(getGame, { gameId })) as { xPlayer: string; _version: number };
    assert.equal(after.xPlayer, "pending");
    assert.equal(after._version, 2);

    const writer = defineFunctions(schema).query({
      args: {},
      handler: ({ db }) => (db as unknown as WriteDB<typeof schema>).delete("games", gameId),
    });
    const refused = yield* failureOf(reader.query(writer, {}));
    assert.ok(refused instanceof QueryWriteAttemptError);
    assert.equal(refused.operation, "delete");
    const wrongKind = yield* failureOf(reader.query(functions.createGame, { xPlayer: "x", oPlayer: "y" }));
    assert.ok(wrongKind instanceof HandlerKindMismatch);
  }),
  { layer: DocumentStoreTest({ schema }) },
);

runTest(
  "StorageTest: a leaked db handle expires with its transaction",
  Effect.gen(function* () {
    const storage = yield* Storage;
    let leaked: WriteDB<typeof schema> | undefined;
    const leak = defineFunctions(schema).mutation({
      args: {},
      handler: ({ db }) => Effect.sync(() => void (leaked = db)),
    });
    yield* storage.mutation(leak, {});
    const expired = yield* failureOf(leaked!.find("games").collect());
    assert.ok(expired instanceof ContextExpiredError);
    assert.equal(expired.context, "mutation");
  }),
  { layer: StorageTest({ schema }) },
);

runTest(
  "ObjectStoreTest: copies bytes, validates keys, injects failures",
  Effect.gen(function* () {
    const objects = yield* ObjectStore;
    const control = yield* ObjectStoreTestControl;
    const bytes = new Uint8Array([1, 2, 3]);
    yield* objects.put("backups/a.sqlite", bytes);
    bytes[0] = 9;
    const read = yield* objects.get("backups/a.sqlite");
    assert.deepEqual([...read], [1, 2, 3]);
    read[0] = 9;
    assert.deepEqual([...(yield* objects.get("backups/a.sqlite"))], [1, 2, 3]);

    const invalid = yield* failureOf(objects.put("../escape", bytes));
    assert.equal((invalid as { reason?: string }).reason, "parent-traversal");
    const missing = yield* failureOf(objects.get("nope"));
    assert.ok(missing instanceof ObjectStoreError);
    assert.equal(missing.status, 404);

    yield* control.failNext({ operation: "put", key: /latest\.json$/ });
    const injected = yield* failureOf(objects.put("app/latest.json", bytes));
    assert.ok(injected instanceof ObjectStoreError);
    assert.deepEqual(yield* control.keys, ["backups/a.sqlite"]);
    yield* objects.put("app/latest.json", bytes);
    assert.deepEqual(yield* control.keys, ["app/latest.json", "backups/a.sqlite"]);

    yield* control.intercept((operation) =>
      operation === "get" ? new ObjectStoreError({ operation, key: "x", detail: "intercepted" }) : Effect.void
    );
    assert.equal(
      ((yield* failureOf(objects.get("app/latest.json"))) as ObjectStoreError).detail,
      "intercepted",
    );
    assert.equal((yield* control.calls).length, 7);
  }),
);

runTest(
  "EventSinkTest: records every event, queryable by kind",
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const envelope = {
      eventId: "e",
      ts: new Date(0).toISOString(),
      level: "info" as const,
      role: "server" as const,
      pid: 1,
      traceId: "t",
    };
    yield* sink.emit(
      txEvent({
        ...envelope,
        engine: "sqlite",
        outcome: "commit",
        operations: 2,
        durationMs: 1,
        queueWaitMs: 0,
      }),
    );
    yield* sink.emit(sqlEvent({
      ...envelope,
      engine: "sqlite",
      dialect: "sqlite",
      statementKind: "select",
      sqlText: "SELECT 1",
      bindCount: 0,
      durationMs: 1,
      outcome: "ok",
    }));
    const tx = yield* eventsOfKind("tx");
    assert.equal(tx.length, 1);
    assert.equal(tx[0].outcome, "commit");
    assert.equal((yield* eventsOfKind("sql"))[0].sqlText, "SELECT 1");
    assert.equal((yield* eventsWhere((e) => e.level === "info")).length, 2);
  }),
);

runTest(
  "IdGenTest: id-1, id-2, … restarting per layer build",
  Effect.gen(function* () {
    const ids = yield* IdGen;
    assert.deepEqual([yield* ids.next, yield* ids.next], ["id-1", "id-2"]);
    const fresh = yield* Effect.provide(Effect.flatMap(IdGen, (g) => g.next), IdGenTest);
    assert.equal(fresh, "id-1");
  }),
);
