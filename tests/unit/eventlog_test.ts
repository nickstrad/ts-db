/**
 * Unit tests for the DuckDB event log (plan item 21): `core/eventlog/*` and `EventLogIngestLive`
 * against a real, persistent DuckDB file and a real `LOG_DIR` tree in a temp directory.
 *
 * DuckDB runs in this (shared) test process. That is safe here, unlike `reader_test.ts`'s
 * in-process half: the hazard ADR 0001 describes is DuckDB's `sqlite` extension sharing an address
 * space with Node's SQLite, and event-log ingest never loads that extension.
 *
 * Every ingest runs in its own scope, so each run opens and closes the event-log file — which also
 * proves the tables and offsets persist across process-like restarts. Assertions read the file with
 * a separate DuckDB instance after the run's scope has closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { Effect, Either, Layer, Ref, TestClock, TestContext } from "effect";
import type { IngestError } from "../../core/errors.ts";
import {
  backupEvent,
  type EventEnvelope,
  type EventRecord,
  handlerEvent,
  httpEvent,
  ingestEvent,
  type IngestEventRecord,
  lifecycleEvent,
  queueEvent,
  sqlEvent,
  toJsonLine,
  txEvent,
} from "../../core/events.ts";
import { EVENT_TABLES } from "../../core/eventlog/ddl.ts";
import { completeLines, decide, type IngestStateRow, parseSourceFile } from "../../core/eventlog/offsets.ts";
import { ConfigTest } from "../../platform/config.ts";
import { EventSink, type IngestReport } from "../../platform/services.ts";
import {
  type EventLogConnection,
  type EventLogDriver,
  eventLogDriver,
  type EventLogIngestOptions,
  makeEventLogIngest,
} from "../../platform/eventlog/ingest.ts";
import { repairLoneSurrogates } from "../../platform/eventlog/tables.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SERVER_FILE = "server/2026-10-10/events-12-4242-001.jsonl";
const READER_FILE = "reader/2026-10-10/events-12-5151-001.jsonl";

interface World {
  readonly root: string;
  readonly logDir: string;
  readonly dbPath: string;
  readonly events: EventRecord[];
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "eventlog-test-" });
  try {
    await body({
      root,
      logDir: join(root, "logs"),
      dbPath: join(root, "logs", "duckdb", "events.duckdb"),
      events: [],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** One ingest run at a fixed `TestClock` instant, in its own scope. Emitted events land in `world.events`. */
async function ingestEither(
  world: World,
  atMillis: number,
  options: EventLogIngestOptions = {},
): Promise<Either.Either<IngestReport, IngestError>> {
  const program = Effect.gen(function* () {
    const sunk = yield* Ref.make<EventRecord[]>([]);
    const sink = Layer.succeed(EventSink, {
      emit: (event: EventRecord) => Ref.update(sunk, (all) => [...all, event]),
    });
    yield* TestClock.setTime(atMillis);
    const result = yield* Effect.either(
      Effect.scoped(Effect.flatMap(makeEventLogIngest(options), (service) => service.ingest)).pipe(
        Effect.provide(Layer.merge(
          ConfigTest({ logging: { dir: world.logDir }, eventLog: { duckdbPath: world.dbPath } }),
          sink,
        )),
      ),
    );
    world.events.push(...(yield* Ref.get(sunk)));
    return result;
  });
  return await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
}

async function ingest(
  world: World,
  atMillis: number,
  options: EventLogIngestOptions = {},
): Promise<IngestReport> {
  const result = await ingestEither(world, atMillis, options);
  if (Either.isLeft(result)) throw new Error(`ingest failed: ${JSON.stringify(result.left)}`);
  return result.right;
}

type Row = Record<string, unknown>;

/** Runs `sql` against the event-log file with a fresh instance; bigints stay bigints. */
async function query(world: World, sql: string): Promise<Row[]> {
  const instance = await DuckDBInstance.create(world.dbPath);
  try {
    const connection = await instance.connect();
    try {
      return (await connection.runAndReadAll(sql)).getRowObjects();
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

async function counts(world: World): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of EVENT_TABLES) {
    const [row] = await query(world, `SELECT count(*) AS n FROM ${table}`);
    out[table] = Number(row.n);
  }
  return out;
}

async function stateRows(world: World): Promise<Row[]> {
  return await query(
    world,
    `SELECT source_file, bytes_ingested, prefix_sha256, CAST(last_ingested_at AS VARCHAR) AS at
     FROM _ingest_state ORDER BY source_file`,
  );
}

async function eventIds(world: World): Promise<string[]> {
  const rows = await query(world, "SELECT event_id FROM platform_events ORDER BY source_file, source_offset");
  return rows.map((row) => String(row.event_id));
}

async function writeSource(world: World, relative: string, content: string | Uint8Array): Promise<void> {
  const path = join(world.logDir, relative);
  await Deno.mkdir(join(path, ".."), { recursive: true });
  if (typeof content === "string") await Deno.writeTextFile(path, content);
  else await Deno.writeFile(path, content);
}

async function appendSource(world: World, relative: string, content: string): Promise<void> {
  await Deno.writeTextFile(join(world.logDir, relative), content, { append: true });
}

function envelope(id: string, role: EventEnvelope["role"], second = 0): EventEnvelope {
  return {
    eventId: id,
    ts: `2026-10-10T12:00:${String(second).padStart(2, "0")}.000Z`,
    level: "info",
    role,
    pid: role === "server" ? 4242 : 5151,
    traceId: "trace-1",
    appId: "column",
  };
}

const lines = (records: readonly EventRecord[]): string => records.map((r) => toJsonLine(r) + "\n").join("");

/** One record of every kind with a typed table, plus a handler record (generic table only). */
function serverFixture(): EventRecord[] {
  return [
    httpEvent({
      ...envelope("s-http", "server", 1),
      method: "POST",
      path: "/apps/column/mutation/makeMove",
      handlerKind: "mutation",
      name: "makeMove",
      status: 200,
      durationMs: 4.5,
      bytesIn: 120,
      bytesOut: 340,
    }),
    handlerEvent({
      ...envelope("s-handler", "server", 2),
      handlerKind: "query",
      name: "getGame",
      outcome: "error",
      durationMs: 1.25,
      errorTag: "NotFoundError",
      errorDetail: { table: "games", id: "g-1" },
    }),
    sqlEvent({
      ...envelope("s-sql", "server", 3),
      engine: "sqlite",
      dialect: "sqlite",
      statementKind: "insert",
      tableName: "games",
      sqlText: "INSERT INTO games VALUES (?)",
      bindCount: 1,
      durationMs: 0.5,
      rowCount: 1,
      outcome: "ok",
    }),
    txEvent({
      ...envelope("s-tx", "server", 4),
      engine: "sqlite",
      outcome: "commit",
      operations: 3,
      durationMs: 2,
      queueWaitMs: 0.25,
    }),
    queueEvent({
      ...envelope("s-queue", "server", 5),
      queue: "writer",
      depth: 7,
      cap: 1000,
      event: "high-water",
      dropped: 0,
    }),
    backupEvent({
      ...envelope("s-backup", "server", 6),
      phase: "put-object",
      key: "snapshots/column/1.sqlite",
      bytes: 4096,
      sha256: "ab".repeat(32),
      durationMs: 12,
      outcome: "ok",
    }),
    lifecycleEvent({ ...envelope("s-life", "server", 7), phase: "ready", detail: { port: 8000 } }),
  ];
}

function readerFixture(): EventRecord[] {
  return [
    sqlEvent({
      ...envelope("r-sql", "reader", 8),
      engine: "duckdb",
      dialect: "duckdb",
      statementKind: "select",
      tableName: "games",
      sqlText: "SELECT * FROM games",
      bindCount: 0,
      durationMs: 1.5,
      rowCount: 2,
      outcome: "ok",
    }),
    txEvent({
      ...envelope("r-tx", "reader", 9),
      engine: "duckdb",
      outcome: "rollback",
      operations: 1,
      durationMs: 3,
      queueWaitMs: 0,
      errorTag: "ReaderError",
    }),
    ingestEvent({
      ...envelope("r-ingest", "reader", 10),
      sourceFile: SERVER_FILE,
      bytesIngested: 10,
      status: "ok",
    }),
  ];
}

async function writeFixture(world: World): Promise<void> {
  await writeSource(world, SERVER_FILE, lines(serverFixture()));
  await writeSource(world, READER_FILE, lines(readerFixture()));
  // Not sources: ignored by the inventory.
  await writeSource(world, "server/2026-10-10/notes.txt", "not a log\n");
  await writeSource(world, "server/2026-10-08/events-09-4242-001.jsonl.gz", "gzipped history");
  await writeSource(world, "k6/run-1/raw.json", '{"type":"Point"}\n');
}

const T0 = Date.UTC(2026, 9, 10, 13, 0, 0);

// ---------------------------------------------------------------------------
// Acceptance: fixture ingest, then idempotence
// ---------------------------------------------------------------------------

test("ingest of a fixture directory fills each table; a second run inserts nothing and leaves _ingest_state unchanged", async () => {
  await withWorld(async (world) => {
    await writeFixture(world);

    const first = await ingest(world, T0);
    assert.deepEqual(await counts(world), {
      platform_events: 10,
      sql_events: 2,
      tx_events: 2,
      http_events: 1,
      queue_events: 1,
      backup_events: 1,
      lifecycle_events: 1,
      k6_points: 0,
    });
    assert.equal(first.filesScanned, 2);
    assert.equal(first.filesIngested, 2);
    assert.equal(first.linesIngested, 10);
    assert.equal(first.linesRejected, 0);
    const serverBytes = (await Deno.stat(join(world.logDir, SERVER_FILE))).size;
    const readerBytes = (await Deno.stat(join(world.logDir, READER_FILE))).size;
    assert.equal(first.bytesIngested, serverBytes + readerBytes);

    const stateBefore = await stateRows(world);
    assert.deepEqual(stateBefore.map((row) => [row.source_file, Number(row.bytes_ingested)]), [
      [READER_FILE, readerBytes],
      [SERVER_FILE, serverBytes],
    ]);
    assert.equal(stateBefore[0].at, "2026-10-10 13:00:00");

    // An hour later: if the second run touched a row, `last_ingested_at` would show it.
    const second = await ingest(world, T0 + 3_600_000);
    assert.deepEqual(
      {
        filesIngested: second.filesIngested,
        linesIngested: second.linesIngested,
        bytes: second.bytesIngested,
      },
      { filesIngested: 0, linesIngested: 0, bytes: 0 },
    );
    assert.equal((await counts(world)).platform_events, 10);
    assert.deepEqual(await stateRows(world), stateBefore);
    assert.deepEqual(world.events, [], "a clean run emits no ingest events");
  });
});

test("columns follow the documented mapping from event records", async () => {
  await withWorld(async (world) => {
    await writeFixture(world);
    await ingest(world, T0);

    const [http] = await query(
      world,
      "SELECT CAST(ts AS VARCHAR) AS ts, method, kind, name, status, duration_ms, bytes_in, bytes_out FROM http_events",
    );
    assert.deepEqual(http, {
      ts: "2026-10-10 12:00:01",
      method: "POST",
      kind: "mutation",
      name: "makeMove",
      status: 200,
      duration_ms: 4.5,
      bytes_in: 120n,
      bytes_out: 340n,
    });

    const generic = await query(
      world,
      `SELECT event_id, kind, name, outcome, error_tag, CAST(attrs AS VARCHAR) AS attrs, source_offset, pid
       FROM platform_events WHERE source_file = '${SERVER_FILE}' ORDER BY source_offset`,
    );
    const firstLineBytes = new TextEncoder().encode(toJsonLine(serverFixture()[0]) + "\n").length;
    assert.equal(generic[0].source_offset, 0n);
    assert.equal(generic[1].source_offset, BigInt(firstLineBytes));
    // A handler record's generic `kind` is its handlerKind; attrs carries errorDetail.
    assert.deepEqual(
      {
        kind: generic[1].kind,
        name: generic[1].name,
        outcome: generic[1].outcome,
        tag: generic[1].error_tag,
      },
      { kind: "query", name: "getGame", outcome: "error", tag: "NotFoundError" },
    );
    assert.deepEqual(JSON.parse(String(generic[1].attrs)), { id: "g-1", table: "games" });
    assert.equal(generic[0].pid, 4242);
    assert.deepEqual(generic.map((row) => row.kind), [
      "http",
      "query",
      "sql",
      "tx",
      "queue",
      "backup",
      "lifecycle",
    ]);
    assert.deepEqual(generic.map((row) => row.name), [
      "makeMove",
      "getGame",
      "insert",
      null,
      "writer",
      "put-object",
      "ready",
    ]);

    const [life] = await query(
      world,
      "SELECT phase, CAST(detail AS VARCHAR) AS detail, pid FROM lifecycle_events",
    );
    assert.deepEqual({ ...life, detail: JSON.parse(String(life.detail)) }, {
      phase: "ready",
      detail: { port: 8000 },
      pid: 4242,
    });
    const [tx] = await query(
      world,
      "SELECT outcome, operations, error_tag FROM tx_events WHERE engine = 'duckdb'",
    );
    assert.deepEqual(tx, { outcome: "rollback", operations: 1, error_tag: "ReaderError" });
    const [ingested] = await query(
      world,
      "SELECT kind, name, outcome FROM platform_events WHERE event_id = 'r-ingest'",
    );
    assert.deepEqual(ingested, { kind: "ingest", name: SERVER_FILE, outcome: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Acceptance: appends
// ---------------------------------------------------------------------------

test("appending to an ingested file ingests only the new complete lines; a partial line waits for its newline", async () => {
  await withWorld(async (world) => {
    await writeFixture(world);
    await ingest(world, T0);
    const before = await eventIds(world);

    const more = [
      lifecycleEvent({ ...envelope("s-more-1", "server", 20), phase: "stopping" }),
      lifecycleEvent({ ...envelope("s-more-2", "server", 21), phase: "stopped" }),
    ];
    const partial = toJsonLine(lifecycleEvent({ ...envelope("s-more-3", "server", 22), phase: "exit" }));
    await appendSource(world, SERVER_FILE, lines(more) + partial.slice(0, 25));

    const report = await ingest(world, T0 + 1000);
    assert.equal(report.linesIngested, 2);
    assert.equal(report.filesIngested, 1);
    const after = await eventIds(world);
    assert.deepEqual(after.filter((id) => !before.includes(id)), ["s-more-1", "s-more-2"]);
    assert.equal(after.length, before.length + 2);
    const [row] = await query(
      world,
      `SELECT bytes_ingested FROM _ingest_state WHERE source_file = '${SERVER_FILE}'`,
    );
    const size = (await Deno.stat(join(world.logDir, SERVER_FILE))).size;
    assert.equal(Number(row.bytes_ingested), size - 25, "the partial line is not consumed");

    await appendSource(world, SERVER_FILE, partial.slice(25) + "\n");
    const completed = await ingest(world, T0 + 2000);
    assert.equal(completed.linesIngested, 1);
    assert.deepEqual((await eventIds(world)).slice(-1), ["s-more-3"]);
    assert.equal((await counts(world)).lifecycle_events, 4);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: quarantine
// ---------------------------------------------------------------------------

test("malformed lines are quarantined beside their source with an ingest event; the rest of the batch lands", async () => {
  await withWorld(async (world) => {
    const good = (id: string, second: number) =>
      toJsonLine(lifecycleEvent({ ...envelope(id, "server", second), phase: "tick" }));
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [
      encoder.encode(good("ok-1", 1) + "\n"),
      encoder.encode("this is not json\n"),
      encoder.encode("[1, 2, 3]\n"),
      encoder.encode('{"ts":"2026-10-10T12:00:00.000Z","kind":"lifecycle"}\n'),
      encoder.encode('{"eventId":"bad-ts","ts":"yesterday"}\n'),
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a]), // `{` + invalid UTF-8 + `}`
      encoder.encode(good("ok-2", 2) + "\n"),
      encoder.encode("\n\r\n"), // blank lines: consumed, neither rows nor rejects
      encoder.encode(good("ok-3", 3) + "\r\n"), // CRLF
    ];
    const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      content.set(part, at);
      at += part.length;
    }
    await writeSource(world, SERVER_FILE, content);

    const report = await ingest(world, T0);
    assert.equal(report.linesIngested, 3);
    assert.equal(report.linesRejected, 5);
    assert.deepEqual(await eventIds(world), ["ok-1", "ok-2", "ok-3"]);
    const [state] = await stateRows(world);
    assert.equal(Number(state.bytes_ingested), content.length, "rejected lines are consumed, not retried");

    const quarantine = join(world.logDir, "server/2026-10-10/rejected.jsonl");
    const rejected = (await Deno.readTextFile(quarantine)).trimEnd().split("\n").map((line) =>
      JSON.parse(line)
    );
    assert.deepEqual(rejected.map((r) => [r.reason, r.sourceFile]), [
      ["invalid-json", SERVER_FILE],
      ["not-an-object", SERVER_FILE],
      ["missing-event-id", SERVER_FILE],
      ["invalid-ts", SERVER_FILE],
      ["invalid-utf8", SERVER_FILE],
    ]);
    assert.equal(rejected[0].line, "this is not json");
    assert.equal(rejected[0].sourceOffset, parts[0].length);
    assert.equal(rejected[0].rejectedAt, new Date(T0).toISOString());

    assert.equal(world.events.length, 1);
    const event = world.events[0] as IngestEventRecord;
    assert.equal(event.kind, "ingest");
    assert.equal(event.role, "reader");
    assert.equal(event.sourceFile, SERVER_FILE);
    assert.equal(event.errorTag, "RejectedLines");
    assert.equal((event.errorDetail as { rejected: number }).rejected, 5);
    assert.equal(
      (event.errorDetail as { quarantine: string }).quarantine,
      "server/2026-10-10/rejected.jsonl",
    );

    // Quarantine is not a source, and a second run neither re-quarantines nor re-emits.
    const quarantineBefore = await Deno.readTextFile(quarantine);
    const again = await ingest(world, T0 + 1000);
    assert.equal(again.filesScanned, 1);
    assert.equal(again.linesRejected, 0);
    assert.equal(await Deno.readTextFile(quarantine), quarantineBefore);
    assert.equal(world.events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Rewrites and truncation
// ---------------------------------------------------------------------------

test("a rewritten file is re-read from byte 0, deduplicated on eventId, and reported", async () => {
  await withWorld(async (world) => {
    const life = (id: string, second: number) =>
      lifecycleEvent({ ...envelope(id, "server", second), phase: id });
    await writeSource(world, SERVER_FILE, lines([life("a", 1), life("b", 2), life("c", 3)]));
    await ingest(world, T0);

    // Same path, different history: one old event survives, two are new.
    await writeSource(world, SERVER_FILE, lines([life("b", 2), life("d", 4), life("e", 5)]));
    const report = await ingest(world, T0 + 1000);
    assert.equal(report.linesIngested, 2);
    assert.deepEqual((await eventIds(world)).sort(), ["a", "b", "c", "d", "e"]);
    const rewrite = world.events.at(-1) as IngestEventRecord;
    assert.equal(rewrite.errorTag, "SourceRewritten");
    assert.deepEqual(rewrite.errorDetail, {
      reason: "prefix-mismatch",
      previousBytesIngested:
        new TextEncoder().encode(lines([life("a", 1), life("b", 2), life("c", 3)])).length,
      size: (await Deno.stat(join(world.logDir, SERVER_FILE))).size,
      deduplicated: 1,
    });

    // Truncated back to its first line: nothing new, and the row now describes the shorter file.
    const firstLine = lines([life("b", 2)]);
    await writeSource(world, SERVER_FILE, firstLine);
    const truncated = await ingest(world, T0 + 2000);
    assert.equal(truncated.linesIngested, 0);
    assert.equal((world.events.at(-1) as IngestEventRecord).errorTag, "SourceRewritten");
    assert.equal(
      ((world.events.at(-1) as IngestEventRecord).errorDetail as { reason: string }).reason,
      "truncated",
    );
    const [state] = await stateRows(world);
    assert.equal(Number(state.bytes_ingested), new TextEncoder().encode(firstLine).length);

    // The new generation is an ordinary append from here on.
    const eventsBefore = world.events.length;
    await appendSource(world, SERVER_FILE, lines([life("f", 6)]));
    assert.equal((await ingest(world, T0 + 3000)).linesIngested, 1);
    assert.equal(world.events.length, eventsBefore, "an append to the new generation is not a rewrite");
    assert.deepEqual((await eventIds(world)).sort(), ["a", "b", "c", "d", "e", "f"]);
  });
});

test("a torn terminator restored later does not insert the old line twice (sticky dedupe)", async () => {
  await withWorld(async (world) => {
    const only = lines([lifecycleEvent({ ...envelope("only", "server", 1), phase: "ready" })]);
    await writeSource(world, SERVER_FILE, only);
    await ingest(world, T0);

    // The file loses its final `\n`: a rewrite with no complete line left to consume.
    await writeSource(world, SERVER_FILE, only.slice(0, -1));
    const torn = await ingest(world, T0 + 1000);
    assert.equal(torn.linesIngested, 0);
    const event = world.events.at(-1) as IngestEventRecord;
    assert.equal(event.errorTag, "SourceRewritten");
    assert.equal((event.errorDetail as { reason: string }).reason, "truncated");
    // The row now describes the new generation — nothing consumed — and is flagged for dedupe.
    const [state] = await query(world, "SELECT bytes_ingested, dedupe FROM _ingest_state");
    assert.deepEqual(state, { bytes_ingested: 0n, dedupe: true });

    // The terminator comes back: the line is complete again, and it is the old line.
    await appendSource(world, SERVER_FILE, "\n");
    const restored = await ingest(world, T0 + 2000);
    assert.equal(restored.linesIngested, 0);
    assert.deepEqual(await eventIds(world), ["only"]);
    // Fresh lines in the flagged file still land.
    await appendSource(
      world,
      SERVER_FILE,
      lines([lifecycleEvent({ ...envelope("next", "server", 2), phase: "x" })]),
    );
    assert.equal((await ingest(world, T0 + 3000)).linesIngested, 1);
    assert.deepEqual(await eventIds(world), ["only", "next"]);
  });
});

test("records the platform's serializer writes always parse: lone surrogates, non-finite numbers, bare ts", async () => {
  await withWorld(async (world) => {
    // `toJsonLine` writes a lone surrogate as an escape that DuckDB's json_valid would reject.
    const lone = toJsonLine(handlerEvent({
      ...envelope("lone", "server", 1),
      handlerKind: "query",
      name: "getGame",
      outcome: "error",
      durationMs: 1,
      errorTag: "SchemaError",
      errorDetail: { actual: "x\ud800y", pair: "\ud83d\ude00" },
    }));
    assert.ok(lone.includes("\\ud800"));
    const raw = (id: string, extra: string) =>
      `{"eventId":"${id}","ts":"2026-10-10T12:00:00","level":"info","role":"server","pid":1,"traceId":"t",` +
      `"kind":"tx","engine":"sqlite","outcome":"commit","operations":1,"queueWaitMs":0${extra}}\n`;
    await writeSource(
      world,
      SERVER_FILE,
      lone + "\n" + raw("inf", ',"durationMs":1e999') + raw("nan", ',"durationMs":NaN') +
        raw("ok", ',"durationMs":2'),
    );
    const report = await ingest(world, T0);
    assert.equal(report.linesRejected, 0);
    assert.deepEqual(await eventIds(world), ["lone", "inf", "nan", "ok"]);
    const [attrs] = await query(
      world,
      "SELECT CAST(attrs AS VARCHAR) AS a FROM platform_events WHERE event_id = 'lone'",
    );
    assert.deepEqual(JSON.parse(String(attrs.a)), { actual: "x\ufffdy", pair: "\ud83d\ude00" });
    const tx = await query(
      world,
      "SELECT duration_ms, CAST(ts AS VARCHAR) AS ts FROM tx_events ORDER BY ts, duration_ms NULLS FIRST",
    );
    assert.deepEqual(tx.map((row) => row.duration_ms), [null, null, 2]);
    // An offset-less timestamp is read as UTC, whatever the host's zone.
    assert.equal(tx[0].ts, "2026-10-10 12:00:00");
  });
});

test("repairLoneSurrogates fixes only unpaired surrogate escapes", () => {
  assert.equal(repairLoneSurrogates('{"a":"\\ud800"}'), '{"a":"\\ufffd"}');
  assert.equal(repairLoneSurrogates('{"a":"\\udc00x\\ud800"}'), '{"a":"\\ufffdx\\ufffd"}');
  assert.equal(repairLoneSurrogates('{"a":"\\ud83d\\ude00"}'), '{"a":"\\ud83d\\ude00"}');
  assert.equal(repairLoneSurrogates('{"a":"\\ud83d\\u0041"}'), '{"a":"\\ufffd\\u0041"}');
  // An escaped backslash followed by `ud800` is literal text, not an escape.
  assert.equal(repairLoneSurrogates('{"a":"\\\\ud800"}'), '{"a":"\\\\ud800"}');
  assert.equal(repairLoneSurrogates('{"a":"plain \\n"}'), '{"a":"plain \\n"}');
  // Every repaired line is still valid JSON with the same structure.
  assert.deepEqual(JSON.parse(repairLoneSurrogates(JSON.stringify({ k: "\ud800", n: 1 }))), {
    k: "\ufffd",
    n: 1,
  });
});

test("two copies of one event in a rewritten file land once", async () => {
  await withWorld(async (world) => {
    const life = (id: string) => lifecycleEvent({ ...envelope(id, "server", 1), phase: id });
    await writeSource(world, SERVER_FILE, lines([life("a")]));
    await ingest(world, T0);
    await writeSource(world, SERVER_FILE, lines([life("b"), life("c"), life("c"), life("a")]));
    const report = await ingest(world, T0 + 1000);
    assert.equal(report.linesIngested, 2);
    assert.deepEqual((await eventIds(world)).sort(), ["a", "b", "c"]);
  });
});

/** Wraps the real driver and records every statement that builds `ingest_rows`. */
function rowsRecordingDriver(seen: string[]): EventLogDriver {
  return {
    open: async (path) => {
      const instance = await eventLogDriver.open(path);
      return {
        closeSync: () => instance.closeSync(),
        connect: async () => {
          const connection = await instance.connect();
          return {
            run: (sql, values) => {
              if (sql.includes("TEMP TABLE ingest_rows")) seen.push(sql);
              return connection.run(sql, values);
            },
            runAndReadAll: (sql) => connection.runAndReadAll(sql),
            closeSync: () => connection.closeSync(),
          };
        },
      };
    },
  };
}

test("only a batch with a rewritten file anti-joins against platform_events", async () => {
  await withWorld(async (world) => {
    const life = (id: string) => lifecycleEvent({ ...envelope(id, "server", 1), phase: id });
    const seen: string[] = [];
    const driver = rowsRecordingDriver(seen);
    await writeSource(world, SERVER_FILE, lines([life("a")]));
    await ingest(world, T0, { driver });
    await appendSource(world, SERVER_FILE, lines([life("b")]));
    await ingest(world, T0 + 1000, { driver });
    assert.equal(seen.length, 2);
    // A new file and a plain append trust their lines: the batch never reads history.
    assert.ok(seen.every((sql) => !sql.includes("platform_events")), seen.join("\n---\n"));

    await writeSource(world, SERVER_FILE, lines([life("a"), life("c")]));
    assert.equal((await ingest(world, T0 + 2000, { driver })).linesIngested, 1);
    assert.equal(seen.length, 3);
    assert.ok(seen[2].includes("platform_events"));
    assert.deepEqual((await eventIds(world)).sort(), ["a", "b", "c"]);
  });
});

/** Wraps the real driver; the first `COMMIT` and the first `ROLLBACK` issued both fail. */
function failingRollbackDriver(): EventLogDriver {
  const failed = new Set<string>();
  return {
    open: async (path) => {
      const instance = await eventLogDriver.open(path);
      return {
        closeSync: () => instance.closeSync(),
        connect: async () => {
          const connection = await instance.connect();
          return {
            run: (sql, values) => {
              if ((sql === "COMMIT" || sql === "ROLLBACK") && !failed.has(sql)) {
                failed.add(sql);
                return Promise.reject(new Error(`injected ${sql} failure`));
              }
              return connection.run(sql, values);
            },
            runAndReadAll: (sql) => connection.runAndReadAll(sql),
            closeSync: () => connection.closeSync(),
          };
        },
      };
    },
  };
}

test("a failed ROLLBACK leaves the service usable: the next run reconnects and ingests exactly once", async () => {
  await withWorld(async (world) => {
    await writeFixture(world);
    const sink = Layer.succeed(EventSink, { emit: () => Effect.void });
    const [first, second] = await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const service = yield* makeEventLogIngest({ driver: failingRollbackDriver() });
        // Both runs share one service, and so one connection until it is replaced.
        return [yield* Effect.either(service.ingest), yield* Effect.either(service.ingest)] as const;
      })).pipe(
        Effect.provide(Layer.merge(
          ConfigTest({ logging: { dir: world.logDir }, eventLog: { duckdbPath: world.dbPath } }),
          sink,
        )),
      ),
    );
    assert.ok(Either.isLeft(first) && first.left.phase === "commit");
    assert.ok(Either.isRight(second), JSON.stringify(second));
    assert.equal(second.right.linesIngested, 10);
    assert.equal((await counts(world)).platform_events, 10);
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Wraps the real driver; the first `COMMIT` issued fails. */
function failingCommitDriver(): EventLogDriver {
  let failed = false;
  return {
    open: async (path) => {
      const instance = await eventLogDriver.open(path);
      return {
        closeSync: () => instance.closeSync(),
        connect: async () => {
          const connection = await instance.connect();
          const wrapped: EventLogConnection = {
            run: (sql, values) => {
              if (sql === "COMMIT" && !failed) {
                failed = true;
                return Promise.reject(new Error("injected commit failure"));
              }
              return connection.run(sql, values);
            },
            runAndReadAll: (sql) => connection.runAndReadAll(sql),
            closeSync: () => connection.closeSync(),
          };
          return wrapped;
        },
      };
    },
  };
}

test("a failed commit rolls back rows and offsets together; the next run ingests everything exactly once", async () => {
  await withWorld(async (world) => {
    await writeFixture(world);

    const failed = await ingestEither(world, T0, { driver: failingCommitDriver() });
    assert.ok(Either.isLeft(failed));
    assert.equal(failed.left.phase, "commit");
    assert.deepEqual(Object.values(await counts(world)), EVENT_TABLES.map(() => 0));
    assert.deepEqual(await stateRows(world), []);
    assert.equal((world.events.at(-1) as IngestEventRecord).errorTag, "IngestError");

    await ingest(world, T0 + 1000);
    assert.equal((await counts(world)).platform_events, 10);
    assert.equal(new Set(await eventIds(world)).size, 10);
  });
});

test("small batches commit separately and produce the same tables as one batch", async () => {
  await withWorld(async (world) => {
    await writeFixture(world);
    await writeSource(
      world,
      "server/2026-10-10/events-13-4242-001.jsonl",
      lines([lifecycleEvent({ ...envelope("later", "server", 30), phase: "later" })]),
    );
    const report = await ingest(world, T0, { batchBytes: 1 });
    assert.equal(report.filesIngested, 3);
    assert.equal((await counts(world)).platform_events, 11);
    assert.equal((await ingest(world, T0 + 1000, { batchBytes: 1 })).linesIngested, 0);
  });
});

// ---------------------------------------------------------------------------
// Large integers and timestamps (the item-13 json_extract concern)
// ---------------------------------------------------------------------------

test("integers are exact or NULL, never silently rounded; timestamp offsets are honoured", async () => {
  await withWorld(async (world) => {
    // `durationMs` doubles as the row's position, since the typed tables carry no offset.
    const cases: [bytes: string, expected: bigint | null][] = [
      ["9007199254740993", 9007199254740993n], // > 2^53 as an integer literal: exact
      ["9223372036854775807", 9223372036854775807n], // int64 max
      ["9223372036854775808", null], // past int64: NULL, not wrapped
      ["9007199254740993.0", null], // already rounded to ...992 by the JSON parser: NULL
      ["1e+21", null], // JSON.stringify's form for >= 1e21: NULL
      ["12.5", null], // TRY_CAST would round to 13: NULL
      ["4096.0", 4096n], // an integral double below 2^53 is exact
      ['"123"', 123n], // how core/events.ts serialises a bigint
      ['"12x"', null],
    ];
    const backup = (i: number, bytes: string, ts = "2026-10-10T12:00:00.000Z") =>
      `{"eventId":"b-${i}","ts":"${ts}","level":"info","role":"server","pid":1,"traceId":"t","kind":"backup",` +
      `"phase":"hash","bytes":${bytes},"durationMs":${i},"outcome":"ok"}\n`;
    await writeSource(
      world,
      SERVER_FILE,
      cases.map(([bytes], i) => backup(i, bytes)).join("") +
        backup(cases.length, "1", "2026-10-10T12:00:00.000+02:00"),
    );
    await ingest(world, T0);
    const rows = await query(
      world,
      "SELECT bytes, CAST(ts AS VARCHAR) AS ts FROM backup_events ORDER BY duration_ms",
    );
    assert.deepEqual(rows.map((row) => row.bytes), [...cases.map(([, expected]) => expected), 1n]);
    assert.equal(rows[0].ts, "2026-10-10 12:00:00");
    assert.equal(rows[cases.length].ts, "2026-10-10 10:00:00");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers and source-level invariants
// ---------------------------------------------------------------------------

test("decide: new, append, skip, truncated and prefix-mismatch", () => {
  const state: IngestStateRow = {
    sourceFile: "f",
    bytesIngested: 10,
    prefixSha256: "h",
    dedupe: false,
    lastIngestedAt: "",
  };
  assert.deepEqual(decide("f", undefined, 0, undefined), { kind: "skip", sourceFile: "f" });
  assert.equal(decide("f", undefined, 5, undefined).kind, "read");
  assert.deepEqual(decide("f", state, 10, "h"), { kind: "skip", sourceFile: "f" });
  const append = decide("f", state, 15, "h");
  assert.ok(
    append.kind === "read" && append.mode === "append" && append.from === 10 && !append.dedupe,
  );
  const truncated = decide("f", state, 9, undefined);
  assert.ok(
    truncated.kind === "read" && truncated.rewrite === "truncated" && truncated.from === 0 &&
      truncated.dedupe,
  );
  const mismatch = decide("f", state, 10, "other");
  assert.ok(
    mismatch.kind === "read" && mismatch.rewrite === "prefix-mismatch" && mismatch.dedupe,
  );
  // An append to a file that was once rewritten stays deduplicated.
  const sticky = decide("f", { ...state, dedupe: true }, 20, "h");
  assert.ok(sticky.kind === "read" && sticky.mode === "append" && sticky.dedupe);
});

test("completeLines stops at the last newline and strips CR", () => {
  const bytes = new TextEncoder().encode("ab\r\n\ncd\nef");
  assert.deepEqual(completeLines(bytes, 0), { lines: [{ start: 0, end: 2 }, { start: 5, end: 7 }], end: 8 });
  assert.deepEqual(completeLines(bytes, 8), { lines: [], end: 8 });
});

test("parseSourceFile accepts only event-log sources", () => {
  assert.deepEqual(parseSourceFile("server/2026-10-10/events-14-31887-001.jsonl"), {
    path: "server/2026-10-10/events-14-31887-001.jsonl",
    role: "server",
    date: "2026-10-10",
    hour: 14,
    pid: 31887,
    seq: 1,
  });
  for (
    const path of [
      "server/2026-10-10/events-14-31887-001.jsonl.gz",
      "server/2026-10-10/rejected.jsonl",
      "k6/2026-10-10/events-14-1-001.jsonl",
      "server/events-14-1-001.jsonl",
      "../server/2026-10-10/events-14-1-001.jsonl",
    ]
  ) {
    assert.equal(parseSourceFile(path), undefined, path);
  }
});

const repoRoot = new URL("../../", import.meta.url);

test("ingest.ts and tables.ts change no existing row outside _ingest_state and the temp tables", async () => {
  const mutating = /\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b|INSERT OR REPLACE/;
  const allowed = /_ingest_state|UPSERT_INGEST_STATE|\$\{(ROWS|STAGE)_TABLE\}/;
  for (const file of ["platform/eventlog/ingest.ts", "platform/eventlog/tables.ts"]) {
    const source = await Deno.readTextFile(new URL(file, repoRoot));
    const offending = source.split("\n").filter((line) => mutating.test(line) && !allowed.test(line));
    assert.deepEqual(offending, [], file);
  }
});

test("core/eventlog is pure and the event log never loads node:sqlite", async () => {
  for (const file of ["core/eventlog/ddl.ts", "core/eventlog/offsets.ts"]) {
    const source = await Deno.readTextFile(new URL(file, repoRoot));
    assert.deepEqual(source.match(/^import .*$/gm) ?? [], [], file);
    assert.ok(!/\bDeno\./.test(source), `${file} touches Deno.*`);
  }
  for (const file of ["platform/eventlog/ingest.ts", "platform/eventlog/tables.ts"]) {
    assert.ok(!(await Deno.readTextFile(new URL(file, repoRoot))).includes("node:sqlite"), file);
  }
});
