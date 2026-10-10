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
 * duration and outcome. This module reads no environment variables; `platform/config.ts` is the only reader.
 */
import { dirname, resolve } from "node:path";
import { Cause, Clock, Duration, Effect, Exit, HashMap, Layer, Option, Schedule } from "effect";
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

/** Why `key` is not a legal object key, or `undefined` when it is. Pure. */
export function keyFailure(key: string): KeyFailure | undefined {
  if (!KEY_PATTERN.test(key)) return "illegal-character";
  if (key.split("/").includes("..")) return "parent-traversal";
  if (key.startsWith("/")) return "absolute-path";
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

interface Instrumentation {
  readonly role: Role;
  readonly sink: EventSinkService;
  readonly ids: IdGenService;
}

/** A log annotation (`traceId`, `appId`) as the logger reads it, so object events join their request. */
function annotation(annotations: HashMap.HashMap<string, unknown>, key: string): string | undefined {
  const value = Option.getOrUndefined(HashMap.get(annotations, key));
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Runs `operation`, then emits exactly one event describing it. The event is emitted whatever the
 * outcome and cannot fail (`EventSink.emit` is `Effect<void>`), so it never alters the result.
 */
function instrument<A>(
  deps: Instrumentation,
  op: ObjectOperation,
  key: string,
  bytesIn: number | undefined,
  run: Effect.Effect<A, OperationError>,
  bytesOf: (value: A) => number,
): Effect.Effect<A, OperationError> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(run);
    const finishedAt = yield* Clock.currentTimeMillis;
    const annotations = yield* Effect.logAnnotations;
    const eventId = yield* deps.ids.next;
    const ok = Exit.isSuccess(exit);
    const error = ok ? undefined : Option.getOrUndefined(Cause.failureOption(exit.cause));
    const columns = error === undefined ? undefined : fromPlatformError(error);
    const bytes = ok ? bytesOf(exit.value) : bytesIn;
    const envelope: EventEnvelope = {
      eventId,
      ts: new Date(finishedAt).toISOString(),
      level: ok ? "info" : "error",
      role: deps.role,
      pid: Deno.pid,
      traceId: annotation(annotations, "traceId") ?? "object-store",
      spanId: annotation(annotations, "spanId"),
      appId: annotation(annotations, "appId"),
    };
    const durationMs = finishedAt - startedAt;
    const outcome = ok ? "ok" : "error";
    const event: EventRecord = op === "put"
      ? backupEvent({
        ...envelope,
        phase: "put-object",
        key,
        bytes,
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
          durationMs,
          outcome,
          errorTag: columns?.errorTag,
          errorDetail: columns?.errorDetail,
        },
      });
    yield* deps.sink.emit(event);
    // A defect (not a typed failure) is re-raised as-is; typed failures keep their channel.
    return yield* exit;
  });
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

      const fail = (operation: ObjectOperation, key: string) => (cause: unknown) =>
        new ObjectStoreError({ operation, key, cause, detail: String(cause) });

      const publish = (key: string, bytes: Uint8Array) =>
        Effect.tryPromise({
          try: async () => {
            const file = resolve(root, key);
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
            Effect.flatMap(validateKey(key), () => publish(key, bytes)),
            () => bytes.byteLength,
          ),
        get: (key) =>
          instrument(
            deps,
            "get",
            key,
            undefined,
            Effect.flatMap(
              validateKey(key),
              () =>
                Effect.tryPromise({
                  try: () => fs.readFile(resolve(root, key)),
                  catch: fail("get", key),
                }),
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

/** Network errors, timeouts, throttling and server faults may succeed on a retry; other 4xx will not. */
function isTransient(error: ObjectStoreError): boolean {
  const status = error.status;
  return status === undefined || status === 429 || status >= 500;
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
      const schedule = Schedule.exponential(options.retryBase ?? DEFAULT_RETRY_BASE).pipe(
        Schedule.intersect(Schedule.recurs(RETRIES)),
      );

      /** One signed request, one attempt. Re-signed per attempt so the timestamp is fresh. */
      const attempt = <A>(
        operation: ObjectOperation,
        key: string,
        init: RequestInit,
        read: (response: Response) => Promise<A>,
      ): Effect.Effect<A, ObjectStoreError> =>
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
        }).pipe(Effect.retry({ schedule, while: isTransient }));

      const service: ObjectStoreService = {
        put: (key, bytes) =>
          instrument(
            deps,
            "put",
            key,
            bytes.byteLength,
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
              )),
            () => bytes.byteLength,
          ),
        get: (key) =>
          instrument(
            deps,
            "get",
            key,
            undefined,
            Effect.flatMap(validateKey(key), () =>
              attempt(
                "get",
                key,
                { method: "GET" },
                async (response) => new Uint8Array(await response.arrayBuffer()),
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
 * The Promise-shaped interface `platform/backup.ts` and `scripts/restore.ts` still consume.
 *
 * @deprecated Transitional. Items 19 (`Backups`) and 22 (server composition) move those callers onto
 * the `ObjectStore` tag from `platform/services.ts`; this interface and `objectStore()` go with them.
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
