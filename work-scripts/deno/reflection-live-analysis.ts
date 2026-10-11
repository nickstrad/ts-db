/**
 * Real HTTP workload -> JSONL -> ingest -> every current SQL file/catalog entry.
 * Run from repo root via:
 * bash work-scripts/bash/ci-isolated-postgres.sh deno run -A work-scripts/deno/reflection-live-analysis.ts
 * Needs Docker wrapper, Deno/native DuckDB, k6, network and scratch filesystem/process access.
 * No fixture event INSERTs. Reader-only --analyze mode runs in another OS process.
 * Scratch retained on failure; KEEP_REFLECTION_DATA=1 retains it on success.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Effect } from "effect";

if (Deno.args[0] === "--analyze") {
  const root = Deno.args[1];
  assert.ok(root);
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const { CATALOG, resolveParams } = await import("../../platform/analysis/catalog.ts");
  const { ingestK6 } = await import("../../perf/ingest_k6.ts");
  const loaded = await ingestK6("reflection", root + "/k6.json", root + "/events.duckdb");
  console.log("real k6 points:", loaded.points);
  const instance = await DuckDBInstance.create(root + "/events.duckdb", {
    access_mode: "READ_ONLY",
    threads: "2",
    memory_limit: "256MB",
  });
  const connection = await instance.connect();
  try {
    const count = await connection.runAndReadAll("SELECT count(*) AS n FROM platform_events");
    console.log("ingested platform events:", count.getRowObjectsJson()[0].n);
    const values: Record<string, string | number> = {
      start_ts: "2000-01-01",
      end_ts: "2100-01-01",
      trace_id: "reflection-query",
      limit: 100,
      log_glob: root + "/logs/*/*/events-*.jsonl",
    };
    const files = [];
    for await (const file of Deno.readDir("scripts/duckdb")) {
      if (file.name.endsWith(".sql")) files.push(file.name);
    }
    for (const name of files.sort()) {
      const sql = await Deno.readTextFile("scripts/duckdb/" + name);
      const names = [...new Set([...sql.matchAll(/\$([a-z_]+)/g)].map((m) => m[1]))];
      const bound = Object.fromEntries(names.map((name) => {
        assert.ok(Object.hasOwn(values, name), name);
        return [name, values[name]];
      }));
      const rows = (await connection.runAndReadAll(sql, bound)).getRowObjectsJson();
      assert.ok(rows.length > 0, name + " returned no rows");
      console.log("SQL", name, "rows=" + rows.length);
      if (name === "reader-restarts.sql") console.log("restart evidence:", JSON.stringify(rows));
    }
    for (const [name, entry] of Object.entries(CATALOG)) {
      const params = await Effect.runPromise(
        resolveParams(name, entry, name === "trace" ? { traceId: "reflection-query" } : {}),
      );
      const rows = (await connection.runAndReadAll(entry.sql, { ...params })).getRowObjectsJson();
      assert.ok(rows.length > 0, name + " returned no rows");
      console.log("CATALOG", name, "rows=" + rows.length);
      if (name === "k6-vs-platform") console.log("bucket evidence:", JSON.stringify(rows));
    }
    const cols = (await connection.runAndReadAll(
      "SELECT table_name, column_name FROM duckdb_columns() WHERE column_name LIKE '%tenant%'",
    )).getRowObjectsJson();
    console.log("tenant columns:", JSON.stringify(cols));
    assert.equal(cols.length, 0, "Update the tenant-attribution finding for the new schema");
    console.log("PASS: all current SQL files and catalog entries returned real-workload rows");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
} else {
  assert.equal(Deno.env.get("TSDB_DISPOSABLE_POSTGRES"), "1", "Use the disposable Postgres wrapper");
  assert.ok(Deno.env.get("DATABASE_URL"));
  const { startScratchServer, serverLogRecords } = await import("../../tests/integration.ts");
  const root = await Deno.makeTempDir({ prefix: "tsdb-reflection-" });
  const common = {
    LOG_DIR: root + "/logs",
    EVENTLOG_DUCKDB: root + "/events.duckdb",
    TRACE_SQL: "true",
    EVENT_FLUSH_MS: "20",
  };
  let passed = false;
  const command = async (args: string[], env: Record<string, string> = {}) => {
    const out = await new Deno.Command(Deno.execPath(), {
      args,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(out.code, 0, new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout);
  };
  const request = async (
    base: string,
    path: string,
    body: unknown = {},
    token = "dev-only",
    expected = 200,
    trace = "reflection-request",
    method = "POST",
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: "Bearer " + token, "x-trace-id": trace },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const decoded = await response.json();
    assert.equal(response.status, expected, path + ": " + JSON.stringify(decoded.error));
    return decoded.result;
  };
  try {
    await command(["task", "db:migrate"]);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* startScratchServer(root + "/legacy", { ...common, TENANCY: "off" });
      yield* Effect.promise(async () => {
        for (const app of ["tic-tac-toe", "tic-tac-toe-json"]) {
          const { gameId } = await request(server.base, "/apps/" + app + "/mutation/createGame", {
            xPlayer: "reflection-x",
            oPlayer: "reflection-o",
          });
          await request(
            server.base,
            "/apps/" + app + "/query/getGame",
            { gameId },
            "dev-only",
            200,
            "reflection-query",
          );
          await request(
            server.base,
            "/apps/" + app + "/mutation/createGame",
            { xPlayer: "same", oPlayer: "same" },
            "dev-only",
            400,
          );
          await request(server.base, "/admin/backup/" + app);
        }
        const work = root + "/k6-work";
        await Deno.mkdir(work + "/logs/k6/reflection", { recursive: true });
        const load = await new Deno.Command("k6", {
          args: [
            "run",
            "--quiet",
            "--duration",
            "3s",
            "--out",
            "json=" + root + "/k6.json",
            resolve("perf/smoke.js"),
          ],
          cwd: work,
          env: { BASE_URL: server.base, TOKEN: "dev-only", APP_ID: "tic-tac-toe", K6_RUN_ID: "reflection" },
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert.equal(load.code, 0, new TextDecoder().decode(load.stderr));
        const records = await serverLogRecords(server.logDir);
        const ready = records.find((r) => r.kind === "lifecycle" && r.phase === "ready");
        const pid = (ready?.detail as { readerPid?: number })?.readerPid;
        assert.ok(pid);
        // Hold only our child briefly so real HTTP traffic crosses the reader's 100-call high-water mark.
        Deno.kill(pid, "SIGSTOP");
        let queued: Promise<unknown>[];
        try {
          queued = Array.from(
            { length: 120 },
            () => request(server.base, "/apps/tic-tac-toe/query/listGames", { status: "playing" }),
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } finally {
          Deno.kill(pid, "SIGCONT");
        }
        await Promise.all(queued!);
        Deno.kill(pid, "SIGKILL"); // PID belongs to the server this scope just started.
        let recovered = false;
        let saw502 = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          const response = await fetch(server.base + "/health", { signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          if (response.status === 502) saw502 = true;
          if (saw502 && response.ok) {
            recovered = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(recovered && saw502, "Reader did not expose 502 then recover");
      });
      assert.equal((yield* server.stop).code, 0);
    })));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* startScratchServer(root + "/tenant", { ...common, TENANCY: "api-key" });
      yield* Effect.promise(async () => {
        const tenants = [];
        for (const [i, app] of ["tic-tac-toe", "tic-tac-toe-json"].entries()) {
          const created = await request(server.base, "/admin/tenants", {
            name: "Reflection " + i,
            slug: "reflection-" + i,
          });
          const token = created.apiKey.plaintext;
          const { gameId } = await request(server.base, "/apps/" + app + "/mutation/createGame", {
            xPlayer: "tenant-x",
            oPlayer: "tenant-o",
          }, token);
          await request(server.base, "/apps/" + app + "/query/getGame", { gameId }, token);
          tenants.push(created.tenant.id);
        }
        await request(server.base, "/admin/tenants", {}, "dev-only", 200, "reflection-admin", "GET");
        await request(server.base, "/admin/backup/tic-tac-toe", {}, "dev-only", 500);
        await request(
          server.base,
          "/admin/tenants/" + tenants[0],
          {},
          "dev-only",
          200,
          "reflection-admin",
          "DELETE",
        );
        console.log("Tenant workload: two layouts/two tenants; tenant backup correctly fails HTTP 500");
      });
      assert.equal((yield* server.stop).code, 0);
    })));
    console.log((await command(["task", "logs:ingest"], {
      ...common,
      DATA_DIR: root + "/offline",
      TENANCY: "off",
    })).trim());
    console.log(
      await command([
        "run",
        "-A",
        "--v8-flags=--expose-gc",
        "work-scripts/deno/reflection-live-analysis.ts",
        "--analyze",
        root,
      ]),
    );
    passed = true;
  } finally {
    if (passed && Deno.env.get("KEEP_REFLECTION_DATA") !== "1") await Deno.remove(root, { recursive: true });
    else console.log("Reflection scratch retained:", root);
  }
}
