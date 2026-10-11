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
 * Events: one `backup` event per phase this module owns — `snapshot`, `verify`, `hash`, `put-manifest`,
 * `publish-latest` — with duration and outcome, emitted on interruption too, so a stalled or killed
 * backup is visible. A run that fails before its snapshot starts (the temp directory cannot be created)
 * still emits one failed `snapshot` event. `put-object` is NOT emitted here on success or failure:
 * `ObjectStore` already emits a `backup`/`put-object` event for every put (the manifest and
 * `latest.json` puts included), and a second one would double-count. The exception is interruption,
 * which the store usually cannot record (its event is written after the put settles, and an interrupted
 * fiber normally never gets there); see `putObject`. That exception is not race-free: an interrupt that
 * lands after the store has emitted its event but before `put` returns is recorded here as well, so one
 * written object can show both the store's `ok` and an `Interrupted` event. The `Interrupted` event
 * therefore carries `errorDetail: { written: "unknown" }`: the object may or may not have been written.
 * Every event of a run carries its `appId` and `traceId` through log annotations, which the store's
 * events read as well, so the store's put events join the run.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { sha256 } from "./object_store.ts";
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message || cause.name : String(cause);
}

/** `PRAGMA quick_check` on a standalone SQLite file. Anything but a single `ok` row fails. */
export function verifySnapshot(file: string): Effect.Effect<void, SnapshotIntegrityError> {
  return Effect.try({
    try: () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare("PRAGMA quick_check").all();
      } finally {
        db.close();
      }
    },
    catch: (cause) => new SnapshotIntegrityError({ file, detail: messageOf(cause) }),
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
export function integrityCheck(file: string): void {
  const exit = Effect.runSyncExit(verifySnapshot(file));
  if (Exit.isFailure(exit)) {
    throw new Error("Snapshot failed integrity check", { cause: Cause.squash(exit.cause) });
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

    /**
     * Emits the one `backup` event describing a phase that started at `startedAt` and ended in `exit`.
     * `detail`, when given, replaces the failure's `errorDetail`.
     */
    const record = <A, E>(
      name: BackupPhase,
      startedAt: number,
      exit: Exit.Exit<A, E>,
      fields: PhaseFields,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis;
        const ok = Exit.isSuccess(exit);
        const errors = ok ? undefined : errorColumns(exit.cause);
        const level: Level = ok ? "info" : errors?.errorTag === "Interrupted" ? "warn" : "error";
        yield* sink.emit(backupEvent({
          ...(yield* envelope(level, finishedAt)),
          phase: name,
          ...fields,
          durationMs: finishedAt - startedAt,
          outcome: ok ? "ok" : "error",
          errorTag: errors?.errorTag,
          errorDetail: detail ?? errors?.errorDetail,
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

    /**
     * The snapshot-object put. `ObjectStore` records its success or failure; only an interruption is
     * recorded here, since the store's event is normally never written. So a backup killed mid-upload
     * still shows where it stopped.
     *
     * This can double-count. The store emits its event before its `put` effect returns, so an interrupt
     * landing between the two is recorded here too, for an object that was written (the store's event
     * says `ok`). The interrupted record is marked `written: "unknown"` for that reason: read it as "may
     * or may not have been written", and prefer the store's `put-object` event for the same key when
     * both exist. Closing the window needs `ObjectStore` to record interruption itself (follow-up; that
     * file is outside this item).
     */
    const putObject = (key: string, bytes: Uint8Array) =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (startedAt) =>
          Effect.onExit(
            store.put(key, bytes),
            (exit) =>
              Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)
                ? record("put-object", startedAt, exit, { key, bytes: bytes.byteLength }, {
                  written: "unknown",
                })
                : Effect.void,
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
        yield* phase("verify", verifySnapshot(file));
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
        // The store's own `put-object` events record each JSON's bytes; these phase events carry the key.
        yield* putObject(key, bytes).pipe(Effect.mapError(failed(appId, "put-object")));
        yield* phase("put-manifest", store.put(manifestKey, json), undefined, { key: manifestKey })
          .pipe(Effect.mapError(failed(appId, "put-manifest")));
        yield* phase("publish-latest", store.put(latestKey, json), undefined, { key: latestKey })
          .pipe(Effect.mapError(failed(appId, "publish-latest")));
        return manifest;
      }));

    /** Annotates the run with its app and, unless the caller already has one, a fresh trace id. */
    const take = (appId: string, storage: SnapshotSource): Effect.Effect<Manifest, TakeError> =>
      Effect.flatMap(
        Effect.logAnnotations,
        (annotations) =>
          annotation(annotations, "traceId", "trace_id") !== undefined
            ? Effect.annotateLogs(run(appId, storage), { appId })
            : Effect.flatMap(
              ids.next,
              (traceId) => Effect.annotateLogs(run(appId, storage), { appId, traceId }),
            ),
      );

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
