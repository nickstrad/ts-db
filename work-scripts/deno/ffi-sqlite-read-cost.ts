// ffi-sqlite-read-cost.ts: what a point read costs through each Deno path, so the FFI route from
// ffi-sqlite-interrupt.ts can be judged on latency as well as cancellability. Three paths over the
// same on-disk WAL file with 1000 rows:
//   node_sqlite_sync_us   node:sqlite prepare().get() on the main thread (today's document reader)
//   ffi_blocking_us       Deno FFI to libsqlite3, sqlite3_step on the main thread
//   ffi_nonblocking_us    Deno FFI, sqlite3_step marked nonblocking (thread pool + Promise)
// Permissions: --allow-ffi, --allow-env, --allow-read/--allow-write for the scratch file.
// Usage: deno run --allow-ffi --allow-env --allow-read --allow-write work-scripts/deno/ffi-sqlite-read-cost.ts
import { DatabaseSync } from "node:sqlite";

const lib = Deno.env.get("LIBSQLITE3") ?? "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0";
const file = await Deno.makeTempFile({ suffix: ".db" });
{
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT); BEGIN;");
  const ins = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
  for (let i = 1; i <= 1000; i++) ins.run(i, "x".repeat(200));
  db.exec("COMMIT");
  db.close();
}
const N = 20000;
const pct = (a: number[]) => {
  a.sort((x, y) => x - y);
  const at = (p: number) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
  return { p50_us: +at(0.5).toFixed(2), p99_us: +at(0.99).toFixed(2), n: a.length };
};
const ids = Array.from({ length: N }, (_, i) => 1 + ((i * 7919) % 1000));

// Path 1: node:sqlite synchronous.
const nodeDb = new DatabaseSync(file, { readOnly: true });
const nodeStmt = nodeDb.prepare("SELECT body FROM docs WHERE id = ?");
const nodeLat: number[] = [];
for (const id of ids) {
  const t = performance.now();
  nodeStmt.get(id);
  nodeLat.push((performance.now() - t) * 1000);
}
nodeDb.close();

// Paths 2 and 3: FFI.
const sqlite = Deno.dlopen(lib, {
  sqlite3_open_v2: { parameters: ["buffer", "buffer", "i32", "pointer"], result: "i32" },
  sqlite3_prepare_v2: { parameters: ["pointer", "buffer", "i32", "buffer", "pointer"], result: "i32" },
  sqlite3_bind_int: { parameters: ["pointer", "i32", "i32"], result: "i32" },
  sqlite3_step: { parameters: ["pointer"], result: "i32" },
  sqlite3_step_nb: { name: "sqlite3_step", parameters: ["pointer"], result: "i32", nonblocking: true },
  sqlite3_column_text: { parameters: ["pointer", "i32"], result: "pointer" },
  sqlite3_reset: { parameters: ["pointer"], result: "i32" },
  sqlite3_finalize: { parameters: ["pointer"], result: "i32" },
  sqlite3_close_v2: { parameters: ["pointer"], result: "i32" },
});
const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
const dbOut = new BigUint64Array(1);
if (sqlite.symbols.sqlite3_open_v2(cstr(file), new Uint8Array(dbOut.buffer), 1 | 0x10000, null) !== 0) {
  throw new Error("open");
}
const db = Deno.UnsafePointer.create(dbOut[0]);
const stmtOut = new BigUint64Array(1);
if (
  sqlite.symbols.sqlite3_prepare_v2(
    db,
    cstr("SELECT body FROM docs WHERE id = ?"),
    -1,
    new Uint8Array(stmtOut.buffer),
    null,
  ) !== 0
) throw new Error("prepare");
const stmt = Deno.UnsafePointer.create(stmtOut[0]);

const ffiLat: number[] = [];
for (const id of ids) {
  const t = performance.now();
  sqlite.symbols.sqlite3_bind_int(stmt, 1, id);
  if (sqlite.symbols.sqlite3_step(stmt) !== 100) throw new Error("step");
  Deno.UnsafePointerView.getCString(sqlite.symbols.sqlite3_column_text(stmt, 0)!);
  sqlite.symbols.sqlite3_reset(stmt);
  ffiLat.push((performance.now() - t) * 1000);
}
const ffiNbLat: number[] = [];
for (const id of ids) {
  const t = performance.now();
  sqlite.symbols.sqlite3_bind_int(stmt, 1, id);
  if ((await sqlite.symbols.sqlite3_step_nb(stmt)) !== 100) throw new Error("step nb");
  Deno.UnsafePointerView.getCString(sqlite.symbols.sqlite3_column_text(stmt, 0)!);
  sqlite.symbols.sqlite3_reset(stmt);
  ffiNbLat.push((performance.now() - t) * 1000);
}
sqlite.symbols.sqlite3_finalize(stmt);
sqlite.symbols.sqlite3_close_v2(db);
sqlite.close();
await Deno.remove(file);
for (const s of ["-wal", "-shm"]) await Deno.remove(file + s).catch(() => {});
console.log(JSON.stringify({
  runtime: `deno ${Deno.version.deno}`,
  node_sqlite_sync_us: pct(nodeLat),
  ffi_blocking_us: pct(ffiLat),
  ffi_nonblocking_us: pct(ffiNbLat),
  notes: [
    "in-process point read on a 1000-row WAL file, prepared statement reused; microseconds per call including JS overhead",
  ],
}));
