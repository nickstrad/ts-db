/**
 * The typed event tables (plan item 21, §4.1): how one ingested JSONL record becomes a row in each
 * DuckDB table. Statements only — `platform/eventlog/ingest.ts` decides when to run them, inside the
 * one transaction per batch that also moves `_ingest_state`.
 *
 * Every statement here against an event table is an `INSERT ... SELECT` from the batch's staging
 * relations. Nothing in this module rewrites or removes a row.
 *
 * ## Staging
 *
 * `ingest.ts` writes each source file's new complete lines to an offset-trimmed temp file, one
 * wrapper object per line: `{"source_file", "source_offset", "dedupe", "line"}`, where `line` is the
 * original line *as a JSON string*. `read_json_auto` over that explicit file list therefore never
 * parses a record itself, so one malformed record cannot fail the read, and DuckDB's JSON functions
 * are the single judge of what is well-formed:
 *
 * - `ingest_stage`: every staged line plus a `reject_reason` (`NULL` when the line is ingestible).
 * - `ingest_rows`: the ingestible lines as `JSON`, minus — for a file that is or was rewritten only —
 *   lines whose `eventId` is already in `platform_events` (see `core/eventlog/offsets.ts`).
 *
 * A line is ingestible iff it is valid JSON, an object, has a non-empty string `eventId`, and has a
 * `ts` DuckDB can read as a timestamp. A wrong-typed *field* is not a reject: that column is `NULL`.
 *
 * ## Column mapping
 *
 * Every ingestible record lands in `platform_events`; records of a typed kind also land in that
 * kind's table. `handler` and `ingest` records have no typed table. As `core/events.ts` documents:
 *
 * - `platform_events.kind` is the union discriminant, except for `handler` records, where it is the
 *   handler's `handlerKind` (`query` / `mutation`); `http_events.kind` is `handlerKind` too.
 * - `platform_events.attrs` is `errorDetail` (for `lifecycle` records, `detail`).
 * - `platform_events.name` is the record's most specific label: `name` (http, handler),
 *   `statementKind` (sql), `queue` (queue), `phase` (backup, lifecycle), `sourceFile` (ingest).
 * - `platform_events.outcome` is `outcome`, or `event` (queue), or `status` (ingest).
 * - `ts` is read as `TIMESTAMPTZ` and stored as its UTC wall time, so a `+02:00` offset is honoured
 *   rather than dropped (a plain `CAST(... AS TIMESTAMP)` silently ignores the offset).
 *
 * ## Large integers
 *
 * The item-13 review found SQLite's `json_extract` mishandles integral doubles ≥ 2^53. DuckDB
 * 1.5.6's JSON reader (yyjson), probed with `work-scripts/deno/duckdb-json-bigint-probe.ts`:
 *
 * - An integer literal (`9007199254740993`) is typed `BIGINT`/`UBIGINT` and extracts exactly.
 * - A literal with a fraction or exponent (`9007199254740993.0`, `1e16`) is typed `DOUBLE` and has
 *   already been rounded to the nearest double (`...992`) by the time SQL sees it.
 * - `TRY_CAST('12.5' AS BIGINT)` *rounds* to 13, and out-of-range values become `NULL`.
 *
 * So `intOf` never casts a `DOUBLE` it cannot prove exact: an integral `DOUBLE` with magnitude
 * ≤ 2^53 - 1 is accepted, any other `DOUBLE` becomes `NULL`, a string is accepted only if it is all
 * digits (that is how `core/events.ts` serialises a `bigint`), and anything outside the column's
 * range is `NULL`. A `NULL` is an honest "unknown"; a silently rounded count is not. Note the JSONL
 * producers are JavaScript, so a `number` past 2^53 has lost precision *before* it is written —
 * DuckDB stores exactly what the line says, which is the most this side can promise.
 */
import { EVENTLOG_DDL } from "../../core/eventlog/ddl.ts";

export { EVENTLOG_DDL };

/** The staging relations. Temp tables: connection-local, never persisted to the event-log file. */
export const STAGE_TABLE = "ingest_stage";
export const ROWS_TABLE = "ingest_rows";

/** Why a staged line was quarantined. The first two are decided in `ingest.ts` before staging. */
export type RejectReason =
  | "invalid-utf8"
  | "line-too-large"
  | "invalid-json"
  | "not-an-object"
  | "missing-event-id"
  | "invalid-ts";

/** The per-line wrapper `ingest.ts` writes to the temp files `read_json_auto` reads. */
export interface StagedLine {
  readonly source_file: string;
  readonly source_offset: number;
  readonly dedupe: boolean;
  readonly line: string;
}

/**
 * Upper bound on one wrapper object, in bytes. `ingest.ts` rejects source lines over
 * `MAX_LINE_BYTES` before staging; JSON-string escaping grows a line by at most 6x (`\u0000`), so
 * this leaves room for every line that gets through.
 */
export const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OBJECT_BYTES = 8 * MAX_LINE_BYTES;

/**
 * Replaces each `\\uXXXX` escape of an unpaired UTF-16 surrogate with `\\ufffd`.
 *
 * `core/events.ts` serialises with `JSON.stringify`, which writes a lone surrogate (a client can put
 * one in any string that reaches `errorDetail`) as an escape. `JSON.parse` accepts that, but
 * DuckDB's `json_valid` rejects the whole line, so without this a client could keep its own error
 * events out of the tables. The replacement is the character DuckDB would need to substitute anyway.
 * Escaped backslashes are skipped, so `\\\\ud800` (a literal backslash, then `ud800`) is untouched.
 * Valid UTF-8 cannot hold a raw lone surrogate, so escapes are the only form to repair.
 */
export function repairLoneSurrogates(line: string): string {
  if (!line.includes("\\u")) return line;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "\\") {
      out += line[i];
      i += 1;
      continue;
    }
    if (line[i + 1] !== "u" || !hex4.test(line.slice(i + 2, i + 6))) {
      out += line.slice(i, i + 2); // any other escape, including an escaped backslash
      i += 2;
      continue;
    }
    const code = parseInt(line.slice(i + 2, i + 6), 16);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh && line[i + 6] === "\\" && line[i + 7] === "u" && hex4.test(line.slice(i + 8, i + 12))) {
      const next = parseInt(line.slice(i + 8, i + 12), 16);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += line.slice(i, i + 12); // a well-formed pair
        i += 12;
        continue;
      }
    }
    out += isHigh || isLow ? "\\ufffd" : line.slice(i, i + 6);
    i += 6;
  }
  return out;
}

/** A single-quoted SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Stages the batch's temp files. Not called with an empty list: `read_json_auto([])` does not bind. */
export function stageSql(files: readonly string[]): string {
  const list = `[${files.map(sqlString).join(", ")}]`;
  return `CREATE OR REPLACE TEMP TABLE ${STAGE_TABLE} AS
SELECT source_file, source_offset, dedupe, line,
  CASE
    WHEN NOT json_valid(line) THEN 'invalid-json'
    WHEN json_type(line) <> 'OBJECT' THEN 'not-an-object'
    WHEN json_type(line, '$.eventId') IS DISTINCT FROM 'VARCHAR' OR (line ->> '$.eventId') = ''
      THEN 'missing-event-id'
    WHEN json_type(line, '$.ts') IS DISTINCT FROM 'VARCHAR'
      OR TRY_CAST((line ->> '$.ts') AS TIMESTAMPTZ) IS NULL THEN 'invalid-ts'
  END AS reject_reason
FROM read_json_auto(${list},
  format = 'newline_delimited',
  columns = {source_file: 'VARCHAR', source_offset: 'BIGINT', dedupe: 'BOOLEAN', line: 'VARCHAR'},
  maximum_object_size = ${MAX_OBJECT_BYTES})`;
}

/**
 * The ingestible rows. A line flagged `dedupe` lands only if its `eventId` is not already in
 * `platform_events` and is the first ingestible line with that id in this batch (file, then offset
 * order), so two flagged copies in one batch cannot both land. Unflagged lines are trusted: they come
 * from past a verified prefix of a file that was never rewritten.
 *
 * `dedupe` says whether any staged line is flagged. Without one, the anti-join is left out of the SQL
 * entirely: DuckDB plans `NOT r.dedupe OR (… NOT EXISTS …)` as a MARK delim-join that scans all of
 * `platform_events` even when no row is flagged, which makes every batch cost O(history).
 */
export function rowsSql(dedupe: boolean): string {
  if (!dedupe) {
    return `CREATE OR REPLACE TEMP TABLE ${ROWS_TABLE} AS
SELECT source_file, source_offset, line::JSON AS j
FROM ${STAGE_TABLE}
WHERE reject_reason IS NULL`;
  }
  return `CREATE OR REPLACE TEMP TABLE ${ROWS_TABLE} AS
SELECT source_file, source_offset, j FROM (
  SELECT s.source_file, s.source_offset, s.dedupe, s.line::JSON AS j, (s.line ->> '$.eventId') AS event_id,
    row_number() OVER (PARTITION BY (s.line ->> '$.eventId') ORDER BY s.source_file, s.source_offset) AS occurrence
  FROM ${STAGE_TABLE} s
  WHERE s.reject_reason IS NULL
) r
WHERE NOT r.dedupe OR (
  r.occurrence = 1 AND NOT EXISTS (SELECT 1 FROM platform_events p WHERE p.event_id = r.event_id)
)`;
}

/** Lines to quarantine, in file order. */
export const rejectedSql = `SELECT source_file, source_offset, reject_reason, line
FROM ${STAGE_TABLE} WHERE reject_reason IS NOT NULL
ORDER BY source_file, source_offset`;

/** Per source file: ingestible lines staged, and rows actually inserted (they differ only by dedupe). */
export const countsSql = `SELECT s.source_file,
  count(*) FILTER (WHERE s.reject_reason IS NULL) AS valid,
  (SELECT count(*) FROM ${ROWS_TABLE} r WHERE r.source_file = s.source_file) AS inserted
FROM ${STAGE_TABLE} s GROUP BY s.source_file`;

export const dropStagingSql = [
  `DROP TABLE IF EXISTS ${ROWS_TABLE}`,
  `DROP TABLE IF EXISTS ${STAGE_TABLE}`,
] as const;

// ---------------------------------------------------------------------------
// Field extraction from `ingest_rows.j`
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER = 9007199254740991;

function path(field: string): string {
  return sqlString(`$.${field}`);
}

/** A scalar as text; `NULL` for a missing key or JSON `null`. */
function textOf(field: string): string {
  return `(j ->> ${path(field)})`;
}

/**
 * A finite number as `DOUBLE`; `NULL` for anything else. DuckDB's JSON parser accepts `Infinity`,
 * `NaN` and overflowing literals (`1e999`), none of which is a duration.
 */
function doubleOf(field: string): string {
  const value = `TRY_CAST(${textOf(field)} AS DOUBLE)`;
  return `CASE WHEN json_type(j, ${path(field)}) IN ('BIGINT', 'UBIGINT', 'DOUBLE') AND isfinite(${value}) ` +
    `THEN ${value} END`;
}

/** An exact integer of `type`, or `NULL` — see "Large integers" above. */
function intOf(field: string, type: "INTEGER" | "BIGINT"): string {
  const text = textOf(field);
  const asDouble = `TRY_CAST(${text} AS DOUBLE)`;
  const big = `CASE json_type(j, ${path(field)})
      WHEN 'BIGINT' THEN TRY_CAST(${text} AS BIGINT)
      WHEN 'UBIGINT' THEN TRY_CAST(${text} AS BIGINT)
      WHEN 'DOUBLE' THEN CASE WHEN abs(${asDouble}) <= ${MAX_SAFE_INTEGER} AND ${asDouble} = floor(${asDouble})
        THEN CAST(${asDouble} AS BIGINT) END
      WHEN 'VARCHAR' THEN CASE WHEN regexp_full_match(${text}, '-?[0-9]{1,19}') THEN TRY_CAST(${text} AS BIGINT) END
    END`;
  return type === "BIGINT" ? `(${big})` : `TRY_CAST((${big}) AS INTEGER)`;
}

/** A JSON value; `NULL` for a missing key or JSON `null`. */
function jsonOf(field: string): string {
  return `CASE WHEN coalesce(json_type(j, ${path(field)}), 'NULL') <> 'NULL' THEN (j -> ${path(field)}) END`;
}

const TS = `(TRY_CAST(${textOf("ts")} AS TIMESTAMPTZ) AT TIME ZONE 'UTC')`;
const KIND = textOf("kind");

/** One event table's insert: target columns, the expression for each, and which records qualify. */
interface TableInsert {
  readonly table: string;
  readonly columns: readonly (readonly [column: string, expression: string])[];
  /** `undefined`: every ingestible record. */
  readonly kind?: string;
}

function insertSql({ table, columns, kind }: TableInsert): string {
  const where = kind === undefined ? "" : `\nWHERE ${KIND} = ${sqlString(kind)}`;
  return `INSERT INTO ${table} (${columns.map(([column]) => column).join(", ")})
SELECT ${columns.map(([column, expression]) => `${expression} AS ${column}`).join(",\n  ")}
FROM ${ROWS_TABLE}${where}
ORDER BY source_file, source_offset`;
}

const PLATFORM_EVENTS: TableInsert = {
  table: "platform_events",
  columns: [
    ["event_id", textOf("eventId")],
    ["ts", TS],
    ["level", textOf("level")],
    ["role", textOf("role")],
    ["pid", intOf("pid", "INTEGER")],
    ["trace_id", textOf("traceId")],
    ["span_id", textOf("spanId")],
    ["parent_span_id", textOf("parentSpanId")],
    ["app_id", textOf("appId")],
    ["kind", `CASE WHEN ${KIND} = 'handler' THEN ${textOf("handlerKind")} ELSE ${KIND} END`],
    [
      "name",
      `CASE ${KIND} WHEN 'http' THEN ${textOf("name")} WHEN 'handler' THEN ${textOf("name")} ` +
      `WHEN 'sql' THEN ${textOf("statementKind")} WHEN 'queue' THEN ${textOf("queue")} ` +
      `WHEN 'backup' THEN ${textOf("phase")} WHEN 'lifecycle' THEN ${textOf("phase")} ` +
      `WHEN 'ingest' THEN ${textOf("sourceFile")} END`,
    ],
    [
      "outcome",
      `CASE ${KIND} WHEN 'queue' THEN ${textOf("event")} WHEN 'ingest' THEN ${textOf("status")} ` +
      `ELSE ${textOf("outcome")} END`,
    ],
    ["error_tag", textOf("errorTag")],
    ["duration_ms", doubleOf("durationMs")],
    ["attrs", `CASE WHEN ${KIND} = 'lifecycle' THEN ${jsonOf("detail")} ELSE ${jsonOf("errorDetail")} END`],
    ["source_file", "source_file"],
    ["source_offset", "source_offset"],
  ],
};

const TYPED_TABLES: readonly TableInsert[] = [
  {
    table: "sql_events",
    kind: "sql",
    columns: [
      ["ts", TS],
      ["trace_id", textOf("traceId")],
      ["app_id", textOf("appId")],
      ["engine", textOf("engine")],
      ["dialect", textOf("dialect")],
      ["statement_kind", textOf("statementKind")],
      ["table_name", textOf("tableName")],
      ["sql_text", textOf("sqlText")],
      ["bind_count", intOf("bindCount", "INTEGER")],
      ["duration_ms", doubleOf("durationMs")],
      ["row_count", intOf("rowCount", "BIGINT")],
      ["outcome", textOf("outcome")],
      ["error_tag", textOf("errorTag")],
    ],
  },
  {
    table: "tx_events",
    kind: "tx",
    columns: [
      ["ts", TS],
      ["trace_id", textOf("traceId")],
      ["app_id", textOf("appId")],
      ["engine", textOf("engine")],
      ["outcome", textOf("outcome")],
      ["operations", intOf("operations", "INTEGER")],
      ["duration_ms", doubleOf("durationMs")],
      ["queue_wait_ms", doubleOf("queueWaitMs")],
      ["error_tag", textOf("errorTag")],
    ],
  },
  {
    table: "http_events",
    kind: "http",
    columns: [
      ["ts", TS],
      ["trace_id", textOf("traceId")],
      ["method", textOf("method")],
      ["path", textOf("path")],
      ["app_id", textOf("appId")],
      ["kind", textOf("handlerKind")],
      ["name", textOf("name")],
      ["status", intOf("status", "INTEGER")],
      ["duration_ms", doubleOf("durationMs")],
      ["bytes_in", intOf("bytesIn", "BIGINT")],
      ["bytes_out", intOf("bytesOut", "BIGINT")],
      ["error_tag", textOf("errorTag")],
    ],
  },
  {
    table: "queue_events",
    kind: "queue",
    columns: [
      ["ts", TS],
      ["queue", textOf("queue")],
      ["depth", intOf("depth", "INTEGER")],
      ["cap", intOf("cap", "INTEGER")],
      ["event", textOf("event")],
      ["dropped", intOf("dropped", "BIGINT")],
    ],
  },
  {
    table: "backup_events",
    kind: "backup",
    columns: [
      ["ts", TS],
      ["app_id", textOf("appId")],
      ["phase", textOf("phase")],
      ["key", textOf("key")],
      ["bytes", intOf("bytes", "BIGINT")],
      ["sha256", textOf("sha256")],
      ["duration_ms", doubleOf("durationMs")],
      ["outcome", textOf("outcome")],
      ["error_tag", textOf("errorTag")],
    ],
  },
  {
    table: "lifecycle_events",
    kind: "lifecycle",
    columns: [
      ["ts", TS],
      ["role", textOf("role")],
      ["pid", intOf("pid", "INTEGER")],
      ["phase", textOf("phase")],
      ["detail", jsonOf("detail")],
    ],
  },
];

/** The batch's inserts, `platform_events` first. Run in this order inside the batch transaction. */
export const insertStatements: readonly { readonly table: string; readonly sql: string }[] = [
  PLATFORM_EVENTS,
  ...TYPED_TABLES,
].map((spec) => ({ table: spec.table, sql: insertSql(spec) }));
