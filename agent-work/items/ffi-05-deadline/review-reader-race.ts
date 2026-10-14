/** Review-only reproduction of FFI-05 reader context expiry after waiting at the gate.
 * Run: deno run -A agent-work/items/ffi-05-deadline/review-reader-race.ts delay-sink
 * Expected: late read fails ContextExpiredError. At 6246f9d it succeeds after COMMIT.
 * Without delay-sink it instead attempts prepare after close and fails ReaderError.
 * The prototype wrappers only record native call ordering; they delegate unchanged.
 */
import { Effect, Either, Fiber } from "effect";
import { querySqlite } from "../../../platform/document_reader.ts";
import { Database, Statement } from "../../../platform/sqlite_ffi/mod.ts";
import { ConfigTest } from "../../../platform/config.ts";
import { EventSink } from "../../../platform/services.ts";
import { defineFunctions } from "../../../sdk/functions.ts";
import { defineSchema, defineTable, v, withStorage } from "../../../sdk/schema.ts";
import { compileDDL } from "../../../core/compile/ddl.ts";
const schema = withStorage(defineSchema({ t: defineTable({ value: v.string() }) }), "json");
const file = "agent-work/items/ffi-05-deadline/review-evidence/race.sqlite";
const seed = Database.open(file);
for (const ddl of Either.getOrThrow(compileDDL(schema))) seed.exec(ddl);
seed.exec(
  `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<199999) INSERT INTO t (_id,_creationTime,_version,doc) SELECT 'id-'||i,i,1,'{"value":"abc"}' FROM n`,
);
seed.close();
const log: unknown[] = [];
const exec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  log.push(["exec", sql]);
  return exec.call(this, sql);
};
const all = Statement.prototype.all;
Statement.prototype.all = function (p) {
  log.push(["all", this.sql]);
  return all.call(this, p);
};
let slow: Fiber.RuntimeFiber<unknown, unknown>;
let late: Fiber.RuntimeFiber<unknown, unknown>;
const query = defineFunctions(schema).query({
  args: {},
  handler: ({ db }) =>
    Effect.gen(function* () {
      slow = yield* Effect.forkDaemon(db.find("t", { value: "none" }).count());
      late = yield* Effect.forkDaemon(Effect.zipRight(Effect.sleep("10 millis"), db.get("t", "id-1")));
      yield* Effect.sleep("2 millis");
      return null;
    }),
});
const result = await Effect.runPromiseExit(
  querySqlite({ id: "test", file, schema }, query, {}).pipe(
    Effect.provide(ConfigTest({ sqlite: { statementDeadlineMs: 5000 }, logging: { traceSql: true } })),
    Effect.provideService(EventSink, {
      emit: (event) =>
        Effect.zipRight(
          Effect.sync(() => {
            log.push([
              event.kind,
              event.kind === "sql" ? event.outcome : event.kind === "tx" ? event.outcome : "",
            ]);
          }),
          Deno.args.includes("delay-sink") && event.kind === "tx" ? Effect.sleep("5 millis") : Effect.void,
        ),
    }),
  ),
);
console.log("load", Deno.loadavg(), "mode", Deno.args);
console.log("result", result);
console.log("slow", await Effect.runPromise(Fiber.await(slow!)));
console.log("late", await Effect.runPromise(Fiber.await(late!)));
console.log("order", log);
Database.prototype.exec = exec;
Statement.prototype.all = all;
await Deno.remove(file);
