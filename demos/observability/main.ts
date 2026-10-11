import { Effect } from "effect";
import type { functions } from "../../app/functions.ts";
import { createClient } from "../../sdk/client.ts";
import { assert, post, run, server, temporaryRoot } from "./lifecycle.ts";

type Row = Record<string, unknown>;

function analysis(base: string, name: string, params: Record<string, string | number> = {}) {
  return post(base, `/admin/logs/analysis/${name}`, params).pipe(Effect.map((rows) => {
    assert(Array.isArray(rows), `${name}: analysis returns rows`);
    return rows as Row[];
  }));
}

async function tree(path: string, indent = ""): Promise<void> {
  const entries = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    console.log(`${indent}${entry.name}${entry.isDirectory ? "/" : ""}`);
    if (entry.isDirectory) await tree(`${path}/${entry.name}`, `${indent}  `);
  }
}

await run(
  "observability",
  Effect.scoped(Effect.gen(function* () {
    const root = yield* temporaryRoot;
    const base = yield* server(root);
    const client = createClient<typeof functions>(base, "tic-tac-toe", "demo-app");
    const { gameId } = yield* client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
    const traceId = `demo-${crypto.randomUUID()}`;
    const game = yield* client.query("getGame", { gameId }, traceId);
    assert(game, "traced getGame exists");
    const moved = yield* client.mutation("makeMove", {
      gameId,
      playerId: "alice",
      cell: 0,
      expectedVersion: game._version,
    });
    assert(moved && moved._version === game._version + 1, "workload move succeeds");
    const conflict = yield* client.mutation("makeMove", {
      gameId,
      playerId: "bob",
      cell: 3,
      expectedVersion: game._version,
    }).pipe(Effect.catchTag("RemoteError", (error) => {
      assert(error.status === 409 && error.remoteTag === "ConflictError", "deliberate 409 ConflictError");
      return Effect.succeed(true);
    }));
    assert(conflict === true, "stale move failed");
    yield* Effect.promise(async () => {
      const response = await fetch(`${base}/apps/tic-tac-toe/query/demoUnknownHandler`, {
        method: "POST",
        headers: { authorization: "Bearer demo-app", "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      assert(
        response.status === 404 && body.error.tag === "UnknownHandlerError",
        "deliberate unknown-handler 404",
      );
    });
    console.log(`Caller-supplied X-Trace-Id: ${traceId}; deliberate HTTP errors: 409, 404`);
    const result = yield* Effect.gen(function* () {
      while (true) {
        yield* post(base, "/admin/logs/ingest");
        const trace = yield* analysis(base, "trace", { traceId });
        const errors = yield* analysis(base, "error-rate-by-handler", { appId: "tic-tac-toe" });
        const throughput = yield* analysis(base, "handler-throughput", { appId: "tic-tac-toe" });
        const sql = yield* analysis(base, "slowest-sql", { appId: "tic-tac-toe" });
        const conflictRow = errors.find((row) =>
          row.name === "makeMove" && String(row.error_tags).includes("ConflictError:1")
        );
        const missingRow = errors.find((row) =>
          row.name === "demoUnknownHandler" && String(row.error_tags).includes("UnknownHandlerError:1")
        );
        // Wait for both processes' buffered events, not just the first server span.
        if (
          trace.some((row) => row.source === "http") && trace.some((row) => row.role === "reader") &&
          trace.some((row) => row.source === "sql") && conflictRow && missingRow && sql.length > 0
        ) {
          assert(
            Number(conflictRow.errors) === 1 && Number(missingRow.errors) === 1,
            "analysis contains the 409 and 404",
          );
          for (const name of ["makeMove", "demoUnknownHandler"]) {
            assert(
              throughput.some((row) => row.name === name && Number(row.status_4xx) === 1),
              `${name}: throughput records 4xx`,
            );
          }
          return { throughput, errors, sql, trace };
        }
        yield* Effect.sleep("100 millis");
      }
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag(
        "TimeoutException",
        () => Effect.die(new Error("Assertion failed: trace, 409, 404 and SQL queryable within 10 seconds")),
      ),
    );
    for (
      const [name, rows] of [
        ["handler-throughput", result.throughput],
        ["error-rate-by-handler", result.errors],
        ["slowest-sql", result.sql],
        ["trace", result.trace],
      ] as const
    ) {
      assert(rows.length > 0, `${name}: nonempty table`);
      console.log(`\n${name}`);
      console.table(rows);
    }
    console.log("\nLOG_DIR tree (logs/<role>/<date>/):\nlogs/");
    yield* Effect.promise(async () => {
      for (const role of ["server", "reader"]) {
        const dates = [];
        for await (const entry of Deno.readDir(`${root}/logs/${role}`)) {
          if (entry.isDirectory && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) dates.push(entry.name);
        }
        assert(dates.length > 0, `${role}: dated log directory exists`);
      }
      await tree(`${root}/logs`, "  ");
    });
  })),
);
