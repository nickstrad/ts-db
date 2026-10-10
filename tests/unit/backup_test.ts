/**
 * Unit tests for the `Backups` service (plan item 19).
 *
 * Item 20's `StorageTest` / `ObjectStoreTest` had not landed when this was written, so the doubles are
 * local and inline (owned by this item, per the plan): a `Storage` whose `snapshot` writes a small real
 * SQLite file (or garbage, or blocks on a gate), and an in-memory `ObjectStore` with per-key failure and
 * gate injection. The event-ordering and round-trip tests use the real `StorageLive` and the real
 * `ObjectStoreLocal`, because the no-duplicate-`put-object` contract is about the real store's events.
 *
 * The three behaviours the plan calls out get the most attention: a failed snapshot-object upload leaves
 * `latest.json` unchanged; interrupting `take` mid-upload releases the per-app guard and removes the
 * temp directory; two concurrent `take`s for one app yield exactly one `BackupAlreadyRunning`.
 *
 * The real-S3 round trip at the end runs only with `S3_INTEGRATION=1` (see
 * `tests/integration/object_store_s3_test.ts` for the SeaweedFS setup).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AwsClient } from "aws4fetch";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import {
  BackupAlreadyRunning,
  BackupError,
  ObjectStoreError,
  SnapshotIntegrityError,
  StorageError,
} from "../../core/errors.ts";
import type { BackupEventRecord, EventRecord } from "../../core/events.ts";
import {
  Backups as LegacyBackups,
  BackupsLive,
  integrityCheck,
  makeBackupRunner,
  type SnapshotSource,
  verifySnapshot,
} from "../../platform/backup.ts";
import { ConfigTest } from "../../platform/config.ts";
import { makeObjectStoreLocal, makeObjectStoreS3, sha256 } from "../../platform/object_store.ts";
import {
  Backups,
  EventSink,
  IdGen,
  type Manifest,
  ObjectStore,
  type ObjectStoreService,
  Storage,
} from "../../platform/services.ts";
import { SQLiteWriter, StorageLive } from "../../platform/sqlite.ts";
import { schema } from "../../app/schema.ts";
import { functions } from "../../app/functions.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** Writes a tiny, valid, standalone SQLite database at `path`. */
function writeValidSnapshot(path: string, marker = "snapshot"): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run(marker);
  } finally {
    db.close();
  }
}

interface StubStorage extends SnapshotSource {
  /** Every path `snapshot` was asked to write; its directory is the run's temp directory. */
  readonly paths: string[];
}

type SnapshotMode =
  | { readonly kind: "valid" }
  | { readonly kind: "garbage" }
  | { readonly kind: "fail" }
  | { readonly kind: "die" }
  | {
    readonly kind: "gate";
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };

function stubStorage(mode: SnapshotMode = { kind: "valid" }): StubStorage {
  const paths: string[] = [];
  return {
    paths,
    snapshot: (path) =>
      Effect.gen(function* () {
        paths.push(path);
        switch (mode.kind) {
          case "garbage":
            writeFileSync(path, "this is not a database, just bytes long enough to look like one".repeat(4));
            return;
          case "fail":
            return yield* new StorageError({ operation: "snapshot", detail: "disk full" });
          case "die":
            return yield* Effect.die(new Error("driver crashed"));
          case "gate":
            yield* Deferred.succeed(mode.entered, undefined);
            yield* Deferred.await(mode.release);
            writeValidSnapshot(path);
            return;
          default:
            writeValidSnapshot(path);
        }
      }),
  };
}

interface StubStore {
  readonly service: ObjectStoreService;
  readonly objects: Map<string, Uint8Array>;
  /** Keys in the order `put` was called, failed puts included. */
  readonly puts: string[];
  /** Fail every put whose key satisfies the predicate. */
  failWhen(predicate: (key: string) => boolean): void;
  /** Park every put whose key satisfies the predicate: `entered` fires, then it waits forever. */
  hangWhen(predicate: (key: string) => boolean, entered: Deferred.Deferred<void>): void;
  unhang(): void;
}

function stubStore(seed: Record<string, Uint8Array> = {}): StubStore {
  const objects = new Map(Object.entries(seed));
  const puts: string[] = [];
  let fail: (key: string) => boolean = () => false;
  let hang: { predicate: (key: string) => boolean; entered: Deferred.Deferred<void> } | undefined;
  return {
    objects,
    puts,
    failWhen: (predicate) => void (fail = predicate),
    hangWhen: (predicate, entered) => void (hang = { predicate, entered }),
    unhang: () => void (hang = undefined),
    service: {
      put: (key, bytes) =>
        Effect.gen(function* () {
          puts.push(key);
          if (fail(key)) {
            return yield* new ObjectStoreError({ operation: "put", key, status: 503, detail: "injected" });
          }
          if (hang?.predicate(key)) {
            yield* Deferred.succeed(hang.entered, undefined);
            return yield* Effect.never;
          }
          objects.set(key, bytes.slice());
        }),
      get: (key) =>
        Effect.suspend(() => {
          const bytes = objects.get(key);
          return bytes
            ? Effect.succeed(bytes.slice())
            : Effect.fail(new ObjectStoreError({ operation: "get", key, status: 404 }));
        }),
    },
  };
}

interface Run {
  readonly events: EventRecord[];
  readonly deps: Layer.Layer<EventSink | IdGen>;
}

function collector(): Run {
  const events: EventRecord[] = [];
  let id = 0;
  return {
    events,
    deps: Layer.mergeAll(
      Layer.succeed(EventSink, { emit: (event) => Effect.sync(() => void events.push(event)) }),
      Layer.succeed(IdGen, { next: Effect.sync(() => `id-${++id}`) }),
    ),
  };
}

/** A runner over the stub store, with events collected. */
function runnerOver(store: StubStore) {
  const run = collector();
  const runner = Effect.runSync(
    makeBackupRunner().pipe(
      Effect.provideService(ObjectStore, store.service),
      Effect.provide(run.deps),
    ),
  );
  return { runner, events: run.events };
}

const backupEvents = (events: EventRecord[]) =>
  events.filter((e): e is BackupEventRecord => e.kind === "backup");

const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  assert.ok(Exit.isFailure(exit), "expected a failure");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
};

const OLD_LATEST = enc.encode('{"format":1,"appId":"app","note":"previous good backup"}');

// ---------------------------------------------------------------------------
// Happy path, ordering, events (real StorageLive + real ObjectStoreLocal)
// ---------------------------------------------------------------------------

test("BackupsLive over real Storage + local ObjectStore: ordered puts, restorable object, one event per phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-backup-"));
  try {
    const run = collector();
    const deps = Layer.mergeAll(run.deps, ConfigTest({ objectStore: { localDir: join(dir, "objects") } }));
    const storage = StorageLive({ file: join(dir, "app.sqlite"), schema, appId: "app" });
    // `provideMerge`, not a second `mergeAll`: the writer must be built once, shared by test and service.
    const layer = BackupsLive.pipe(
      Layer.provideMerge(Layer.mergeAll(storage, makeObjectStoreLocal())),
      Layer.provide(deps),
    );

    const { manifest, latest, object, objectManifest } = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Storage;
        yield* db.mutation(functions.createGame, { xPlayer: "alice", oPlayer: "bob" });
        const manifest = yield* (yield* Backups).take("app");
        const store = yield* ObjectStore;
        return {
          manifest,
          latest: yield* store.get("apps/app/latest.json"),
          object: yield* store.get(manifest.key),
          objectManifest: yield* store.get(`${manifest.key}.json`),
        };
      }).pipe(Effect.provide(layer)),
    );

    // Manifest shape is byte-compatible with what restore reads.
    assert.equal(manifest.format, 1);
    assert.equal(manifest.appId, "app");
    assert.match(manifest.key, /^apps\/app\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-id-\d+\.sqlite$/);
    assert.equal(manifest.bytes, object.byteLength);
    assert.equal(manifest.sha256, await sha256(object));
    assert.equal(dec.decode(latest), JSON.stringify(manifest, null, 2));
    assert.deepEqual(objectManifest, latest);

    // The uploaded object is a real, intact copy holding the committed game.
    const restored = join(dir, "restored.sqlite");
    await Deno.writeFile(restored, object);
    integrityCheck(restored);
    const db = new DatabaseSync(restored, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) =>
        r.name
      );
      assert.ok(tables.length > 0);
      const games = db.prepare(`SELECT count(*) AS n FROM ${tables.find((t) => String(t).includes("games"))}`)
        .get();
      assert.equal(games?.n, 1);
    } finally {
      db.close();
    }

    const events = backupEvents(run.events);
    assert.deepEqual(
      events.map((e) => [e.phase, e.key]),
      [
        ["snapshot", undefined],
        ["verify", undefined],
        ["hash", undefined],
        ["put-object", manifest.key],
        ["put-object", `${manifest.key}.json`],
        ["put-manifest", `${manifest.key}.json`],
        ["put-object", "apps/app/latest.json"],
        ["publish-latest", "apps/app/latest.json"],
      ],
    );
    // No duplicates: exactly one event per Backups phase, and one store put-object per object written.
    for (const phase of ["snapshot", "verify", "hash", "put-manifest", "publish-latest"]) {
      assert.equal(events.filter((e) => e.phase === phase).length, 1, phase);
    }
    const putKeys = events.filter((e) => e.phase === "put-object").map((e) => e.key);
    assert.equal(new Set(putKeys).size, 3);
    assert.ok(events.every((e) => e.outcome === "ok" && e.level === "info" && e.durationMs >= 0));
    // Every event of the run, the store's included, joins on appId and one traceId.
    assert.ok(events.every((e) => e.appId === "app"));
    assert.equal(new Set(events.map((e) => e.traceId)).size, 1);
    const hash = events.find((e) => e.phase === "hash")!;
    assert.equal(hash.bytes, manifest.bytes);
    assert.equal(hash.sha256, manifest.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("take keeps a caller's traceId instead of minting one", async () => {
  const store = stubStore();
  const { runner, events } = runnerOver(store);
  await Effect.runPromise(runner.take("app", stubStorage()).pipe(Effect.annotateLogs({ traceId: "req-42" })));
  assert.ok(backupEvents(events).every((e) => e.traceId === "req-42"));
});

test("the temp directory is removed after a successful run", async () => {
  const storage = stubStorage();
  const { runner } = runnerOver(stubStore());
  await Effect.runPromise(runner.take("app", storage));
  assert.equal(storage.paths.length, 1);
  assert.ok(!existsSync(dirname(storage.paths[0])));
});

// ---------------------------------------------------------------------------
// Upload failures never advance latest.json
// ---------------------------------------------------------------------------

test("a put failure on the snapshot object leaves latest.json unchanged", async () => {
  const store = stubStore({ "apps/app/latest.json": OLD_LATEST });
  store.failWhen((key) => key.endsWith(".sqlite"));
  const storage = stubStorage();
  const { runner, events } = runnerOver(store);

  const error = failureOf(await Effect.runPromiseExit(runner.take("app", storage)));
  assert.ok(error instanceof BackupError);
  assert.equal(error.phase, "put-object");
  assert.equal(error.appId, "app");
  assert.ok(error.cause instanceof ObjectStoreError);

  assert.deepEqual(store.objects.get("apps/app/latest.json"), OLD_LATEST);
  assert.equal(store.puts.length, 1, "nothing is uploaded after the failed object put");
  assert.deepEqual([...store.objects.keys()], ["apps/app/latest.json"]);
  assert.ok(!existsSync(dirname(storage.paths[0])));
  assert.deepEqual(backupEvents(events).map((e) => e.phase), ["snapshot", "verify", "hash"]);

  // The guard was released: a retry with a healthy store succeeds and only then advances latest.json.
  store.failWhen(() => false);
  const manifest = await Effect.runPromise(runner.take("app", storage));
  assert.equal(dec.decode(store.objects.get("apps/app/latest.json")), JSON.stringify(manifest, null, 2));
});

test("a put failure on the manifest leaves latest.json unchanged and records put-manifest", async () => {
  const store = stubStore({ "apps/app/latest.json": OLD_LATEST });
  store.failWhen((key) => key.endsWith(".sqlite.json"));
  const { runner, events } = runnerOver(store);

  const error = failureOf(await Effect.runPromiseExit(runner.take("app", stubStorage())));
  assert.ok(error instanceof BackupError);
  assert.equal(error.phase, "put-manifest");
  assert.deepEqual(store.objects.get("apps/app/latest.json"), OLD_LATEST);
  assert.ok(!store.puts.includes("apps/app/latest.json"));

  const failed = backupEvents(events).at(-1)!;
  assert.equal(failed.phase, "put-manifest");
  assert.equal(failed.outcome, "error");
  assert.equal(failed.level, "error");
  assert.equal(failed.errorTag, "ObjectStoreError");
});

test("a publish-latest failure is reported at that phase", async () => {
  const store = stubStore({ "apps/app/latest.json": OLD_LATEST });
  store.failWhen((key) => key.endsWith("latest.json"));
  const { runner } = runnerOver(store);
  const error = failureOf(await Effect.runPromiseExit(runner.take("app", stubStorage())));
  assert.ok(error instanceof BackupError);
  assert.equal(error.phase, "publish-latest");
  assert.deepEqual(store.objects.get("apps/app/latest.json"), OLD_LATEST);
});

// ---------------------------------------------------------------------------
// Snapshot and verify failures
// ---------------------------------------------------------------------------

test("a corrupt snapshot fails verify with SnapshotIntegrityError, unwrapped, and uploads nothing", async () => {
  const store = stubStore();
  const storage = stubStorage({ kind: "garbage" });
  const { runner, events } = runnerOver(store);

  const error = failureOf(await Effect.runPromiseExit(runner.take("app", storage)));
  assert.ok(error instanceof SnapshotIntegrityError);
  assert.equal(store.puts.length, 0);
  assert.ok(!existsSync(dirname(storage.paths[0])));
  const verify = backupEvents(events).find((e) => e.phase === "verify")!;
  assert.equal(verify.outcome, "error");
  assert.equal(verify.errorTag, "SnapshotIntegrityError");
});

test("a Storage failure becomes BackupError at phase snapshot", async () => {
  const store = stubStore();
  const storage = stubStorage({ kind: "fail" });
  const { runner, events } = runnerOver(store);
  const error = failureOf(await Effect.runPromiseExit(runner.take("app", storage)));
  assert.ok(error instanceof BackupError);
  assert.equal(error.phase, "snapshot");
  assert.ok(error.cause instanceof StorageError);
  assert.equal(store.puts.length, 0);
  assert.ok(!existsSync(dirname(storage.paths[0])));
  assert.deepEqual(backupEvents(events).map((e) => [e.phase, e.errorTag]), [["snapshot", "StorageError"]]);
});

test("a temp-directory failure fails take at phase snapshot and still emits a snapshot event", async () => {
  const store = stubStore();
  const storage = stubStorage();
  const { runner, events } = runnerOver(store);
  const previous = Deno.env.get("TMPDIR");
  // `Deno.makeTempDir` creates under `TMPDIR`; a missing parent makes it fail.
  Deno.env.set("TMPDIR", join(tmpdir(), `ts-db-missing-${crypto.randomUUID()}`));
  let exit: Exit.Exit<Manifest, unknown>;
  try {
    exit = await Effect.runPromiseExit(runner.take("app", storage));
  } finally {
    if (previous === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", previous);
  }
  const error = failureOf(exit);
  assert.ok(error instanceof BackupError);
  assert.equal(error.phase, "snapshot");
  assert.equal(storage.paths.length, 0, "the snapshot was never attempted");
  assert.equal(store.puts.length, 0);
  const trace = backupEvents(events);
  assert.deepEqual(trace.map((e) => [e.phase, e.outcome, e.level, e.errorTag]), [
    ["snapshot", "error", "error", "BackupError"],
  ]);
  assert.equal(trace[0].appId, "app");
  // The guard was released: the next take is admitted and completes.
  await Effect.runPromise(runner.take("app", stubStorage()));
});

test("a defect in Storage still releases the guard and removes the temp directory", async () => {
  const store = stubStore();
  const dying = stubStorage({ kind: "die" });
  const { runner, events } = runnerOver(store);
  const exit = await Effect.runPromiseExit(runner.take("app", dying));
  assert.ok(Exit.isFailure(exit) && Cause.isDie(exit.cause));
  assert.ok(!existsSync(dirname(dying.paths[0])));
  assert.equal(backupEvents(events)[0].errorTag, "Defect");
  await Effect.runPromise(runner.take("app", stubStorage()));
});

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------

test("interrupting take mid-upload releases the per-app guard and removes the temp directory", async () => {
  const store = stubStore({ "apps/app/latest.json": OLD_LATEST });
  const storage = stubStorage();
  const { runner, events } = runnerOver(store);

  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    store.hangWhen((key) => key.endsWith(".sqlite"), entered);
    const fiber = yield* Effect.fork(runner.take("app", storage));
    yield* Deferred.await(entered);

    // While parked in the upload, the guard is held and the snapshot is on disk.
    const temp = dirname(storage.paths[0]);
    assert.ok(existsSync(join(temp, "snapshot.sqlite")));
    const blocked = yield* Effect.exit(runner.take("app", storage));
    assert.ok(Exit.isFailure(blocked));
    assert.ok(Option.getOrThrow(Cause.failureOption(blocked.cause)) instanceof BackupAlreadyRunning);

    const exit = yield* Fiber.interrupt(fiber);
    assert.ok(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause));
    assert.ok(!existsSync(temp), "temp directory removed on interruption");
  }));

  assert.deepEqual(store.objects.get("apps/app/latest.json"), OLD_LATEST);
  // The stall is visible: the run's trace ends in an interrupted put-object (the stub store emits nothing).
  const trace = backupEvents(events);
  assert.deepEqual(trace.map((e) => [e.phase, e.outcome]), [
    ["snapshot", "ok"],
    ["verify", "ok"],
    ["hash", "ok"],
    ["put-object", "error"],
  ]);
  assert.equal(trace[3].errorTag, "Interrupted");
  assert.equal(trace[3].level, "warn");
  // An interrupt can land after the store wrote the object, so the record does not claim it was not.
  assert.deepEqual(trace[3].errorDetail, { written: "unknown" });
  assert.match(trace[3].key ?? "", /^apps\/app\/.*\.sqlite$/);
  // Guard released: the next take is admitted and completes.
  store.unhang();
  const manifest = await Effect.runPromise(runner.take("app", storage));
  assert.equal(manifest.appId, "app");
});

test("interrupted upload over the real ObjectStoreLocal records exactly one put-object event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-backup-interrupt-"));
  const writeGate = Promise.withResolvers<void>();
  try {
    const run = collector();
    const writing = Promise.withResolvers<void>();
    const store = makeObjectStoreLocal({
      fs: {
        writeFile: async (path, bytes) => {
          if (path.includes(".sqlite.") && !path.includes(".sqlite.json")) {
            writing.resolve();
            await writeGate.promise;
          }
          await Deno.writeFile(path, bytes);
        },
      },
    }).pipe(Layer.provide(Layer.mergeAll(run.deps, ConfigTest({ objectStore: { localDir: dir } }))));
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* makeBackupRunner();
        const fiber = yield* Effect.fork(runner.take("app", stubStorage()));
        yield* Effect.promise(() => writing.promise);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(Layer.mergeAll(store, run.deps))),
    );
    const puts = backupEvents(run.events).filter((e) => e.phase === "put-object");
    assert.equal(puts.length, 1, "the store emits nothing on interrupt; Backups emits the one event");
    assert.equal(puts[0].errorTag, "Interrupted");
    assert.ok(!existsSync(join(dir, "apps/app/latest.json")));
  } finally {
    writeGate.resolve();
    // Let the orphaned write settle before its directory goes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupting take during the snapshot releases the guard, removes the temp dir, records the phase", async () => {
  const store = stubStore();
  const { runner, events } = runnerOver(store);
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const storage = stubStorage({ kind: "gate", entered, release });
    const fiber = yield* Effect.fork(runner.take("app", storage));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert.ok(!existsSync(dirname(storage.paths[0])));
    yield* runner.take("app", stubStorage());
  }));
  const interrupted = backupEvents(events)[0];
  assert.equal(interrupted.phase, "snapshot");
  assert.equal(interrupted.outcome, "error");
  assert.equal(interrupted.errorTag, "Interrupted");
  assert.equal(interrupted.level, "warn");
  assert.equal(
    store.puts.filter((k) => k.endsWith("latest.json")).length,
    1,
    "only the second run published",
  );
});

// ---------------------------------------------------------------------------
// The per-app guard
// ---------------------------------------------------------------------------

test("two concurrent takes for the same app produce exactly one BackupAlreadyRunning", async () => {
  const store = stubStore();
  const { runner } = runnerOver(store);
  const exits = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.fork(
      Effect.exit(runner.take("app", stubStorage({ kind: "gate", entered, release }))),
    );
    yield* Deferred.await(entered);
    const second = yield* Effect.exit(runner.take("app", stubStorage()));
    yield* Deferred.succeed(release, undefined);
    return [yield* Fiber.join(first), second] as const;
  }));
  const rejected = exits.filter((exit) =>
    Exit.isFailure(exit) &&
    Option.getOrUndefined(Cause.failureOption(exit.cause)) instanceof BackupAlreadyRunning
  );
  assert.equal(rejected.length, 1);
  assert.ok(Exit.isSuccess(exits[0]));
  const error = failureOf(exits[1]) as BackupAlreadyRunning;
  assert.equal(error.appId, "app");
});

test("concurrent takes for different apps both run", async () => {
  const store = stubStore();
  const { runner } = runnerOver(store);
  const manifests: Manifest[] = await Effect.runPromise(
    Effect.all([runner.take("a", stubStorage()), runner.take("b", stubStorage())], { concurrency: 2 }),
  );
  assert.deepEqual(manifests.map((m) => m.appId), ["a", "b"]);
  assert.ok(store.objects.has("apps/a/latest.json") && store.objects.has("apps/b/latest.json"));
});

test("the guard is a race-free claim: N simultaneous takes while one is in flight admit exactly one", async () => {
  const store = stubStore();
  const { runner } = runnerOver(store);
  const exits = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // One shared gated storage: whichever take is admitted parks in its snapshot until released.
    const storage = stubStorage({ kind: "gate", entered, release });
    const fibers = yield* Effect.forEach(
      Array.from({ length: 8 }),
      () => Effect.fork(Effect.exit(runner.take("app", storage))),
    );
    yield* Deferred.await(entered);
    // Every other fiber has started and been rejected before the admitted one is released.
    yield* Effect.sleep("20 millis");
    yield* Deferred.succeed(release, undefined);
    return yield* Fiber.joinAll(fibers);
  }));
  const busy = exits.filter((exit) =>
    Exit.isFailure(exit) &&
    Option.getOrUndefined(Cause.failureOption(exit.cause)) instanceof BackupAlreadyRunning
  ).length;
  assert.equal(exits.filter(Exit.isSuccess).length, 1);
  assert.equal(busy, exits.length - 1);
  assert.equal(store.puts.filter((k) => k.endsWith("latest.json")).length, 1);
});

// ---------------------------------------------------------------------------
// verifySnapshot / integrityCheck
// ---------------------------------------------------------------------------

test("verifySnapshot accepts a healthy file and rejects a non-database as SnapshotIntegrityError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-verify-"));
  try {
    const good = join(dir, "good.sqlite");
    writeValidSnapshot(good);
    await Effect.runPromise(verifySnapshot(good));
    integrityCheck(good);

    const bad = join(dir, "bad.sqlite");
    writeFileSync(bad, "x".repeat(4096));
    const error = failureOf(await Effect.runPromiseExit(verifySnapshot(bad)));
    assert.ok(error instanceof SnapshotIntegrityError);
    assert.equal(error.file, bad);
    assert.throws(() => integrityCheck(bad), /Snapshot failed integrity check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deprecated compatibility class (platform/server.ts until item 22)
// ---------------------------------------------------------------------------

test("legacy Backups class: takes a real SQLiteWriter snapshot and rejects a concurrent second take", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-legacy-backup-"));
  const writer = new SQLiteWriter(join(dir, "app.sqlite"), schema);
  try {
    const objects = new Map<string, Uint8Array>();
    const entered = Promise.withResolvers<void>();
    const uploadGate = Promise.withResolvers<void>();
    const backups = new LegacyBackups({
      put: async (key, bytes) => {
        if (key.endsWith(".sqlite")) {
          entered.resolve();
          await uploadGate.promise;
        }
        objects.set(key, bytes);
      },
      get: (key) => Promise.resolve(objects.get(key)!),
    });
    await writer.mutation(functions.createGame, { xPlayer: "a", oPlayer: "b" });
    const first = backups.take("app", writer);
    await entered.promise;
    await assert.rejects(backups.take("app", writer), /Backup already running for this app/);
    uploadGate.resolve();
    const manifest = await first;
    assert.equal(dec.decode(objects.get("apps/app/latest.json")), JSON.stringify(manifest, null, 2));
    assert.equal(await sha256(objects.get(manifest.key)!), manifest.sha256);

    // Upload failures surface as an Error naming the phase; latest.json stays put.
    const before = objects.get("apps/app/latest.json")!;
    const failing = new LegacyBackups({
      put: (key, bytes) => {
        if (key.endsWith(".sqlite")) return Promise.reject(new Error("boom"));
        objects.set(key, bytes);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(objects.get(key)!),
    });
    await assert.rejects(failing.take("app", writer), /Backup failed at put-object: .*boom/);
    assert.equal(objects.get("apps/app/latest.json"), before);
    assert.equal([...objects.keys()].length, 3, "nothing new was written");
  } finally {
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real S3 (SeaweedFS): gated on S3_INTEGRATION=1
// ---------------------------------------------------------------------------

const s3Enabled = Deno.env.get("S3_INTEGRATION") === "1";
const s3Skip = s3Enabled ? false : "S3_INTEGRATION=1 is not set; real-S3 backup round trip skipped";
const s3Endpoint = (Deno.env.get("S3_BASE_URL") ?? "http://localhost:8333").replace(/\/$/, "");
const s3BucketUrl = s3Endpoint !== "" && new URL(s3Endpoint).pathname !== "/"
  ? s3Endpoint
  : `${s3Endpoint}/${Deno.env.get("S3_BUCKET") ?? "tsdb-test"}`;
const s3Creds = {
  accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID") ?? "tsdbdevkey",
  secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY") ?? "tsdbdevsecret",
  region: Deno.env.get("AWS_REGION") ?? "us-east-1",
};
/** A per-run app id, so the run's `apps/<id>/` prefix is unique and can be deleted afterwards. */
const s3AppId = `it-backup-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const s3Written = new Set<string>();

after(async () => {
  if (!s3Enabled || s3Written.size === 0) return;
  const client = new AwsClient({ ...s3Creds, service: "s3", retries: 0 });
  for (const key of s3Written) {
    const response = await client.fetch(`${s3BucketUrl}/${key}`, { method: "DELETE" });
    await response.body?.cancel();
  }
});

test("real S3: backup round trip over ObjectStoreS3 publishes latest.json last and restores", {
  skip: s3Skip,
}, async () => {
  const run = collector();
  const config = ConfigTest({ objectStore: { s3BaseUrl: s3BucketUrl, ...s3Creds } });
  const store = makeObjectStoreS3().pipe(Layer.provide(Layer.mergeAll(config, run.deps)));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* makeBackupRunner();
      const manifest = yield* runner.take(s3AppId, stubStorage());
      for (const key of [manifest.key, `${manifest.key}.json`, `apps/${s3AppId}/latest.json`]) {
        s3Written.add(key);
      }
      const s3 = yield* ObjectStore;
      return {
        manifest,
        latest: yield* s3.get(`apps/${s3AppId}/latest.json`),
        object: yield* s3.get(manifest.key),
      };
    }).pipe(Effect.provide(Layer.mergeAll(store, run.deps))),
  );
  assert.equal(dec.decode(result.latest), JSON.stringify(result.manifest, null, 2));
  assert.equal(await sha256(result.object), result.manifest.sha256);
  const puts = backupEvents(run.events).filter((e) => e.phase === "put-object").map((e) => e.key);
  assert.deepEqual(puts, [result.manifest.key, `${result.manifest.key}.json`, `apps/${s3AppId}/latest.json`]);
  const dir = mkdtempSync(join(tmpdir(), "ts-db-s3-restore-"));
  try {
    const file = join(dir, "restored.sqlite");
    await Deno.writeFile(file, result.object);
    await Effect.runPromise(verifySnapshot(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
