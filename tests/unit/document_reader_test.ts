import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Cause, Deferred, Effect, Either, Exit, Fiber, Option } from "effect";
import { type StatementDeadlineError, toHttpStatus } from "../../core/errors.ts";
import type { EventRecord, SqlEventRecord, TxEventRecord } from "../../core/events.ts";
import { compileDDL } from "../../core/compile/ddl.ts";
import { compileInsert } from "../../core/compile/write.ts";
import { schema } from "../../app/schema.ts";
import { functions } from "../../app/functions.ts";
import { withStorage } from "../../sdk/schema.ts";
import { ConfigTest } from "../../platform/config.ts";
import { AppRegistryTest } from "../../platform/registry.ts";
import {
  DOCUMENT_READ_CONCURRENCY_CAP,
  makeDocumentReaderClient,
  querySqlite,
} from "../../platform/document_reader.ts";
import { type App, type Config, EventSink, type ReaderRequest } from "../../platform/services.ts";
import { defineFunctions } from "../../sdk/functions.ts";
import { inspect } from "../helpers/sqlite_inspect.ts";

function right<A, E>(value: Either.Either<A, E>): A {
  assert.ok(Either.isRight(value));
  return value.right;
}

const tenantId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const game = {
  xPlayer: "alice",
  oPlayer: "bob",
  board: Array(9).fill(null),
  turn: "X",
  status: "playing",
  winner: null,
};

test("document execution is capped, queued reads are interruptible, and health pings stay responsive", async () => {
  const root = await Deno.makeTempDir({ prefix: "sp05-concurrency-" });
  const file = join(root, "app.sqlite");
  const writer = inspect(file, { write: true });
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    for (const ddl of right(compileDDL(schema))) writer.exec(ddl);
    const insert = right(compileInsert(schema, "games", game, { _id: "game-1", _creationTime: 1 }));
    writer.run(insert.text, insert.values);
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const full = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        let entered = 0;
        const blocking = defineFunctions(schema).query({
          args: {},
          handler: ({ db }) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active++;
                entered++;
                maximum = Math.max(maximum, active);
              }),
              () =>
                Effect.gen(function* () {
                  // Simulate a blocking lookup, then keep the handler alive across a yield.
                  // Purely synchronous JS sections cannot overlap on the same thread.
                  yield* Effect.sync(() => {
                    const until = performance.now() + 2;
                    while (performance.now() < until) { /* blocking SQLite work */ }
                  });
                  const row = yield* db.get("games", "game-1");
                  if (active === DOCUMENT_READ_CONCURRENCY_CAP) yield* Deferred.succeed(full, undefined);
                  yield* Deferred.await(release);
                  return { id: row?._id };
                }),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
        });
        const app: App = { id: "test", file, schema, functions: { blocking }, token: "" };
        yield* Effect.gen(function* () {
          const client = yield* makeDocumentReaderClient({
            call: (request) => {
              assert.equal(request.kind, "ping", "document query reached IPC");
              return Effect.succeed("ready");
            },
          });
          const request = { kind: "query", appId: app.id, name: "blocking", args: {} } as const;
          const reads = yield* Effect.forkScoped(Effect.all(
            Array.from({ length: 100 }, () => client.call(request)),
            { concurrency: "unbounded" },
          ));
          yield* Deferred.await(full).pipe(Effect.timeout("2 seconds"));
          // A timer and the health endpoint's ping must run while the cap is saturated.
          const ping = yield* Effect.sleep("1 millis").pipe(
            Effect.zipRight(client.call({ kind: "ping" })),
            Effect.timeout("1 second"),
          );
          assert.equal(ping, "ready");
          assert.equal(active, DOCUMENT_READ_CONCURRENCY_CAP);
          assert.equal(entered, DOCUMENT_READ_CONCURRENCY_CAP);

          const waiting = yield* client.call(request).pipe(Effect.timeoutOption("20 millis"));
          assert.ok(Option.isNone(waiting), "a parked read must be interruptible by a deadline");
          assert.equal(entered, DOCUMENT_READ_CONCURRENCY_CAP, "cancelled waiter entered the handler");
          yield* Deferred.succeed(release, undefined);
          const results = yield* Fiber.join(reads);
          assert.equal(results.length, 100);
          assert.ok(results.every((result) => (result as { id: string }).id === "game-1"));
          assert.ok(maximum > 1, "execution was accidentally serialized");
          assert.ok(maximum <= DOCUMENT_READ_CONCURRENCY_CAP);
          assert.equal(active, 0);
          assert.equal(entered, 100, "cancelled waiter never entered the handler");
          assert.deepEqual(yield* client.call(request), { id: "game-1" });
          // Second full wave: proves permits and admission slots fully recovered
          // after the cancellation above (a leaked `pending` slot would fail here).
          const wave2 = yield* Effect.all(
            Array.from({ length: 100 }, () => client.call(request)),
            { concurrency: "unbounded" },
          );
          assert.equal(wave2.length, 100);
          assert.ok(wave2.every((result) => (result as { id: string }).id === "game-1"));
        }).pipe(Effect.provide(AppRegistryTest([app])));
      })).pipe(
        Effect.provide(ConfigTest({ reader: { callTimeoutMs: 5000 } })),
        Effect.provideService(EventSink, { emit: () => Effect.void }),
      ),
    );
  } finally {
    writer.close();
    await Deno.remove(root, { recursive: true });
  }
});

for (const tenancy of ["off", "api-key"] as const) {
  for (const layout of ["columns", "json"] as const) {
    test(`document reads match DuckDB: ${tenancy}/${layout}; query never calls IPC`, async () => {
      const root = await Deno.makeTempDir({ prefix: "sp02-parity-" });
      const appId = layout === "columns" ? "tic-tac-toe" : "tic-tac-toe-json";
      const file = join(root, tenancy === "off" ? `${appId}.sqlite` : `${tenantId}.db`);
      const app: App = {
        id: appId,
        file: tenancy === "off" ? file : join(root, "unused-legacy.sqlite"),
        schema: withStorage(schema, layout),
        functions,
        token: "test",
      };
      const writer = inspect(file, { write: true });
      try {
        writer.exec("PRAGMA journal_mode=WAL");
        for (const ddl of right(compileDDL(app.schema))) writer.exec(ddl);
        for (let i = 1; i <= 3; i++) {
          const insert = right(compileInsert(app.schema, "games", {
            ...game,
            xPlayer: i === 3 ? "céline 😀" : "alice",
          }, { _id: `game-${i}`, _creationTime: i }));
          writer.run(insert.text, insert.values);
        }
        const requests: ReaderRequest[] = [
          { kind: "query", appId, name: "getGame", args: { gameId: "game-1" } },
          { kind: "query", appId, name: "getGame", args: { gameId: "missing" } },
          { kind: "query", appId, name: "listGames", args: { status: "playing" } },
          { kind: "query", appId, name: "moveHistory", args: { gameId: "game-1" } },
        ].map((r) => ({
          ...r,
          ...(tenancy === "off" ? {} : { tenant: { id: tenantId, file } }),
        })) as ReaderRequest[];
        const forwarded: ReaderRequest[] = [];
        const local = await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* makeDocumentReaderClient({
              call: (request) => {
                forwarded.push(request);
                assert.notEqual(request.kind, "query", "document query reached IPC");
                return Effect.succeed(request.kind);
              },
            });
            const results: unknown[] = [];
            for (const request of requests) results.push(yield* client.call(request));
            assert.equal(forwarded.length, 0);
            for (
              const request of [
                { kind: "ping" },
                { kind: "ingest" },
                { kind: "analysis", name: "test", params: {} },
              ] as const
            ) assert.equal(yield* client.call(request), request.kind);
            assert.deepEqual(forwarded.map((r) => r.kind), ["ping", "ingest", "analysis"]);
            if (tenancy !== "off") {
              const missing = yield* Effect.either(client.call({
                kind: "query",
                appId,
                name: "getGame",
                args: { gameId: "game-1" },
              }));
              assert.ok(Either.isLeft(missing));
              assert.equal(missing.left._tag, "ReaderError");
            }
            return results;
          }).pipe(
            Effect.provide(
              ConfigTest({ server: { dataDir: root }, tenancy: { mode: tenancy, tenantsDir: root } }),
            ),
            Effect.provide(AppRegistryTest([app])),
            Effect.provideService(EventSink, { emit: () => Effect.void }),
          ),
        );

        // The old path stays in its own OS process: never load DuckDB's SQLite extension here.
        const child = new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "platform/reader.ts"],
          env: { DATA_DIR: root, TENANCY: tenancy, TENANTS_DIR: root, LOG_DIR: join(root, "logs") },
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const input = child.stdin.getWriter();
        await input.write(
          new TextEncoder().encode(requests.map((r, id) => JSON.stringify({ ...r, id }) + "\n").join("")),
        );
        await input.close();
        const output = await child.output();
        assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
        const replies = new TextDecoder().decode(output.stdout).trim().split("\n").map((l) => JSON.parse(l));
        assert.equal(replies.length, requests.length);
        assert.ok(replies.every((r) => !r.error), JSON.stringify(replies));
        assert.deepEqual(local, replies.map((r) => r.result));

        // A separate read-only handle must see committed state during BEGIN IMMEDIATE.
        writer.exec("BEGIN IMMEDIATE");
        writer.exec('DELETE FROM "games"');
        const committed = await Effect.runPromise(
          querySqlite({ ...app, file }, functions.getGame, { gameId: "game-1" }).pipe(
            Effect.provide(ConfigTest()),
            Effect.provideService(EventSink, { emit: () => Effect.void }),
          ),
        );
        assert.deepEqual(committed, local[0]);
        writer.exec("ROLLBACK");

        // A yielding handler retains one snapshot even if the writer commits between selects.
        const snapshot = defineFunctions(app.schema).query({
          args: {},
          handler: ({ db }) =>
            Effect.gen(function* () {
              const before = yield* db.get("games", "game-1");
              yield* Effect.sync(() => writer.exec('DELETE FROM "games"'));
              yield* Effect.yieldNow();
              const after = yield* db.get("games", "game-1");
              return { before, after };
            }),
        });
        const result = await Effect.runPromise(
          querySqlite({ ...app, file }, snapshot, {}).pipe(
            Effect.provide(ConfigTest()),
            Effect.provideService(EventSink, { emit: () => Effect.void }),
          ),
        ) as { before: unknown; after: unknown };
        assert.deepEqual(result.before, local[0]);
        assert.deepEqual(result.after, local[0]);
      } finally {
        writer.close();
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

test("document read-only open does not create a missing database", async () => {
  const root = await Deno.makeTempDir({ prefix: "sp02-missing-" });
  try {
    const file = join(root, "missing.sqlite");
    const result = await Effect.runPromise(
      Effect.either(querySqlite(
        { id: "test", file, schema },
        functions.getGame,
        { gameId: "x" },
      )).pipe(
        Effect.provide(ConfigTest()),
        Effect.provideService(EventSink, { emit: () => Effect.void }),
      ),
    );
    assert.ok(Either.isLeft(result));
    assert.equal(result.left._tag, "ReaderError");
    assert.equal(Array.from(Deno.readDirSync(root)).length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("document deadline expires the context, closes the reader, and releases admission", async () => {
  const root = await Deno.makeTempDir({ prefix: "sp02-deadline-" });
  const file = join(root, "app.sqlite");
  const writer = inspect(file, { write: true });
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    for (const ddl of right(compileDDL(schema))) writer.exec(ddl);
    let escaped: (() => Effect.Effect<unknown, unknown>) | undefined;
    const hanging = defineFunctions(schema).query({
      args: {},
      handler: ({ db }) =>
        Effect.gen(function* () {
          escaped = () => db.get("games", "x");
          yield* db.get("games", "x");
          return yield* Effect.never;
        }),
    });
    const app: App = { id: "test", file, schema, functions: { ...functions, hanging }, token: "" };
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeDocumentReaderClient({ call: () => Effect.die("unexpected IPC") });
        const timed = yield* Effect.either(
          client.call({ kind: "query", appId: app.id, name: "hanging", args: {} }),
        );
        assert.ok(Either.isLeft(timed));
        assert.equal(timed.left._tag, "IpcError");
        assert.ok(escaped);
        const expired = yield* Effect.either(escaped());
        assert.ok(Either.isLeft(expired));
        assert.equal((expired.left as { _tag: string })._tag, "ContextExpiredError");
        assert.equal(
          yield* client.call({
            kind: "query",
            appId: app.id,
            name: "getGame",
            args: { gameId: "missing" },
          }),
          null,
        );
        assert.equal(writer.get("PRAGMA wal_checkpoint(TRUNCATE)")?.busy, 0);
      }).pipe(
        Effect.provide(ConfigTest({ reader: { callTimeoutMs: 50 } })),
        Effect.provide(AppRegistryTest([app])),
        Effect.provideService(EventSink, { emit: () => Effect.void }),
      ),
    );
  } finally {
    writer.close();
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// FFI-05: unbounded selects run nonblocking under the statement deadline
// ---------------------------------------------------------------------------

/**
 * Seed `rows` games with one recursive-CTE statement (seconds faster than one insert per row). The
 * JSON layout makes every non-key filter a `json_extract` per row, so a filtered `count` scans and
 * decodes the whole table: about 200 ms for 200 000 rows on vm-1 at load 0.2, four times the
 * deadline below.
 */
function seedGames(file: string, rows: number): void {
  const json = withStorage(schema, "json");
  const fixture = inspect(file, { write: true });
  try {
    fixture.exec("PRAGMA journal_mode=WAL");
    for (const ddl of right(compileDDL(json))) fixture.exec(ddl);
    const doc = JSON.stringify(game);
    fixture.run(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO "games" ("_id", "_creationTime", "_version", "doc") SELECT 'game-' || i, i, 1, ? FROM n`,
      [rows - 1, doc],
    );
  } finally {
    fixture.close();
  }
}

/**
 * The slack a wall-clock bound gets on a loaded host: 1 up to one runnable task per CPU, then the
 * one-minute load per CPU (plan risk 11: the shared VM's load distorts latency gates, so a gate
 * scales with the load it ran under, which the test prints).
 */
function loadFactor(): { load1: number; cpus: number; factor: number } {
  const load1 = Deno.loadavg()[0];
  const cpus = navigator.hardwareConcurrency;
  return { load1, cpus, factor: Math.max(1, load1 / cpus) };
}

test("FFI-05: an unbounded count stops at the statement deadline (504) while a point read on another file stays blocking and fast", async () => {
  const root = await Deno.makeTempDir({ prefix: "ffi05-deadline-" });
  const big = join(root, "big.sqlite");
  const small = join(root, "small.sqlite");
  try {
    const seedStart = performance.now();
    seedGames(big, 200_000);
    seedGames(small, 3);
    const seedMs = performance.now() - seedStart;
    const appSchema = withStorage(schema, "json");
    const slow = defineFunctions(appSchema).query({
      args: {},
      // Both filters match no index; every row's doc is decoded twice (`xPlayer` matches them all).
      handler: ({ db }) => db.find("games", { xPlayer: "alice", oPlayer: "nobody" }).count(),
    });
    const bigApp = { id: "big", file: big, schema: appSchema };
    const smallApp = { id: "small", file: small, schema: appSchema };
    const events: EventRecord[] = [];
    const deadlineMs = 50;
    const services = <A, E>(effect: Effect.Effect<A, E, Config | EventSink>) =>
      effect.pipe(
        Effect.provide(
          ConfigTest({ sqlite: { statementDeadlineMs: deadlineMs }, logging: { traceSql: true } }),
        ),
        Effect.provideService(EventSink, { emit: (event) => Effect.sync(() => void events.push(event)) }),
      );
    const timed = async <A, E>(effect: Effect.Effect<A, E>) => {
      const started = performance.now();
      const exit = await Effect.runPromiseExit(effect);
      return { exit, ms: performance.now() - started };
    };

    // Warm-up, both paths: library load, first prepare, the blocking pool's first thread, JIT.
    await Effect.runPromise(services(querySqlite(smallApp, functions.getGame, { gameId: "game-0" })));
    await Effect.runPromise(services(querySqlite(smallApp, functions.listGames, { status: "won" })));
    events.length = 0;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

    // 1. The count stops at its deadline with the typed error, not the call timeout's IpcError.
    //    Three runs. The 20 ms budget bounds each run's statement (`elapsedMs`, the binding's own
    //    clock: deadline timer, interrupt, step return) and the median of the whole call's wall
    //    clock, which also pays the call's fixed cost (open, BEGIN, compile, events, ROLLBACK,
    //    close: about 7 ms on vm-1, 3 ms of it the same on a point read before this item).
    const { load1, cpus, factor } = loadFactor();
    const slack = 20 * factor;
    const walls: number[] = [];
    const elapsed: number[] = [];
    for (let run = 0; run < 3; run++) {
      events.length = 0;
      const { exit, ms } = await timed(services(Effect.flip(querySqlite(bigApp, slow, {}))));
      assert.ok(Exit.isSuccess(exit), `the count must fail with a typed error: ${String(exit)}`);
      assert.equal(exit.value._tag, "StatementDeadlineError");
      const failure = exit.value as StatementDeadlineError;
      assert.equal(failure.deadlineMs, deadlineMs);
      assert.equal(failure.table, "games");
      assert.equal(failure.statementKind, "count");
      assert.ok(failure.elapsedMs >= deadlineMs, `elapsedMs ${failure.elapsedMs}`);
      assert.ok(
        failure.elapsedMs <= deadlineMs + slack,
        `statement stopped after ${failure.elapsedMs.toFixed(1)} ms, bound ${deadlineMs + slack}`,
      );
      assert.equal(toHttpStatus(failure), 504);
      walls.push(ms);
      elapsed.push(failure.elapsedMs);

      const sql = events.filter((e): e is SqlEventRecord => e.kind === "sql");
      assert.equal(sql.length, 1, JSON.stringify(sql));
      assert.equal(sql[0].path, "nonblocking");
      assert.equal(sql[0].outcome, "error");
      assert.equal(sql[0].errorTag, "StatementDeadlineError");
      assert.equal(sql[0].level, "error");
      const tx = events.filter((e): e is TxEventRecord => e.kind === "tx");
      assert.equal(tx.length, 1);
      assert.equal(tx[0].outcome, "rollback");
      assert.equal(tx[0].errorTag, "StatementDeadlineError");
      assert.equal(events.filter((e) => e.kind === "lifecycle").length, 0, "no stuck-statement event");
    }
    console.log(
      `FFI-05 deadline ${deadlineMs} ms: call wall ${walls.map((w) => w.toFixed(1)).join(", ")} ms ` +
        `(median ${median(walls).toFixed(1)}), statement elapsed ${
          elapsed.map((e) => e.toFixed(1)).join(", ")
        } ms, ` +
        `bound ${(deadlineMs + slack).toFixed(1)} ms; load1 ${load1.toFixed(2)} on ${cpus} CPUs; seed ${
          seedMs.toFixed(0)
        } ms`,
    );
    assert.ok(
      median(walls) <= deadlineMs + slack,
      `median call wall ${median(walls).toFixed(1)} ms, bound ${deadlineMs + slack}`,
    );

    // 2. Point reads on another file complete while a long statement runs on the pool: five in a
    //    row, all finished before the count hit its deadline (event order), median under 5 ms.
    events.length = 0;
    const longRun = Effect.runPromiseExit(services(querySqlite(bigApp, slow, {})));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const points: number[] = [];
    for (let i = 0; i < 5; i++) {
      const point = await timed(services(querySqlite(smallApp, functions.getGame, { gameId: "game-1" })));
      assert.ok(Exit.isSuccess(point.exit), String(point.exit));
      assert.equal((point.exit.value as { _id?: string })?._id, "game-1");
      points.push(point.ms);
    }
    const longExit = await longRun;
    const pointBound = 5 * factor;
    console.log(
      `FFI-05 point reads during the long count: ${points.map((p) => p.toFixed(2)).join(", ")} ms ` +
        `(median ${median(points).toFixed(2)}), bound ${pointBound.toFixed(1)} ms; load1 ${load1.toFixed(2)}`,
    );
    assert.ok(Exit.isFailure(longExit), "the long count must still have hit its deadline");
    const order = events.filter((e): e is SqlEventRecord => e.kind === "sql");
    assert.deepEqual(
      order.map((e) => [e.path, e.outcome]),
      [...Array(5).fill(["blocking", "ok"]), ["nonblocking", "error"]],
      "every point read finished first, on the blocking path",
    );
    assert.ok(
      median(points) < pointBound,
      `point read median ${median(points).toFixed(2)} ms, bound ${pointBound}`,
    );

    // 3. Through the client, the deadline (not IpcError) reaches the caller, and the next call works.
    const app: App = {
      id: "big",
      file: big,
      schema: appSchema,
      functions: { slow, getGame: functions.getGame },
      token: "",
    };
    await Effect.runPromise(services(
      Effect.gen(function* () {
        const client = yield* makeDocumentReaderClient({ call: () => Effect.die("unexpected IPC") });
        const failed = yield* Effect.either(
          client.call({ kind: "query", appId: "big", name: "slow", args: {} }),
        );
        assert.ok(Either.isLeft(failed));
        assert.equal(failed.left._tag, "StatementDeadlineError");
        const after = yield* client.call({
          kind: "query",
          appId: "big",
          name: "getGame",
          args: { gameId: "game-7" },
        });
        assert.equal((after as { _id?: string } | null)?._id, "game-7");
      }).pipe(Effect.provide(AppRegistryTest([app]))),
    ));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("FFI-05: a forked read queued behind an in-flight read fails ContextExpiredError once COMMIT ran, on both paths, with no late sql event", async () => {
  // Astra review of FFI-05, defect 1. A handler forks a long count (nonblocking, on the pool) and a
  // delayed read, then returns. COMMIT queues behind the count; the delayed read passes `executeIn`'s
  // check (the context is still active) and queues behind COMMIT. When the count settles, COMMIT runs
  // and expires the context in its own step, so the queued read must refuse where it starts: before
  // the repair it ran after COMMIT (outside the snapshot, a `sql` event after the `tx` event) or hit
  // the connection the release had closed (ReaderError "prepare on a closed connection").
  const root = await Deno.makeTempDir({ prefix: "ffi05-escaped-" });
  const file = join(root, "big.sqlite");
  try {
    seedGames(file, 200_000);
    const appSchema = withStorage(schema, "json");
    const app = { id: "big", file, schema: appSchema };
    const { load1 } = loadFactor();
    for (const path of ["blocking", "nonblocking"] as const) {
      // `yielding`: the sink sleeps 5 ms after recording a `tx` event, as a real sink may yield.
      for (const sinkMode of ["immediate", "yielding"] as const) {
        const label = `${path}/${sinkMode}`;
        const events: EventRecord[] = [];
        let slow: Fiber.RuntimeFiber<unknown, unknown> | undefined;
        let late: Fiber.RuntimeFiber<unknown, unknown> | undefined;
        let lateStarted = 0;
        let countSettled = 0;
        const query = defineFunctions(appSchema).query({
          args: {},
          handler: ({ db }) =>
            Effect.gen(function* () {
              // About 200 ms on vm-1 (see `seedGames`), far under the default 5 s statement deadline.
              slow = yield* Effect.forkDaemon(
                db.find("games", { xPlayer: "alice", oPlayer: "nobody" }).count(),
              );
              late = yield* Effect.forkDaemon(Effect.zipRight(
                Effect.sleep("10 millis"),
                Effect.suspend((): Effect.Effect<unknown, unknown> => {
                  lateStarted = performance.now();
                  // `get` by `_id` is bounded (blocking path); a filtered `count` is unbounded.
                  return path === "blocking"
                    ? db.get("games", "game-1")
                    : db.find("games", { oPlayer: "nobody" }).count();
                }),
              ));
              yield* Effect.sleep("2 millis");
              return null;
            }),
        });
        const started = performance.now();
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const exit = yield* Effect.exit(querySqlite(app, query, {}));
            const slowExit = yield* Fiber.await(slow!);
            const lateExit = yield* Fiber.await(late!);
            return { exit, slowExit, lateExit };
          }).pipe(
            Effect.provide(ConfigTest({ logging: { traceSql: true } })),
            Effect.provideService(EventSink, {
              emit: (event) =>
                Effect.zipRight(
                  Effect.sync(() => {
                    if (event.kind === "sql" && countSettled === 0) countSettled = performance.now();
                    events.push(event);
                  }),
                  sinkMode === "yielding" && event.kind === "tx" ? Effect.sleep("5 millis") : Effect.void,
                ),
            }),
          ),
        );
        const sql = events.filter((e): e is SqlEventRecord => e.kind === "sql");
        const tx = events.filter((e): e is TxEventRecord => e.kind === "tx");
        console.log(
          `FFI-05 escaped read ${label}: late read began at ${(lateStarted - started).toFixed(1)} ms, ` +
            `count settled at ${(countSettled - started).toFixed(1)} ms; load1 ${load1.toFixed(2)}`,
        );
        assert.ok(Exit.isSuccess(result.exit), `${label}: handler ${String(result.exit)}`);
        assert.equal(result.exit.value, null);
        // The count ran inside the transaction: count 0 (no `oPlayer` is "nobody").
        assert.ok(Exit.isSuccess(result.slowExit), `${label}: count ${String(result.slowExit)}`);
        assert.equal(result.slowExit.value, 0);
        // Fixture check: the late read began while the count was still on the pool, so it queued
        // behind the count (and behind COMMIT) rather than meeting an already-expired context.
        assert.ok(sql.length >= 1 && sql[0].path === "nonblocking", `${label}: ${JSON.stringify(sql)}`);
        assert.ok(
          lateStarted > 0 && lateStarted < countSettled,
          `${label}: the late read must begin before the count settles`,
        );
        // The queued read refused where it reached the connection: expected ContextExpiredError,
        // the pre-FFI-05 outcome, and no statement ran.
        assert.ok(Exit.isFailure(result.lateExit), `${label}: late read ${String(result.lateExit)}`);
        const failure = Cause.failureOption(result.lateExit.cause);
        assert.ok(Option.isSome(failure), `${label}: ${String(result.lateExit.cause)}`);
        assert.equal((failure.value as { _tag: string })._tag, "ContextExpiredError", label);
        // Only the count's `sql` event, and it precedes the transaction's completion event.
        assert.deepEqual(sql.map((e) => [e.path, e.outcome]), [["nonblocking", "ok"]], label);
        assert.equal(tx.length, 1, label);
        assert.equal(tx[0].outcome, "commit", label);
        assert.equal(tx[0].operations, 1, `${label}: the refused read is not an operation`);
        assert.ok(events.indexOf(sql[0]) < events.indexOf(tx[0]), `${label}: sql event after tx`);
        assert.equal(events.at(-1), tx[0], `${label}: nothing recorded after the tx event`);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
