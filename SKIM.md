# Skim the document-platform MVP

The app author writes TypeScript document operations. The SDK records operations; the platform compiles them. No app handler supplies SQL.

Two long-lived processes share each app's local SQLite file: the API/SQLite writer and a DuckDB query worker. The writer also runs an optional backup timer.

**Verification:** 20 core tests passed using Node's real SQLite adapter. Core TypeScript passed strict checking. The Deno server, native DuckDB execution, end-to-end integration test, and S3 upload were not run in this environment. See README.md for exact commands and limits.

## 1. App schema — app/schema.ts

```ts
import { defineSchema, defineTable, v } from "../sdk/schema.ts";
export const mark = v.enum("X", "O");

export const schema = defineSchema({
  games: defineTable({
    xPlayer: v.string(),
    oPlayer: v.string(),
    board: v.array(v.nullable(mark), 9),
    turn: mark,
    status: v.enum("playing", "won", "draw"),
    winner: v.nullable(mark),
  }).index("by_status", ["status"]),

  moves: defineTable({
    gameId: v.string(),
    playerId: v.string(),
    mark,
    cell: v.integer(),
    moveNumber: v.integer(),
  }).index("by_game", ["gameId", "moveNumber"]),
});
```

## 2. App handlers — app/functions.ts

The application contains the game rules, but no database-specific code. Reads inside mutations use the mutation's SQLite transaction; public query handlers receive the DuckDB adapter.

```ts
// Application code: no SQL, database drivers, file paths, or storage-mode branches.
import { defineFunctions } from "../sdk/functions.ts";
import { v } from "../sdk/schema.ts";
import { schema } from "./schema.ts";
const { query, mutation } = defineFunctions(schema);
const lines = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6],
];

export const functions = {
  createGame: mutation({
    args: { xPlayer: v.string(), oPlayer: v.string() },
    async handler({ db }, { xPlayer, oPlayer }) {
      if (!xPlayer.trim() || !oPlayer.trim() || xPlayer === oPlayer) {
        throw new Error("Provide two distinct players");
      }
      const gameId = await db.insert("games", {
        xPlayer, oPlayer, board: Array(9).fill(null),
        turn: "X", status: "playing", winner: null,
      });
      return { gameId };
    },
  }),

  makeMove: mutation({
    args: { gameId: v.string(), playerId: v.string(), cell: v.integer(), expectedVersion: v.integer() },
    async handler({ db }, { gameId, playerId, cell, expectedVersion }) {
      // Although this is a read, it uses SQLite because we're inside a mutation.
      const game = await db.get("games", gameId);
      if (!game) throw new Error("Game not found");
      if (game._version !== expectedVersion) throw new Error("Stale version; reload the game");
      if (game.status !== "playing") throw new Error("Game is over");
      const expectedPlayer = game.turn === "X" ? game.xPlayer : game.oPlayer;
      if (playerId !== expectedPlayer) throw new Error("Not your turn");
      if (cell < 0 || cell > 8 || game.board[cell] !== null) throw new Error("Invalid move");

      const board = [...game.board];
      board[cell] = game.turn;
      const won = lines.some(([a, b, c]) => board[a] === game.turn && board[b] === game.turn && board[c] === game.turn);
      const status = won ? "won" : board.every((x) => x !== null) ? "draw" : "playing";

      await db.patch("games", gameId, {
        board, status, winner: won ? game.turn : null,
        turn: game.turn === "X" ? "O" : "X",
      });
      await db.insert("moves", {
        gameId, playerId, mark: game.turn, cell,
        moveNumber: board.filter((x) => x !== null).length,
      });
      // Board update + move insertion + this read all share one SQLite transaction.
      return await db.get("games", gameId);
    },
  }),

  getGame: query({
    args: { gameId: v.string() },
    handler: ({ db }, { gameId }) => db.get("games", gameId),
  }),

  listGames: query({
    args: { status: v.enum("playing", "won", "draw") },
    handler: ({ db }, { status }) => db.find("games", { status })
      .sort("_creationTime", "desc").limit(20).collect(),
  }),

  moveHistory: query({
    args: { gameId: v.string() },
    handler: ({ db }, { gameId }) => db.find("moves", { gameId })
      .sort("moveNumber").limit(9).collect(),
  }),

  winsByMark: query({
    args: {},
    // Compiles to a filtered GROUP BY + COUNT in DuckDB, not JS aggregation.
    handler: ({ db }) => db.find("games", { status: "won" }).countBy("winner"),
  }),

  deleteGame: mutation({
    args: { gameId: v.string() },
    async handler({ db }, { gameId }) {
      if (!await db.get("games", gameId)) throw new Error("Game not found");
      for (const move of await db.find("moves", { gameId }).limit(9).collect()) {
        await db.delete("moves", move._id);
      }
      await db.delete("games", gameId);
      return { deleted: true };
    },
  }),
};
```

## 3. Typed client — scripts/demo.ts

```ts
import { createClient } from "../sdk/client.ts";
import type { functions } from "../app/functions.ts";
const base = Deno.env.get("BASE_URL") ?? "http://127.0.0.1:8000";
const app = Deno.args[0] ?? "tic-tac-toe";
const client = createClient<typeof functions>(base, app, Deno.env.get("TOKEN") ?? "dev-only");
const { gameId } = await client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
console.log("Created:", gameId);
let game = await client.query("getGame", { gameId });
for (const [playerId, cell] of [["alice", 0], ["bob", 3], ["alice", 1], ["bob", 4], ["alice", 2]] as const) {
  game = await client.mutation("makeMove", { gameId, playerId, cell, expectedVersion: game!._version });
}
console.log("Game:", await client.query("getGame", { gameId }));
console.log("Moves:", await client.query("moveHistory", { gameId }));
console.log("Wins:", await client.query("winsByMark", {}));
console.log("Won games:", await client.query("listGames", { status: "won" }));
```

## 4. Query API to plan — sdk/db.ts, excerpts

Each chained method creates a new plan. collect/first/count/countBy execute it. The full file includes typing, validation, additional methods, and writes.

```ts
export type Filter = { field: string; op: "eq" | "gt"; value: unknown };
export type SelectPlan = {
  kind: "select";
  table: string;
  filters: Filter[];
  order?: { field: string; direction: "asc" | "desc" };
  limit: number;
  aggregate?: { kind: "count" } | { kind: "countBy"; field: string };
};

export class Find<T> {
  constructor(private execute: Execute, readonly plan: SelectPlan) {}
  where<K extends ScalarKey<T>>(field: K, value: T[K]): Find<T> {
    return new Find(this.execute, { ...this.plan, filters: [...this.plan.filters, { field, op: "eq", value }] });
  }
  // ... sort and limit create modified copies of this same plan ...
  async collect(): Promise<T[]> { return await this.execute(this.plan) as T[]; }
}
```

## 5. Plan to SQL — platform/compiler.ts, excerpt

This is platform code, not app code. The remaining compiler helpers handle schema metadata, JSON extraction/casts, bound values, DDL, writes, and row decoding.

```ts
export function compileSelect(schema: Schema, plan: SelectPlan, dialect: Dialect): SQL {
  const table = tableFor(schema, plan.table);
  if (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 1000) throw new Error("Invalid limit");
  const values: Bind[] = [];
  const bind = (value: Bind) => { values.push(value); return dialect === "sqlite" ? "?" : `$p${values.length}`; };
  const where = plan.filters.map((filter) => {
    const node = scalar(table, filter.field);
    validate(node, filter.value, filter.field);
    const expr = expression(table, filter.field, dialect);
    if (filter.op === "eq" && filter.value === null) return `${expr} IS NULL`;
    if (filter.op !== "eq" && filter.op !== "gt") throw new Error("Unsupported operator");
    if (filter.op === "gt" && (filter.value === null || !["integer", "number"].includes(node.kind))) {
      throw new Error("gt requires a non-null numeric field and value");
    }
    return `${expr} ${filter.op === "eq" ? "=" : ">"} ${bind(encode(node, filter.value))}`;
  });
  const target = dialect === "duckdb" ? `"app".${quote(plan.table)}` : quote(plan.table);
  let projection = "*";
  if (plan.aggregate?.kind === "count") projection = 'COUNT(*) AS "count"';
  if (plan.aggregate?.kind === "countBy") {
    projection = `${expression(table, plan.aggregate.field, dialect)} AS "value", COUNT(*) AS "count"`;
  }
  let text = `SELECT ${projection} FROM ${target}`;
  if (where.length) text += ` WHERE ${where.join(" AND ")}`;
  if (plan.aggregate?.kind === "countBy") text += ' GROUP BY 1 ORDER BY "value" ASC NULLS FIRST';
  else if (!plan.aggregate) {
    if (plan.order) {
      if (!["asc", "desc"].includes(plan.order.direction)) throw new Error("Invalid ordering");
      const { field, direction } = plan.order;
      text += ` ORDER BY ${expression(table, field, dialect)} ${direction.toUpperCase()} NULLS ${direction === "asc" ? "FIRST" : "LAST"}, "_id" ASC`;
    } else text += ' ORDER BY "_id" ASC';
  }
  // count counts all matching documents; countBy limits returned groups, not input rows.
  if (plan.aggregate?.kind !== "count") text += ` LIMIT ${bind(plan.limit)}`;
  return { text, values };
}

```

## 6. SQLite mutation boundary — platform/sqlite.ts, excerpt

The exclusive queue prevents asynchronous handlers from interleaving on the same SQLite connection. All document operations inside the handler use this transaction.

```ts
  async mutation(definition: AnyDefinition, args: unknown): Promise<unknown> {
    if (definition.kind !== "mutation") throw new Error("Expected a mutation");
    return await this.exclusive(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      let active = true;
      const documents = new Documents<S>(async (op) => {
        if (!active) throw new Error("Transaction context has expired");
        return this.execute(op);
      });
      try {
        const result = await definition.invoke(documents, args);
        // Catch non-JSON results before committing; transport cannot serialize them later.
        const safeResult = JSON.parse(JSON.stringify(result ?? null));
        this.database.exec("COMMIT");
        return safeResult;
      } catch (e) {
        this.database.exec("ROLLBACK");
        throw e;
      } finally { active = false; }
    });
  }
```

## 7. DuckDB execution — platform/duckdb.ts

This module is only loaded in the reader OS process. It attaches the live SQLite file read-only; it does not create a second persistent database.

```ts
// Reader process ONLY. It deliberately never imports node:sqlite.
import { DuckDBInstance, type DuckDBConnection } from "npm:@duckdb/node-api@1.5.6";
import { Documents } from "../sdk/db.ts";
import type { Schema } from "../sdk/schema.ts";
import type { AnyDefinition } from "../sdk/functions.ts";
import { compileSelect, decode, literal, type SQL } from "./compiler.ts";
// Keep this type local: do NOT import the SQLite module merely for its logger.
type Trace = (engine: "sqlite" | "duckdb", sql: SQL) => void;

export class DuckReader<S extends Schema> {
  private constructor(
    private instance: DuckDBInstance,
    private connection: DuckDBConnection,
    private schema: S,
    private trace: Trace,
  ) {}
  static async open<S extends Schema>(file: string, schema: S, trace: Trace = () => {}): Promise<DuckReader<S>> {
    const instance = await DuckDBInstance.create(":memory:", { threads: "2", memory_limit: "256MB" });
    const connection = await instance.connect();
    try {
      await connection.run("INSTALL sqlite");
      await connection.run("LOAD sqlite");
      await connection.run(`ATTACH ${literal(file)} AS "app" (TYPE SQLITE, READ_ONLY)`);
      return new DuckReader(instance, connection, schema, trace);
    } catch (e) { connection.closeSync(); instance.closeSync(); throw e; }
  }
  // The worker serializes whole query handlers: never share an active transaction.
  async query(definition: AnyDefinition, args: unknown): Promise<unknown> {
    if (definition.kind !== "query") throw new Error("Expected a query");
    await this.connection.run("BEGIN TRANSACTION");
    let active = true;
    const db = new Documents<S>(async (operation) => {
      if (!active) throw new Error("Query context has expired");
      if (operation.kind !== "select") throw new Error("Queries cannot write");
      const sql = compileSelect(this.schema, operation, "duckdb");
      this.trace("duckdb", sql);
      const parameters = Object.fromEntries(sql.values.map((value, i) => [`p${i + 1}`, value]));
      const reader = await this.connection.runAndReadAll(sql.text, parameters);
      return decode(this.schema, operation, reader.getRowObjects());
    });
    try {
      const result = await definition.invoke(db, args);
      const safeResult = JSON.parse(JSON.stringify(result ?? null));
      await this.connection.run("COMMIT");
      return safeResult;
    } catch (e) {
      await this.connection.run("ROLLBACK");
      throw e;
    } finally { active = false; }
  }
  close(): void { this.connection.closeSync(); this.instance.closeSync(); }
}
```

## 8. Object-storage backup

`platform/backup.ts` obtains a consistent `VACUUM INTO` snapshot, checks integrity, computes a checksum, uploads an immutable object, and only then advances a latest manifest. `platform/object_store.ts` supplies a local stand-in or a signed S3-compatible adapter. `scripts/restore.ts` verifies a snapshot and restores to a fresh, absent file while the service is stopped.

A mutation response acknowledges local commit, not off-host replication. A backup is not automatic failover.

## Run

```sh
TRACE_SQL=1 deno task serve
# In another terminal:
deno task demo
deno task demo tic-tac-toe-json
deno task explain
deno task test
deno task check
deno task integration
```

See README.md for all configuration, security limits, object-storage settings, source references, and restore instructions.
