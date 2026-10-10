/**
 * The event taxonomy: one discriminated union over every event this platform can emit, total
 * constructors for each kind, and `toJsonLine`, which serializes a record to one canonical,
 * key-ordered JSON line for the rotating JSONL log (ADR 0001 decision 4; §4.1 of the plan).
 *
 * This module is PURE: it imports only `effect`-free types from `./errors.ts` and does no I/O.
 * Constructors never call `crypto.randomUUID()` or `Date.now()` — `eventId` and `ts` are always
 * caller-supplied, which is what makes them deterministic and property-testable.
 *
 * Redaction is load-bearing, not cosmetic (see the plan's item 07 and ADR 0002 decision 4):
 *
 * - `sql` events never carry bind values unless the constructor is given
 *   `{ includeBindValues: true }`, mirroring today's `TRACE_SQL=1` caveat that it logs
 *   application values.
 * - Bearer tokens (`Bearer <token>`), `authorization` headers (any casing) and S3 credential
 *   fields are redacted unconditionally, regardless of any flag, wherever they appear in
 *   free-form payload data (`errorDetail`, `lifecycle` detail, bind values).
 * - Player ids and document ids are never redacted: they are the data this log exists to
 *   analyse.
 *
 * Field naming note: the plan's per-kind field lists for `http` and `handler` include a `kind`
 * field (the routed handler's `"query" | "mutation"`). That name collides with this union's own
 * discriminant (`EventRecord["kind"]`, one of the eight event kinds below), so the handler's
 * query/mutation distinction is carried here as `handlerKind` instead.
 */
import type { BackupPhase, HandlerKind, PlatformError, QueueName } from "./errors.ts";

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

export type Level = "debug" | "info" | "warn" | "error";
export type Role = "server" | "reader" | "restore" | "cli";

/** Fields every event record carries, regardless of kind. */
export interface EventEnvelope {
  readonly eventId: string;
  readonly ts: string;
  readonly level: Level;
  readonly role: Role;
  readonly pid: number;
  readonly traceId: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly appId?: string;
}

/** `fromPlatformError`'s output: a stable, low-cardinality `error_tag` plus the structured payload. */
export interface ErrorColumns {
  readonly errorTag: string;
  readonly errorDetail: unknown;
}

// ---------------------------------------------------------------------------
// Per-kind payloads
// ---------------------------------------------------------------------------

export type SqlEngine = "sqlite" | "duckdb";
export type SqlStatementKind = "select" | "insert" | "update" | "delete" | "ddl" | "pragma";
export type TxOutcome = "commit" | "rollback" | "interrupted";
export type QueueSignal = "high-water" | "rejected" | "dropped";
export type Outcome = "ok" | "error";

export interface HttpPayload {
  readonly method: string;
  readonly path: string;
  readonly handlerKind: HandlerKind;
  readonly name: string;
  readonly status: number;
  readonly durationMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly errorTag?: string;
  readonly errorDetail?: unknown;
}

export interface HandlerPayload {
  readonly handlerKind: HandlerKind;
  readonly name: string;
  readonly outcome: Outcome;
  readonly durationMs: number;
  readonly errorTag?: string;
  readonly errorDetail?: unknown;
}

export interface SqlPayload {
  readonly engine: SqlEngine;
  readonly dialect: string;
  readonly statementKind: SqlStatementKind;
  readonly tableName?: string;
  readonly sqlText: string;
  readonly bindCount: number;
  readonly bindValues?: readonly unknown[];
  readonly durationMs: number;
  readonly rowCount?: number;
  readonly outcome: Outcome;
  readonly errorTag?: string;
  readonly errorDetail?: unknown;
}

export interface SqlEventOptions {
  /** Default false: bind values are never logged unless explicitly opted in. */
  readonly includeBindValues?: boolean;
}

export interface TxPayload {
  readonly engine: SqlEngine;
  readonly outcome: TxOutcome;
  readonly operations: number;
  readonly durationMs: number;
  readonly queueWaitMs: number;
  readonly errorTag?: string;
  readonly errorDetail?: unknown;
}

export interface QueuePayload {
  readonly queue: QueueName;
  readonly depth: number;
  readonly cap: number;
  readonly event: QueueSignal;
  readonly dropped: number;
}

export interface BackupPayload {
  readonly phase: BackupPhase;
  readonly key?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly errorTag?: string;
  readonly errorDetail?: unknown;
}

export interface LifecyclePayload {
  readonly phase: string;
  readonly detail?: unknown;
}

export interface IngestPayload {
  readonly sourceFile: string;
  readonly bytesIngested: number;
  readonly runId?: string;
  readonly status?: Outcome;
  readonly errorTag?: string;
  readonly errorDetail?: unknown;
}

// ---------------------------------------------------------------------------
// EventRecord: the discriminated union over `kind`
// ---------------------------------------------------------------------------

export type EventRecord =
  | (EventEnvelope & { readonly kind: "http" } & HttpPayload)
  | (EventEnvelope & { readonly kind: "handler" } & HandlerPayload)
  | (EventEnvelope & { readonly kind: "sql" } & SqlPayload)
  | (EventEnvelope & { readonly kind: "tx" } & TxPayload)
  | (EventEnvelope & { readonly kind: "queue" } & QueuePayload)
  | (EventEnvelope & { readonly kind: "backup" } & BackupPayload)
  | (EventEnvelope & { readonly kind: "lifecycle" } & LifecyclePayload)
  | (EventEnvelope & { readonly kind: "ingest" } & IngestPayload);

// ---------------------------------------------------------------------------
// Constructors — total, deterministic, one per kind
// ---------------------------------------------------------------------------

export function httpEvent(input: EventEnvelope & HttpPayload): EventRecord {
  return { ...input, kind: "http" };
}

export function handlerEvent(input: EventEnvelope & HandlerPayload): EventRecord {
  return { ...input, kind: "handler" };
}

export function sqlEvent(
  input: EventEnvelope & SqlPayload,
  opts: SqlEventOptions = {},
): EventRecord {
  const includeBindValues = opts.includeBindValues ?? false;
  const { bindValues, ...rest } = input;
  return includeBindValues ? { ...rest, bindValues, kind: "sql" } : { ...rest, kind: "sql" };
}

export function txEvent(input: EventEnvelope & TxPayload): EventRecord {
  return { ...input, kind: "tx" };
}

export function queueEvent(input: EventEnvelope & QueuePayload): EventRecord {
  return { ...input, kind: "queue" };
}

export function backupEvent(input: EventEnvelope & BackupPayload): EventRecord {
  return { ...input, kind: "backup" };
}

export function lifecycleEvent(input: EventEnvelope & LifecyclePayload): EventRecord {
  return { ...input, kind: "lifecycle" };
}

export function ingestEvent(input: EventEnvelope & IngestPayload): EventRecord {
  return { ...input, kind: "ingest" };
}

// ---------------------------------------------------------------------------
// fromPlatformError
// ---------------------------------------------------------------------------

/**
 * Every `PlatformError` is a `Data.TaggedError`, whose only own enumerable keys are `_tag` plus
 * its payload fields (verified against `effect@3.22.2`). `errorTag` is the stable, low-cardinality
 * analysis column; `errorDetail` is the rest of the payload, redacted like everything else by
 * `toJsonLine`.
 */
export function fromPlatformError(e: PlatformError): ErrorColumns {
  const { _tag, ...rest } = e;
  return { errorTag: _tag, errorDetail: rest };
}

// ---------------------------------------------------------------------------
// toJsonLine: canonical key order, redaction, newline sanitization
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = [
  "eventId",
  "ts",
  "level",
  "role",
  "pid",
  "traceId",
  "spanId",
  "parentSpanId",
  "appId",
] as const;

const KIND_KEYS: Record<EventRecord["kind"], readonly string[]> = {
  http: [
    "method",
    "path",
    "handlerKind",
    "name",
    "status",
    "durationMs",
    "bytesIn",
    "bytesOut",
    "errorTag",
    "errorDetail",
  ],
  handler: ["handlerKind", "name", "outcome", "durationMs", "errorTag", "errorDetail"],
  sql: [
    "engine",
    "dialect",
    "statementKind",
    "tableName",
    "sqlText",
    "bindCount",
    "bindValues",
    "durationMs",
    "rowCount",
    "outcome",
    "errorTag",
    "errorDetail",
  ],
  tx: ["engine", "outcome", "operations", "durationMs", "queueWaitMs", "errorTag", "errorDetail"],
  queue: ["queue", "depth", "cap", "event", "dropped"],
  backup: ["phase", "key", "bytes", "sha256", "durationMs", "outcome", "errorTag", "errorDetail"],
  lifecycle: ["phase", "detail"],
  ingest: ["sourceFile", "bytesIngested", "runId", "status", "errorTag", "errorDetail"],
};

/** Builds the canonical, fully-populated (absent optionals as `null`) plain object for a record. */
function canonicalize(record: EventRecord): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const r = record as any;
  const out: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) out[key] = r[key] ?? null;
  out.kind = record.kind;
  for (const key of KIND_KEYS[record.kind]) {
    out[key] = r[key] === undefined ? null : r[key];
  }
  return out;
}

const BEARER_PATTERN = /Bearer\s+\S+/gi;
const SECRET_KEY_PATTERN = /^(authorization|accesskeyid|secretaccesskey|sessiontoken)$/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function redactString(s: string): string {
  return s.replace(BEARER_PATTERN, "Bearer <redacted>");
}

function sanitizeNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** Depth-first redaction (bearer tokens, `authorization`, S3 credentials) and newline sanitization. */
function redactAndSanitize(value: unknown): unknown {
  if (typeof value === "string") return sanitizeNewlines(redactString(value));
  if (Array.isArray(value)) return value.map(redactAndSanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(normalizeKey(k)) ? "<redacted>" : redactAndSanitize(v);
    }
    return out;
  }
  return value;
}

/** Serializes a record to one canonical, key-ordered, newline-free JSON line. */
export function toJsonLine(record: EventRecord): string {
  const ordered = canonicalize(record);
  const redacted = redactAndSanitize(ordered);
  return JSON.stringify(redacted);
}
