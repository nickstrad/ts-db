import assert from "node:assert/strict";
import { Effect, Fiber } from "effect";
import { ConnectionGate } from "../../../platform/sqlite.ts";
import { allAsync, Database } from "../../../platform/sqlite_ffi/mod.ts";
const db = Database.open(":memory:");
const gate = new ConnectionGate(db);
const sql =
  "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n";
let stuck = 0;
for (let i = 0; i < 100; i++) {
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* Effect.fork(
      gate.nonblocking({
        sql,
        execute: (s) => allAsync(s, [], { timeoutMs: 1000 }),
        limits: { deadlineMs: 1000, graceMs: 10 },
        onStuck: Effect.sync(() => {
          stuck++;
        }),
      }),
    );
    if (i % 2) yield* Effect.sleep("1 millis");
    yield* Fiber.interrupt(f);
    yield* gate.blocking(() => {
      assert.equal(db.inFlight, false);
      return Effect.succeed(db.prepare("SELECT 1 AS x").get()?.x);
    });
  }));
}
await new Promise((r) => setTimeout(r, 1050));
assert.equal(stuck, 0);
assert.equal(gate.poisoned, false);
db.close();
console.log(
  "PASS 100 immediate/delayed interrupts: gate released, connection reusable, no late watchdog; load",
  Deno.loadavg(),
);
const file = "agent-work/items/ffi-05-deadline/review-evidence/poison.sqlite";
const holder = Database.open(file);
const victim = Database.open(file, { busyTimeoutMs: 250 });
try {
  holder.exec("CREATE TABLE t(x INTEGER)");
  const { prepareCached } = await import("../../../platform/sqlite_ffi/mod.ts");
  prepareCached(victim, "SELECT * FROM t").all();
  victim.exec("BEGIN");
  assert.equal(victim.inTransaction, true);
  holder.exec("BEGIN EXCLUSIVE");
  const poisonedGate = new ConnectionGate(victim);
  let notified = false;
  await Effect.runPromiseExit(
    poisonedGate.nonblocking({
      sql: "SELECT * FROM t",
      execute: (s) => allAsync(s, [], { timeoutMs: 20 }),
      limits: { deadlineMs: 20, graceMs: 40 },
      onStuck: Effect.sync(() => {
        notified = true;
      }),
    }),
  );
  assert.equal(notified, true);
  assert.equal(poisonedGate.poisoned, true);
  assert.equal(victim.isOpen, false);
  assert.equal(victim.inTransaction, false);
  await Effect.runPromise(poisonedGate.blocking(() => {
    assert.equal(victim.isOpen, false);
    return Effect.void;
  }));
  console.log(
    "PASS stuck step with an open transaction: poisoned, closed, inTransaction=false before a queued caller can proceed; load",
    Deno.loadavg(),
  );
} finally {
  holder.exec("ROLLBACK");
  holder.close();
  await victim.closeAsync();
  await Deno.remove(file);
}
