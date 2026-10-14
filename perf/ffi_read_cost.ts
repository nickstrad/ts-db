// Production-binding port of research/fable-lang-switch:work-scripts/deno/ffi-sqlite-read-cost.ts.
// Each SQLite library owns a different file. Run: deno run -A perf/ffi_read_cost.ts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../platform/sqlite_ffi/mod.ts";

const loadavg = Deno.loadavg();
const root = await Deno.makeTempDir({ prefix: "ffi-read-cost-" });
const nodeDb = new DatabaseSync(`${root}/node.db`);
const db = Database.open(`${root}/ffi.db`);
const pct = (a: number[]) => {
  a.sort((x, y) => x - y);
  const at = (p: number) => a[Math.ceil(p * a.length) - 1];
  return { p50_us: +at(0.5).toFixed(2), p99_us: +at(0.99).toFixed(2), n: a.length };
};
try {
  const setup = "PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT); BEGIN;";
  nodeDb.exec(setup);
  db.exec(setup);
  const ni = nodeDb.prepare("INSERT INTO docs VALUES (?, ?)");
  const fi = db.prepare("INSERT INTO docs VALUES (?, ?)");
  for (let i = 1; i <= 1000; i++) {
    ni.run(i, "x".repeat(200));
    fi.run([i, "x".repeat(200)]);
  }
  nodeDb.exec("COMMIT");
  db.exec("COMMIT");
  const ns = nodeDb.prepare("SELECT body FROM docs WHERE id = ?");
  const fs = db.prepare("SELECT body FROM docs WHERE id = ?");
  const ids = Array.from({ length: 20000 }, (_, i) => 1 + ((i * 7919) % 1000));
  // Reuse parameter arrays on both sides: no FFI-only array allocation in the timer.
  // node:sqlite's API is variadic; Statement accepts the same values as an array.
  const binds = ids.map((id) => [id]);
  const expected = "x".repeat(200);
  for (const params of binds.slice(0, 2000)) {
    assert.equal(fs.get(params)?.body, ns.get(...params)?.body);
    assert.equal((await fs.getAsync(params))?.body, expected);
  }
  const node: number[] = [], blocking: number[] = [], nonblocking: number[] = [];
  // Alternating order in rounds gives both paths the same host noise.
  for (let round = 0; round < 10; round++) {
    for (const ffi of round % 2 ? [true, false] : [false, true]) {
      for (const params of binds.slice(round * 2000, (round + 1) * 2000)) {
        const t = performance.now();
        const row = ffi ? fs.get(params) : ns.get(...params);
        (ffi ? blocking : node).push((performance.now() - t) * 1000);
        assert.equal(row?.body, expected);
      }
    }
  }
  for (const params of binds) {
    const t = performance.now();
    const row = await fs.getAsync(params);
    nonblocking.push((performance.now() - t) * 1000);
    assert.equal(row?.body, expected);
  }
  const report = {
    runtime: `deno ${Deno.version.deno}`,
    loadavg,
    node_sqlite_sync_us: pct(node),
    ffi_blocking_us: pct(blocking),
    ffi_nonblocking_us: pct(nonblocking),
    notes: [
      "1000-row WAL files, reused production Statement; microseconds including JS overhead",
      "Reused bind arrays, identical one-column decode, 2000 warm-ups per path excluded; alternating blocking batches",
    ],
  };
  console.log(JSON.stringify(report));
  assert.ok(report.ffi_blocking_us.p50_us <= 6.8 * 1.5, "PoC blocking budget");
  assert.ok(report.ffi_blocking_us.p50_us <= report.node_sqlite_sync_us.p50_us, "node parity");
  assert.ok(report.ffi_nonblocking_us.p50_us <= 100, "nonblocking p50");
  assert.ok(report.ffi_nonblocking_us.p99_us <= 3000, "nonblocking p99");
} finally {
  nodeDb.close();
  await db.closeAsync();
  await Deno.remove(root, { recursive: true });
}
