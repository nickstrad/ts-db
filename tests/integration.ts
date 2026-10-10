/** Real Deno + DuckDB integration checks. Run separately from core tests. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createClient } from "../sdk/client.ts";
import type { functions } from "../app/functions.ts";
import { sha256 } from "../platform/object_store.ts";
import type { Manifest } from "../platform/backup.ts";
const root = await Deno.makeTempDir({ prefix: "document-db-integration-" });
const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const port = (probe.addr as Deno.NetAddr).port;
probe.close();
const base = `http://127.0.0.1:${port}`;
const env = {
  DATA_DIR: resolve(root, "data"), LOCAL_OBJECT_DIR: resolve(root, "objects"),
  PORT: String(port), COLUMN_APP_TOKEN: "dev-only", JSON_APP_TOKEN: "dev-only",
  ADMIN_TOKEN: "dev-only", S3_BASE_URL: "", BACKUP_INTERVAL_MS: "0",
};
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "platform/server.ts"], env, stdout: "null", stderr: "inherit",
}).spawn();
let exited = false;
void child.status.then(() => { exited = true; });
const snapshots: Manifest[] = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 1200; attempt++) {
    if (exited) throw new Error("Server exited before becoming ready");
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) { ready = true; break; }
    } catch { /* initial startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Server never became ready");
  const games: Record<string, string> = {};
  for (const appId of ["tic-tac-toe", "tic-tac-toe-json"]) {
    const client = createClient<typeof functions>(base, appId, "dev-only");
    const { gameId } = await client.mutation("createGame", { xPlayer: "alice", oPlayer: "bob" });
    games[appId] = gameId;
    let game = await client.query("getGame", { gameId });
    assert.equal(game!._version, 1);
    assert.equal(typeof game!._creationTime, "number");
    for (const [playerId, cell] of [["alice", 0], ["bob", 3], ["alice", 1], ["bob", 4], ["alice", 2]] as const) {
      const written: unknown = await client.mutation("makeMove", { gameId, playerId, cell, expectedVersion: game!._version });
      game = await client.query("getGame", { gameId });
      assert.deepEqual(game, written, "DuckDB must see the acknowledged SQLite commit");
    }
    assert.equal(game!.winner, "X");
    assert.deepEqual(await client.query("winsByMark", {}), [{ value: "X", count: 1 }]);
    assert.equal((await client.query("moveHistory", { gameId })).length, 5);
    assert.equal((await client.query("listGames", { status: "won" })).length, 1);

    const response = await fetch(`${base}/admin/backup/${appId}`, {
      method: "POST", headers: { authorization: "Bearer dev-only" },
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const manifest = body.result as Manifest;
    const snapshot = await Deno.readFile(resolve(env.LOCAL_OBJECT_DIR, manifest.key));
    assert.equal(await sha256(snapshot), manifest.sha256);
    snapshots.push(manifest);
  }
  const client = createClient<typeof functions>(base, "tic-tac-toe-json", "dev-only");
  assert.equal(await client.query("getGame", { gameId: games["tic-tac-toe"] }), null, "Files must be app-scoped");
  const response = await fetch(`${base}/apps/tic-tac-toe/query/listGames`, {
    method: "POST", body: JSON.stringify({ status: "won" }),
  });
  await response.body?.cancel();
  assert.equal(response.status, 401);
} finally {
  if (!exited) child.kill("SIGTERM");
  await child.status;
}
try {
  for (const manifest of snapshots) {
    const target = resolve(root, "restored", `${manifest.appId}.sqlite`);
    const restore = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "scripts/restore.ts", manifest.appId, target], env,
    }).output();
    assert.ok(restore.success, new TextDecoder().decode(restore.stderr));
    assert.equal(await sha256(await Deno.readFile(target)), manifest.sha256);
  }
  console.log("PASS: both layouts, DuckDB read-after-write, aggregation, app isolation, backup, restore, HTTP auth");
} finally { await Deno.remove(root, { recursive: true }); }
