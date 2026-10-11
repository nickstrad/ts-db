import type { functions } from "../../app/functions.ts";
import { createClient } from "../../sdk/client.ts";
import { Cause, Effect, Exit } from "effect";

const token = "dev-only";
const traceId = `demo-observability-${crypto.randomUUID()}`;

type Server = { root: string; logDir: string; baseURL: string; process: Deno.ChildProcess };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function startServer(): Effect.Effect<Server, Error> {
  return Effect.tryPromise({
    try: async () => {
      const root = await Deno.makeTempDir({ prefix: "tsdb-demo-observability-" });
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      listener.close();
      const logDir = `${root}/logs`;
      const process = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "platform/server.ts"],
        env: {
          PORT: String(port),
          DATA_DIR: `${root}/data`,
          LOG_DIR: logDir,
          LOCAL_OBJECT_DIR: `${root}/object-store`,
        },
        stdout: "null",
        stderr: "piped",
      }).spawn();
      return { root, logDir, baseURL: `http://127.0.0.1:${port}`, process };
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function releaseServer(server: Server) {
  return Effect.tryPromise({
    try: async () => {
      try {
        server.process.kill("SIGTERM");
      } catch { /* The server may already have exited after a failed startup. */ }
      await server.process.status;
      await Deno.remove(server.root, { recursive: true }).catch(() => {});
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

async function admin(server: Server, path: string, body: unknown = {}, deadline?: number) {
  const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
  const response = await fetch(`${server.baseURL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(remaining === undefined ? {} : { signal: AbortSignal.timeout(remaining) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return (payload as { result: unknown }).result;
}

function records(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value), "analysis result is an array of rows");
  return value as Record<string, unknown>[];
}

function printTable(name: string, rows: Record<string, unknown>[]) {
  console.log(`\n${name}`);
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const values = rows.map((row) =>
    columns.map((column) => {
      const value = row[column];
      return value === null || value === undefined
        ? ""
        : typeof value === "string"
        ? value
        : JSON.stringify(value);
    })
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...values.map((row) => row[index].length))
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  console.log(line(columns));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of values) console.log(line(row));
}

async function printTree(root: string, prefix = "") {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(root)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const last = index === entries.length - 1;
    console.log(`${prefix}${last ? "└── " : "├── "}${entry.name}${entry.isDirectory ? "/" : ""}`);
    if (entry.isDirectory) await printTree(`${root}/${entry.name}`, `${prefix}${last ? "    " : "│   "}`);
  }
}

const program = Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(startServer(), releaseServer);
  yield* waitHealthy(server);
  const client = createClient<typeof functions>(server.baseURL, "tic-tac-toe", token);

  const { gameId } = yield* client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" }, traceId);
  let game = yield* client.query("getGame", { gameId });
  assert(game !== null, "getGame returns the game created under the caller trace id");
  game = yield* client.mutation("makeMove", {
    gameId,
    playerId: "alice",
    cell: 0,
    expectedVersion: game._version,
  });
  assert(game!._version > 0, "successful workload mutation advances the game version");

  const stale = yield* client.mutation("makeMove", {
    gameId,
    playerId: "bob",
    cell: 3,
    expectedVersion: 0,
  }).pipe(
    Effect.catchTag("RemoteError", (error) =>
      Effect.sync(() => {
        assert(error.status === 409, "stale expectedVersion move returns HTTP 409");
        return { status: error.status };
      })),
  );
  assert(
    typeof stale === "object" && stale !== null && "status" in stale && stale.status === 409,
    "deliberate conflict is observed",
  );

  const missing = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${server.baseURL}/apps/tic-tac-toe/query/noSuchHandler`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      return response.status;
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  });
  assert(missing === 404, "unknown handler returns HTTP 404");

  // Ingestion and analysis are separate requests. Retry the pair under one 10-second deadline,
  // because the event sink writes asynchronously and the reader may not see this trace yet.
  const deadline = Date.now() + 10_000;
  let traceRows: Record<string, unknown>[] = [];
  let lastIngestError = "none";
  while (Date.now() < deadline) {
    const ingest = yield* Effect.either(Effect.tryPromise({
      try: () => admin(server, "/admin/logs/ingest", {}, deadline),
      catch: (cause) => new Error(String(cause)),
    }));
    if (ingest._tag === "Left") {
      lastIngestError = ingest.left.message;
    } else {
      const analysis = yield* Effect.either(Effect.tryPromise({
        try: () => admin(server, "/admin/logs/analysis/trace", { traceId }, deadline),
        catch: (cause) => new Error(String(cause)),
      }));
      if (analysis._tag === "Left") {
        lastIngestError = analysis.left.message;
      } else {
        traceRows = records(analysis.right);
        if (traceRows.some((row) => Object.values(row).includes(traceId))) break;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) yield* Effect.sleep(`${Math.min(200, remaining)} millis`);
  }
  assert(
    traceRows.some((row) => Object.values(row).includes(traceId)),
    `trace ${traceId} becomes queryable within 10s (last ingest/query error: ${lastIngestError})`,
  );

  const query = (name: string, params: Record<string, unknown> = {}) =>
    Effect.tryPromise({
      try: () => admin(server, `/admin/logs/analysis/${name}`, params),
      catch: (cause) => new Error(String(cause)),
    })
      .pipe(Effect.map(records));
  const throughput = yield* query("handler-throughput");
  const errors = yield* query("error-rate-by-handler");
  const slowest = yield* query("slowest-sql");
  traceRows = yield* query("trace", { traceId });

  const errorRows = JSON.stringify(errors);
  assert(errors.some((row) => JSON.stringify(row).includes("409")), "error-rate-by-handler includes the 409");
  assert(errors.some((row) => JSON.stringify(row).includes("404")), "error-rate-by-handler includes the 404");
  assert(errorRows.length > 2, "error-rate-by-handler returns rows");
  assert(
    traceRows.some((row) => Object.values(row).includes(traceId)),
    "trace query returns the caller trace id",
  );

  printTable("handler-throughput", throughput);
  printTable("error-rate-by-handler", errors);
  printTable("slowest-sql", slowest);
  printTable("trace", traceRows);
  console.log(`\nLOG_DIR: ${server.logDir}/`);
  yield* Effect.tryPromise({
    try: () => printTree(server.logDir),
    catch: (cause) => new Error(String(cause)),
  });
  console.log("DEMO OK: observability");
});

const result = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(result)) {
  console.error(`observability demo failed: ${Cause.pretty(result.cause)}`);
  Deno.exitCode = 1;
}
