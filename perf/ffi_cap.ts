// Blocking-pool capacity at the production document-read cap. Run: deno run -A perf/ffi_cap.ts.
import assert from "node:assert/strict";
import { Database, SqliteCancelled } from "../platform/sqlite_ffi/mod.ts";

const loadavg = Deno.loadavg();
const root = await Deno.makeTempDir({ prefix: "ffi-cap-" });
const databases: Database[] = [];
try {
  const statements = Array.from({ length: 32 }, (_, i) => {
    const db = Database.open(`${root}/${i}.db`);
    databases.push(db);
    return db.prepare(
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c",
    );
  });
  // Submit all calls in one main-thread turn; time each call from submission until typed failure.
  const samples = await Promise.all(statements.map(async (statement, reader) => {
    const t = performance.now();
    try {
      await statement.allAsync(undefined, { timeoutMs: 50 });
      throw new Error("unbounded statement completed");
    } catch (e) {
      const elapsedMs = performance.now() - t;
      if (!(e instanceof SqliteCancelled)) throw e;
      assert.equal(e.reason, "deadline");
      return {
        reader,
        elapsed_ms: +elapsedMs.toFixed(3),
        cancel_latency_ms: +e.cancelLatencyMs.toFixed(3),
      };
    }
  }));
  const max = Math.max(...samples.map((s) => s.elapsed_ms));
  console.log(JSON.stringify({
    runtime: `deno ${Deno.version.deno}`,
    loadavg,
    readers: 32,
    deadline_ms: 50,
    samples,
    max_elapsed_ms: max,
  }));
  assert.ok(max <= 100, `pool starvation: max ${max} ms > 100 ms`);
} finally {
  await Promise.all(databases.map((db) => db.closeAsync()));
  await Deno.remove(root, { recursive: true });
}
