# Skim the Effect document database

These excerpts are copied from the landed source at `643b706`. Omitted sections are described in prose, not
rewritten as alternate implementations. See [README.md](README.md) for configuration and verification.

## Application schema and handler

Source: [app/schema.ts](app/schema.ts).

<!-- deno-fmt-ignore -->
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

The schema remains TypeScript data. Mutations compose document operations as effects; the following member
belongs to the exported functions object, not a separate Promise-based handler.

Source: [app/functions.ts](app/functions.ts).

<!-- deno-fmt-ignore -->
```ts
  createGame: mutation({
    args: { xPlayer: v.string(), oPlayer: v.string() },
    handler: ({ db }, { xPlayer, oPlayer }) =>
      Effect.gen(function* () {
        yield* validatePlayers(xPlayer, oPlayer);
        const gameId = yield* db.insert("games", {
          xPlayer,
          oPlayer,
          board: Array(9).fill(null),
          turn: "X",
          status: "playing",
          winner: null,
        });
        return { gameId };
      }),
  }),
```

## Document operations describe effects

Source: [sdk/db.ts](sdk/db.ts).

<!-- deno-fmt-ignore -->
```ts
export type Operation =
  | SelectPlan
  | { kind: "insert"; table: string; value: unknown }
  | { kind: "patch"; table: string; id: string; value: unknown }
  | { kind: "delete"; table: string; id: string };
export type Execute = (operation: Operation) => Effect.Effect<unknown, DbError>;
```

## A terminal read returns a typed Effect

Source: [sdk/db.ts](sdk/db.ts).

<!-- deno-fmt-ignore -->
```ts
collect(): Effect.Effect<T[], DbError> {
  return Effect.map(this.execute(this.plan), (rows) => rows as T[]);
}
first(): Effect.Effect<T | null, DbError> {
  return Effect.map(this.limit(1).collect(), (rows) => rows[0] ?? null);
}
```

## Pure compilation reports typed errors

Source: [core/compile/select.ts](core/compile/select.ts).

<!-- deno-fmt-ignore -->
```ts
export function tableFor(schema: Schema, name: string): Either.Either<Table, CompileError> {
  if (!Object.hasOwn(schema, name)) {
    return Either.left(new CompileError({ reason: "unknown-collection", table: name }));
  }
  return Either.right(schema[name]);
}
```

`compileSelect` in the same file normalizes the plan and returns `Either<SQL, CompileError | SchemaError>`.
The compiler returns SQL text with bound values; the platform lifts the Either into its Effect channel.
`GENERATED_SQL.txt` shows actual output for both layouts and dialects.

## Mutation transactions have scoped rollback

Source: [platform/sqlite.ts](platform/sqlite.ts).

<!-- deno-fmt-ignore -->
```ts
    const transaction = <A, E>(
      queueWaitMs: number,
      use: (tx: Tx) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | StorageError> =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          const startedNanos = nanos();
          try {
            database.exec("BEGIN IMMEDIATE");
          } catch (cause) {
            return Effect.fail(new StorageError({ operation: "begin", detail: messageOf(cause), cause }));
          }
          const tx: Tx = { active: true, committed: false, operations: 0, startedNanos, queueWaitMs };
          return Effect.succeed(tx);
        }),
        (tx) =>
          Effect.flatMap(use(tx), (result) =>
            Effect.suspend(() => {
              // Expire in the same step as COMMIT: the release runs later, after a possible yield.
              tx.active = false;
              try {
                database.exec("COMMIT");
              } catch (cause) {
                return Effect.fail(
                  new StorageError({ operation: "commit", detail: messageOf(cause), cause }),
                );
              }
              tx.committed = true;
              return Effect.succeed(result);
            })),
        (tx, exit) =>
          Effect.suspend(() => {
            tx.active = false;
            let rollbackFailure: unknown;
            if (!tx.committed && database.isTransaction) {
              try {
                database.exec("ROLLBACK");
              } catch (cause) {
                rollbackFailure = cause;
              }
            }
            const outcome: TxOutcome = tx.committed
              ? "commit"
              : Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)
              ? "interrupted"
              : "rollback";
            const columns = Exit.isFailure(exit) ? errorColumns(exit.cause) : {};
            const emitted = Effect.flatMap(envelope(outcome === "interrupted" ? "warn" : "info"), (env) =>
              sink.emit(txEvent({
                ...env,
                engine: "sqlite",
                outcome,
                operations: tx.operations,
                durationMs: msSince(tx.startedNanos),
                queueWaitMs: tx.queueWaitMs,
                ...columns,
              })));
            // A connection still inside a transaction would poison every later job: fail loudly.
            return rollbackFailure !== undefined && database.isTransaction
              ? Effect.zipRight(
                emitted,
                Effect.die(
                  new StorageError({
                    operation: "rollback",
                    detail: messageOf(rollbackFailure),
                    cause: rollbackFailure,
                  }),
                ),
              )
              : emitted;
          }),
      );
```

The release callback expires the context, rolls back every uncommitted exit, emits the transaction event, and
reports rollback failures. A semaphore serializes the writer queue.

## Reader resources belong to a layer

Source: [platform/duckdb.ts](platform/duckdb.ts).

<!-- deno-fmt-ignore -->
```ts
export function ReaderLive(
  app: ReaderApp,
  driver: DuckDriver = duckDriver,
): Layer.Layer<Reader, ReaderError, Config | EventSink> {
  return Layer.scoped(Reader, makeReader(app, driver));
}
```

## Native handles register finalizers immediately

Source: [platform/duckdb.ts](platform/duckdb.ts).

<!-- deno-fmt-ignore -->
```ts
    const instance = yield* Effect.acquireRelease(
      native("open", () => driver.open()),
      (handle) => close("instance", handle),
    );
    // Registered after the instance, so it is released before it (finalizers run LIFO).
    const connection = yield* Effect.acquireRelease(
      native("open", () => instance.connect()),
      (handle) => close("connection", handle),
    );
    yield* native("open", () => connection.run("INSTALL sqlite"));
    yield* native("open", () => connection.run("LOAD sqlite"));
    yield* native(
      "attach",
      () => connection.run(`ATTACH ${literal(app.file)} AS "app" (TYPE SQLITE, READ_ONLY)`),
    );
```

`makeReader` acquires the instance before the connection, so LIFO release closes the connection first. It
attaches the live SQLite file read-only in the separate reader OS process. There is no static Promise
constructor or throwing compiler wrapper in these paths; pure SQL compilation lives in `core/compile/`.

## Run

```sh
deno task explain > GENERATED_SQL.txt
deno task ci
deno task integration
deno task e2e
```

All four commands are executed in item 27; results and operational examples are in the README.
