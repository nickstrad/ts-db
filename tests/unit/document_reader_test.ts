import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Deferred, Effect, Either, Fiber, Option } from "effect";
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
import { type App, EventSink, type ReaderRequest } from "../../platform/services.ts";
import { defineFunctions } from "../../sdk/functions.ts";

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
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    for (const ddl of right(compileDDL(schema))) writer.exec(ddl);
    const insert = right(compileInsert(schema, "games", game, { _id: "game-1", _creationTime: 1 }));
    writer.prepare(insert.text).run(...insert.values);
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
          assert.equal(entered, 100, "cancelled waiter executed after permits were released");
          assert.deepEqual(yield* client.call(request), { id: "game-1" });
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
      const writer = new DatabaseSync(file);
      try {
        writer.exec("PRAGMA journal_mode=WAL");
        for (const ddl of right(compileDDL(app.schema))) writer.exec(ddl);
        for (let i = 1; i <= 3; i++) {
          const insert = right(compileInsert(app.schema, "games", {
            ...game,
            xPlayer: i === 3 ? "céline 😀" : "alice",
          }, { _id: `game-${i}`, _creationTime: i }));
          writer.prepare(insert.text).run(...insert.values);
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
  const writer = new DatabaseSync(file);
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
        assert.equal(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 0);
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
