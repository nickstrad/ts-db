/**
 * Unit tests for the reader IPC client (plan item 17), against a stub child process.
 *
 * The stub is a dependency-free Deno script written to a temp file (this item owns only this test
 * file and `platform/ipc.ts`). It speaks the reader wire protocol and picks its behaviour from each
 * request's `name`: echo after a delay, never answer, exit, emit garbage, answer an unknown id, or
 * send an error frame. `--ignore-eof` makes it keep running after stdin closes, so the finalizer has
 * to kill it.
 *
 * Every test runs its connection inside `Effect.scoped` and, after the scope closes, asserts the
 * child's `status` has settled — no test leaves a process behind.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Cause, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import type { EventRecord } from "../../core/events.ts";
import {
  IpcError,
  NotFoundError,
  QueueFullError,
  ReaderError,
  ReaderExitedError,
} from "../../core/errors.ts";
import { EventSink, ReaderClient } from "../../platform/services.ts";
import {
  type CallError,
  makeReaderConnection,
  ReaderClientLive,
  type ReaderClientOptions,
  type ReaderConnection,
} from "../../platform/ipc.ts";

const STUB = `
const ignoreEof = Deno.args.includes("--ignore-eof");
const out = Deno.stdout.writable.getWriter();
const enc = new TextEncoder();
let tail = Promise.resolve();
const send = (text) => { tail = tail.then(() => out.write(enc.encode(text))); return tail; };
const reply = (value) => send(JSON.stringify(value) + "\\n");
async function handle(req) {
  if (req.kind === "ping") return reply({ id: req.id, result: "pong" });
  const args = req.args ?? {};
  switch (req.name) {
    case "echo":
      if (args.delayMs) await new Promise((r) => setTimeout(r, args.delayMs));
      return reply({ id: req.id, result: args });
    case "undefined":
      return reply({ id: req.id, result: undefined });
    case "never":
      return;
    case "exit":
      await tail;
      Deno.exit(args.code ?? 0);
    case "garbage":
      return send("this is not json\\n");
    case "unknownId":
      await reply({ id: req.id + 1000, result: "stray" });
      return reply({ id: req.id, result: "ok" });
    case "frame":
      return reply({ id: req.id, error: args.frame });
    case "split": {
      const text = JSON.stringify({ id: req.id, result: args }) + "\\n";
      await send(text.slice(0, 5));
      await new Promise((r) => setTimeout(r, 20));
      return send(text.slice(5));
    }
  }
}
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Deno.stdin.readable) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
}
if (ignoreEof) setInterval(() => {}, 1000);
else { await tail; }
`;

const stubPath = await (async () => {
  const path = await Deno.makeTempFile({ prefix: "ipc-stub-", suffix: ".js" });
  await Deno.writeTextFile(path, STUB);
  return path;
})();
after(() => Deno.remove(stubPath));

/** An `EventSink` that records into an array the test can inspect. */
function recordingSink() {
  const events: EventRecord[] = [];
  const layer = Layer.succeed(EventSink, { emit: (e) => Effect.sync(() => void events.push(e)) });
  return { events, layer };
}

interface Harness {
  readonly connection: ReaderConnection;
  readonly events: EventRecord[];
}

/**
 * Run `body` against a fresh stub connection in its own scope; after the scope closes, assert the
 * child exited (status settled) and return what `body` returned plus that status.
 */
async function withStub<A>(
  body: (h: Harness) => Effect.Effect<A, unknown>,
  options: Partial<ReaderClientOptions> = {},
): Promise<{ value: A; status: Deno.CommandStatus; events: EventRecord[] }> {
  const { events, layer } = recordingSink();
  let child: Deno.ChildProcess | undefined;
  const value = await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeReaderConnection({ module: stubPath, ...options });
      child = connection.child;
      return yield* body({ connection, events });
    })).pipe(Effect.provide(layer)),
  );
  const status = await settled(child!.status);
  return { value, status, events };
}

/** Resolve if `promise` has already settled (within a tick), else fail: a stray process would hang here. */
async function settled<T>(promise: Promise<T>): Promise<T> {
  const pending = Symbol("pending");
  const winner = await Promise.race([
    promise,
    new Promise<typeof pending>((r) => setTimeout(() => r(pending), 50)),
  ]);
  assert.notEqual(winner, pending, "child process still running after scope close");
  return winner as T;
}

/** Run `call` and return its failure, asserting it failed. */
function failure(effect: Effect.Effect<unknown, CallError>): Effect.Effect<CallError> {
  return Effect.flatMap(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) {
      return Effect.die(new Error(`expected failure, got ${JSON.stringify(exit.value)}`));
    }
    const error = Cause.failureOption(exit.cause);
    if (Option.isNone(error)) {
      return Effect.die(new Error(`expected a typed failure, got ${Cause.pretty(exit.cause)}`));
    }
    return Effect.succeed(error.value);
  });
}

/** Poll `pendingCount` until it equals `n` (real time; the stub runs on wall-clock). */
function waitForPending(connection: ReaderConnection, n: number) {
  return Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      if ((yield* connection.pendingCount) === n) return;
      yield* Effect.sleep("5 millis");
    }
    assert.fail(`pendingCount never reached ${n} (now ${yield* connection.pendingCount})`);
  });
}

const query = (name: string, args: unknown = {}) => ({ kind: "query" as const, appId: "stub", name, args });

test("ping round-trips and the finalizer lets the child exit gracefully on stdin EOF", async () => {
  const { value, status, events } = await withStub(({ connection }) => connection.call({ kind: "ping" }));
  assert.equal(value, "pong");
  assert.equal(status.code, 0);
  assert.equal(status.signal, null);
  const phases = events.filter((e) => e.kind === "lifecycle").map((e) => e.kind === "lifecycle" && e.phase);
  assert.deepEqual(phases, ["reader-spawned", "reader-exited"]);
});

test("correlated replies resolve the right callers, even out of order", async () => {
  const { value } = await withStub(({ connection }) =>
    Effect.all(
      [80, 10, 50, 0, 30].map((delayMs, i) => connection.call(query("echo", { delayMs, i }))),
      { concurrency: "unbounded" },
    ).pipe(Effect.zip(connection.pendingCount))
  );
  const [results, pending] = value;
  assert.deepEqual(results, [80, 10, 50, 0, 30].map((delayMs, i) => ({ delayMs, i })));
  assert.equal(pending, 0);
});

test("a reply split across chunks and an absent result both decode", async () => {
  const { value } = await withStub(({ connection }) =>
    Effect.all([
      connection.call(query("split", { big: "x".repeat(10_000) })),
      connection.call(query("undefined")),
    ])
  );
  assert.deepEqual(value, [{ big: "x".repeat(10_000) }, undefined]);
});

test("early child exit fails every pending call with ReaderExitedError, and later calls immediately", async () => {
  const { value, events } = await withStub(({ connection }) =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forEach(
        [1, 2, 3],
        () => Effect.fork(failure(connection.call(query("never")))),
      );
      yield* waitForPending(connection, 3);
      const exitCall = yield* failure(connection.call(query("exit", { code: 3 })));
      const pendingErrors = yield* Effect.forEach(waiting, Fiber.join);
      const later = yield* failure(connection.call({ kind: "ping" }));
      return { exitCall, pendingErrors, later, pending: yield* connection.pendingCount };
    })
  );
  for (const error of [value.exitCall, ...value.pendingErrors, value.later]) {
    assert.ok(error instanceof ReaderExitedError, `expected ReaderExitedError, got ${String(error)}`);
    assert.equal(error.code, 3);
  }
  assert.equal(value.pending, 0);
  const exited = events.find((e) => e.kind === "lifecycle" && e.phase === "reader-exited");
  assert.equal(exited?.level, "warn");
});

test("a malformed line fails the connection, is logged, and kills the child", async () => {
  const { value, status, events } = await withStub(({ connection }) =>
    Effect.gen(function* () {
      const bystander = yield* Effect.fork(failure(connection.call(query("never"))));
      yield* waitForPending(connection, 1);
      const garbage = yield* failure(connection.call(query("garbage")));
      const other = yield* Fiber.join(bystander);
      const later = yield* failure(connection.call({ kind: "ping" }));
      return { garbage, other, later };
    })
  );
  for (const error of [value.garbage, value.other, value.later]) {
    assert.ok(error instanceof IpcError, `expected IpcError, got ${String(error)}`);
    assert.equal(error.reason, "malformed-frame");
  }
  const failed = events.find((e) => e.kind === "lifecycle" && e.phase === "reader-connection-failed");
  assert.ok(failed, "connection failure must be logged");
  assert.equal(failed.level, "error");
  assert.equal(failed.kind === "lifecycle" && (failed.detail as { errorTag: string }).errorTag, "IpcError");
  assert.equal(status.signal, "SIGTERM");
});

test("an interrupted call removes its pending entry", async () => {
  const { value } = await withStub(({ connection }) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(connection.call(query("never")));
      yield* waitForPending(connection, 1);
      yield* Fiber.interrupt(fiber);
      const afterInterrupt = yield* connection.pendingCount;
      // The connection is still healthy after the interruption.
      const pong = yield* connection.call({ kind: "ping" });
      return { afterInterrupt, pong };
    })
  );
  assert.deepEqual(value, { afterInterrupt: 0, pong: "pong" });
});

test("the per-call timeout fires and leaves no leaked Deferred; a late reply is an anomaly", async () => {
  const { value, events } = await withStub(
    ({ connection }) =>
      Effect.gen(function* () {
        const never = yield* failure(connection.call(query("never")));
        const afterNever = yield* connection.pendingCount;
        // Times out at 100 ms; the stub still answers at 250 ms, for an id nobody awaits.
        const late = yield* failure(connection.call(query("echo", { delayMs: 250 })));
        yield* Effect.sleep("300 millis");
        const pong = yield* connection.call({ kind: "ping" });
        return { never, afterNever, late, pong, pending: yield* connection.pendingCount };
      }),
    { callTimeout: "100 millis" },
  );
  for (const error of [value.never, value.late]) {
    assert.ok(error instanceof IpcError);
    assert.equal(error.reason, "timeout");
  }
  assert.equal(value.afterNever, 0);
  assert.equal(value.pending, 0);
  assert.equal(value.pong, "pong");
  const anomaly = events.find((e) => e.kind === "lifecycle" && e.phase === "reader-reply-anomaly");
  assert.ok(anomaly, "a reply for an unknown id must be logged");
  assert.deepEqual(
    anomaly.kind === "lifecycle" &&
      (anomaly.detail as { errorDetail: { reason: string } }).errorDetail.reason,
    "unknown-reply-id",
  );
});

test("a reply to an unknown id is logged and the real reply still resolves", async () => {
  const { value, events } = await withStub(({ connection }) => connection.call(query("unknownId")));
  assert.equal(value, "ok");
  assert.equal(events.filter((e) => e.kind === "lifecycle" && e.phase === "reader-reply-anomaly").length, 1);
});

test("the cap rejects with QueueFullError and emits high-water and rejected queue events", async () => {
  const { value, events } = await withStub(
    ({ connection }) =>
      Effect.gen(function* () {
        yield* Effect.forEach([1, 2], () => Effect.fork(connection.call(query("never"))));
        yield* waitForPending(connection, 2);
        return yield* failure(connection.call({ kind: "ping" }));
      }),
    { cap: 2, highWaterMarks: [1, 2] },
  );
  assert.ok(value instanceof QueueFullError);
  assert.deepEqual({ queue: value.queue, depth: value.depth, cap: value.cap }, {
    queue: "reader",
    depth: 2,
    cap: 2,
  });
  const queue = events.flatMap((
    e,
  ) => (e.kind === "queue" ? [{ event: e.event, depth: e.depth, cap: e.cap }] : []));
  assert.deepEqual(queue, [
    { event: "high-water", depth: 1, cap: 2 },
    { event: "high-water", depth: 2, cap: 2 },
    { event: "rejected", depth: 2, cap: 2 },
  ]);
});

test("error frames rehydrate into the reader's tagged class; legacy strings into ReaderError", async () => {
  const { value } = await withStub(({ connection }) =>
    Effect.all([
      failure(connection.call(query("frame", {
        frame: { _tag: "NotFoundError", message: "Game not found", fields: { table: "games", id: "g1" } },
      }))),
      failure(connection.call(query("frame", { frame: "Unknown app or handler" }))),
      failure(connection.call(query("frame", { frame: { _tag: "NoSuchTag", message: "?", fields: {} } }))),
      connection.call({ kind: "ping" }),
    ])
  );
  const [notFound, legacy, unknown, pong] = value;
  assert.ok(notFound instanceof NotFoundError);
  assert.deepEqual({ table: notFound.table, id: notFound.id }, { table: "games", id: "g1" });
  assert.equal(notFound.message, "Game not found");
  assert.ok(!Object.keys(notFound).includes("message"), "message stays out of the structured payload");
  assert.ok(legacy instanceof ReaderError);
  assert.equal(legacy.message, "Unknown app or handler");
  assert.ok(unknown instanceof IpcError);
  assert.equal(unknown.reason, "malformed-frame");
  assert.equal(pong, "pong", "a bad error frame fails only its own call");
});

test("the scope finalizer kills a child that ignores stdin EOF", async () => {
  const started = Date.now();
  const { status, events } = await withStub(
    ({ connection }) => connection.call({ kind: "ping" }),
    { args: ["--ignore-eof"], shutdownTimeout: "200 millis" },
  );
  assert.equal(status.signal, "SIGTERM");
  assert.ok(Date.now() - started < 5_000);
  const exited = events.find((e) => e.kind === "lifecycle" && e.phase === "reader-exited");
  assert.equal(exited?.level, "info", "the scope's own shutdown is not a warning");
});

test("ReaderClientLive provides the service and tears the child down with its layer", async () => {
  const { layer } = recordingSink();
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(ReaderClientLive({ module: stubPath }), scope).pipe(Effect.provide(layer)),
  );
  const client = Effect.runSync(Effect.provide(ReaderClient, context));
  assert.equal(await Effect.runPromise(client.call({ kind: "ping" })), "pong");
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const after = await Effect.runPromise(Effect.either(client.call({ kind: "ping" })));
  assert.ok(after._tag === "Left" && after.left instanceof ReaderExitedError);
  assert.equal(after.left.code, 0);
});
