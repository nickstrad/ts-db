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
import type { AnyError } from "../../core/errors.ts";
import { ConfigError, DecodeError, NotFoundError, StorageError } from "../../core/errors.ts";

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

test("backup event: golden fixture (an object-store transfer record)", () => {
  const record = backupEvent({
    ...envelope,
    phase: "put-object",
    emitter: "object-store",
    runId: "run-7",
    key: "backups/app-1/2026-10-10.sqlite",
    bytes: 4096,
    attempts: 2,
    durationMs: 120,
    outcome: "ok",
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"backup","phase":"put-object","emitter":"object-store","runId":"run-7","key":"backups/app-1/2026-10-10.sqlite","bytes":4096,"sha256":null,"attempts":2,"durationMs":120,"outcome":"ok","errorTag":null,"errorDetail":null}';
  assert.equal(toJsonLine(record), expected);
});

test("backup event: golden fixture (a Backups phase record)", () => {
  const record = backupEvent({
    ...envelope,
    phase: "hash",
    emitter: "backups",
    runId: "run-7",
    bytes: 4096,
    sha256: "deadbeef",
    durationMs: 3,
    outcome: "ok",
  });
  const expected =
    '{"eventId":"evt-1","ts":"2026-10-10T12:00:00.000Z","level":"info","role":"server","pid":4242,"traceId":"trace-1","spanId":"span-1","parentSpanId":"span-0","appId":"app-1","kind":"backup","phase":"hash","emitter":"backups","runId":"run-7","key":null,"bytes":4096,"sha256":"deadbeef","attempts":null,"durationMs":3,"outcome":"ok","errorTag":null,"errorDetail":null}';
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

test("constructors return narrow per-kind variants (fields typecheck without narrowing)", () => {
  const http = httpEvent({
    ...envelope,
    method: "GET",
    path: "/",
    handlerKind: "query",
    name: "getGame",
    status: 200,
    durationMs: 1,
    bytesIn: 0,
    bytesOut: 0,
  });
  const status: number = http.status;
  const kind: "http" = http.kind;
  assert.equal(status, 200);
  assert.equal(kind, "http");

  const sql = sqlEvent({
    ...envelope,
    engine: "sqlite",
    dialect: "sqlite",
    statementKind: "select",
    sqlText: "SELECT 1",
    bindCount: 0,
    durationMs: 1,
    outcome: "ok",
  });
  const text: string = sql.sqlText;
  assert.equal(text, "SELECT 1");
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

test("toJsonLine withholds bindValues from hand-built records (defense in depth)", () => {
  const injection = "O'Reilly'); DROP TABLE games; --";
  const record = {
    ...envelope,
    kind: "sql" as const,
    engine: "sqlite" as const,
    dialect: "sqlite",
    statementKind: "select" as const,
    tableName: "games",
    sqlText: "SELECT * FROM games WHERE id = ?",
    bindCount: 1,
    bindValues: [injection],
    durationMs: 0.8,
    outcome: "ok" as const,
  };
  const line = toJsonLine(record);
  assert.ok(!line.includes(injection));
  assert.ok(line.includes('"bindValues":null'));
});

test("redacts Bearer tokens and authorization headers unconditionally", () => {
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

test("redacts S3 credentials in every spelling, plus cookies and raw tokens", () => {
  const line = toJsonLine(lifecycleEvent({
    ...envelope,
    phase: "backup",
    detail: {
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SESSION_TOKEN: "FwoGZXIvYXdzEExample",
      awsAccessKeyId: "AKIA-camel-case-key",
      aws_secret_access_key: "snake-case-secret",
      "Proxy-Authorization": "Basic cHJveHk6c2VjcmV0",
      Cookie: "session=secret-cookie-value",
      "Set-Cookie": "id=cookie-secret-value",
      COLUMN_APP_TOKEN: "app-token-secret",
      ADMIN_TOKEN: "admin-token-secret",
      presigned:
        "https://s3.example.net/x?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261010%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=presigned-signature-secret&X-Amz-Security-Token=presigned-token-secret",
      playerId: "alice",
      gameId: "game-1",
      docId: "doc-9",
    },
  }));
  for (
    const secret of [
      "wJalrXUtnFEMI",
      "AKIAIOSFODNN7EXAMPLE",
      "FwoGZXIvYXdzEExample",
      "AKIA-camel-case-key",
      "snake-case-secret",
      "cHJveHk6c2VjcmV0",
      "secret-cookie-value",
      "cookie-secret-value",
      "app-token-secret",
      "admin-token-secret",
      "presigned-signature-secret",
      "presigned-token-secret",
    ]
  ) {
    assert.ok(!line.includes(secret), `leaked secret: ${secret}`);
  }
  assert.ok(!line.includes("AKIAIOSFODNN7EXAMPLE%2F20261010"));
  assert.ok(line.includes('"AWS_SECRET_ACCESS_KEY":"<redacted>"'));
  assert.ok(line.includes("X-Amz-Credential=<redacted>"));
  assert.ok(line.includes("X-Amz-Signature=<redacted>"));
  assert.ok(line.includes("X-Amz-Security-Token=<redacted>"));
  // Player and document ids are data, not secrets, and must survive redaction.
  assert.ok(line.includes('"playerId":"alice"'));
  assert.ok(line.includes('"gameId":"game-1"'));
  assert.ok(line.includes('"docId":"doc-9"'));
});

test("fromPlatformError preserves the non-enumerable cause", () => {
  const cols = fromPlatformError(
    new StorageError({
      operation: "commit",
      table: "games",
      detail: "disk I/O error",
      cause: { code: "SQLITE_BUSY" },
    }),
  );
  assert.equal(cols.errorTag, "StorageError");
  const line = toJsonLine(handlerEvent({
    ...envelope,
    handlerKind: "mutation",
    name: "commitGame",
    outcome: "error",
    durationMs: 1,
    errorTag: cols.errorTag,
    errorDetail: cols.errorDetail,
  }));
  assert.ok(line.includes('"cause":{"code":"SQLITE_BUSY"}'));
});

test("secrets smuggled in via cause are still redacted", () => {
  const cols = fromPlatformError(
    new StorageError({
      operation: "commit",
      table: "games",
      cause: { AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    }),
  );
  const line = toJsonLine(handlerEvent({
    ...envelope,
    handlerKind: "mutation",
    name: "commitGame",
    outcome: "error",
    durationMs: 1,
    errorTag: cols.errorTag,
    errorDetail: cols.errorDetail,
  }));
  assert.ok(!line.includes("wJalrXUtnFEMI"));
  assert.ok(line.includes('"AWS_SECRET_ACCESS_KEY":"<redacted>"'));
});

test("fromPlatformError accepts any AnyError member (ConfigError needs no cast)", () => {
  const cols = fromPlatformError(
    new ConfigError({ key: "PORT", reason: "malformed", detail: "not a number" }),
  );
  assert.equal(cols.errorTag, "ConfigError");
  assert.deepEqual(cols.errorDetail, { key: "PORT", reason: "malformed", detail: "not a number" });
});

test("fromPlatformError never throws on non-object or foreign inputs", () => {
  for (const bad of [null, undefined, "boom", 42] as const) {
    const cols = fromPlatformError(bad as unknown as AnyError);
    assert.equal(cols.errorTag, "UnknownError");
  }
  const foreign = fromPlatformError(new Error("kaboom") as unknown as AnyError);
  assert.equal(foreign.errorTag, "UnknownError");
  assert.deepEqual(foreign.errorDetail, {});
  const line = toJsonLine(handlerEvent({
    ...envelope,
    handlerKind: "query",
    name: "getGame",
    outcome: "error",
    durationMs: 1,
    errorTag: foreign.errorTag,
    errorDetail: foreign.errorDetail,
  }));
  assert.ok(line.includes('"errorTag":"UnknownError"'));
});

test("toJsonLine serializes BigInt instead of throwing (DecodeError.actual)", () => {
  const cols = fromPlatformError(
    new DecodeError({
      reason: "unsafe-integer",
      table: "wins",
      field: "total",
      actual: 9007199254740993n,
    }),
  );
  const line = toJsonLine(handlerEvent({
    ...envelope,
    handlerKind: "query",
    name: "getWins",
    outcome: "error",
    durationMs: 1,
    errorTag: cols.errorTag,
    errorDetail: cols.errorDetail,
  }));
  assert.ok(line.includes('"actual":"9007199254740993"'));
  assert.equal(line.split("\n").length, 1);
});

test("toJsonLine survives cyclic structures", () => {
  const cyclic: Record<string, unknown> = { depth: 1 };
  cyclic.self = cyclic;
  const line = toJsonLine(lifecycleEvent({ ...envelope, phase: "startup", detail: cyclic }));
  assert.ok(line.includes("<circular>"));
  assert.equal(line.split("\n").length, 1);
});

test("toJsonLine survives throwing getters", () => {
  const evil = {
    get boom(): unknown {
      throw new Error("getter exploded");
    },
    fine: "ok",
  };
  const line = toJsonLine(lifecycleEvent({ ...envelope, phase: "startup", detail: evil }));
  assert.ok(line.includes("<unreadable>"));
  assert.ok(line.includes('"fine":"ok"'));
});

test("toJsonLine caps hostile nesting depth instead of throwing", () => {
  let deep: unknown = { leaf: true };
  for (let i = 0; i < 50000; i++) deep = { next: deep };
  const line = toJsonLine(lifecycleEvent({ ...envelope, phase: "startup", detail: deep }));
  assert.ok(line.includes("<max-depth>"));
  assert.equal(line.split("\n").length, 1);
});

test("toJsonLine falls back to an envelope-only line instead of throwing", () => {
  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error("nope");
    },
  });
  const line = toJsonLine(lifecycleEvent({ ...envelope, phase: "startup", detail: hostile }));
  assert.ok(line.includes('"serialization":"serialization-failed"'));
  assert.ok(line.includes('"eventId":"evt-1"'));
  assert.ok(line.includes('"traceId":"trace-1"'));
  assert.equal(line.split("\n").length, 1);
  // The fallback is still a valid JSON line.
  JSON.parse(line);
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

test("toJsonLine strips U+2028/U+2029 like other line breaks", () => {
  const record = lifecycleEvent({
    ...envelope,
    phase: "a\u2028b\u2029c",
    detail: { note: "x\u2028y\u2029z" },
  });
  const line = toJsonLine(record);
  assert.ok(!line.includes("\u2028"));
  assert.ok(!line.includes("\u2029"));
  assert.ok(line.includes("a b c"));
  assert.ok(line.includes("x y z"));
});

test("toJsonLine is canonical: source key order does not change output", () => {
  const ordered = httpEvent({
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
  const shuffled = httpEvent({
    bytesOut: 64,
    bytesIn: 0,
    durationMs: 2,
    status: 200,
    name: "getGame",
    handlerKind: "query",
    path: "/api/app-1/game",
    method: "GET",
    ...envelope,
  });
  assert.equal(toJsonLine(ordered), toJsonLine(shuffled));
  assert.equal(toJsonLine(ordered), toJsonLine(ordered));
  // Nested payloads are canonical too: same logical detail, different insertion order.
  const a = lifecycleEvent({
    ...envelope,
    phase: "startup",
    detail: { b: 1, a: 2, nested: { z: 0, y: 1 } },
  });
  const b = lifecycleEvent({
    ...envelope,
    phase: "startup",
    detail: { a: 2, nested: { y: 1, z: 0 }, b: 1 },
  });
  assert.equal(toJsonLine(a), toJsonLine(b));
  assert.ok(toJsonLine(a).includes('"detail":{"a":2,"b":1,"nested":{"y":1,"z":0}}'));
});
