import { ConflictError, RemoteError } from "../../core/errors.ts";
import type { functions } from "../../app/functions.ts";
import { createClient } from "../../sdk/client.ts";
import { Cause, Effect, Exit } from "effect";

const token = "dev-only";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function startServer(): Effect.Effect<{
  root: string;
  baseURL: string;
  process: Deno.ChildProcess;
}, Error> {
  return Effect.tryPromise({
    try: async () => {
      const root = await Deno.makeTempDir({ prefix: "tsdb-demo-documents-" });
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      listener.close();
      const process = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "platform/server.ts"],
        env: {
          PORT: String(port),
          DATA_DIR: `${root}/data`,
          LOG_DIR: `${root}/logs`,
          LOCAL_OBJECT_DIR: `${root}/object-store`,
        },
        stdout: "null",
        stderr: "piped",
      }).spawn();
      return { root, baseURL: `http://127.0.0.1:${port}`, process };
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
}

type Server = { root: string; baseURL: string; process: Deno.ChildProcess };

function releaseServer(server: Server) {
  return Effect.tryPromise({
    try: async () => {
      try {
        server.process.kill("SIGTERM");
      } catch { /* It may already have exited after a failed startup. */ }
      await server.process.status;
      await Deno.remove(server.root, { recursive: true }).catch(() => {});
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  })
    .pipe(Effect.catchAll(() => Effect.void));
}

function waitHealthy(baseURL: string) {
  return Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 15_000;
      let last = "no response";
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) return;
          last = `HTTP ${response.status}`;
        } catch (cause) {
          last = String(cause);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`GET /health timed out after 15s (${last})`);
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function logical<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => logical(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "_id" && key !== "_creationTime")
        .map(([key, child]) => [key, logical(child)]),
    ) as T;
  }
  return value;
}

const program = Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(startServer(), releaseServer);
  yield* waitHealthy(server.baseURL);
  const client = createClient<typeof functions>(server.baseURL, "tic-tac-toe", token);
  const jsonClient = createClient<typeof functions>(server.baseURL, "tic-tac-toe-json", token);

  const runLayout = (db: typeof client, suffix: string) =>
    Effect.gen(function* () {
      const { gameId } = yield* db.mutation("createGame", {
        xPlayer: "alice",
        oPlayer: "bob",
      });
      let game = yield* db.query("getGame", { gameId });
      assert(game !== null, `${suffix}: getGame returns newly created game`);
      for (const [playerId, cell] of [["alice", 0], ["bob", 3]] as const) {
        game = yield* db.mutation("makeMove", { gameId, playerId, cell, expectedVersion: game!._version });
      }
      const playing = yield* db.query("listGames", { status: "playing" });
      const history = yield* db.query("moveHistory", { gameId });
      const wins = yield* db.query("winsByMark", {});
      const firstVersion = game!._version;
      const stale = db.mutation("makeMove", {
        gameId,
        playerId: "alice",
        cell: 1,
        expectedVersion: 0,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof RemoteError && error.status === 409
            ? new ConflictError({ expected: 0, actual: firstVersion, table: "games", id: gameId })
            : error
        ),
        Effect.catchTag("ConflictError", (error) =>
          Effect.sync(() => {
            assert(
              error.expected === 0 && error.actual === firstVersion,
              `${suffix}: stale move is typed ConflictError`,
            );
            return "conflict handled";
          })),
      );
      assert((yield* stale) === "conflict handled", `${suffix}: stale expectedVersion is rejected as 409`);
      const invalid = db.mutation("createGame", { xPlayer: " ", oPlayer: "bob" }).pipe(
        Effect.catchTag("RemoteError", (error) =>
          Effect.sync(() => {
            assert(error.status === 400, `${suffix}: invalid players return typed HTTP 400`);
            return { rejected: true };
          })),
      );
      const invalidResult = yield* invalid;
      assert("rejected" in invalidResult && invalidResult.rejected, `${suffix}: validation failure handled`);
      return {
        game: yield* db.query("getGame", { gameId }),
        playing: playing.filter((item) => item._id === gameId),
        history,
        wins,
      };
    });

  const columns = yield* runLayout(client, "columns");
  const json = yield* runLayout(jsonClient, "json");
  assert(
    JSON.stringify(logical(columns.game)) === JSON.stringify(logical(json.game)),
    "both layouts return the same game shape and values",
  );
  assert(
    JSON.stringify(
      logical(columns.playing).map((item) => ({ ...item, xPlayer: "alice", oPlayer: "bob" })),
    ) ===
      JSON.stringify(logical(json.playing).map((item) => ({ ...item, xPlayer: "alice", oPlayer: "bob" }))),
    "both layouts filter playing games consistently",
  );
  assert(
    JSON.stringify(logical(columns.history).map(({ gameId: _id, ...move }) => move)) ===
      JSON.stringify(logical(json.history).map(({ gameId: _id, ...move }) => move)),
    "both layouts return the same move history",
  );
  assert(
    JSON.stringify(columns.wins) === JSON.stringify(json.wins),
    "both layouts return the same winsByMark countBy aggregate",
  );
  console.log(
    "Columns and JSON layouts agree on game documents, filtered lists, move history, and winsByMark.",
  );
  console.log("DEMO OK: documents");
});

const result = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(result)) {
  console.error(`documents demo failed: ${Cause.pretty(result.cause)}`);
  Deno.exitCode = 1;
}
