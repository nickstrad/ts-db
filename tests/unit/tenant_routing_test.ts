import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { ConfigTest } from "../../platform/config.ts";
import { EventSink, IdGen, type StorageService } from "../../platform/services.ts";
import { makeStorage, type TenantCacheOptions } from "../../platform/sqlite.ts";
import {
  LocalFolderRouter,
  makeLocalFolderRouter,
  parseTenantId,
  type StorageLocation,
  TenantContext,
  type TenantId,
  TenantStorageRouter,
  type TenantStorageRouterService,
} from "../../platform/tenants/routing.ts";
import { defineFunctions } from "../../sdk/functions.ts";
import { defineSchema, defineTable, v } from "../../sdk/schema.ts";

const schema = defineSchema({ counters: defineTable({ value: v.number() }) });
const app = defineFunctions(schema);
const increment = app.mutation({
  args: {},
  handler: ({ db }) =>
    Effect.gen(function* () {
      const rows = yield* db.find("counters").collect();
      yield* Effect.yieldNow();
      if (rows.length) yield* db.patch("counters", rows[0]._id, { value: rows[0].value + 1 });
      else yield* db.insert("counters", { value: 1 });
    }),
});
const read = app.mutation({ args: {}, handler: ({ db }) => db.find("counters").collect() });
const ids = Array.from(
  { length: 5 },
  (_, n) => Effect.runSync(parseTenantId(`aaaaaaaa-0000-4000-8000-00000000000${n}`)),
);
const asTenant = <A, E, R>(id: TenantId, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(TenantContext, { tenantId: id }));
const typedFailure = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.failureOption(exit.cause);
  assert.equal(failure._tag, "Some");
  if (failure._tag !== "Some") throw new Error("Expected typed failure");
  return failure.value;
};

async function harness(
  run: (storage: StorageService, opens: Map<string, number>, dir: string) => Effect.Effect<void, unknown>,
  cache: TenantCacheOptions = {},
  mode: "api-key" | "better-auth" | "off" = "api-key",
) {
  const dir = mkdtempSync(join(tmpdir(), "tenant-routing-"));
  const opens = new Map<string, number>();
  const handles: DatabaseSync[] = [];
  const local = makeLocalFolderRouter(dir, schema);
  // A stub router is the only source of storage locations. Config's tenantsDir and options.file
  // deliberately point elsewhere. Count persistent writer opens separately from prepare's DDL handle.
  const router: TenantStorageRouterService = {
    resolve: local.resolve,
    prepare: local.prepare,
  };
  const counted: TenantStorageRouterService = {
    resolve: (id) =>
      Effect.map(router.resolve(id), (location) => ({
        ...location,
        open: () => {
          opens.set(id, (opens.get(id) ?? 0) + 1);
          const db = location.open();
          handles.push(db);
          assert.ok(handles.filter((handle) => handle.isOpen).length <= (cache.capacity ?? 64));
          return db;
        },
      })),
    // Keep the issuer's capability intact for prepare, while instrumenting the writer open.
    prepare: (location) =>
      Effect.flatMap(
        local.resolve(
          ids.find((id) => location.path.endsWith(`${id}.db`))!,
        ),
        local.prepare,
      ),
  };
  try {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const storage = yield* makeStorage({ file: join(dir, "legacy.db"), schema }, cache);
        yield* run(storage, opens, dir);
      })).pipe(Effect.provide(Layer.mergeAll(
        ConfigTest({ tenancy: { mode, tenantsDir: "/unused/router-only" } }),
        Layer.succeed(TenantStorageRouter, counted),
        Layer.succeed(EventSink, { emit: () => Effect.void }),
        Layer.succeed(IdGen, { next: Effect.succeed("same-document-id") }),
      ))),
    );
    assert.ok(handles.every((handle) => !handle.isOpen), "scope closed every cached handle");
    if (mode !== "off") assert.equal(existsSync(join(dir, "legacy.db")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("router rejects traversal and every non-canonical UUID form without I/O", async () => {
  const local = makeLocalFolderRouter("/unused", schema);
  for (
    const input of [
      "../x",
      ids[0].toUpperCase(),
      `urn:uuid:${ids[0]}`,
      `${ids[0]}\0`,
      ` ${ids[0]}`,
      `${ids[0]}\n`,
      `%61${ids[0].slice(1)}`,
      ids[0].replaceAll("-", ""),
      "a/b",
    ]
  ) {
    const error = typedFailure(await Effect.runPromiseExit(local.resolve(input as TenantId)));
    assert.equal(error._tag, "MalformedTenantId");
  }
  const first = await Effect.runPromise(local.resolve(ids[0]));
  const second = await Effect.runPromise(local.resolve(ids[0]));
  assert.deepStrictEqual(first, second);
});

test("prepare is idempotent, rejects forged locations and refuses symlinks at prepare and open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-path-"));
  try {
    const router = makeLocalFolderRouter(dir, schema);
    const location = await Effect.runPromise(router.resolve(ids[0]));
    await Effect.runPromise(router.prepare(location));
    await Effect.runPromise(router.prepare(location));
    const forged = { ...location, path: join(dir, "escape.db") } as StorageLocation;
    assert.equal(typedFailure(await Effect.runPromiseExit(router.prepare(forged)))._tag, "UnknownTenant");
    rmSync(location.path);
    symlinkSync(join(dir, "other.db"), location.path);
    assert.equal(typedFailure(await Effect.runPromiseExit(router.prepare(location)))._tag, "UnknownTenant");
    assert.throws(() => location.open(), { _tag: "StorageError", detail: /regular|symlink/ });
    assert.equal(existsSync(join(dir, "other.db")), false);
    rmSync(location.path);
    await Effect.runPromise(router.prepare(location));
    symlinkSync(join(dir, "outside"), `${location.path}-wal`);
    assert.throws(() => location.open(), { _tag: "StorageError", detail: /regular|symlink/ });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("50 concurrent writes across 5 fiber-local tenants isolate identical document ids; single-flight opens", async () => {
  await harness((storage, opens) =>
    Effect.gen(function* () {
      yield* Effect.all(
        Array.from({ length: 50 }, (_, n) => asTenant(ids[n % 5], storage.mutation(increment, {}))),
        { concurrency: "unbounded" },
      );
      for (const id of ids) {
        const rows = yield* asTenant(id, storage.mutation(read, {}));
        assert.equal((rows as { value: number }[])[0].value, 10);
        assert.equal((rows as { _id: string }[])[0]._id, "same-document-id");
        assert.equal(opens.get(id), 1);
      }
      assert.equal(typedFailure(yield* Effect.exit(storage.mutation(read, {})))._tag, "StorageError");
    })
  );
});

for (const mode of ["api-key", "better-auth"] as const) {
  test(`${mode} fails closed for mutation and snapshot without TenantContext`, async () => {
    await harness(
      (storage, opens, dir) =>
        Effect.gen(function* () {
          for (const operation of [storage.mutation(read, {}), storage.snapshot(join(dir, "snapshot.db"))]) {
            assert.equal(typedFailure(yield* Effect.exit(operation))._tag, "StorageError");
          }
          assert.equal(opens.size, 0);
          assert.equal(existsSync(join(dir, "snapshot.db")), false);
        }),
      {},
      mode,
    );
  });
}

test("tenancy off chooses legacy storage even when a TenantContext is provided", async () => {
  await harness(
    (storage, opens) =>
      Effect.gen(function* () {
        yield* asTenant(ids[0], storage.mutation(increment, {}));
        const rows = yield* asTenant(ids[1], storage.mutation(read, {}));
        assert.equal((rows as { value: number }[])[0].value, 1);
        assert.equal(opens.size, 0);
      }),
    {},
    "off",
  );
});

test("bounded eviction under concurrent load retains writes and never closes a leased handle", async () => {
  await harness((storage, opens) =>
    Effect.gen(function* () {
      yield* Effect.all(
        Array.from({ length: 50 }, (_, n) => asTenant(ids[n % 5], storage.mutation(increment, {}))),
        { concurrency: "unbounded" },
      );
      for (const id of ids) {
        const rows = yield* asTenant(id, storage.mutation(read, {}));
        assert.equal((rows as { value: number }[])[0].value, 10);
      }
      assert.ok([...opens.values()].reduce((a, b) => a + b, 0) > 5, "eviction reopened handles");
    }), { capacity: 2, idleMs: 5 });
});

test("interrupted capacity waiter and active mutation release leases; idle eviction reopens", async () => {
  await harness((storage, opens) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blocked = app.mutation({
        args: {},
        handler: () => Effect.zipRight(Deferred.succeed(entered, undefined), Effect.never),
      });
      const active = yield* Effect.fork(asTenant(ids[0], storage.mutation(blocked, {})));
      yield* Deferred.await(entered);
      const waiting = yield* Effect.fork(asTenant(ids[1], storage.mutation(increment, {})));
      yield* Effect.sleep(20);
      assert.equal(opens.size, 1);
      yield* Fiber.interrupt(waiting);
      yield* Fiber.interrupt(active);
      yield* asTenant(ids[1], storage.mutation(increment, {}));
      yield* Effect.sleep(30);
      yield* asTenant(ids[1], storage.mutation(increment, {}));
      assert.equal(opens.get(ids[1]), 2);
    }), { capacity: 1, idleMs: 5 });
});

test("LocalFolderRouter layer uses config; enabled Storage requires a router at startup", async () => {
  const router = await Effect.runPromise(TenantStorageRouter.pipe(
    Effect.provide(
      LocalFolderRouter(schema).pipe(Layer.provide(ConfigTest({
        tenancy: { tenantsDir: "/configured/tenants" },
      }))),
    ),
  ));
  assert.equal((await Effect.runPromise(router.resolve(ids[0]))).path, `/configured/tenants/${ids[0]}.db`);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(makeStorage({ file: "/unused", schema })).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigTest({ tenancy: { mode: "api-key" } }),
          Layer.succeed(EventSink, { emit: () => Effect.void }),
          Layer.succeed(IdGen, { next: Effect.succeed("id") }),
        ),
      ),
    ),
  );
  assert.equal(typedFailure(exit)._tag, "StorageError");
});

test("scope shutdown waits for an active tenant lease and rejects subsequent operations", async () => {
  await harness(() =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const storage = yield* makeStorage({ file: "/unused", schema }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocked = app.mutation({
        args: {},
        handler: () => Effect.zipRight(Deferred.succeed(entered, undefined), Deferred.await(release)),
      });
      const active = yield* Effect.fork(asTenant(ids[0], storage.mutation(blocked, {})));
      yield* Deferred.await(entered);
      const closing = yield* Effect.fork(Scope.close(scope, Exit.void));
      yield* Effect.sleep(10);
      assert.equal((yield* Fiber.poll(closing))._tag, "None");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(active);
      yield* Fiber.join(closing);
      assert.equal(
        typedFailure(yield* Effect.exit(asTenant(ids[0], storage.mutation(read, {}))))._tag,
        "StorageError",
      );
    }).pipe(Effect.provide(Layer.mergeAll(
      ConfigTest({ tenancy: { mode: "api-key" } }),
      Layer.succeed(EventSink, { emit: () => Effect.void }),
      Layer.succeed(IdGen, { next: Effect.succeed("id") }),
    )))
  );
});
