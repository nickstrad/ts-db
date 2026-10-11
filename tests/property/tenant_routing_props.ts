/** MT-09: routing, registry gating and real-file isolation. PROP_SEED replays via arbitraries.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Either, Layer } from "effect";
import fc from "fast-check";
import { MalformedTenantId, TenantDeactivated, UnknownTenant } from "../../core/errors.ts";
import { ConfigTest } from "../../platform/config.ts";
import { EventSink, IdGen } from "../../platform/services.ts";
import { makeStorage } from "../../platform/sqlite.ts";
import { parseTenantId, type TenantId, type TenantRegistryService } from "../../platform/tenants/registry.ts";
import { makeLocalFolderRouter, TenantContext, TenantStorageRouter } from "../../platform/tenants/routing.ts";
import { defineFunctions } from "../../sdk/functions.ts";
import { defineSchema, defineTable, v } from "../../sdk/schema.ts";
import { check, NUM_RUNS, SEED, titled } from "./arbitraries.ts";

const schema = defineSchema({ documents: defineTable({ owner: v.string(), value: v.integer() }) });
const app = defineFunctions(schema);
const tenantIdArb = fc.uuid().map((id) => Effect.runSync(parseTenantId(id)));
const tenantSetArb = fc.uniqueArray(tenantIdArb, { minLength: 2, maxLength: 3 });
const malformedArbs = {
  traversal: fc.string().map((s) => `../${s}`),
  separators: fc.tuple(tenantIdArb, fc.constantFrom("/", "\\")).map(([id, s]) => `${id}${s}x`),
  unicode: fc.constantFrom("é", "日", "😀").map((s) => `${s}-0000-0000-0000-000000000000`),
  empty: fc.constant(""),
  uppercase: tenantIdArb.map((id) => `A${id.slice(1)}`),
  urn: tenantIdArb.map((id) => `urn:uuid:${id}`),
  nul: tenantIdArb.map((id) => `${id}\0`),
  whitespace: fc.tuple(tenantIdArb, fc.constantFrom(" ", "\n", "\t")).map(([id, s]) => `${s}${id}${s}`),
  encoded: tenantIdArb.map((id) => `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`),
  unhyphenated: tenantIdArb.map((id) => id.replaceAll("-", "")),
};
const malformedArb = fc.oneof(...Object.values(malformedArbs));
const stateArb = fc.constantFrom("active", "deactivated", "unknown");
const opArb = fc.record({
  kind: fc.constantFrom("put", "get", "del"),
  value: fc.integer({ min: -99, max: 99 }),
});
const loadArb = tenantSetArb.chain((ids) =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 16 }).filter((id) => !id.includes("\0")),
    fc.array(fc.array(opArb, { minLength: 1, maxLength: 3 }), {
      minLength: ids.length,
      maxLength: ids.length,
    }),
    fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 2, maxLength: 3 }),
  ).map(([docId, sequences, deltas]) => ({ ids, docId, sequences, deltas }))
);
const title = (name: string) => titled(`${name} [runs=${NUM_RUNS}]`);

// Generator coverage is a separate test: a coverage miss is not an invariant failure.
test(title("tenant routing generators: malformed categories, registry states and operations occur"), () => {
  // The UUID property visits every malformed category on every run, without probabilistic coverage.
  assert.deepEqual(
    new Set(fc.sample(stateArb, { seed: SEED, numRuns: 200 })),
    new Set(["active", "deactivated", "unknown"]),
  );
  assert.deepEqual(
    new Set(fc.sample(opArb, { seed: SEED, numRuns: 200 }).map((op) => op.kind)),
    new Set(["put", "get", "del"]),
  );
});

test(title("tenant routing: canonical UUIDs parse unchanged and malformed forms are typed failures"), () => {
  check(fc.property(tenantIdArb, fc.tuple(...Object.values(malformedArbs)), (id, inputs) => {
    assert.equal(Effect.runSync(parseTenantId(id)), id);
    const router = makeLocalFolderRouter("/unused/tenants", schema);
    for (const input of inputs) {
      for (
        const result of [
          Effect.runSync(Effect.either(parseTenantId(input))),
          Effect.runSync(Effect.either(router.resolve(input as TenantId))),
        ]
      ) {
        assert.ok(result._tag === "Left");
        assert.ok(result.left instanceof MalformedTenantId);
        assert.equal(result.left.input, input);
      }
    }
  }));
});

test(title("tenant routing: repeated resolution yields deep-equal locations"), () => {
  check(fc.property(tenantIdArb, (id) => {
    const router = makeLocalFolderRouter("/unused/tenants", schema);
    assert.deepEqual(Effect.runSync(router.resolve(id)), Effect.runSync(router.resolve(id)));
  }));
});

test(title("tenant routing: distinct parsed ids have distinct files"), () => {
  check(fc.property(tenantSetArb, (ids) => {
    const router = makeLocalFolderRouter("/unused/tenants", schema);
    const paths = ids.map((id) => Effect.runSync(router.resolve(id)).path);
    assert.equal(new Set(paths).size, ids.length);
  }));
});

test(
  title("tenant routing: arbitrary strings fail typed or remain strictly inside the normalized root"),
  () => {
    check(fc.property(fc.oneof(fc.string(), malformedArb, tenantIdArb), (input) => {
      const root = resolve("/unused/tenants/child/..");
      const router = makeLocalFolderRouter(root, schema);
      // A thrown exception or Effect defect fails the property; either captures only typed failures.
      const result = Effect.runSync(Effect.either(router.resolve(input as TenantId)));
      if (Either.isLeft(result)) assert.ok(result.left instanceof MalformedTenantId);
      else {
        const child = relative(root, resolve(result.right.path));
        assert.ok(child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
        assert.equal(result.right.path, join(root, `${input}.db`));
      }
    }));
  },
);

// Registry exposes getTenant, not authorize. Compose the request's state gate explicitly with
// the real router; the stub supplies only registry state, never routing or storage behavior.
test(
  title("tenant routing: authorize -> resolve -> prepare gates each registry state before I/O"),
  async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.record({ id: tenantIdArb, state: stateArb }), {
        selector: (row) => row.id,
        minLength: 2,
        maxLength: 4,
      }),
      async (rows) => {
        const dir = mkdtempSync(join(tmpdir(), "tenant-gating-prop-"));
        const registry: Pick<TenantRegistryService, "getTenant"> = {
          getTenant: (id) => {
            const row = rows.find((row) => row.id === id);
            return !row || row.state === "unknown"
              ? Effect.fail(new UnknownTenant({ tenantId: id }))
              : Effect.succeed({ id, slug: id, name: id, status: row.state, createdAt: new Date(0) });
          },
        };
        try {
          const router = makeLocalFolderRouter(dir, schema);
          for (const { id, state } of rows) {
            const result = await Effect.runPromise(Effect.either(Effect.gen(function* () {
              const tenant = yield* registry.getTenant(id);
              if (tenant.status === "deactivated") return yield* new TenantDeactivated({ tenantId: id });
              const location = yield* router.resolve(tenant.id);
              yield* router.prepare(location);
              return location;
            })));
            if (state === "active") {
              assert.ok(Either.isRight(result));
              assert.equal(result.right.path, join(dir, `${id}.db`));
              assert.ok(existsSync(result.right.path));
            } else {
              assert.ok(Either.isLeft(result));
              assert.ok(
                state === "unknown"
                  ? result.left instanceof UnknownTenant
                  : result.left instanceof TenantDeactivated,
              );
              assert.equal(existsSync(join(dir, `${id}.db`)), false);
            }
          }
          assert.deepEqual(
            readdirSync(dir).filter((name) => name.endsWith(".db")).sort(),
            rows.filter((row) => row.state === "active").map((row) => `${row.id}.db`).sort(),
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ));
  },
);

test(
  title(
    "tenant routing: concurrent tenant operations isolate reads, retain updates and persist to the right file",
  ),
  async () => {
    await fc.assert(fc.asyncProperty(loadArb, async ({ ids, docId, sequences, deltas }) => {
      const dir = mkdtempSync(join(tmpdir(), "tenant-load-prop-"));
      const router = makeLocalFolderRouter(dir, schema);
      const asTenant = <A, E, R>(id: TenantId, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(TenantContext, { tenantId: id }));
      const read = app.mutation({ args: {}, handler: ({ db }) => db.get("documents", docId) });
      const put = (owner: string, value: number, increment = false) =>
        app.mutation({
          args: {},
          handler: ({ db }) =>
            Effect.gen(function* () {
              const before = yield* db.get("documents", docId);
              yield* Effect.yieldNow();
              if (before) {
                yield* db.patch("documents", docId, {
                  owner,
                  value: increment ? before.value + value : value,
                });
              } else yield* db.insert("documents", { owner, value });
            }),
        });
      try {
        await Effect.runPromise(
          Effect.scoped(Effect.gen(function* () {
            const storage = yield* makeStorage({ file: join(dir, "legacy.db"), schema });
            yield* Effect.forEach(ids, (id, index) =>
              asTenant(
                id,
                Effect.gen(function* () {
                  // A generated transaction per tenant keeps 200 real-file runs bounded. Reads
                  // check every operation; independent racing transactions below check commits.
                  const sequence = app.mutation({
                    args: {},
                    handler: ({ db }) =>
                      Effect.gen(function* () {
                        let expected: number | undefined;
                        assert.equal(yield* db.get("documents", docId), null);
                        for (const op of sequences[index]) {
                          yield* Effect.yieldNow();
                          if (op.kind === "put") {
                            if (expected === undefined) {
                              yield* db.insert("documents", { owner: id, value: op.value });
                            } else yield* db.patch("documents", docId, { owner: id, value: op.value });
                            expected = op.value;
                          } else if (op.kind === "del" && expected !== undefined) {
                            yield* db.delete("documents", docId);
                            expected = undefined;
                          }
                          const actual = yield* db.get("documents", docId);
                          if (expected === undefined) {
                            assert.equal(actual, null);
                          } else {
                            assert.equal(actual!.owner, id);
                            assert.equal(actual!.value, expected);
                          }
                        }
                        if (expected === undefined) {
                          yield* db.insert("documents", { owner: id, value: index });
                        } else yield* db.patch("documents", docId, { owner: id, value: index });
                      }),
                  });
                  yield* storage.mutation(sequence, {});
                  const committed = yield* storage.mutation(read, {});
                  assert.equal((committed as { owner: string }).owner, id);
                  assert.equal((committed as { value: number }).value, index);
                  yield* Effect.forEach(deltas, (delta) => storage.mutation(put(id, delta, true), {}), {
                    concurrency: "unbounded",
                  });
                  const actual = yield* storage.mutation(read, {});
                  assert.equal((actual as { owner: string }).owner, id);
                  assert.equal(
                    (actual as { value: number }).value,
                    index + deltas.reduce((a, b) => a + b, 0),
                  );
                }),
              ), { concurrency: "unbounded" });
          })).pipe(Effect.provide(Layer.mergeAll(
            ConfigTest({ tenancy: { mode: "api-key", tenantsDir: "/unused/router-only" } }),
            Layer.succeed(TenantStorageRouter, router),
            Layer.succeed(EventSink, { emit: () => Effect.void }),
            Layer.succeed(IdGen, { next: Effect.succeed(docId) }),
          ))),
        );
        assert.equal(existsSync(join(dir, "legacy.db")), false);
        for (const [index, id] of ids.entries()) {
          const location = Effect.runSync(router.resolve(id));
          assert.equal(location.path, join(dir, `${id}.db`));
          const db = new DatabaseSync(location.path, { readOnly: true });
          try {
            assert.deepEqual(
              db.prepare('SELECT "_id", owner, value FROM documents').all().map((row) => ({ ...row })),
              [{
                _id: docId,
                owner: id,
                value: index + deltas.reduce((a, b) => a + b, 0),
              }],
            );
          } finally {
            db.close();
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));
  },
);
