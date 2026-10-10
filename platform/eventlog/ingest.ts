/**
 * `EventLogIngestLive`: idempotent, exactly-once ingest of the rotating JSONL event log into the
 * append-only DuckDB event tables (plan item 21).
 *
 * **Reader process only.** This module imports `@duckdb/node-api`; the writer (server) process must
 * never load it — see ADR 0004. The event-log DuckDB file (`Config.eventLog.duckdbPath`) is a
 * persistent file of its own, separate from the per-app `:memory:` instances `platform/duckdb.ts`
 * opens, and nothing here loads DuckDB's `sqlite` extension.
 *
 * ## One run
 *
 * 1. **Inventory**: list `LOG_DIR/<role>/<YYYY-MM-DD>/events-*.jsonl` and read every
 *    `_ingest_state` row.
 * 2. **Plan**, per file: read its bytes and hand them to `core/eventlog/offsets.ts`'s `planFile`,
 *    which re-hashes the recorded prefix, decides `skip` / `new` / `append` / `rewritten`, and cuts
 *    the complete lines past the offset. Lines that are not UTF-8 or exceed `MAX_LINE_BYTES` are
 *    rejected here; the rest are written to an offset-trimmed temp file (see `tables.ts`).
 * 3. **Commit**, per batch of roughly `batchBytes` of new data: in **one DuckDB transaction**, stage the temp
 *    files with `read_json_auto` over the explicit file list, insert into the event tables, write
 *    rejected lines to quarantine, and upsert each file's `_ingest_state` row. Either all of it
 *    commits or none of it does, so a crash or a failed statement never advances an offset past rows
 *    that did not land, and never lands rows without advancing the offset.
 *
 * Event tables only ever receive `INSERT`s (from `tables.ts`); `_ingest_state` is the one mutable
 * table, and the upsert below is the only statement in this module that changes an existing row.
 *
 * ## Rejected lines
 *
 * A line that cannot be ingested is appended to `LOG_DIR/<role>/<date>/rejected.jsonl` beside its
 * source file, and the rest of the batch proceeds. (A line rejected for exceeding `MAX_LINE_BYTES`
 * keeps only its first 64 Ki characters there; the source JSONL still holds it in full.) Quarantine
 * is written *before* `COMMIT`: if the commit then fails, the next run quarantines the same lines
 * again. A duplicate in a diagnostic file
 * is the safe failure; a rejected line that vanished would not be. Each file with rejects yields one
 * `ingest` event.
 *
 * Only anomalies (rejected lines, a rewritten source, an unreadable file, a failed run) are emitted
 * as `ingest` events. A success event per run would itself be ingested by the next run, so a quiet
 * tree would never become an unchanged one.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { Clock, Effect, Exit, Layer, type Scope } from "effect";
import { IngestError, type IngestPhase } from "../../core/errors.ts";
import {
  fromPlatformError,
  ingestEvent,
  type IngestPayload,
  type Level,
  type Role,
} from "../../core/events.ts";
import {
  compareSourceFiles,
  type FilePlan,
  type IngestStateRow,
  parseSourceFile,
  planFile,
  quarantinePath,
  SOURCE_ROLES,
  type SourceFile,
} from "../../core/eventlog/offsets.ts";
import {
  countsSql,
  dropStagingSql,
  EVENTLOG_DDL,
  insertStatements,
  MAX_LINE_BYTES,
  rejectedSql,
  type RejectReason,
  repairLoneSurrogates,
  rowsSql,
  type StagedLine,
  stageSql,
} from "./tables.ts";
import {
  Config,
  EventLogIngest,
  type EventLogIngestService,
  EventSink,
  type IngestReport,
} from "../services.ts";

// ---------------------------------------------------------------------------
// The native seam
// ---------------------------------------------------------------------------

type SqlValue = string | number | boolean | null;

/** The slice of `DuckDBConnection` ingest uses. */
export interface EventLogConnection {
  run(sql: string, values?: SqlValue[]): Promise<unknown>;
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Record<string, unknown>[] }>;
  closeSync(): void;
}

/** The slice of `DuckDBInstance` ingest uses. */
export interface EventLogInstance {
  connect(): Promise<EventLogConnection>;
  closeSync(): void;
}

/** How the layer opens the event-log file. Tests wrap it to inject failures. */
export interface EventLogDriver {
  readonly open: (path: string) => Promise<EventLogInstance>;
}

/** The persistent event-log file, sized like the per-app readers. */
export const eventLogDriver: EventLogDriver = {
  open: (path) => DuckDBInstance.create(path, { threads: "2", memory_limit: "256MB" }),
};

export interface EventLogIngestOptions {
  readonly driver?: EventLogDriver;
  /** Target new bytes per transaction. A single file is never split, so a batch may exceed it. */
  readonly batchBytes?: number;
  /** The `role` on emitted `ingest` events. Default `"reader"`, the process that owns DuckDB. */
  readonly role?: Role;
}

const DEFAULT_BATCH_BYTES = 32 * 1024 * 1024;

/**
 * Moves one file's offset. `_ingest_state` is the one mutable table, and this is the only statement in
 * this module that replaces an existing row. `$5` is an ISO-8601 instant; it is stored as UTC.
 */
const UPSERT_INGEST_STATE =
  "INSERT OR REPLACE INTO _ingest_state (source_file, bytes_ingested, prefix_sha256, dedupe, last_ingested_at) " +
  "VALUES ($1, $2, $3, $4, CAST($5 AS TIMESTAMPTZ) AT TIME ZONE 'UTC')";

/** How many rejected offsets an `ingest` event lists before it only counts. */
const MAX_LISTED_REJECTS = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs one native or filesystem call; a rejection becomes `IngestError({ phase })`. */
function attempt<A>(
  phase: IngestPhase,
  run: () => Promise<A>,
  sourceFile?: string,
): Effect.Effect<A, IngestError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new IngestError({ phase, sourceFile, detail: messageOf(cause), cause }),
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Closes a native handle; a failing close is logged, never raised — finalizers cannot fail. */
function close(what: string, handle: { closeSync(): void }): Effect.Effect<void> {
  return Effect.try(() => handle.closeSync()).pipe(
    Effect.catchAll((error) => Effect.logWarning(`event-log ${what} failed to close`, error)),
  );
}

/** The entries of a directory, or none if it does not exist. */
async function entries(path: string): Promise<Deno.DirEntry[]> {
  const found: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(path)) found.push(entry);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
  return found;
}

/** Every event-log source file under `logDir`, in ingest order. */
async function inventory(logDir: string): Promise<SourceFile[]> {
  const sources: SourceFile[] = [];
  for (const role of SOURCE_ROLES) {
    for (const day of await entries(join(logDir, role))) {
      if (!day.isDirectory) continue;
      for (const file of await entries(join(logDir, role, day.name))) {
        if (!file.isFile) continue;
        const source = parseSourceFile(`${role}/${day.name}/${file.name}`);
        if (source !== undefined) sources.push(source);
      }
    }
  }
  return sources.sort(compareSourceFiles);
}

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

// ---------------------------------------------------------------------------
// Per-file staging
// ---------------------------------------------------------------------------

/** One line that will not reach an event table, and why. */
interface Reject {
  readonly sourceOffset: number;
  readonly reason: RejectReason;
  readonly line: string;
}

/** One file's plan, its staged temp file (when it has lines to stage), and its pre-staging rejects. */
interface Staged {
  readonly source: SourceFile;
  readonly plan: FilePlan;
  readonly tempFile?: string;
  readonly rejects: readonly Reject[];
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

/** Quarantine keeps at most this much of a line rejected for its size. */
const QUARANTINE_LINE_CHARS = 64 * 1024;

/**
 * Writes `plan`'s lines as `StagedLine` wrappers to `tempFile`. The original line travels as a JSON
 * *string*, byte-for-byte, so DuckDB alone parses it and no JavaScript number ever touches it.
 */
async function stage(
  source: SourceFile,
  plan: FilePlan,
  bytes: Uint8Array,
  tempFile: string,
): Promise<Staged> {
  const dedupe = plan.decision.kind === "read" && plan.decision.dedupe;
  const rejects: Reject[] = [];
  const out: string[] = [];
  for (const span of plan.lines) {
    const raw = bytes.subarray(span.start, span.end);
    if (raw.length > MAX_LINE_BYTES) {
      const prefix = lossyUtf8.decode(raw.subarray(0, QUARANTINE_LINE_CHARS));
      rejects.push({ sourceOffset: span.start, reason: "line-too-large", line: prefix });
      continue;
    }
    let line: string;
    try {
      line = repairLoneSurrogates(strictUtf8.decode(raw));
    } catch {
      rejects.push({ sourceOffset: span.start, reason: "invalid-utf8", line: lossyUtf8.decode(raw) });
      continue;
    }
    const wrapper: StagedLine = { source_file: source.path, source_offset: span.start, dedupe, line };
    out.push(JSON.stringify(wrapper));
  }
  if (out.length === 0) return { source, plan, rejects };
  await Deno.writeTextFile(tempFile, out.join("\n") + "\n");
  return { source, plan, tempFile, rejects };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** What one committed batch contributes to the run's report and events. */
interface BatchResult {
  readonly inserted: number;
  readonly rejected: number;
  /** Per source file: rejects, and lines skipped by dedupe because they were already ingested. */
  readonly perFile: ReadonlyMap<string, { rejects: Reject[]; deduplicated: number }>;
}

/**
 * Builds the service in the current scope: opens (creating if needed) the event-log file, ensures
 * every table exists, and registers connection-then-instance release.
 */
export function makeEventLogIngest(
  options: EventLogIngestOptions = {},
): Effect.Effect<EventLogIngestService, IngestError, Scope.Scope | Config | EventSink> {
  return Effect.gen(function* () {
    const config = yield* Config;
    const sink = yield* EventSink;
    const driver = options.driver ?? eventLogDriver;
    const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
    const role = options.role ?? "reader";
    const logDir = config.logging.dir;
    const dbPath = config.eventLog.duckdbPath;

    yield* attempt("inventory", () => Deno.mkdir(dirname(dbPath), { recursive: true }));
    const instance = yield* Effect.acquireRelease(
      attempt("inventory", () => driver.open(dbPath)),
      (handle) => close("instance", handle),
    );

    /** A fresh connection with the session settings and schema every statement below assumes. */
    const connect = Effect.gen(function* () {
      const fresh = yield* attempt("inventory", () => instance.connect());
      const prepared = yield* Effect.either(Effect.gen(function* () {
        // An offset-less `ts` is read as UTC rather than in the host's zone.
        yield* attempt("inventory", () => fresh.run("SET TimeZone = 'UTC'"));
        for (const ddl of EVENTLOG_DDL) yield* attempt("inventory", () => fresh.run(ddl));
      }));
      if (prepared._tag === "Left") {
        yield* close("connection", fresh);
        return yield* Effect.fail(prepared.left);
      }
      return fresh;
    });

    /**
     * The current connection. A failed `ROLLBACK` can leave it inside a transaction, where every later
     * `BEGIN` would fail, so it is then marked `broken` and the next run replaces it.
     */
    const db = { connection: yield* connect, broken: false };
    // Added after the instance's finalizer, so it runs first (LIFO): connection, then instance.
    yield* Effect.addFinalizer(() => close("connection", db.connection));

    const reconnectIfBroken: Effect.Effect<void, IngestError> = Effect.suspend(() => {
      if (!db.broken) return Effect.void;
      return Effect.gen(function* () {
        yield* close("connection", db.connection);
        db.connection = yield* connect;
        db.broken = false;
      });
    });

    const lock = yield* Effect.makeSemaphore(1);

    const emit = (
      level: Level,
      traceId: string,
      payload: IngestPayload,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* sink.emit(ingestEvent({
          eventId: crypto.randomUUID(),
          ts,
          level,
          role,
          pid: Deno.pid,
          traceId,
          ...payload,
        }));
      });

    const readState: Effect.Effect<Map<string, IngestStateRow>, IngestError> = Effect.map(
      attempt(
        "inventory",
        () =>
          db.connection.runAndReadAll(
            `SELECT source_file, bytes_ingested, prefix_sha256, dedupe, CAST(last_ingested_at AS VARCHAR) AS at
             FROM _ingest_state`,
          ),
      ),
      (reader) =>
        new Map(
          reader.getRowObjects().map((row) => {
            const state: IngestStateRow = {
              sourceFile: String(row.source_file),
              bytesIngested: toNumber(row.bytes_ingested),
              prefixSha256: String(row.prefix_sha256),
              dedupe: row.dedupe === true,
              lastIngestedAt: String(row.at),
            };
            return [state.sourceFile, state];
          }),
        ),
    );

    /** Appends quarantine records, grouped per `rejected.jsonl`. */
    const quarantine = (rejectsBySource: ReadonlyMap<SourceFile, readonly Reject[]>, at: string) =>
      Effect.forEach(
        groupByQuarantine(rejectsBySource),
        ([relative, lines]) =>
          attempt("insert", async () => {
            const file = await Deno.open(join(logDir, relative), { create: true, append: true });
            try {
              const data = new TextEncoder().encode(lines.map((line) => line(at)).join("\n") + "\n");
              let written = 0;
              while (written < data.length) written += await file.write(data.subarray(written));
            } finally {
              file.close();
            }
          }, relative),
        { discard: true },
      );

    /** One transaction: stage, insert, quarantine, move offsets, commit. */
    const commitBatch = (batch: readonly Staged[], at: string): Effect.Effect<BatchResult, IngestError> => {
      const work = Effect.gen(function* () {
        const files = batch.flatMap((item) => item.tempFile === undefined ? [] : [item.tempFile]);
        const perFile = new Map<string, { rejects: Reject[]; deduplicated: number }>(
          batch.map((item) => [item.source.path, { rejects: [...item.rejects], deduplicated: 0 }]),
        );
        let inserted = 0;
        if (files.length > 0) {
          yield* attempt("insert", () => db.connection.run(stageSql(files)));
          yield* attempt("insert", () => db.connection.run(rowsSql));
          for (const statement of insertStatements) {
            yield* attempt("insert", () => db.connection.run(statement.sql), statement.table);
          }
          const rejected = yield* attempt("insert", () => db.connection.runAndReadAll(rejectedSql));
          for (const row of rejected.getRowObjects()) {
            perFile.get(String(row.source_file))?.rejects.push({
              sourceOffset: toNumber(row.source_offset),
              reason: String(row.reject_reason) as RejectReason,
              line: String(row.line),
            });
          }
          const counts = yield* attempt("insert", () => db.connection.runAndReadAll(countsSql));
          for (const row of counts.getRowObjects()) {
            const entry = perFile.get(String(row.source_file));
            const valid = toNumber(row.valid);
            const landed = toNumber(row.inserted);
            inserted += landed;
            if (entry) entry.deduplicated = valid - landed;
          }
        }
        const rejectsBySource = new Map<SourceFile, readonly Reject[]>();
        for (const item of batch) {
          const rejects = perFile.get(item.source.path)?.rejects ?? [];
          if (rejects.length > 0) {
            rejectsBySource.set(item.source, [...rejects].sort((a, b) => a.sourceOffset - b.sourceOffset));
          }
        }
        yield* quarantine(rejectsBySource, at);
        for (const item of batch) {
          const next = item.plan.nextState;
          if (next === undefined) continue;
          yield* attempt(
            "state-update",
            () =>
              db.connection.run(UPSERT_INGEST_STATE, [
                next.sourceFile,
                next.bytesIngested,
                next.prefixSha256,
                next.dedupe,
                next.lastIngestedAt,
              ]),
            next.sourceFile,
          );
        }
        let rejected = 0;
        for (const rejects of rejectsBySource.values()) rejected += rejects.length;
        return { inserted, rejected, perFile };
      });

      return Effect.acquireUseRelease(
        attempt("commit", () => db.connection.run("BEGIN TRANSACTION")),
        () => Effect.zipLeft(work, attempt("commit", () => db.connection.run("COMMIT"))),
        (_, exit) =>
          Effect.zipRight(
            Exit.isFailure(exit)
              ? attempt("commit", () => db.connection.run("ROLLBACK")).pipe(
                Effect.catchAll((error) =>
                  Effect.zipRight(
                    Effect.sync(() => {
                      db.broken = true;
                    }),
                    Effect.logWarning("event-log rollback failed; reconnecting before the next run", error),
                  )
                ),
              )
              : Effect.void,
            Effect.forEach(
              dropStagingSql,
              (sql) => attempt("insert", () => db.connection.run(sql)).pipe(Effect.ignore),
              { discard: true },
            ),
          ),
      );
    };

    const run: Effect.Effect<IngestReport, IngestError> = Effect.gen(function* () {
      const startNanos = yield* Clock.currentTimeNanos;
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
      const runId = crypto.randomUUID();
      const traceId = `ingest-${runId}`;

      const body = Effect.gen(function* () {
        yield* reconnectIfBroken;
        const sources = yield* attempt("inventory", () => inventory(logDir));
        const state = yield* readState;
        const tempDir = yield* Effect.acquireRelease(
          attempt("read", () => Deno.makeTempDir({ prefix: "ts-db-ingest-" })),
          (dir) => Effect.promise(() => Deno.remove(dir, { recursive: true }).catch(() => undefined)),
        );

        let filesIngested = 0;
        let bytesIngested = 0;
        let linesIngested = 0;
        let linesRejected = 0;

        /** Commits the pending batch, reports its anomalies, and frees its temp files. */
        let pending: Staged[] = [];
        let pendingBytes = 0;
        const flush = Effect.gen(function* () {
          const batch = pending;
          pending = [];
          pendingBytes = 0;
          if (batch.length === 0) return;
          const result = yield* commitBatch(batch, at);
          linesIngested += result.inserted;
          linesRejected += result.rejected;
          for (const item of batch) {
            const { decision, end } = item.plan;
            const from = decision.kind === "read" ? decision.from : end;
            filesIngested += 1;
            bytesIngested += end - from;
            const outcome = result.perFile.get(item.source.path);
            if (outcome !== undefined && outcome.rejects.length > 0) {
              yield* emit("warn", traceId, {
                sourceFile: item.source.path,
                bytesIngested: end - from,
                runId,
                status: "error",
                errorTag: "RejectedLines",
                errorDetail: {
                  quarantine: quarantinePath(item.source),
                  rejected: outcome.rejects.length,
                  lines: outcome.rejects.slice(0, MAX_LISTED_REJECTS).map(({ sourceOffset, reason }) => ({
                    sourceOffset,
                    reason,
                  })),
                },
              });
            }
            if (decision.kind === "read" && decision.mode === "rewritten") {
              yield* emit("warn", traceId, {
                sourceFile: item.source.path,
                bytesIngested: end - from,
                runId,
                status: "error",
                errorTag: "SourceRewritten",
                errorDetail: {
                  reason: decision.rewrite,
                  previousBytesIngested: decision.previous?.bytesIngested,
                  size: decision.size,
                  deduplicated: outcome?.deduplicated ?? 0,
                },
              });
            }
            const temp = item.tempFile;
            if (temp !== undefined) yield* Effect.promise(() => Deno.remove(temp).catch(() => undefined));
          }
        });

        // Files are staged as they are planned and committed once roughly `batchBytes` of new data is
        // pending, so temp disk and memory stay bounded by the batch, not by the backlog.
        for (const [index, source] of sources.entries()) {
          const bytes = yield* Effect.either(
            attempt("read", () => Deno.readFile(join(logDir, source.path)), source.path),
          );
          if (bytes._tag === "Left") {
            // Retention may remove a file between listing and reading; that is not an anomaly.
            if (bytes.left.cause instanceof Deno.errors.NotFound) continue;
            // One unreadable file must not wedge every file after it: report it and move on.
            yield* emit("error", traceId, {
              sourceFile: source.path,
              bytesIngested: 0,
              runId,
              status: "error",
              ...fromPlatformError(bytes.left),
            });
            continue;
          }
          const plan = planFile(source.path, state.get(source.path), bytes.right, sha256Hex, at);
          if (plan.nextState === undefined) continue;
          pending.push(
            yield* attempt(
              "read",
              () => stage(source, plan, bytes.right, join(tempDir, `${index}.jsonl`)),
              source.path,
            ),
          );
          pendingBytes += plan.end - (plan.decision.kind === "read" ? plan.decision.from : plan.end);
          if (pendingBytes >= batchBytes) yield* flush;
        }
        yield* flush;
        return { filesScanned: sources.length, filesIngested, bytesIngested, linesIngested, linesRejected };
      });

      const counts = yield* Effect.scoped(body).pipe(
        Effect.tapError((error) =>
          emit("error", traceId, {
            sourceFile: error.sourceFile ?? "",
            bytesIngested: 0,
            runId,
            status: "error",
            ...fromPlatformError(error),
          })
        ),
      );
      const durationMs = Number((yield* Clock.currentTimeNanos) - startNanos) / 1e6;
      return { ...counts, durationMs };
    });

    return { ingest: lock.withPermits(1)(run) };
  });
}

/** Builds quarantine record writers grouped by their `rejected.jsonl`, relative to `LOG_DIR`. */
function groupByQuarantine(
  rejectsBySource: ReadonlyMap<SourceFile, readonly Reject[]>,
): Map<string, ((at: string) => string)[]> {
  const groups = new Map<string, ((at: string) => string)[]>();
  for (const [source, rejects] of rejectsBySource) {
    const target = quarantinePath(source);
    const lines = groups.get(target) ?? [];
    for (const reject of rejects) {
      lines.push((at) =>
        JSON.stringify({
          rejectedAt: at,
          sourceFile: source.path,
          sourceOffset: reject.sourceOffset,
          reason: reject.reason,
          line: reject.line,
        })
      );
    }
    groups.set(target, lines);
  }
  return groups;
}

/** A layer over explicit options; `EventLogIngestLive` is this with the defaults. */
export function eventLogIngestLayer(
  options: EventLogIngestOptions = {},
): Layer.Layer<EventLogIngest, IngestError, Config | EventSink> {
  return Layer.scoped(EventLogIngest, makeEventLogIngest(options));
}

/** Live: the persistent DuckDB event log, ingesting `LOG_DIR`. Reader process only. */
export const EventLogIngestLive: Layer.Layer<EventLogIngest, IngestError, Config | EventSink> =
  eventLogIngestLayer();
