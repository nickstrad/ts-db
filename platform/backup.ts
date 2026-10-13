/**
 * `Backups` service (plan item 19, §1.2): snapshot → `quick_check` → SHA-256 → immutable object PUT →
 * immutable manifest PUT → _only then_ `latest.json`.
 *
 * Invariants:
 * - A failed or interrupted upload never advances `latest.json`. It is the last write, and each step
 *   runs only after the previous one succeeded. (An interrupt that lands _during_ the `latest.json` put
 *   itself leaves that put's outcome unknown: the local store's write has no abort signal and may still
 *   land. Either way `latest.json` never names an object or manifest that was not fully written.)
 * - Only snapshot creation serializes with mutations (`Storage.snapshot` runs on the writer's queue).
 *   Verify, hash and upload read the standalone copy, so mutations proceed while a backup uploads.
 * - One backup per app at a time. The guard is a `Ref<HashSet<string>>` claimed with
 *   `Effect.acquireRelease`, so success, failure, defect and interruption all release it. The temp
 *   directory is a second resource in the same scope; it is removed before the guard is released.
 *
 * Events (ADR 0006): every `take` is one backup run with its own `runId`. This module writes exactly one
 * `backup` record (`emitter: "backups"`) per phase the run reaches — `snapshot`, `verify`, `hash`,
 * `put-object`, `put-manifest`, `publish-latest` — with duration and outcome, emitted on failure and
 * interruption too, so a stalled or killed backup is visible. A run that fails before its snapshot starts
 * (the temp directory cannot be created) still emits one failed `snapshot` record.
 *
 * Object transfers are the store's to record, not this module's: `ObjectStore` writes one
 * `emitter: "object-store"` record per PUT (the snapshot object, the manifest and `latest.json`), with
 * its `attempts`. The run's `runId` reaches those records through the `backupRunId` log annotation, and
 * each one links to the phase that issued it by `(runId, key)`. So a phase is never counted twice, a
 * retry is never counted as a transfer, and a transfer is never counted as a backup: count runs by
 * `runId`, phases from `backups` records, transfers from `object-store` records. Every record of a run
 * also carries its `appId` and `traceId` through log annotations, which the store's records read too.
 */
import { join } from "node:path";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  FiberId,
  HashMap,
  HashSet,
  Layer,
  Option,
  Ref,
  type Scope,
} from "effect";
import {
  type AnyError,
  BackupAlreadyRunning,
  BackupError,
  type BackupPhase,
  SnapshotIntegrityError,
} from "../core/errors.ts";
import {
  backupEvent,
  type BackupPayload,
  type EventEnvelope,
  fromPlatformError,
  type Level,
  lifecycleEvent,
  type Role,
} from "../core/events.ts";
import { BACKUP_RUN_ANNOTATION, sha256 } from "./object_store.ts";
import { sqliteFailureMessage } from "./sqlite.ts";
import { Database, isSqliteFfiError } from "./sqlite_ffi/mod.ts";
import {
  Backups as BackupsTag,
  type BackupsService,
  EventSink,
  IdGen,
  type Manifest,
  ObjectStore,
  Storage,
  type StorageService,
} from "./services.ts";

export type { Manifest } from "./services.ts";

// ===========================================================================
// Integrity check
// ===========================================================================

/** Rows `quick_check` may return on a damaged file; the detail keeps the first few. */
const MAX_INTEGRITY_ROWS = 5;

function messageOf(cause: unknown, file?: string): string {
  if (isSqliteFfiError(cause)) return sqliteFailureMessage(cause, file);
  return cause instanceof Error ? cause.message || cause.name : String(cause);
}

/**
 * `PRAGMA quick_check` on a standalone SQLite file. Anything but a single `ok` row fails. The copy
 * is opened read-only through the FFI binding, on `libraryPath` (`Config.sqlite.library`; absent:
 * the binding's default list), the library every other open in the server process uses.
 */
export function verifySnapshot(
  file: string,
  libraryPath?: string,
): Effect.Effect<void, SnapshotIntegrityError> {
  return Effect.try({
    try: () => {
      const db = Database.open(file, { readOnly: true, libraryPath });
      try {
        return db.prepare("PRAGMA quick_check").all();
      } finally {
        db.close();
      }
    },
    catch: (cause) => new SnapshotIntegrityError({ file, detail: messageOf(cause, file) }),
  }).pipe(
    Effect.flatMap((rows) =>
      rows.length === 1 && rows[0].quick_check === "ok" ? Effect.void : Effect.fail(
        new SnapshotIntegrityError({
          file,
          detail: rows.slice(0, MAX_INTEGRITY_ROWS).map((row) => String(row.quick_check)).join("; "),
        }),
      )
    ),
  );
}

/**
 * The pre-port synchronous check, still imported by `scripts/restore.ts`.
 *
 * @deprecated Use {@link verifySnapshot}. Kept until `scripts/restore.ts` is ported.
 */
export function integrityCheck(file: string, libraryPath?: string): void {
  const exit = Effect.runSyncExit(verifySnapshot(file, libraryPath));
  if (Exit.isFailure(exit)) {
    // The tagged error, not an untyped `Error`: the boundary test forbids `throw new Error` in
    // `platform/`, and the structured failure carries more than the old message did.
    throw Cause.squash(exit.cause);
  }
}

// ===========================================================================
// Runner
// ===========================================================================

/** What `take` needs from the app's storage: only the snapshot. */
export type SnapshotSource = Pick<StorageService, "snapshot">;

export type TakeError = BackupError | BackupAlreadyRunning | SnapshotIntegrityError;

/**
 * One guard and one set of dependencies, with the app's storage supplied per call. `BackupsLive` binds
 * it to a single `Storage`; a composition that resolves storage per app can share one runner (and so
 * one guard) across apps instead.
 */
export interface BackupRunner {
  take(appId: string, storage: SnapshotSource): Effect.Effect<Manifest, TakeError>;
}

export interface BackupsOptions {
  /** Process role stamped on emitted events. Defaults to `server`. */
  readonly role?: Role;
  /** `Config.sqlite.library`, for `verifySnapshot`'s open. Absent: the binding's default list. */
  readonly sqliteLibrary?: string;
}

type PhaseFields = Pick<BackupPayload, "key" | "bytes" | "sha256">;

/** A tagged error's `_tag: detail`, for `BackupError.detail`. */
function describe(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "_tag" in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    const tag = String((cause as { _tag: unknown })._tag);
    return typeof detail === "string" && detail !== "" ? `${tag}: ${detail}` : tag;
  }
  return messageOf(cause);
}

/** `errorTag`/`errorDetail` for a failed phase: the repo's tag, `Interrupted`, or `Defect`. */
function errorColumns(cause: Cause.Cause<unknown>): { errorTag: string; errorDetail?: unknown } {
  if (Cause.isInterruptedOnly(cause)) return { errorTag: "Interrupted" };
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined) return fromPlatformError(failure as AnyError);
  return { errorTag: "Defect", errorDetail: { message: messageOf(Cause.squash(cause)) } };
}

/** The first string-valued annotation among `keys`. */
function annotation(annotations: HashMap.HashMap<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = Option.getOrUndefined(HashMap.get(annotations, key));
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

const encoder = new TextEncoder();

/** Builds the runner over `ObjectStore`, `EventSink`, `IdGen` and Effect's `Clock`. */
export function makeBackupRunner(
  options: BackupsOptions = {},
): Effect.Effect<BackupRunner, never, ObjectStore | EventSink | IdGen> {
  const role = options.role ?? "server";
  return Effect.gen(function* () {
    const store = yield* ObjectStore;
    const sink = yield* EventSink;
    const ids = yield* IdGen;
    const active = yield* Ref.make(HashSet.empty<string>());

    /** The run this fiber is part of, from the annotation `take` sets. */
    const runIdOf = Effect.map(
      Effect.logAnnotations,
      (annotations) => annotation(annotations, BACKUP_RUN_ANNOTATION),
    );

    const envelope = (level: Level, at: number): Effect.Effect<EventEnvelope> =>
      Effect.gen(function* () {
        const annotations = yield* Effect.logAnnotations;
        return {
          eventId: yield* ids.next,
          ts: new Date(at).toISOString(),
          level,
          role,
          pid: Deno.pid,
          traceId: annotation(annotations, "traceId", "trace_id") ??
            FiberId.threadName(yield* Effect.fiberId),
          spanId: annotation(annotations, "spanId", "span_id"),
          appId: annotation(annotations, "appId", "app_id"),
        };
      });

    /** Emits the one `backup` record describing a phase that started at `startedAt` and ended in `exit`. */
    const record = <A, E>(
      name: BackupPhase,
      startedAt: number,
      exit: Exit.Exit<A, E>,
      fields: PhaseFields,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis;
        const ok = Exit.isSuccess(exit);
        const errors = ok ? undefined : errorColumns(exit.cause);
        const level: Level = ok ? "info" : errors?.errorTag === "Interrupted" ? "warn" : "error";
        yield* sink.emit(backupEvent({
          ...(yield* envelope(level, finishedAt)),
          phase: name,
          emitter: "backups",
          runId: yield* runIdOf,
          ...fields,
          durationMs: finishedAt - startedAt,
          outcome: ok ? "ok" : "error",
          errorTag: errors?.errorTag,
          errorDetail: errors?.errorDetail,
        }));
      });

    /**
     * Runs one phase and emits exactly one `backup` event for it, whatever the exit — interruption
     * included (`onExit` finalizers run uninterruptibly). The event never changes the phase's result.
     */
    const phase = <A, E>(
      name: BackupPhase,
      effect: Effect.Effect<A, E>,
      fields: (value: A) => PhaseFields = () => ({}),
      known: PhaseFields = {},
    ): Effect.Effect<A, E> =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (startedAt) =>
          Effect.onExit(
            effect,
            (exit) =>
              record(name, startedAt, exit, {
                ...known,
                ...(Exit.isSuccess(exit) ? fields(exit.value) : {}),
              }),
          ),
      );

    const failed = (appId: string, at: BackupPhase) => (cause: unknown) =>
      new BackupError({ appId, phase: at, detail: describe(cause), cause });

    /** The per-app guard. A rejected claim adds nothing, so it registers no release. */
    const claim = (appId: string): Effect.Effect<void, BackupAlreadyRunning, Scope.Scope> =>
      Effect.acquireRelease(
        Ref.modify(
          active,
          (set): [boolean, HashSet.HashSet<string>] =>
            HashSet.has(set, appId) ? [false, set] : [true, HashSet.add(set, appId)],
        ).pipe(
          Effect.flatMap((claimed) =>
            claimed ? Effect.void : Effect.fail(new BackupAlreadyRunning({ appId }))
          ),
        ),
        () => Ref.update(active, HashSet.remove(appId)),
      );

    /**
     * A private temp directory, removed (recursively) when the run's scope closes. `BackupPhase` has no
     * setup phase, so failing to create it is reported, and recorded as an event, as `snapshot`, the
     * phase it is created for; the snapshot phase's own event is never reached in that case.
     */
    const tempDir = (appId: string): Effect.Effect<string, BackupError, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
          Effect.tryPromise({
            try: () => Deno.makeTempDir({ prefix: "document-db-backup-" }),
            catch: failed(appId, "snapshot"),
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? record("snapshot", startedAt, exit, {}) : Effect.void
            ),
          )),
        (directory) =>
          Effect.tryPromise(() => Deno.remove(directory, { recursive: true })).pipe(
            // A finalizer cannot fail; a leaked directory is reported rather than lost.
            Effect.catchAll((cause) =>
              Effect.flatMap(Clock.currentTimeMillis, (at) =>
                Effect.flatMap(envelope("warn", at), (env) =>
                  sink.emit(lifecycleEvent({
                    ...env,
                    phase: "backup-temp-cleanup-failed",
                    detail: { directory, error: messageOf(cause.error) },
                  }))))
            ),
          ),
      );

    const readAndHash = (file: string) =>
      Effect.tryPromise({
        try: async () => {
          const bytes = await Deno.readFile(file);
          return { bytes, digest: await sha256(bytes) };
        },
        catch: (cause) => cause,
      });

    const run = (appId: string, storage: SnapshotSource): Effect.Effect<Manifest, TakeError> =>
      Effect.scoped(Effect.gen(function* () {
        yield* claim(appId);
        const directory = yield* tempDir(appId);
        const file = join(directory, "snapshot.sqlite");
        // Serializes only snapshot creation with mutations; every later phase reads the standalone copy.
        yield* phase("snapshot", storage.snapshot(file)).pipe(Effect.mapError(failed(appId, "snapshot")));
        const capturedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* phase("verify", verifySnapshot(file, options.sqliteLibrary));
        const { bytes, digest } = yield* phase(
          "hash",
          readAndHash(file),
          (hashed) => ({ bytes: hashed.bytes.byteLength, sha256: hashed.digest }),
        ).pipe(Effect.mapError(failed(appId, "hash")));
        const key = `apps/${appId}/${capturedAt.replaceAll(":", "-")}-${yield* ids.next}.sqlite`;
        const manifest: Manifest = { format: 1, appId, capturedAt, key, bytes: bytes.length, sha256: digest };
        const json = encoder.encode(JSON.stringify(manifest, null, 2));
        const manifestKey = `${key}.json`;
        const latestKey = `apps/${appId}/latest.json`;
        // Upload immutable data first; publish latest only after both immutable uploads succeed.
        // Each put phase records its key; the store's transfer record for that put shares it and the runId.
        yield* phase("put-object", store.put(key, bytes), undefined, { key, bytes: bytes.byteLength })
          .pipe(Effect.mapError(failed(appId, "put-object")));
        yield* phase("put-manifest", store.put(manifestKey, json), undefined, { key: manifestKey })
          .pipe(Effect.mapError(failed(appId, "put-manifest")));
        yield* phase("publish-latest", store.put(latestKey, json), undefined, { key: latestKey })
          .pipe(Effect.mapError(failed(appId, "publish-latest")));
        return manifest;
      }));

    /**
     * Annotates the run with its app, a fresh backup-run id, and, unless the caller already has one, a
     * fresh trace id. The run id is separate from the trace: one caller trace may span several backups.
     */
    const take = (appId: string, storage: SnapshotSource): Effect.Effect<Manifest, TakeError> =>
      Effect.gen(function* () {
        const runId = yield* ids.next;
        const callerTrace = annotation(yield* Effect.logAnnotations, "traceId", "trace_id");
        const traceId = callerTrace === undefined ? { traceId: yield* ids.next } : {};
        return yield* Effect.annotateLogs(run(appId, storage), {
          appId,
          [BACKUP_RUN_ANNOTATION]: runId,
          ...traceId,
        });
      });

    const runner: BackupRunner = { take };
    return runner;
  });
}

// ===========================================================================
// Layer
// ===========================================================================

/**
 * `take(appId)` snapshots the one `Storage` this layer was built over, so it belongs in the same
 * per-app stack as that `StorageLive`. Tests reuse it over test doubles.
 */
export function makeBackupsLive(
  options: BackupsOptions = {},
): Layer.Layer<BackupsTag, never, Storage | ObjectStore | EventSink | IdGen> {
  return Layer.effect(
    BackupsTag,
    Effect.gen(function* () {
      const storage = yield* Storage;
      const runner = yield* makeBackupRunner(options);
      const service: BackupsService = { take: (appId) => runner.take(appId, storage) };
      return service;
    }),
  );
}

export const BackupsLive: Layer.Layer<BackupsTag, never, Storage | ObjectStore | EventSink | IdGen> =
  makeBackupsLive();
