// Transaction-conflict stress for the Storage service (item 15, sq-06).
//
// Question: does the SQLite writer lose updates or detect conflicts when the same counter is
// incremented concurrently, read in one mutation and written in another, or raced against a snapshot?
//
// Scenarios:
//   A  concurrent increments: N fibers each run ONE mutation that reads a counter and writes value+1.
//      Repeated ROUNDS times, each on a fresh database. Any lost update fails the run.
//   B  app-level stale read: M1 reads, M2 increments, M3 writes (read value + 1) from M1's stale read.
//      Plain variant: no version check. Guarded variant: M3 passes M1's `_version` (the pattern
//      app/functions.ts makeMove uses), then re-reads and retries after the ConflictError.
//   C  writes during backup: 20 increment mutations run concurrently with one storage.snapshot().
//      Checks all 20 commit, the snapshot opens and passes quick_check, and its counter equals the
//      number of increments committed before it in the writer queue.
//
// Access: real StorageLive over node:sqlite files in a temp directory (created and removed per
// scenario). Test doubles: EventSink collects into an array, IdGen counts, Config is ConfigTest.
// No network. Env: ROUNDS (scenario A rounds, default 20), FIBERS (scenario A fibers, default 50).
//
// Run from the repo root (the import map lives in deno.json):
//   deno run -A work-scripts/deno/tx-conflict-stress.ts
//
// Why -A and not explicit grants: with Deno 2.9.5 `node:sqlite` runs `VACUUM INTO` with the attached-
// database limit at 0 ("too many attached databases - max 0") unless the process has every permission.
// Each of --allow-read/-write/-env/-net/-ffi/-run/-sys/-import alone still fails (see sq-06 findings).
// `deno task serve` and `deno task test` already use -A, so production backups are not affected.
//
// Exit code: 1 if scenario A loses an update or any A mutation fails, or if scenario C does not
// commit all 20 mutations or its snapshot is unusable. Scenario B's lost update is the expected
// observation (no platform-level detection), so it does not affect the exit code.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, Layer } from "effect";
import { ConflictError, type MutationError } from "../../core/errors.ts";
import type { EventRecord, SqlEventRecord, TxEventRecord } from "../../core/events.ts";
import { ConfigTest } from "../../platform/config.ts";
import { EventSink, IdGen, Storage, type StorageService } from "../../platform/services.ts";
import { StorageLive } from "../../platform/sqlite.ts";
import { type AnyDefinition, defineFunctions } from "../../sdk/functions.ts";
import { defineSchema, defineTable, v } from "../../sdk/schema.ts";

// ---------------------------------------------------------------------------
// Schema and mutations
// ---------------------------------------------------------------------------

const schema = defineSchema({
  counters: defineTable({ name: v.string(), value: v.integer() }),
});
const app = defineFunctions(schema);

interface Counter {
  readonly _id: string;
  readonly value: number;
  readonly _version: number;
}

const seed = app.mutation({
  args: {},
  handler: ({ db }) => db.insert("counters", { name: "hits", value: 0 }),
});

const readCounter = app.mutation({
  args: { id: v.string() },
  handler: ({ db }, { id }) => db.get("counters", id),
});

/** Read-modify-write inside ONE mutation. The yield sits between read and write: the widest window a handler has. */
const incrementInside = app.mutation({
  args: { id: v.string() },
  handler: ({ db }, { id }) =>
    Effect.gen(function* () {
      const doc = (yield* db.get("counters", id))!;
      yield* Effect.yieldNow();
      yield* db.patch("counters", id, { value: doc.value + 1 });
      return doc.value + 1;
    }),
});

/** Writes a value the caller computed, with no check: the shape of read-in-one-mutation, write-in-another. */
const writeValue = app.mutation({
  args: { id: v.string(), value: v.integer() },
  handler: ({ db }, { id, value }) => db.patch("counters", id, { value }),
});

/** Same write, guarded by the `_version` the caller read. Mirrors `makeMove` in app/functions.ts. */
const writeIfVersion = app.mutation({
  args: { id: v.string(), value: v.integer(), expectedVersion: v.integer() },
  handler: ({ db }, { id, value, expectedVersion }) =>
    Effect.gen(function* () {
      const doc = (yield* db.get("counters", id))!;
      if (doc._version !== expectedVersion) {
        return yield* new ConflictError({
          expected: expectedVersion,
          actual: doc._version,
          table: "counters",
          id,
        });
      }
      yield* db.patch("counters", id, { value });
    }),
});

// ---------------------------------------------------------------------------
// Harness (mirrors tests/unit/storage_test.ts)
// ---------------------------------------------------------------------------

/** Runs `program` against a fresh StorageLive over a temp directory; appends every event to `events`. */
async function withStorage<A>(
  events: EventRecord[],
  program: (storage: StorageService, dir: string) => Effect.Effect<A, unknown>,
): Promise<A> {
  const dir = mkdtempSync(join(tmpdir(), "ts-db-sq06-"));
  let id = 0;
  const deps = Layer.mergeAll(
    Layer.succeed(EventSink, { emit: (event) => Effect.sync(() => void events.push(event)) }),
    Layer.succeed(IdGen, { next: Effect.sync(() => `id-${++id}`) }),
    ConfigTest(),
  );
  try {
    return await Effect.runPromise(
      Effect.flatMap(Storage, (storage) => program(storage, dir)).pipe(
        Effect.provide(
          StorageLive({ file: join(dir, "app.sqlite"), schema, appId: "sq-06" }).pipe(Layer.provide(deps)),
        ),
        Effect.orDie,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Typed call into the Storage service. The handler's result is `unknown` at the service boundary. */
const call = <T>(storage: StorageService, def: AnyDefinition, args: unknown) =>
  storage.mutation(def, args) as Effect.Effect<T, MutationError>;

const txCount = (events: EventRecord[], outcome: TxEventRecord["outcome"]) =>
  events.filter((e): e is TxEventRecord => e.kind === "tx" && e.outcome === outcome).length;

const queueRejects = (events: EventRecord[]) =>
  events.filter((e) => e.kind === "queue" && e.event === "rejected").length;

/** `ok`, or the failure's tag; a `StorageError` also carries its driver detail, so a failure is never a bare tag. */
const tagOf = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "ok";
  const failure = Cause.squash(exit.cause) as { _tag?: string; detail?: string };
  const tag = failure._tag ?? "defect";
  return failure.detail && tag === "StorageError" ? `${tag}: ${failure.detail}` : tag;
};

// ---------------------------------------------------------------------------
// Scenario A: concurrent increments, one mutation per fiber
// ---------------------------------------------------------------------------

interface RoundA {
  readonly round: number;
  readonly expected: number;
  readonly actual: number;
  readonly failed: number;
  readonly commits: number;
  readonly rollbacks: number;
  readonly queueRejected: number;
  readonly maxQueueWaitMs: number;
  readonly ms: number;
}

async function scenarioA(rounds: number, fibers: number): Promise<RoundA[]> {
  const out: RoundA[] = [];
  for (let round = 1; round <= rounds; round++) {
    const events: EventRecord[] = [];
    const started = performance.now();
    const result = await withStorage(events, (storage) =>
      Effect.gen(function* () {
        const id = yield* call<string>(storage, seed, {});
        const exits = yield* Effect.forEach(
          Array.from({ length: fibers }),
          () => Effect.exit(call<number>(storage, incrementInside, { id })),
          { concurrency: "unbounded" },
        );
        const final = (yield* call<Counter>(storage, readCounter, { id })) as Counter;
        return { final: final.value, failed: exits.filter(Exit.isFailure).length };
      }));
    out.push({
      round,
      expected: fibers,
      actual: result.final,
      failed: result.failed,
      commits: txCount(events, "commit"),
      rollbacks: txCount(events, "rollback") + txCount(events, "interrupted"),
      queueRejected: queueRejects(events),
      maxQueueWaitMs: Math.max(
        0,
        ...events.filter((e): e is TxEventRecord => e.kind === "tx").map((e) => e.queueWaitMs),
      ),
      ms: performance.now() - started,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenario B: application-level stale read across mutations
// ---------------------------------------------------------------------------

interface ScenarioB {
  readonly plainFinal: number;
  readonly plainM3: string;
  readonly guardedM3: string;
  readonly guardedFinalAfterConflict: number;
  readonly guardedFinalAfterRetry: number;
  readonly guardedRetry: string;
}

async function scenarioB(): Promise<ScenarioB> {
  // Plain: M1 reads (value 0), M2 increments (value 1), M3 writes stale+1 = 1 with no check.
  const plainEvents: EventRecord[] = [];
  const plain = await withStorage(plainEvents, (storage) =>
    Effect.gen(function* () {
      const id = yield* call<string>(storage, seed, {});
      const m1 = (yield* call<Counter>(storage, readCounter, { id })) as Counter;
      yield* call<number>(storage, incrementInside, { id });
      const m3 = yield* Effect.exit(call<void>(storage, writeValue, { id, value: m1.value + 1 }));
      const final = (yield* call<Counter>(storage, readCounter, { id })) as Counter;
      return { final: final.value, m3: tagOf(m3) };
    }));

  // Guarded: same interleaving, but M3 carries M1's `_version`, then retries after the conflict.
  const guardedEvents: EventRecord[] = [];
  const guarded = await withStorage(guardedEvents, (storage) =>
    Effect.gen(function* () {
      const id = yield* call<string>(storage, seed, {});
      const m1 = (yield* call<Counter>(storage, readCounter, { id })) as Counter;
      yield* call<number>(storage, incrementInside, { id });
      const m3 = yield* Effect.exit(
        call<void>(storage, writeIfVersion, { id, value: m1.value + 1, expectedVersion: m1._version }),
      );
      const afterConflict = (yield* call<Counter>(storage, readCounter, { id })) as Counter;
      const retry = yield* Effect.exit(
        call<void>(storage, writeIfVersion, {
          id,
          value: afterConflict.value + 1,
          expectedVersion: afterConflict._version,
        }),
      );
      const afterRetry = (yield* call<Counter>(storage, readCounter, { id })) as Counter;
      return {
        m3: tagOf(m3),
        afterConflict: afterConflict.value,
        retry: tagOf(retry),
        afterRetry: afterRetry.value,
      };
    }));

  return {
    plainFinal: plain.final,
    plainM3: plain.m3,
    guardedM3: guarded.m3,
    guardedFinalAfterConflict: guarded.afterConflict,
    guardedFinalAfterRetry: guarded.afterRetry,
    guardedRetry: guarded.retry,
  };
}

// ---------------------------------------------------------------------------
// Scenario C: writes during backup
// ---------------------------------------------------------------------------

interface ScenarioC {
  readonly mutationsOk: number;
  readonly mutationsFailed: number;
  readonly snapshot: string;
  readonly finalCounter: number;
  readonly snapshotCounter: number | null;
  readonly commitsBeforeSnapshot: number;
  readonly quickCheck: string;
  readonly snapshotVersion: number | null;
  readonly queueRejected: number;
}

/** Opens the snapshot file read-side and returns its counter, version and quick_check result. */
function readSnapshot(file: string): { value: number; version: number; quick: string } {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT "value", "_version" FROM "counters"').get() as
      | { value: number; _version: number }
      | undefined;
    const quick = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    return {
      value: Number(row?.value ?? -1),
      version: Number(row?._version ?? -1),
      quick: quick.quick_check,
    };
  } finally {
    db.close();
  }
}

async function scenarioC(): Promise<ScenarioC> {
  const events: EventRecord[] = [];
  return await withStorage(events, (storage, dir) =>
    Effect.gen(function* () {
      const id = yield* call<string>(storage, seed, {});
      const snapFile = join(dir, "snap.sqlite");
      const startIndex = events.length;
      // Ten increments, then the snapshot, then ten more: the snapshot queues behind some writes and ahead of others.
      const jobs: Effect.Effect<Exit.Exit<unknown, unknown>>[] = Array.from({ length: 21 }, (_, i) =>
        i === 10
          ? Effect.exit(storage.snapshot(snapFile))
          : Effect.exit(call<number>(storage, incrementInside, { id })));
      const exits = yield* Effect.all(jobs, { concurrency: "unbounded" });
      const snapshotExit = exits[10];
      const mutationExits = exits.filter((_, i) =>
        i !== 10
      );
      const final = (yield* call<Counter>(storage, readCounter, { id })) as Counter;

      const vacuumAt = events.findIndex((e, i) =>
        i >= startIndex && e.kind === "sql" && (e as SqlEventRecord).sqlText.startsWith("VACUUM INTO")
      );
      const commitsBefore = events.slice(startIndex, vacuumAt).filter((e) =>
        e.kind === "tx" && (e as TxEventRecord).outcome === "commit"
      ).length;

      let snap: { value: number; version: number; quick: string } | undefined;
      let snapshotErr: string | undefined;
      if (Exit.isSuccess(snapshotExit)) {
        try {
          snap = readSnapshot(snapFile);
        } catch (cause) {
          snapshotErr = String(cause);
        }
      }
      return {
        mutationsOk: mutationExits.filter(Exit.isSuccess).length,
        mutationsFailed: mutationExits.filter(Exit.isFailure).length,
        snapshot: snapshotErr ? `read failed: ${snapshotErr}` : tagOf(snapshotExit),
        finalCounter: final.value,
        snapshotCounter: snap ? snap.value : null,
        commitsBeforeSnapshot: commitsBefore,
        quickCheck: snap ? snap.quick : "n/a",
        snapshotVersion: snap ? snap.version : null,
        queueRejected: queueRejects(events),
      };
    }));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(rows: Record<string, string | number>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells: string[]) => "| " + cells.map((c, i) => c.padEnd(width[i])).join(" | ") + " |";
  console.log(line(cols));
  console.log("| " + width.map((w) => "-".repeat(w)).join(" | ") + " |");
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ROUNDS = Number(Deno.env.get("ROUNDS") ?? 20);
const FIBERS = Number(Deno.env.get("FIBERS") ?? 50);

console.log(`sq-06 tx-conflict stress: ROUNDS=${ROUNDS} FIBERS=${FIBERS} (scenario C: 20 mutations)\n`);

const a = await scenarioA(ROUNDS, FIBERS);
console.log("Scenario A: concurrent increments (one read-modify-write mutation per fiber)");
printTable(a.map((r) => ({
  round: r.round,
  expected: r.expected,
  actual: r.actual,
  lost: r.expected - r.actual,
  failed: r.failed,
  commit_tx: r.commits,
  rollback_tx: r.rollbacks,
  queue_rejected: r.queueRejected,
  max_queue_wait_ms: Math.round(r.maxQueueWaitMs),
  ms: Math.round(r.ms),
})));
const aLost = a.reduce((s, r) => s + (r.expected - r.actual), 0);
const aFailed = a.reduce((s, r) => s + r.failed, 0);
const aMutations = ROUNDS * FIBERS;
console.log(
  `A totals: ${aMutations} mutations, lost updates=${aLost}, failed mutations=${aFailed}, ` +
    `min final=${Math.min(...a.map((r) => r.actual))}, max final=${Math.max(...a.map((r) => r.actual))}\n`,
);

const b = await scenarioB();
console.log(
  "Scenario B: app-level stale read across mutations (M1 read, M2 increment, M3 write from stale read)",
);
// `silent_lost` counts only writes that reported success: a refused write loses nothing silently.
const silentLost = (m3: string, final: number) => (m3 === "ok" ? 2 - final : 0);
printTable([
  {
    variant: "plain (no version check)",
    M3_result: b.plainM3,
    detected: b.plainM3 === "ok" ? "no" : "yes",
    final: b.plainFinal,
    silent_lost: silentLost(b.plainM3, b.plainFinal),
  },
  {
    variant: "guarded (M3 passes M1 _version)",
    M3_result: b.guardedM3,
    detected: b.guardedM3 === "ok" ? "no" : "yes",
    final: b.guardedFinalAfterConflict,
    silent_lost: silentLost(b.guardedM3, b.guardedFinalAfterConflict),
  },
  {
    variant: "guarded + re-read and retry",
    M3_result: b.guardedRetry,
    detected: b.guardedRetry === "ok" ? "no" : "yes",
    final: b.guardedFinalAfterRetry,
    silent_lost: silentLost(b.guardedRetry, b.guardedFinalAfterRetry),
  },
]);
console.log();

const c = await scenarioC();
console.log("Scenario C: 20 increment mutations concurrent with one snapshot (VACUUM INTO)");
printTable([
  {
    mutations_ok: c.mutationsOk,
    mutations_failed: c.mutationsFailed,
    final_counter: c.finalCounter,
    snapshot: c.snapshot,
    snapshot_counter: c.snapshotCounter ?? "n/a",
    commits_before_snapshot: c.commitsBeforeSnapshot,
    snapshot_quick_check: c.quickCheck,
    queue_rejected: c.queueRejected,
  },
]);
console.log();

const cOk = c.mutationsOk === 20 && c.mutationsFailed === 0 && c.snapshot === "ok" &&
  c.quickCheck === "ok" && c.snapshotCounter === c.commitsBeforeSnapshot;
const aOk = aLost === 0 && aFailed === 0;
console.log(
  `A ${aOk ? "PASS" : "FAIL"}  B observed (lost-update finding, no exit impact)  C ${cOk ? "PASS" : "FAIL"}`,
);
if (!aOk || !cOk) Deno.exit(1);
