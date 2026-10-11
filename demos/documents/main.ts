import { Effect } from "effect";
import type { functions } from "../../app/functions.ts";
import { ConflictError, SchemaError } from "../../core/errors.ts";
import { createClient } from "../../sdk/client.ts";
import { assert, run, server, temporaryRoot } from "./lifecycle.ts";

// Strip generated identities recursively, including the moves' foreign key.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["_id", "_creationTime", "gameId"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function play(base: string, appId: string) {
  const client = createClient<typeof functions>(base, appId, "demo-app");
  return Effect.gen(function* () {
    const { gameId } = yield* client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
    const initial = yield* client.query("getGame", { gameId });
    assert(initial && initial.status === "playing" && initial._version === 1, `${appId}: initial game`);
    const playing = yield* client.query("listGames", { status: "playing" });
    assert(playing.length === 1 && playing[0]._id === gameId, `${appId}: playing filter`);
    let game = initial;
    const states = [initial];
    for (
      const [playerId, cell] of [["alice", 0], ["bob", 3], ["alice", 1], ["bob", 4], ["alice", 2]] as const
    ) {
      const moved = yield* client.mutation("makeMove", {
        gameId,
        playerId,
        cell,
        expectedVersion: game._version,
      });
      assert(moved && moved._version === game._version + 1, `${appId}: move increments version`);
      game = moved;
      states.push(game);
    }
    const fetched = yield* client.query("getGame", { gameId });
    assert(
      JSON.stringify(canonical(fetched)) === JSON.stringify(canonical(game)),
      `${appId}: read after write`,
    );
    assert(game.status === "won" && game.winner === "X", `${appId}: X wins`);
    assert(
      JSON.stringify(game.board) === JSON.stringify(["X", "X", "X", "O", "O", null, null, null, null]),
      `${appId}: final board`,
    );
    const won = yield* client.query("listGames", { status: "won" });
    const remaining = yield* client.query("listGames", { status: "playing" });
    assert(won.length === 1 && won[0]._id === gameId && remaining.length === 0, `${appId}: won filter`);
    const moves = yield* client.query("moveHistory", { gameId });
    assert(
      moves.length === 5 && moves.every((move, i) => move.gameId === gameId && move.moveNumber === i + 1),
      `${appId}: ordered move history`,
    );
    const wins = yield* client.query("winsByMark", {});
    assert(wins.length === 1 && wins[0].value === "X" && wins[0].count === 1, `${appId}: countBy winner`);

    // The HTTP client preserves tag/status, not server payload fields. Reconstitute only
    // these two expected failures from the request and the state we just verified.
    const conflict = yield* client.mutation("makeMove", {
      gameId,
      playerId: "bob",
      cell: 8,
      expectedVersion: initial._version,
    }).pipe(
      Effect.catchTag("RemoteError", (error) => {
        assert(error.status === 409 && error.remoteTag === "ConflictError", `${appId}: typed 409`);
        return Effect.fail(new ConflictError({ expected: initial._version, actual: game._version }));
      }),
      Effect.catchTag("ConflictError", (error) => Effect.succeed(error.actual > error.expected)),
    );
    assert(conflict === true, `${appId}: catchTag handles conflict`);
    console.log(`${appId}: handled ConflictError (409)`);
    const validation = yield* client.mutation("makeMove", {
      gameId,
      playerId: "bob",
      cell: 1.5,
      expectedVersion: game._version,
    }).pipe(
      Effect.catchTag("RemoteError", (error) => {
        assert(error.status === 400 && error.remoteTag === "SchemaError", `${appId}: typed 400`);
        return Effect.fail(
          new SchemaError({ reason: "type-mismatch", path: "cell", expected: "integer", actual: 1.5 }),
        );
      }),
      Effect.catchTag("SchemaError", (error) => Effect.succeed(error.path === "cell")),
    );
    assert(validation === true, `${appId}: catchTag handles argument validation`);
    assert(
      (yield* client.query("getGame", { gameId }))?._version === game._version,
      `${appId}: rejected moves leave version unchanged`,
    );
    console.log(`${appId}: handled SchemaError (400); 5 moves, X wins`);
    return canonical({ states, fetched, playing, won, remaining, moves, wins });
  });
}

await run(
  "documents",
  Effect.scoped(Effect.gen(function* () {
    const root = yield* temporaryRoot;
    const base = yield* server(root);
    const columns = yield* play(base, "tic-tac-toe");
    const json = yield* play(base, "tic-tac-toe-json");
    assert(JSON.stringify(columns) === JSON.stringify(json), "both layouts: same documents and aggregates");
    console.log("Both layouts: identical documents and aggregates (generated identities ignored)");
  })),
);
