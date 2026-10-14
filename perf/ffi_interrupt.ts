// Production-binding port of research/fable-lang-switch:work-scripts/deno/ffi-sqlite-interrupt.ts.
// Run: deno run -A perf/ffi_interrupt.ts (50 one-second iterations).
import assert from "node:assert/strict";
import { Database, SqliteCancelled } from "../platform/sqlite_ffi/mod.ts";
const loadavg = Deno.loadavg();
const db = Database.open(":memory:");
const samples: {
  step_ran_ms_before_interrupt: number;
  event_loop_ticks_during_step: number;
  interrupt_latency_ms: number;
}[] = [];
try {
  const statement = db.prepare(
    "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT count(*) FROM c",
  );
  for (let i = 0; i < 50; i++) {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    try {
      const t0 = performance.now();
      const controller = new AbortController();
      const stepping = statement.allAsync(undefined, { signal: controller.signal }).then(
        () => {
          throw new Error("unbounded statement completed");
        },
        (e: unknown) => {
          if (!(e instanceof SqliteCancelled)) throw e;
          return e;
        },
      );
      await new Promise((r) => setTimeout(r, 1000));
      const ticksDuringStep = ticks;
      const tInt = performance.now();
      controller.abort();
      await stepping;
      samples.push({
        step_ran_ms_before_interrupt: Math.round(tInt - t0),
        event_loop_ticks_during_step: ticksDuringStep,
        interrupt_latency_ms: +(performance.now() - tInt).toFixed(3),
      });
    } finally {
      clearInterval(ticker);
    }
  }
  const latencies = samples.map((s) => s.interrupt_latency_ms).sort((a, b) => a - b);
  const worst = samples.reduce((a, b) => a.interrupt_latency_ms > b.interrupt_latency_ms ? a : b);
  console.log(JSON.stringify({
    runtime: `deno ${Deno.version.deno}`,
    libsqlite3: db.library.version,
    loadavg,
    ...worst,
    iterations: samples.length,
    samples,
    interrupt_latency_p99_ms: latencies[Math.ceil(0.99 * latencies.length) - 1],
    min_event_loop_ticks: Math.min(...samples.map((s) => s.event_loop_ticks_during_step)),
    notes: [
      "no rc field: SqliteCancelled carries no result code, so the typed cancellation settlement is the measurement (the PoC read the raw step rc, 9 = SQLITE_INTERRUPT)",
      "top-level PoC fields describe the slowest interrupt",
    ],
  }));
  assert.ok(latencies[49] <= 20, "interrupt p99 <= 20 ms");
  assert.ok(samples.every((s) => s.event_loop_ticks_during_step >= 90), "loop ticks >= 90/100");
} finally {
  await db.closeAsync();
}
