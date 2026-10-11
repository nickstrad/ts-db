/**
 * `ObjectStore` service implementations (plan item 18, §1.2): a local-directory stand-in and a signed
 * S3 client, both behind the `ObjectStoreService` interface frozen in `platform/services.ts`.
 *
 * - `ObjectStoreLocal` publishes through a temp file + `rename`, so a reader never observes a partial
 *   object at its final path. It is a stand-in, NOT off-host redundancy.
 * - `ObjectStoreS3` imports `aws4fetch` dynamically inside the layer, so the dependency stays lazy.
 *   Transient failures (network, 429, 5xx) are retried with an exponential schedule; the timeout is
 *   60 s per attempt.
 * - `ObjectStoreLive` selects between them on `Config.objectStore.s3BaseUrl`.
 *
 * Every operation emits one event: a `backup` event for `put` (phase `put-object`) and a `lifecycle`
 * event for `get`, because `BackupPhase` in `core/errors.ts` has no read phase. Both carry key, bytes,
 * duration, outcome and `attempts` — the requests sent to the backend, retries included, so a retried
 * transfer is one event that says how many tries it took, never several. A put's event is a transfer
 * record (`emitter: "object-store"`), distinct from the phase records `Backups` writes, and carries the
 * backup run it served (`runId`, read from the `backupRunId` log annotation) when there is one (ADR 0006).
 * The event is emitted on interruption too (`errorTag: "Interrupted"`, attempts so far); an interrupted
 * put's `errorDetail` is `{ written: "unknown" }`, because the object may or may not have been stored.
 * This module reads no environment variables; `platform/config.ts` is the only reader.
 */
import { dirname, resolve, sep } from "node:path";
import { Cause, Clock, Duration, Effect, Exit, FiberId, HashMap, Layer, Option, Schedule } from "effect";
import { ConfigError, InvalidKeyError, type KeyFailure, ObjectStoreError } from "../core/errors.ts";
import {
  backupEvent,
  type EventEnvelope,
  type EventRecord,
  fromPlatformError,
  lifecycleEvent,
  type Role,
} from "../core/events.ts";
import {
  Config,
  EventSink,
  type EventSinkService,
  IdGen,
  type IdGenService,
  ObjectStore as ObjectStoreTag,
  type ObjectStoreService,
} from "./services.ts";

// ===========================================================================
// Key validation
// ===========================================================================

const KEY_PATTERN = /^[A-Za-z0-9_./-]+$/;

/**
 * Why `key` is not a legal object key, or `undefined` when it is. Pure.
 *
 * Every `/`-separated segment must be a real name: `..` and `.` are path-relative (both resolve out of
 * or onto the base), and an empty segment (`a//b`, `a/`) is a different key to some backends and the
 * same one to others. The `KeyFailure` taxonomy is frozen by ADR 0002, so `.` is reported as
 * `parent-traversal` and an empty segment as `illegal-character`.
 */
export function keyFailure(key: string): KeyFailure | undefined {
  if (!KEY_PATTERN.test(key)) return "illegal-character";
  const segments = key.split("/");
  if (segments.includes("..")) return "parent-traversal";
  if (key.startsWith("/")) return "absolute-path";
  if (segments.includes(".")) return "parent-traversal";
  if (segments.includes("")) return "illegal-character";
  return undefined;
}

function validateKey(key: string): Effect.Effect<string, InvalidKeyError> {
  const reason = keyFailure(key);
  return reason === undefined ? Effect.succeed(key) : Effect.fail(new InvalidKeyError({ key, reason }));
}

// ===========================================================================
// Event emission
// ===========================================================================

type ObjectOperation = "put" | "get";
type OperationError = ObjectStoreError | InvalidKeyError;

/**
 * The log annotation naming the backup run an operation serves. `platform/backup.ts` sets it for the
 * whole of one `take`; `instrument` copies it to the transfer record's `runId`.
 */
export const BACKUP_RUN_ANNOTATION = "backupRunId";

interface Instrumentation {
  readonly role: Role;
  readonly sink: EventSinkService;
  readonly ids: IdGenService;
}

/**
 * A log annotation (`traceId`/`trace_id`, `appId`/`app_id`) read under the same names and coercions as
 * `recordFromLogEntry`, so object events join their request.
 */
function annotation(annotations: HashMap.HashMap<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = Option.getOrUndefined(HashMap.get(annotations, key));
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/**
 * `errorTag`/`errorDetail` for a failed operation. An interrupted put cannot say whether the object was
 * written: the interrupt may land before the request, during it, or after the backend stored the bytes
 * (a local write already under way runs to completion), so its detail says `written: "unknown"`.
 */
function failureColumns(
  op: ObjectOperation,
  cause: Cause.Cause<OperationError>,
): { errorTag?: string; errorDetail?: unknown } {
  if (Cause.isInterruptedOnly(cause)) {
    return { errorTag: "Interrupted", errorDetail: op === "put" ? { written: "unknown" } : undefined };
  }
  const error = Option.getOrUndefined(Cause.failureOption(cause));
  return error === undefined ? {} : fromPlatformError(error);
}

/**
 * Runs `operation` and emits exactly one event describing it. The event is emitted from a finalizer,
 * so it is written whatever the exit — interruption included — and cannot fail (`EventSink.emit` is
 * `Effect<void>`), so it never alters the result.
 *
 * `run` receives `sent`, which it runs once per request it sends to the backend (each retry included);
 * the event's `attempts` is how many times it ran before the operation ended.
 */
function instrument<A>(
  deps: Instrumentation,
  op: ObjectOperation,
  key: string,
  bytesIn: number | undefined,
  run: (sent: Effect.Effect<void>) => Effect.Effect<A, OperationError>,
  bytesOf: (value: A) => number,
): Effect.Effect<A, OperationError> {
  return Effect.gen(function* () {
    let attempts = 0;
    const sent = Effect.sync(() => void (attempts += 1));
    const startedAt = yield* Clock.currentTimeMillis;
    // `onExit` finalizers run uninterruptibly, so an interrupted operation still records its transfer.
    return yield* Effect.onExit(run(sent), (exit) => emitFor(exit, startedAt, attempts));
  });

  function emitFor(exit: Exit.Exit<A, OperationError>, startedAt: number, attempts: number) {
    return Effect.gen(function* () {
      const finishedAt = yield* Clock.currentTimeMillis;
      const annotations = yield* Effect.logAnnotations;
      const fiber = FiberId.threadName(yield* Effect.fiberId);
      const eventId = yield* deps.ids.next;
      const ok = Exit.isSuccess(exit);
      const columns = Exit.isFailure(exit) ? failureColumns(op, exit.cause) : undefined;
      const interrupted = columns?.errorTag === "Interrupted";
      const bytes = ok ? bytesOf(exit.value) : bytesIn;
      const envelope: EventEnvelope = {
        eventId,
        ts: new Date(finishedAt).toISOString(),
        level: ok ? "info" : interrupted ? "warn" : "error",
        role: deps.role,
        pid: Deno.pid,
        traceId: annotation(annotations, "traceId", "trace_id") ?? fiber,
        spanId: annotation(annotations, "spanId", "span_id"),
        appId: annotation(annotations, "appId", "app_id"),
      };
      const durationMs = finishedAt - startedAt;
      const outcome = ok ? "ok" : "error";
      const event: EventRecord = op === "put"
        ? backupEvent({
          ...envelope,
          phase: "put-object",
          emitter: "object-store",
          runId: annotation(annotations, BACKUP_RUN_ANNOTATION),
          key,
          bytes,
          attempts,
          durationMs,
          outcome,
          errorTag: columns?.errorTag,
          errorDetail: columns?.errorDetail,
        })
        : lifecycleEvent({
          ...envelope,
          phase: "object-get",
          detail: {
            key,
            bytes,
            attempts,
            durationMs,
            outcome,
            errorTag: columns?.errorTag,
            errorDetail: columns?.errorDetail,
          },
        });
      yield* deps.sink.emit(event);
    });
  }
}

// ===========================================================================
// Local adapter
// ===========================================================================

/** The filesystem calls the local adapter makes. Overridable so tests can inject a failing write. */
export interface LocalFs {
  readonly mkdir: (path: string, options: { recursive: true }) => Promise<void>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly remove: (path: string) => Promise<void>;
}

const denoFs: LocalFs = {
  mkdir: (path, options) => Deno.mkdir(path, options),
  writeFile: (path, bytes) => Deno.writeFile(path, bytes),
  rename: (from, to) => Deno.rename(from, to),
  readFile: (path) => Deno.readFile(path),
  remove: (path) => Deno.remove(path),
};

export interface ObjectStoreOptions {
  /** Process role stamped on emitted events. Defaults to `server`. */
  readonly role?: Role;
  /** Local adapter only: replaces the filesystem calls. */
  readonly fs?: Partial<LocalFs>;
  /** S3 adapter only: replaces the global `fetch`. Receives the already-signed request. */
  readonly fetch?: typeof fetch;
  /** S3 adapter only: first retry delay; doubles each retry. Default 200 ms. */
  readonly retryBase?: Duration.DurationInput;
}

type ObjectStoreLayer<E = never> = Layer.Layer<ObjectStoreTag, E, Config | EventSink | IdGen>;

/** Local stand-in so the complete snapshot/restore flow runs without a cloud account. */
export function makeObjectStoreLocal(options: ObjectStoreOptions = {}): ObjectStoreLayer {
  const fs: LocalFs = { ...denoFs, ...options.fs };
  return Layer.effect(
    ObjectStoreTag,
    Effect.gen(function* () {
      const config = yield* Config;
      const deps: Instrumentation = {
        role: options.role ?? "server",
        sink: yield* EventSink,
        ids: yield* IdGen,
      };
      const root = resolve(config.objectStore.localDir);
      const rootPrefix = root.endsWith(sep) ? root : root + sep;

      /**
       * Defence in depth behind `keyFailure`: the resolved path must be strictly inside `root`, so a key
       * the validator ever let through still cannot write or read outside (or at) the base directory.
       */
      const localPath = (key: string): Effect.Effect<string, InvalidKeyError> => {
        const file = resolve(root, key);
        return file.startsWith(rootPrefix)
          ? Effect.succeed(file)
          : Effect.fail(new InvalidKeyError({ key, reason: "parent-traversal" }));
      };

      const fail = (operation: ObjectOperation, key: string) => (cause: unknown) =>
        new ObjectStoreError({ operation, key, cause, detail: String(cause) });

      const publish = (key: string, file: string, bytes: Uint8Array) =>
        Effect.tryPromise({
          try: async () => {
            await fs.mkdir(dirname(file), { recursive: true });
            const tmp = `${file}.${crypto.randomUUID()}.tmp`;
            try {
              await fs.writeFile(tmp, bytes);
              await fs.rename(tmp, file);
            } catch (error) {
              // The final path is untouched; only the temp file can be left behind, so remove it.
              await fs.remove(tmp).catch(() => undefined);
              throw error;
            }
          },
          catch: fail("put", key),
        });

      const service: ObjectStoreService = {
        put: (key, bytes) =>
          instrument(
            deps,
            "put",
            key,
            bytes.byteLength,
            (sent) =>
              validateKey(key).pipe(
                Effect.flatMap(localPath),
                Effect.flatMap((file) => Effect.zipRight(sent, publish(key, file, bytes))),
              ),
            () => bytes.byteLength,
          ),
        get: (key) =>
          instrument(
            deps,
            "get",
            key,
            undefined,
            (sent) =>
              validateKey(key).pipe(
                Effect.flatMap(localPath),
                Effect.flatMap((file) =>
                  Effect.zipRight(
                    sent,
                    Effect.tryPromise({
                      try: () => fs.readFile(file),
                      catch: fail("get", key),
                    }),
                  )
                ),
              ),
            (value) => value.byteLength,
          ),
      };
      return service;
    }),
  );
}

/** `ObjectStoreLocal` with default options (role `server`, real filesystem). */
export const ObjectStoreLocal: ObjectStoreLayer = makeObjectStoreLocal();

// ===========================================================================
// S3 adapter
// ===========================================================================

const REQUEST_TIMEOUT_MS = 60_000;
const RETRIES = 3;
const DEFAULT_RETRY_BASE: Duration.DurationInput = "200 millis";
/** Response bodies are diagnostic only; keep error payloads (and log lines) bounded. */
const MAX_BODY_CHARS = 2_048;

/** A non-2xx response, carried through `tryPromise` so `catch` can map it to `ObjectStoreError`. */
class HttpFailure extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
  }
}

/**
 * Network errors, timeouts, throttling and server faults may succeed on a retry; other 4xx and the
 * permanent 501 will not. S3 reports a slow upload as `400 RequestTimeout`, which is transient.
 * `403 RequestTimeTooSkewed` is deliberately not retried: re-signing reuses the same local clock, so
 * the skew persists and retrying only delays the failure.
 */
function isTransient(error: ObjectStoreError): boolean {
  const status = error.status;
  if (status === undefined) return true;
  if (status === 400) return /<Code>RequestTimeout<\/Code>/.test(error.detail ?? "");
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 ||
    status === 504;
}

/** Signed S3 (or S3-compatible) client; `aws4fetch` is imported when the layer is built. */
export function makeObjectStoreS3(options: ObjectStoreOptions = {}): ObjectStoreLayer<ConfigError> {
  return Layer.effect(
    ObjectStoreTag,
    Effect.gen(function* () {
      const config = yield* Config;
      const deps: Instrumentation = {
        role: options.role ?? "server",
        sink: yield* EventSink,
        ids: yield* IdGen,
      };
      const { s3BaseUrl, accessKeyId, secretAccessKey, sessionToken, region } = config.objectStore;
      if (s3BaseUrl === undefined || s3BaseUrl === "") {
        return yield* new ConfigError({
          key: "S3_BASE_URL",
          reason: "inconsistent",
          detail: "ObjectStoreS3 requires objectStore.s3BaseUrl",
        });
      }
      if (!accessKeyId || !secretAccessKey) {
        return yield* new ConfigError({
          key: "AWS_ACCESS_KEY_ID",
          reason: "inconsistent",
          detail: "S3 credentials are required when S3_BASE_URL is set",
        });
      }
      const { AwsClient } = yield* Effect.promise(() => import("aws4fetch"));
      // Retries live in this module (`Effect.retry`), so the client's own are switched off.
      const signer = new AwsClient({
        accessKeyId,
        secretAccessKey,
        sessionToken,
        service: "s3",
        region,
        retries: 0,
      });
      // Base includes the bucket: virtual-hosted S3 or a path-style S3-compatible URL.
      const base = s3BaseUrl.replace(/\/$/, "");
      const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
      const send = options.fetch ?? ((request: Request, init?: RequestInit) => fetch(request, init));
      // Jittered so concurrent writers backing off from the same throttle do not retry in lockstep.
      const schedule = Schedule.exponential(options.retryBase ?? DEFAULT_RETRY_BASE).pipe(
        Schedule.jittered,
        Schedule.intersect(Schedule.recurs(RETRIES)),
      );

      /**
       * One signed request per attempt, retried on transient failures. Re-signed per attempt so the
       * timestamp is fresh; `sent` counts each one.
       */
      const attempt = <A>(
        operation: ObjectOperation,
        key: string,
        init: RequestInit,
        read: (response: Response) => Promise<A>,
        sent: Effect.Effect<void>,
      ): Effect.Effect<A, ObjectStoreError> =>
        Effect.zipRight(
          sent,
          Effect.tryPromise({
            try: async (interrupt) => {
              const signal = AbortSignal.any([interrupt, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
              const request = await signer.sign(url(key), init);
              const response = await send(request, { signal });
              if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new HttpFailure(response.status, body.slice(0, MAX_BODY_CHARS));
              }
              return await read(response);
            },
            catch: (cause) =>
              cause instanceof HttpFailure
                ? new ObjectStoreError({ operation, key, status: cause.status, detail: cause.body })
                : new ObjectStoreError({ operation, key, cause, detail: String(cause) }),
          }),
        ).pipe(Effect.retry({ schedule, while: isTransient }));

      const service: ObjectStoreService = {
        put: (key, bytes) =>
          instrument(
            deps,
            "put",
            key,
            bytes.byteLength,
            (sent) =>
              Effect.flatMap(validateKey(key), () =>
                attempt(
                  "put",
                  key,
                  {
                    method: "PUT",
                    body: bytes.slice().buffer,
                    headers: { "content-type": "application/octet-stream" },
                  },
                  async (response) => {
                    await response.body?.cancel();
                  },
                  sent,
                )),
            () => bytes.byteLength,
          ),
        get: (key) =>
          instrument(
            deps,
            "get",
            key,
            undefined,
            (sent) =>
              Effect.flatMap(validateKey(key), () =>
                attempt(
                  "get",
                  key,
                  { method: "GET" },
                  async (response) => new Uint8Array(await response.arrayBuffer()),
                  sent,
                )),
            (value) => value.byteLength,
          ),
      };
      return service;
    }),
  );
}

/** `ObjectStoreS3` with default options (role `server`, global `fetch`). */
export const ObjectStoreS3: ObjectStoreLayer<ConfigError> = makeObjectStoreS3();

// ===========================================================================
// Selection
// ===========================================================================

/** Selects S3 when `Config.objectStore.s3BaseUrl` is set, the local stand-in otherwise. */
export function makeObjectStoreLive(options: ObjectStoreOptions = {}): ObjectStoreLayer<ConfigError> {
  return Layer.unwrapEffect(
    Effect.map(
      Config,
      (config) => config.objectStore.s3BaseUrl ? makeObjectStoreS3(options) : makeObjectStoreLocal(options),
    ),
  );
}

export const ObjectStoreLive: ObjectStoreLayer<ConfigError> = makeObjectStoreLive();

// ===========================================================================
// Transitional Promise facade
// ===========================================================================

/**
 * The Promise-shaped interface `scripts/restore.ts` still consumes (its last caller: item 22 moved
 * `platform/server.ts` and `platform/backup.ts` onto the `ObjectStore` tag).
 *
 * @deprecated Transitional. Delete this interface and `objectStore()` once `scripts/restore.ts` is
 * ported onto the `ObjectStore` tag from `platform/services.ts`.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

const noopSink = Layer.succeed(EventSink, { emit: () => Effect.void });
const uuidIds = Layer.succeed(IdGen, { next: Effect.sync(() => crypto.randomUUID()) });

/**
 * Builds the configured store from the environment (via `ConfigLive`) and exposes it as Promises.
 * Failures reject with the tagged error itself. Emits no events: this path has no `EventSink`.
 *
 * @deprecated Transitional; see {@link ObjectStore}.
 */
export async function objectStore(): Promise<ObjectStore> {
  // Imported here, not at the top: `config.ts` is only needed by this compatibility path.
  const { ConfigLive } = await import("./config.ts");
  const layer = ObjectStoreLive.pipe(
    Layer.provide(Layer.mergeAll(ConfigLive, noopSink, uuidIds)),
  );
  const service = await run(Effect.provide(ObjectStoreTag, layer));
  return {
    put: (key, bytes) => run(service.put(key, bytes)),
    get: (key) => run(service.get(key)),
  };
}

/** `Effect.runPromise`, but rejecting with the underlying error instead of a `FiberFailure` wrapper. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
