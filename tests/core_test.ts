import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { SQLiteWriter } from "../platform/sqlite.ts";
import { compileDDL, compileSelect, decode } from "../platform/compiler.ts";
import { defineFunctions } from "../sdk/functions.ts";
import { Documents } from "../sdk/db.ts";
import { v, withStorage, type Storage } from "../sdk/schema.ts";
import { schema } from "../app/schema.ts";
import { functions } from "../app/functions.ts";
import type { ArgsOf, Names, ResultOf } from "../sdk/functions.ts";

// Handlers are Effects since item 10, so the three ad-hoc definitions in this file are
// `Effect.gen` bodies. Every assertion below is untouched; item 20 ports the file to the Effect
// test runner and the test layers.
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
async function fixture(storage: Storage, run: (ctx: {
  writer: SQLiteWriter<typeof schema>;
  dir: string;
  file: string;
  call: <N extends Names<typeof functions, "mutation">>(name: N, args: ArgsOf<typeof functions[N]>) => Promise<ResultOf<typeof functions[N]>>;
  inspect: () => Promise<ResultOf<typeof inspector>>;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "document-db-test-"));
  const file = join(dir, "app.sqlite");
  let id = 0;
  const writer = new SQLiteWriter(file, withStorage(schema, storage), undefined, () => 1_700_000_000_000, () => `id-${++id}`);
  try {
    await run({
      writer, dir, file,
      call: async (name, args) => await writer.mutation(functions[name], args) as never,
      inspect: async () => await writer.mutation(inspector, {}) as ResultOf<typeof inspector>,
    });
  } finally { await writer.close(); rmSync(dir, { recursive: true, force: true }); }
}

for (const storage of ["columns", "json"] as const) {
  test(`${storage}: create, complete game, aggregate wins, delete`, async () => {
    await fixture(storage, async ({ call, inspect }) => {
      const { gameId } = await call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      let version = 1;
      for (const [playerId, cell] of [["alice", 0], ["bob", 3], ["alice", 1], ["bob", 4], ["alice", 2]] as const) {
        const game = await call("makeMove", { gameId, playerId, cell, expectedVersion: version++ });
        assert.equal(game!._version, version);
      }
      const state = await inspect();
      assert.equal(state.games[0].status, "won");
      assert.equal(state.games[0].winner, "X");
      assert.deepEqual(state.wins, [{ value: "X", count: 1 }]);
      assert.equal(state.moves.length, 5);
      assert.equal(state.count, 1);
      await assert.rejects(call("makeMove", { gameId, playerId: "bob", cell: 5, expectedVersion: 6 }), /Game is over/);
      await call("deleteGame", { gameId });
      assert.equal((await inspect()).count, 0);
      assert.equal((await inspect()).moves.length, 0);
    });
  });

  test(`${storage}: two competing moves cannot both commit`, async () => {
    await fixture(storage, async ({ call, inspect }) => {
      const { gameId } = await call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      const results = await Promise.allSettled([0, 1].map((cell) => call("makeMove", {
        gameId, playerId: "alice", cell, expectedVersion: 1,
      })));
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      const state = await inspect();
      assert.equal(state.games[0].board.filter((x) => x !== null).length, 1);
      assert.equal(state.moves.length, 1);
      assert.equal(state.games[0]._version, 2);
    });
  });

  test(`${storage}: rollback restores board, version, and move history`, async () => {
    await fixture(storage, async ({ writer, call, inspect }) => {
      const { gameId } = await call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      const broken = defineFunctions(schema).mutation({
        args: { gameId: v.string() },
        handler: ({ db }, { gameId }) =>
          Effect.gen(function* () {
            yield* db.patch("games", gameId, { board: ["X", null, null, null, null, null, null, null, null] });
            yield* db.insert("moves", { gameId, playerId: "alice", mark: "X", cell: 0, moveNumber: 1 });
            return yield* Effect.fail(new Error("Injected failure after both writes"));
          }),
      });
      await assert.rejects(writer.mutation(broken, { gameId }), /Injected failure/);
      const state = await inspect();
      assert.deepEqual(state.games[0].board, Array(9).fill(null));
      assert.equal(state.games[0]._version, 1);
      assert.equal(state.moves.length, 0);
    });
  });

  test(`${storage}: invalid arguments and illegal moves are rejected`, async () => {
    await fixture(storage, async ({ writer, call, inspect }) => {
      await assert.rejects(writer.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b", extra: true }), /Unknown field/);
      const { gameId } = await call("createGame", { xPlayer: "a", oPlayer: "b" });
      await assert.rejects(call("makeMove", { gameId, playerId: "b", cell: 0, expectedVersion: 1 }), /Not your turn/);
      await assert.rejects(call("makeMove", { gameId, playerId: "a", cell: 10, expectedVersion: 1 }), /Invalid move/);
      await assert.rejects(call("makeMove", { gameId, playerId: "a", cell: 0.5, expectedVersion: 1 }), /expected integer/);
      assert.equal((await inspect()).games[0]._version, 1);
    });
  });

  test(`${storage}: quote-bearing strings stay data, not SQL`, async () => {
    await fixture(storage, async ({ writer, call }) => {
      const value = "O'Reilly'); DROP TABLE games; --";
      await call("createGame", { xPlayer: value, oPlayer: "bob" });
      const find = defineFunctions(schema).mutation({
        args: { xPlayer: v.string() },
        handler: ({ db }, { xPlayer }) => db.find("games", { xPlayer }).collect(),
      });
      const rows = await writer.mutation(find, { xPlayer: value }) as ResultOf<typeof find>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].xPlayer, value);
    });
  });

  test(`${storage}: standalone backup includes uncheckpointed WAL commits`, async () => {
    await fixture(storage, async ({ writer, call, dir, file }) => {
      await call("createGame", { xPlayer: "alice", oPlayer: "bob" });
      assert.ok(existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > 0);
      const backup = join(dir, "backup.sqlite");
      await writer.snapshot(backup);
      const db = new DatabaseSync(backup, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get()!.n, 1);
        assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
      } finally { db.close(); }
    });
  });

  test(`${storage}: schema drift fails rather than silently migrating`, async () => {
    await fixture(storage, async ({ file }) => {
      const changed = withStorage(schema, storage === "json" ? "columns" : "json");
      assert.throws(() => new SQLiteWriter(file, changed), /refuses automatic migration/);
    });
  });
}

test("each app file has its own data, even when IDs collide", async () => {
  await fixture("columns", async (a) => {
    await fixture("columns", async (b) => {
      const first = await a.call("createGame", { xPlayer: "a", oPlayer: "b" });
      const second = await b.call("createGame", { xPlayer: "c", oPlayer: "d" });
      assert.equal(first.gameId, second.gameId);
      assert.equal((await a.inspect()).games[0].xPlayer, "a");
      assert.equal((await b.inspect()).games[0].xPlayer, "c");
    });
  });
});

test("same logical plan generates both dialects and both storage layouts", async () => {
  let plan: import("../sdk/db.ts").SelectPlan | undefined;
  const db = new Documents<typeof schema>((op) =>
    Effect.sync(() => {
      assert.equal(op.kind, "select");
      plan = op as import("../sdk/db.ts").SelectPlan;
      return [];
    })
  );
  await Effect.runPromise(
    db.find("games", { status: "playing" }).sort("_creationTime", "desc").limit(20).collect(),
  );
  const columnSQL = compileSelect(schema, plan!, "duckdb");
  const jsonSQL = compileSelect(withStorage(schema, "json"), plan!, "duckdb");
  const sqliteSQL = compileSelect(withStorage(schema, "json"), plan!, "sqlite");
  assert.match(columnSQL.text, /FROM "app"\."games" WHERE "status" = \$p1/);
  assert.match(jsonSQL.text, /json_extract_string\("doc", '\$\.status'\)/);
  assert.match(sqliteSQL.text, /json_extract\("doc", '\$\.status'\)/);
  assert.deepEqual(columnSQL.values, ["playing", 20]);
  assert.deepEqual(jsonSQL.values, columnSQL.values);
});

test("array predicates and unknown fields fail instead of falling back to JS scans", () => {
  const base = { kind: "select" as const, table: "games", limit: 20 };
  assert.throws(() => compileSelect(schema, { ...base, filters: [{ field: "board", op: "eq", value: [] }] }, "duckdb"), /Array predicates/);
  assert.throws(() => compileSelect(schema, { ...base, filters: [{ field: "notAField", op: "eq", value: "x" }] }, "sqlite"), /Unknown field/);
});

test("JSON numeric queries cast extracted values; null uses IS NULL", () => {
  const json = withStorage(schema, "json");
  const numeric = compileSelect(json, {
    kind: "select", table: "moves", limit: 9, filters: [{ field: "moveNumber", op: "gt", value: 3 }],
  }, "duckdb");
  assert.match(numeric.text, /CAST\(json_extract_string\("doc", '\$\.moveNumber'\) AS BIGINT\) > \$p1/);
  const nullable = compileSelect(json, {
    kind: "select", table: "games", limit: 20, filters: [{ field: "winner", op: "eq", value: null }],
  }, "duckdb");
  assert.match(nullable.text, /IS NULL/);
  assert.deepEqual(nullable.values, [20]);
});

test("decoder normalizes DuckDB BIGINT results to safe JS numbers", () => {
  const plan = { kind: "select" as const, table: "games", filters: [], limit: 20 };
  const rows = decode(schema, plan, [{
    _id: "g", _creationTime: 1700000000000n, _version: 1n,
    xPlayer: "alice", oPlayer: "bob", board: JSON.stringify(Array(9).fill(null)),
    turn: "X", status: "playing", winner: null,
  }]) as { _creationTime: number; board: unknown[] }[];
  assert.equal(typeof rows[0]._creationTime, "number");
  assert.equal(rows[0].board.length, 9);
});

test("schema compiler emits indexes for either physical layout", () => {
  assert.match(compileDDL(schema).join("\n"), /"status" TEXT NOT NULL/);
  const json = compileDDL(withStorage(schema, "json")).join("\n");
  assert.match(json, /"doc" TEXT NOT NULL CHECK/);
  assert.match(json, /CREATE INDEX.*json_extract/);
});
