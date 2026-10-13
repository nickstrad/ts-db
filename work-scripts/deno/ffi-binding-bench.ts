// ffi-binding-bench.ts: the numbers behind the FFI binding's tests, at a size the tests cannot
// afford, through the production module (platform/sqlite_ffi/) rather than raw symbols like the
// lang-switch PoCs (ffi-sqlite-interrupt.ts, ffi-sqlite-read-cost.ts on research/fable-lang-switch).
//   cancel_latency_ms        deadline fire -> getAsync rejecting SqliteCancelled, never-ending CTE
//   loop_max_gap_ms          longest gap in a 2 ms timer chain while each statement ran
//   point_read_us            p50/p99 for node:sqlite sync, FFI sync and FFI nonblocking point reads
//   loadavg                  host 1/5/15-min load when the run started (see docs/knowledge/gotchas.md)
// Two identical files, one per library: two SQLite copies must never share a file in one process.
// Permissions: --allow-ffi (libsqlite3), --allow-read/--allow-write (a temp dir it removes),
// --allow-sys (loadavg).
// Usage: deno run --allow-ffi --allow-read --allow-write --allow-sys work-scripts/deno/ffi-binding-bench.ts [cancel_runs=20] [reads=20000]
import { DatabaseSync } from "node:sqlite";
import { Database, SqliteCancelled } from "../../platform/sqlite_ffi/mod.ts";

const cancelRuns = Number(Deno.args[0] ?? 20);
const reads = Number(Deno.args[1] ?? 20000);
const loadavg = Deno.loadavg();
const dir = await Deno.makeTempDir({ prefix: "ffi-binding-bench-" });

const pct = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return +a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))].toFixed(3);
};
const summary = (xs: number[]) => ({ p50: pct(xs, 0.5), p99: pct(xs, 0.99), max: pct(xs, 1), n: xs.length });

// Cancellation.
const FOREVER = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c";
const cdb = Database.open(`${dir}/cancel.db`);
const forever = cdb.prepare(FOREVER);
const cancelMs: number[] = [];
const gaps: number[] = [];
for (let i = 0; i < cancelRuns; i++) {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 2);
  try {
    await forever.getAsync(undefined, { timeoutMs: 100 });
    throw new Deno.errors.InvalidData("the never-ending statement completed");
  } catch (e) {
    if (!(e instanceof SqliteCancelled)) throw e;
    cancelMs.push(e.cancelLatencyMs);
  } finally {
    clearInterval(timer);
  }
  gaps.push(maxGap);
}
await cdb.closeAsync();

// Point reads.
const SETUP = "PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT NOT NULL);";
const nodeDb = new DatabaseSync(`${dir}/node.db`);
const ffiDb = Database.open(`${dir}/ffi.db`);
nodeDb.exec(SETUP + "BEGIN;");
ffiDb.exec(SETUP + "BEGIN;");
const nIns = nodeDb.prepare("INSERT INTO docs VALUES (?, ?)");
const fIns = ffiDb.prepare("INSERT INTO docs VALUES (?, ?)");
for (let i = 1; i <= 1000; i++) {
  nIns.run(i, "x".repeat(200));
  fIns.run([i, "x".repeat(200)]);
}
nodeDb.exec("COMMIT");
ffiDb.exec("COMMIT");
const nGet = nodeDb.prepare("SELECT body FROM docs WHERE id = ?");
const fGet = ffiDb.prepare("SELECT body FROM docs WHERE id = ?");
const ids = Array.from({ length: reads }, (_, i) => 1 + ((i * 7919) % 1000));
const nodeUs: number[] = [];
const ffiUs: number[] = [];
const nbUs: number[] = [];
for (const id of ids.slice(0, 2000)) {
  nGet.get(id);
  fGet.get([id]);
}
for (const id of ids) {
  let t = performance.now();
  nGet.get(id);
  nodeUs.push((performance.now() - t) * 1000);
  t = performance.now();
  fGet.get([id]);
  ffiUs.push((performance.now() - t) * 1000);
}
for (const id of ids.slice(0, Math.min(reads, 5000))) {
  const t = performance.now();
  await fGet.getAsync([id]);
  nbUs.push((performance.now() - t) * 1000);
}
nodeDb.close();
await ffiDb.closeAsync();
await Deno.remove(dir, { recursive: true });

console.log(JSON.stringify({
  runtime: `deno ${Deno.version.deno}`,
  libsqlite3: ffiDb.library.version,
  loadavg,
  cancel_latency_ms: summary(cancelMs),
  loop_max_gap_ms: summary(gaps),
  point_read_us: {
    node_sqlite_sync: summary(nodeUs),
    ffi_sync: summary(ffiUs),
    ffi_nonblocking: summary(nbUs),
  },
}));
