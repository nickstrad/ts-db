// ffi-sqlite-interrupt.ts: can Deno cancel a running SQLite statement *without* a language switch,
// a worker or a child process? Deno FFI can mark a symbol `nonblocking`, which runs the C call on
// Deno's blocking thread pool and returns a Promise, leaving the event loop free. SQLite documents
// sqlite3_interrupt() as safe to call from another thread. This probe measures both.
//   event_loop_ticks_during_step  10 ms ticks the main loop managed while sqlite3_step ran off-thread
//   interrupt_latency_ms          sqlite3_interrupt() call -> the nonblocking step promise resolving
//   rc                            9 = SQLITE_INTERRUPT
// Permissions: --allow-ffi (system libsqlite3), --allow-env. No files: the database is :memory:.
// Usage: deno run --allow-ffi --allow-env work-scripts/deno/ffi-sqlite-interrupt.ts [libsqlite3 path]
const lib = Deno.args[0] ?? "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0";
const sqlite = Deno.dlopen(lib, {
  sqlite3_libversion: { parameters: [], result: "pointer" },
  sqlite3_open_v2: { parameters: ["buffer", "buffer", "i32", "pointer"], result: "i32" },
  sqlite3_prepare_v2: { parameters: ["pointer", "buffer", "i32", "buffer", "pointer"], result: "i32" },
  sqlite3_step: { parameters: ["pointer"], result: "i32" },
  sqlite3_step_nb: { name: "sqlite3_step", parameters: ["pointer"], result: "i32", nonblocking: true },
  sqlite3_column_int64: { parameters: ["pointer", "i32"], result: "i64" },
  sqlite3_interrupt: { parameters: ["pointer"], result: "void" },
  sqlite3_finalize: { parameters: ["pointer"], result: "i32" },
  sqlite3_close_v2: { parameters: ["pointer"], result: "i32" },
});
const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
const version = Deno.UnsafePointerView.getCString(sqlite.symbols.sqlite3_libversion()!);
const dbOut = new BigUint64Array(1);
const SQLITE_OPEN_READWRITE = 2, SQLITE_OPEN_CREATE = 4, SQLITE_OPEN_FULLMUTEX = 0x10000;
let rc = sqlite.symbols.sqlite3_open_v2(
  cstr(":memory:"),
  new Uint8Array(dbOut.buffer),
  SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
  null,
);
if (rc !== 0) throw new Error("open rc " + rc);
const db = Deno.UnsafePointer.create(dbOut[0]);
const stmtOut = new BigUint64Array(1);
const sql =
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 400000000) SELECT count(*) FROM c";
rc = sqlite.symbols.sqlite3_prepare_v2(db, cstr(sql), -1, new Uint8Array(stmtOut.buffer), null);
if (rc !== 0) throw new Error("prepare rc " + rc);
const stmt = Deno.UnsafePointer.create(stmtOut[0]);

let ticks = 0;
const ticker = setInterval(() => ticks++, 10);
const t0 = performance.now();
const stepping = sqlite.symbols.sqlite3_step_nb(stmt); // Promise<number>, runs on the FFI thread pool
await new Promise((r) => setTimeout(r, 1000));
const ticksDuringStep = ticks;
const tInt = performance.now();
sqlite.symbols.sqlite3_interrupt(db);
const stepRc = await stepping;
const interruptLatency = performance.now() - tInt;
clearInterval(ticker);
sqlite.symbols.sqlite3_finalize(stmt);
sqlite.symbols.sqlite3_close_v2(db);
sqlite.close();
console.log(JSON.stringify({
  runtime: `deno ${Deno.version.deno}`,
  libsqlite3: version,
  step_ran_ms_before_interrupt: Math.round(tInt - t0),
  event_loop_ticks_during_step: ticksDuringStep,
  interrupt_latency_ms: Math.round(interruptLatency * 1000) / 1000,
  rc: stepRc,
  notes: [
    "rc 9 = SQLITE_INTERRUPT",
    "nonblocking FFI symbol runs on Deno's blocking pool; the event loop kept ticking",
  ],
}));
