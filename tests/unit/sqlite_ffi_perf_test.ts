/**
 * FFI SQLite binding (`platform/sqlite_ffi/`): point-read performance parity with `node:sqlite`,
 * the document reader's driver today.
 *
 * Same schema and rows in two files, one per library: two SQLite copies must never hold the same
 * file open in one process (`docs/knowledge/gotchas.md`). Reads alternate between the two paths in
 * rounds so host noise lands on both. The gate is the sync path's p50 against `node:sqlite`'s,
 * with headroom for a shared VM; the nonblocking path is reported, with only a sanity bound, since
 * its thread hop is a known 35–60 µs cost (docs/architecture/lang-switch-fable.md §3.2).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../platform/sqlite_ffi/mod.ts";

const ROWS = 1000;
const ROUNDS = 6;
const READS_PER_ROUND = 4000;
/** FFI sync p50 may be at most this multiple of node:sqlite's p50 (plus 1 µs of timer noise). */
const MAX_P50_RATIO = 1.3;

function pct(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const SETUP =
  "PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT NOT NULL, n REAL);";
const QUERY = "SELECT id, body, n FROM docs WHERE id = ?";
const body = (i: number) => JSON.stringify({ id: i, title: `doc ${i}`, pad: "x".repeat(180) });

Deno.test("perf: FFI sync point reads are at parity with node:sqlite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-ffi-perf-"));
  const nodeDb = new DatabaseSync(join(dir, "node.db"));
  const ffiDb = Database.open(join(dir, "ffi.db"));
  try {
    nodeDb.exec(SETUP + "BEGIN;");
    ffiDb.exec(SETUP + "BEGIN;");
    const nIns = nodeDb.prepare("INSERT INTO docs VALUES (?, ?, ?)");
    const fIns = ffiDb.prepare("INSERT INTO docs VALUES (?, ?, ?)");
    for (let i = 1; i <= ROWS; i++) {
      nIns.run(i, body(i), i / 3);
      fIns.run([i, body(i), i / 3]);
    }
    nodeDb.exec("COMMIT");
    ffiDb.exec("COMMIT");

    const nGet = nodeDb.prepare(QUERY);
    const fGet = ffiDb.prepare(QUERY);
    const ids = Array.from({ length: READS_PER_ROUND }, (_, i) => 1 + ((i * 7919) % ROWS));

    // Same answers from both paths.
    for (const id of ids.slice(0, 50)) assert.deepEqual({ ...fGet.get([id]) }, { ...nGet.get(id) });

    // Warm up both (JIT, page cache), then measure in alternating rounds.
    for (const id of ids) {
      nGet.get(id);
      fGet.get([id]);
    }
    const nodeUs: number[] = [];
    const ffiUs: number[] = [];
    let sink = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const [first, second] = round % 2 === 0 ? ["node", "ffi"] : ["ffi", "node"];
      for (const which of [first, second]) {
        const out = which === "node" ? nodeUs : ffiUs;
        for (const id of ids) {
          const t = performance.now();
          const row = which === "node" ? nGet.get(id) : fGet.get([id]);
          out.push((performance.now() - t) * 1000);
          sink += (row?.body as string).length;
        }
      }
    }
    assert.ok(sink > 0);

    const nbUs: number[] = [];
    for (const id of ids.slice(0, 2000)) {
      const t = performance.now();
      await fGet.getAsync([id]);
      nbUs.push((performance.now() - t) * 1000);
    }

    const report = {
      node_sqlite_sync: { p50: pct(nodeUs, 0.5), p99: pct(nodeUs, 0.99), n: nodeUs.length },
      ffi_sync: { p50: pct(ffiUs, 0.5), p99: pct(ffiUs, 0.99), n: ffiUs.length },
      ffi_nonblocking: { p50: pct(nbUs, 0.5), p99: pct(nbUs, 0.99), n: nbUs.length },
    };
    console.log(`point read µs: ${JSON.stringify(report)}`);
    assert.ok(
      report.ffi_sync.p50 <= report.node_sqlite_sync.p50 * MAX_P50_RATIO + 1,
      `FFI sync p50 ${report.ffi_sync.p50} µs vs node:sqlite ${report.node_sqlite_sync.p50} µs`,
    );
    assert.ok(report.ffi_nonblocking.p50 < 1000, `nonblocking p50 ${report.ffi_nonblocking.p50} µs`);
  } finally {
    nodeDb.close();
    await ffiDb.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  }
});
