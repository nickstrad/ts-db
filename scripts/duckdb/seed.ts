/**
 * Seeds a real event log for the queries in this folder, from the landed Effect layers.
 *
 * `platform/server.ts` is not ported yet (item 22), so the HTTP server writes no JSONL. This script
 * stands in for it: it builds the writer-side stack the port will build (`LoggingLive`, per-app
 * `StorageLive` + `BackupsLive` over `ObjectStoreLocal`, `ReaderClientLive` spawning the real
 * `platform/reader.ts`) and drives a tic-tac-toe workload through it, including the error paths.
 * Then, in a second process (DuckDB stays out of the writer, ADR 0004), it runs `EventLogIngestLive`
 * over the resulting tree.
 *
 * ```sh
 * export DATA_DIR=/tmp/tsdb-seed/data LOG_DIR=/tmp/tsdb-seed/logs \
 *   LOCAL_OBJECT_DIR=/tmp/tsdb-seed/objects TRACE_SQL=true LOG_LEVEL=debug
 * deno run -A scripts/duckdb/seed.ts workload   # JSONL under $LOG_DIR/{server,reader}/
 * deno run -A scripts/duckdb/seed.ts ingest     # -> $DATA_DIR/eventlog.duckdb (EVENTLOG_DUCKDB)
 * ```
 *
 * http and handler events stay empty: nothing emits them until item 22 lands.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Effect, Layer } from "effect";
import { functions } from "../../app/functions.ts";
import { BackupsLive } from "../../platform/backup.ts";
import { ConfigLive } from "../../platform/config.ts";
import { EventLogIngestLive } from "../../platform/eventlog/ingest.ts";
import { ReaderClientLive } from "../../platform/ipc.ts";
import { LoggingLive, LoggingReaderLive } from "../../platform/logging/logger.ts";
import { ObjectStoreLocal } from "../../platform/object_store.ts";
import { loadApps } from "../../platform/registry.ts";
import { Backups, EventLogIngest, ReaderClient, Storage } from "../../platform/services.ts";
import { IdGenLive, StorageLive } from "../../platform/sqlite.ts";

const READER_MODULE = fileURLToPath(new URL("../../platform/reader.ts", import.meta.url));

/** A nine-move draw and a five-move X win, as (player, cell) pairs. */
const DRAW = [[0, "X"], [1, "O"], [2, "X"], [4, "O"], [3, "X"], [5, "O"], [7, "X"], [6, "O"], [
  8,
  "X",
]] as const;
const X_WINS = [[0, "X"], [3, "O"], [1, "X"], [4, "O"], [2, "X"]] as const;

/** Runs `effect` and keeps going whatever it fails with: the failure is the point, it is logged. */
const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.either(effect);

function playApp(appId: string, games: number) {
  return Effect.gen(function* () {
    const storage = yield* Storage;
    const reader = yield* ReaderClient;
    const backups = yield* Backups;
    const query = (name: string, args: unknown) => reader.call({ kind: "query", appId, name, args });
    for (let g = 0; g < games; g++) {
      const players = { X: `x${g}`, O: `o${g}` };
      const { gameId } = (yield* storage.mutation(functions.createGame, {
        xPlayer: players.X,
        oPlayer: players.O,
      })) as { gameId: string };
      const script = g % 3 === 0 ? DRAW : X_WINS;
      for (const [index, [cell, mark]] of script.entries()) {
        yield* storage.mutation(functions.makeMove, {
          gameId,
          playerId: players[mark],
          cell,
          expectedVersion: index + 1,
        });
        yield* query("getGame", { gameId });
      }
      yield* query("moveHistory", { gameId });
      // Rule, conflict and not-found failures, each once per game.
      yield* attempt(storage.mutation(functions.makeMove, {
        gameId,
        playerId: players.X,
        cell: 0,
        expectedVersion: script.length + 1,
      }));
      yield* attempt(
        storage.mutation(functions.makeMove, { gameId, playerId: players.X, cell: 0, expectedVersion: 1 }),
      );
      yield* attempt(storage.mutation(functions.deleteGame, { gameId: `missing-${g}` }));
    }
    yield* attempt(storage.mutation(functions.createGame, { xPlayer: "same", oPlayer: "same" }));
    yield* attempt(storage.mutation(functions.createGame, { xPlayer: 42 }));
    for (const status of ["playing", "won", "draw"]) yield* query("listGames", { status });
    yield* query("winsByMark", {});
    yield* attempt(query("noSuchHandler", {}));
    yield* attempt(query("createGame", { xPlayer: "a", oPlayer: "b" }));
    yield* attempt(query("listGames", { status: "nope" }));
    for (let b = 0; b < 2; b++) yield* backups.take(appId);
  });
}

const workload = Effect.gen(function* () {
  const apps = [...loadApps().values()];
  for (const app of apps) yield* Effect.promise(() => Deno.mkdir(dirname(app.file), { recursive: true }));
  for (const app of apps) {
    const appLayer = BackupsLive.pipe(
      Layer.provideMerge(StorageLive({ file: app.file, schema: app.schema, appId: app.id })),
      Layer.provideMerge(ObjectStoreLocal),
    );
    yield* Effect.provide(playApp(app.id, 12), appLayer);
  }
  yield* attempt(
    (yield* ReaderClient).call({ kind: "query", appId: "no-such-app", name: "getGame", args: {} }),
  );
}).pipe(
  Effect.provide(ReaderClientLive({ module: READER_MODULE, role: "server" })),
  Effect.provide(Layer.mergeAll(LoggingLive, IdGenLive).pipe(Layer.provideMerge(ConfigLive))),
);

const ingest = Effect.gen(function* () {
  const service = yield* EventLogIngest;
  const first = yield* service.ingest;
  const second = yield* service.ingest;
  return { first, second };
}).pipe(
  Effect.provide(EventLogIngestLive),
  Effect.provide(LoggingReaderLive.pipe(Layer.provideMerge(ConfigLive))),
);

const mode = Deno.args[0];
if (mode === "workload") {
  await Effect.runPromise(workload);
} else if (mode === "ingest") {
  console.log(JSON.stringify(await Effect.runPromise(ingest), null, 2));
} else {
  console.error("usage: seed.ts workload|ingest");
  Deno.exit(2);
}
