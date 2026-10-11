import type { functions } from "../../app/functions.ts";
import { createClient } from "../../sdk/client.ts";
import { Cause, Effect, Exit } from "effect";

const token = "dev-only";
type Server = { root: string; dataDir: string; baseURL: string; port: number; process: Deno.ChildProcess };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function startServer(root: string, dataDir: string): Effect.Effect<Server, Error> {
  return Effect.try({
    try: () => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      listener.close();
      const process = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "platform/server.ts"],
        env: {
          PORT: String(port),
          DATA_DIR: dataDir,
          LOG_DIR: `${root}/logs`,
          LOCAL_OBJECT_DIR: `${root}/object-store`,
        },
        stdout: "null",
        stderr: "piped",
      }).spawn();
      return { root, dataDir, baseURL: `http://127.0.0.1:${port}`, port, process };
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function releaseServer(server: Server) {
  return Effect.tryPromise({
    try: async () => {
      try {
        server.process.kill("SIGTERM");
      } catch { /* Already stopped. */ }
      await server.process.status;
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  })
    .pipe(Effect.catchAll(() => Effect.void));
}

function waitHealthy(server: Server) {
  return Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 15_000;
      let last = "no response";
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${server.baseURL}/health`, { signal: AbortSignal.timeout(500) });
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

async function admin(server: Server, path: string, body: unknown = {}) {
  const response = await fetch(`${server.baseURL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path} failed HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result as { result: unknown };
}

const program = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Deno.makeTempDir({ prefix: "tsdb-demo-backup-" }),
      catch: (cause) => new Error(String(cause)),
    }),
    (path) =>
      Effect.tryPromise({
        try: () => Deno.remove(path, { recursive: true }).catch(() => {}),
        catch: (cause) => new Error(String(cause)),
      })
        .pipe(Effect.catchAll(() => Effect.void)),
  );
  const dataDir = `${root}/data`;
  const server = yield* Effect.acquireRelease(startServer(root, dataDir), releaseServer);
  yield* waitHealthy(server);
  const client = createClient<typeof functions>(server.baseURL, "tic-tac-toe", token);
  const { gameId } = yield* client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
  let game = yield* client.query("getGame", { gameId });
  assert(game !== null, "getGame returns the created game before backup");
  for (const [playerId, cell] of [["alice", 0], ["bob", 3]] as const) {
    game = yield* client.mutation("makeMove", { gameId, playerId, cell, expectedVersion: game!._version });
  }
  const backedUpVersion = game!._version;
  yield* Effect.tryPromise({
    try: () => admin(server, "/admin/backup/tic-tac-toe"),
    catch: (cause) => new Error(String(cause)),
  });
  const latestPath = `${root}/object-store/apps/tic-tac-toe/latest.json`;
  const manifest = JSON.parse(
    yield* Effect.tryPromise({
      try: () => Deno.readTextFile(latestPath),
      catch: (cause) => new Error(String(cause)),
    }),
  ) as { key: string; sha256: string };
  assert(
    typeof manifest.key === "string" && manifest.key.startsWith("apps/tic-tac-toe/"),
    "latest.json names the tic-tac-toe snapshot",
  );
  const snapshot = yield* Effect.tryPromise({
    try: () => Deno.readFile(`${root}/object-store/${manifest.key}`),
    catch: (cause) => new Error(String(cause)),
  });
  const hashBytes = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", snapshot),
    catch: (cause) => new Error(String(cause)),
  });
  const sha256 = [...new Uint8Array(hashBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert(sha256 === manifest.sha256, "snapshot bytes match latest.json SHA-256");
  console.log(`Backup key: ${manifest.key}`);
  console.log(`Backup SHA-256: ${sha256}`);

  game = yield* client.mutation("makeMove", {
    gameId,
    playerId: "alice",
    cell: 1,
    expectedVersion: game!._version,
  });
  const afterBackupVersion = game!._version;
  assert(afterBackupVersion > backedUpVersion, "post-backup move increments _version");

  // Stop the first server before restoring, as required by the offline restore contract.
  yield* releaseServer(server);
  const restore = yield* Effect.tryPromise({
    try: async () => {
      const command = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "scripts/restore.ts", "tic-tac-toe", `${root}/restored/tic-tac-toe.sqlite`],
        env: { LOCAL_OBJECT_DIR: `${root}/object-store` },
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      if (!output.success) {
        throw new Error(`restore command failed: ${new TextDecoder().decode(output.stderr)}`);
      }
      return new TextDecoder().decode(output.stdout).trim();
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
  console.log(`Restore: ${restore}`);

  const restored = yield* Effect.acquireRelease(startServer(root, `${root}/restored`), releaseServer);
  yield* waitHealthy(restored);
  const restoredClient = createClient<typeof functions>(restored.baseURL, "tic-tac-toe", token);
  const restoredGame = yield* restoredClient.query("getGame", { gameId });
  assert(restoredGame !== null, "restored server can read the backed-up game");
  assert(
    restoredGame._version === backedUpVersion,
    `restored _version ${restoredGame._version} equals backed-up _version ${backedUpVersion}`,
  );
  assert(restoredGame._version !== afterBackupVersion, "restore excludes the move made after backup");
  console.log(`Restored _version: ${restoredGame._version} (post-backup was ${afterBackupVersion})`);
  console.log("DEMO OK: backup-restore");
});

const result = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(result)) {
  console.error(`backup-restore demo failed: ${Cause.pretty(result.cause)}`);
  Deno.exitCode = 1;
}
