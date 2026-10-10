import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupEvent,
  fromPlatformError,
  handlerEvent,
  httpEvent,
  ingestEvent,
  lifecycleEvent,
  queueEvent,
  sqlEvent,
  toJsonLine,
  txEvent,
} from "../../core/events.ts";
import { NotFoundError } from "../../core/errors.ts";

const envelope = {
  eventId: "evt-1",
  ts: "2026-10-10T12:00:00.000Z",
  level: "info" as const,
  role: "server" as const,
  pid: 4242,
  traceId: "trace-1",
  spanId: "span-1",
  parentSpanId: "span-0",
  appId: "app-1",
};

test("http event: golden fixture", () => {
  const record = httpEvent({
    ...envelope,
    method: "POST",
    path: "/api/app-1/createGame",
    handlerKind: "mutation",
    name: "createGame",
    status: 200,
    durationMs: 12.5,
    bytesIn: 128,
    bytesOut: 256,
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"http","method":"POST","path":"/api/app-1/createGame","handlerKind":"mutation","name":"createGame","status":200,"durationMs":12.5,"bytesIn":128,"bytesOut":256,"errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("handler event: golden fixture", () => {
  const record = handlerEvent({
    ...envelope,
    handlerKind: "mutation",
    name: "createGame",
    outcome: "ok",
    durationMs: 3.1,
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"handler","handlerKind":"mutation","name":"createGame","outcome":"ok","durationMs":3.1,"errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("sql event: golden fixture (bind values withheld by default)", () => {
  const record = sqlEvent({
    ...envelope,
    engine: "sqlite",
    dialect: "sqlite",
    statementKind: "select",
    tableName: "games",
    sqlText: "SELECT * FROM games WHERE id = ?",
    bindCount: 1,
    bindValues: ["game-1"],
    durationMs: 0.8,
    rowCount: 1,
    outcome: "ok",
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"sql","engine":"sqlite","dialect":"sqlite","statementKind":"select","tableName":"games","sqlText":"SELECT * FROM games WHERE id = ?","bindCount":1,"bindValues":null,"durationMs":0.8,"rowCount":1,"outcome":"ok","errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("tx event: golden fixture", () => {
  const record = txEvent({
    ...envelope,
    engine: "sqlite",
    outcome: "commit",
    operations: 2,
    durationMs: 4.2,
    queueWaitMs: 0.5,
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"tx","engine":"sqlite","outcome":"commit","operations":2,"durationMs":4.2,"queueWaitMs":0.5,"errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("queue event: golden fixture", () => {
  const record = queueEvent({
    ...envelope,
    level: "warn",
    queue: "writer",
    depth: 950,
    cap: 1000,
    event: "high-water",
    dropped: 0,
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"warn","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"queue","queue":"writer","depth":950,"cap":1000,"event":"high-water","dropped":0}';
  assert.equal(toJsonLine(record), expected);
});

test("backup event: golden fixture", () => {
  const record = backupEvent({
    ...envelope,
    phase: "put-object",
    key: "backups/app-1/2026-10-10.sqlite",
    bytes: 4096,
    sha256: "deadbeef",
    durationMs: 120,
    outcome: "ok",
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"backup","phase":"put-object","key":"backups/app-1/2026-10-10.sqlite","bytes":4096,"sha256":"deadbeef","durationMs":120,"outcome":"ok","errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("lifecycle event: golden fixture", () => {
  const record = lifecycleEvent({
    ...envelope,
    phase: "startup",
    detail: { port: 8080 },
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"lifecycle","phase":"startup","detail":{"port":8080}}';
  assert.equal(toJsonLine(record), expected);
});

test("ingest event: golden fixture", () => {
  const record = ingestEvent({
    ...envelope,
    sourceFile: "logs/server/2026-10-10/events-12-4242-0.jsonl",
    bytesIngested: 10240,
    runId: "run-1",
    status: "ok",
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"ingest","sourceFile":"logs/server/2026-10-10/events-12-4242-0.jsonl","bytesIngested":10240,"runId":"run-1","status":"ok","errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("sql redaction: bind values withheld unless includeBindValues is true", () => {
  const injection = "O'Reilly'); DROP TABLE games; --";
  const record = sqlEvent(
    {
      ...envelope,
      engine: "sqlite",
      dialect: "sqlite",
      statementKind: "insert",
      tableName: "games",
      sqlText: "INSERT INTO games (xPlayer) VALUES (?)",
      bindCount: 1,
      bindValues: [injection],
      durationMs: 1.1,
      outcome: "ok",
    },
    { includeBindValues: false },
  );
  const line = toJsonLine(record);
  assert.ok(!line.includes(injection));
  assert.ok(line.includes('"sqlText":"INSERT INTO games (xPlayer) VALUES (?)"'));
  assert.ok(line.includes('"bindCount":1'));

  const withValues = sqlEvent(
    {
      ...envelope,
      engine: "sqlite",
      dialect: "sqlite",
      statementKind: "insert",
      tableName: "games",
      sqlText: "INSERT INTO games (xPlayer) VALUES (?)",
      bindCount: 1,
      bindValues: [injection],
      durationMs: 1.1,
      outcome: "ok",
    },
    { includeBindValues: true },
  );
  assert.ok(toJsonLine(withValues).includes(injection));
});

test("redacts bearer tokens and authorization headers unconditionally", () => {
  const error = fromPlatformError(new NotFoundError({ table: "games", id: "game-1" }));
  const record = handlerEvent({
    ...envelope,
    handlerKind: "mutation",
    name: "createGame",
    outcome: "error",
    durationMs: 1,
    errorTag: error.errorTag,
    errorDetail: {
      authorization: "Bearer super-secret-token",
      note: "caller sent Bearer super-secret-token in the Authorization header",
      AccessKeyId: "AKIA-should-be-redacted",
      playerId: "alice",
      gameId: "game-1",
    },
  });
  const line = toJsonLine(record);
  assert.ok(!line.includes("super-secret-token"));
  assert.ok(!line.includes("AKIA-should-be-redacted"));
  assert.ok(line.includes('"authorization":"<redacted>"'));
  assert.ok(line.includes('"AccessKeyId":"<redacted>"'));
  assert.ok(line.includes("Bearer <redacted>"));
  // player ids and document ids are data, not secrets, and must survive redaction.
  assert.ok(line.includes('"playerId":"alice"'));
  assert.ok(line.includes('"gameId":"game-1"'));
});

test("toJsonLine never contains a newline, even when inputs do", () => {
  const record = lifecycleEvent({
    ...envelope,
    phase: "startup\nwith a fake\r\nlog line",
    detail: { note: "line one\nline two\r\nline three" },
  });
  const line = toJsonLine(record);
  assert.ok(!line.includes("\n"));
  assert.ok(!line.includes("\r"));
  assert.ok(line.includes("line one line two line three"));
});

test("toJsonLine is stable across repeated calls on the same record", () => {
  const record = httpEvent({
    ...envelope,
    method: "GET",
    path: "/api/app-1/game",
    handlerKind: "query",
    name: "getGame",
    status: 200,
    durationMs: 2,
    bytesIn: 0,
    bytesOut: 64,
  });
  assert.equal(toJsonLine(record), toJsonLine(record));
});
