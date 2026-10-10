/**
 * Unit tests for the `ObjectStore` layers (plan item 18).
 *
 * The local tests run against a fresh temp `LOCAL_OBJECT_DIR` and assert on what actually landed on
 * disk. The S3 tests inject a stub `fetch` through `makeObjectStoreS3({ fetch })`, so nothing leaves
 * the process; the retry delay is shrunk to a millisecond so the exhausted-retries case stays fast.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { KeyFailure } from "../../core/errors.ts";
import { ConfigError, InvalidKeyError, ObjectStoreError } from "../../core/errors.ts";
import type { EventRecord } from "../../core/events.ts";
import { ConfigTest } from "../../platform/config.ts";
import {
  keyFailure,
  makeObjectStoreLive,
  makeObjectStoreLocal,
  makeObjectStoreS3,
  type ObjectStoreOptions,
  sha256,
} from "../../platform/object_store.ts";
import {
  type Config,
  EventSink,
  IdGen,
  ObjectStore,
  type ObjectStoreConfig,
} from "../../platform/services.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Harness {
  readonly layer: Layer.Layer<ObjectStore, ConfigError>;
  readonly events: EventRecord[];
}

/** Test deps: an in-memory sink, sequential ids, and `ConfigTest` with the given object-store config. */
function harness(
  objectStore: Partial<ObjectStoreConfig>,
  make: (options: ObjectStoreOptions) => Layer.Layer<ObjectStore, ConfigError, Config | EventSink | IdGen>,
  options: ObjectStoreOptions = {},
): Harness {
  const events: EventRecord[] = [];
  let n = 0;
  const deps = Layer.mergeAll(
    ConfigTest({ objectStore }),
    Layer.succeed(EventSink, { emit: (event) => Effect.sync(() => void events.push(event)) }),
    Layer.succeed(IdGen, { next: Effect.sync(() => `id-${++n}`) }),
  );
  return { layer: Layer.provide(make(options), deps), events };
}

function exec<A, E>(
  h: Harness,
  program: Effect.Effect<A, E, ObjectStore>,
): Promise<Exit.Exit<A, E | ConfigError>> {
  return Effect.runPromiseExit(Effect.provide(program, h.layer));
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E {
  assert.ok(Exit.isFailure(exit), "expected a failure");
  const failure = Cause.failureOption(exit.cause);
  assert.ok(Option.isSome(failure), "expected a typed failure, not a defect");
  return failure.value;
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "object-store-test-" });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const put = (key: string, bytes: Uint8Array) => Effect.flatMap(ObjectStore, (s) => s.put(key, bytes));
const get = (key: string) => Effect.flatMap(ObjectStore, (s) => s.get(key));

// ---------------------------------------------------------------------------
// Local adapter
// ---------------------------------------------------------------------------

test("local: put then get round-trips bytes, nested keys included", async () => {
  await withTempDir(async (dir) => {
    const h = harness({ localDir: dir }, makeObjectStoreLocal);
    const payload = Uint8Array.from([0, 1, 2, 254, 255]);
    const exit = await exec(
      h,
      Effect.gen(function* () {
        yield* put("app/2026/snap.sqlite", payload);
        return yield* get("app/2026/snap.sqlite");
      }),
    );
    assert.ok(Exit.isSuccess(exit));
    assert.deepEqual(exit.value, payload);
    assert.deepEqual(await Deno.readFile(join(dir, "app/2026/snap.sqlite")), payload);
  });
});

test("local: overwriting a key replaces the object and leaves no temp files", async () => {
  await withTempDir(async (dir) => {
    const h = harness({ localDir: dir }, makeObjectStoreLocal);
    await exec(h, put("latest.json", enc.encode("one")));
    await exec(h, put("latest.json", enc.encode("two")));
    assert.equal(dec.decode(await Deno.readFile(join(dir, "latest.json"))), "two");
    assert.deepEqual([...Deno.readDirSync(dir)].map((e) => e.name), ["latest.json"]);
  });
});

test("local: getting a missing key fails with ObjectStoreError", async () => {
  await withTempDir(async (dir) => {
    const h = harness({ localDir: dir }, makeObjectStoreLocal);
    const error = failureOf(await exec(h, get("nope/missing.bin")));
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(error.operation, "get");
    assert.equal(error.key, "nope/missing.bin");
    assert.equal(error.status, undefined);
  });
});

const INVALID_KEYS: ReadonlyArray<readonly [string, string, KeyFailure]> = [
  ["empty key", "", "illegal-character"],
  ["space", "a b", "illegal-character"],
  ["backslash", "a\\b", "illegal-character"],
  ["query character", "a?b", "illegal-character"],
  ["non-ascii", "snapshot-é", "illegal-character"],
  ["bare parent", "..", "parent-traversal"],
  ["leading parent", "../escape", "parent-traversal"],
  ["embedded parent", "a/../../b", "parent-traversal"],
  ["trailing parent", "a/b/..", "parent-traversal"],
  ["leading slash", "/etc/passwd", "absolute-path"],
  ["bare slash", "/", "absolute-path"],
  ["bare dot", ".", "parent-traversal"],
  ["dot and slash", "./", "parent-traversal"],
  ["dot, slash, dot", "./.", "parent-traversal"],
  ["leading dot segment", "./a", "parent-traversal"],
  ["embedded dot segment", "a/./b", "parent-traversal"],
  ["trailing dot segment", "a/.", "parent-traversal"],
  ["parent after dot segment", "a/./../b", "parent-traversal"],
  ["empty segment", "a//b", "illegal-character"],
  ["trailing slash", "a/", "illegal-character"],
  ["double trailing slash", "a//", "illegal-character"],
];

for (const [label, key, reason] of INVALID_KEYS) {
  test(`local: invalid key (${label}) is an InvalidKeyError "${reason}" for put and get`, async () => {
    await withTempDir(async (dir) => {
      const h = harness({ localDir: dir }, makeObjectStoreLocal);
      assert.equal(keyFailure(key), reason);

      const putError = failureOf(await exec(h, put(key, enc.encode("x"))));
      assert.ok(putError instanceof InvalidKeyError);
      assert.equal(putError.reason, reason);
      assert.equal(putError.key, key);

      const getError = failureOf(await exec(h, get(key)));
      assert.ok(getError instanceof InvalidKeyError);
      assert.equal(getError.reason, reason);

      // Nothing was created, in the root or (for traversal keys) above it.
      assert.deepEqual([...Deno.readDirSync(dir)], []);
      assert.ok(h.events.every((e) => e.level === "error"));
    });
  });
}

test("keyFailure accepts the key shapes the platform generates", () => {
  for (
    const key of [
      "a",
      "app/2026-10-10T12-00-00Z-ab12.sqlite",
      "tic-tac-toe/latest.json",
      "a.b_c/d-e",
      ".hidden",
      "a/..b/c.",
    ]
  ) {
    assert.equal(keyFailure(key), undefined, key);
  }
});

test("local: a failed write leaves no partial file at the final path", async () => {
  await withTempDir(async (dir) => {
    // The write dies after producing half the bytes, as a full disk or a crash would.
    const h = harness({ localDir: dir }, makeObjectStoreLocal, {
      fs: {
        writeFile: async (path, bytes) => {
          await Deno.writeFile(path, bytes.slice(0, Math.floor(bytes.length / 2)));
          throw new Error("disk full");
        },
      },
    });
    const error = failureOf(await exec(h, put("snap/new.bin", enc.encode("0123456789"))));
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(error.operation, "put");
    await assert.rejects(Deno.stat(join(dir, "snap/new.bin")));
    assert.deepEqual([...Deno.readDirSync(join(dir, "snap"))], [], "temp file must be cleaned up");
  });
});

test("local: a failed overwrite keeps the previous object intact", async () => {
  await withTempDir(async (dir) => {
    const good = harness({ localDir: dir }, makeObjectStoreLocal);
    await exec(good, put("latest.json", enc.encode("old-complete-object")));

    const failing = harness({ localDir: dir }, makeObjectStoreLocal, {
      fs: {
        writeFile: async (path, bytes) => {
          await Deno.writeFile(path, bytes.slice(0, 3));
          throw new Error("interrupted");
        },
      },
    });
    const error = failureOf(await exec(failing, put("latest.json", enc.encode("new-object"))));
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(dec.decode(await Deno.readFile(join(dir, "latest.json"))), "old-complete-object");
    assert.deepEqual([...Deno.readDirSync(dir)].map((e) => e.name), ["latest.json"]);
  });
});

test("local: a failed rename removes the temp file and reports ObjectStoreError", async () => {
  await withTempDir(async (dir) => {
    const h = harness({ localDir: dir }, makeObjectStoreLocal, {
      fs: { rename: () => Promise.reject(new Error("EXDEV")) },
    });
    const error = failureOf(await exec(h, put("a.bin", enc.encode("x"))));
    assert.ok(error instanceof ObjectStoreError);
    assert.deepEqual([...Deno.readDirSync(dir)], []);
  });
});

test("local: put and get each emit one event with key, bytes, duration and outcome", async () => {
  await withTempDir(async (dir) => {
    const h = harness({ localDir: dir }, makeObjectStoreLocal, { role: "restore" });
    await exec(
      h,
      Effect.gen(function* () {
        yield* put("k/obj.bin", enc.encode("12345"));
        yield* get("k/obj.bin");
        yield* Effect.either(get("k/missing.bin"));
      }),
    );
    assert.equal(h.events.length, 3);
    const [putEvent, getEvent, missingEvent] = h.events;

    assert.equal(putEvent.kind, "backup");
    assert.ok(putEvent.kind === "backup");
    assert.equal(putEvent.phase, "put-object");
    assert.equal(putEvent.key, "k/obj.bin");
    assert.equal(putEvent.bytes, 5);
    assert.equal(putEvent.outcome, "ok");
    assert.equal(typeof putEvent.durationMs, "number");
    assert.equal(putEvent.role, "restore");
    assert.equal(putEvent.eventId, "id-1");
    assert.equal(putEvent.level, "info");

    // `BackupPhase` has no read phase, so a get is a lifecycle event.
    assert.ok(getEvent.kind === "lifecycle");
    assert.equal(getEvent.phase, "object-get");
    assert.deepEqual(
      { ...(getEvent.detail as Record<string, unknown>), durationMs: undefined },
      {
        key: "k/obj.bin",
        bytes: 5,
        durationMs: undefined,
        outcome: "ok",
        errorTag: undefined,
        errorDetail: undefined,
      },
    );

    assert.ok(missingEvent.kind === "lifecycle");
    assert.equal(missingEvent.level, "error");
    assert.equal((missingEvent.detail as { outcome: string }).outcome, "error");
    assert.equal((missingEvent.detail as { errorTag: string }).errorTag, "ObjectStoreError");
  });
});

test("local: a failed put reports the attempted byte count and the error tag", async () => {
  await withTempDir(async (dir) => {
    const h = harness({ localDir: dir }, makeObjectStoreLocal);
    await exec(h, put("../out.bin", enc.encode("abc")));
    const [event] = h.events;
    assert.ok(event.kind === "backup");
    assert.equal(event.outcome, "error");
    assert.equal(event.bytes, 3);
    assert.equal(event.errorTag, "InvalidKeyError");
    assert.equal(event.level, "error");
  });
});

// ---------------------------------------------------------------------------
// S3 adapter
// ---------------------------------------------------------------------------

const S3 = {
  s3BaseUrl: "https://s3.example.test/bucket/",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret-example-key",
  region: "us-east-1",
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

/** A stub `fetch` that replays `responses` in order (the last repeats) and records every call. */
function stubFetch(responses: ReadonlyArray<Response | Error>) {
  const calls: Call[] = [];
  const impl = async (input: Request | URL | string, _init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: new Uint8Array(await request.arrayBuffer()),
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    // A `Response` body is single-use; hand back a copy so a repeated last response still works.
    return next.clone();
  };
  return { calls, fetch: impl as typeof fetch };
}

const s3Options = (fetch: typeof globalThis.fetch): ObjectStoreOptions => ({ fetch, retryBase: "1 millis" });

test("s3: put signs and sends a PUT to the base-relative URL", async () => {
  const stub = stubFetch([new Response(null, { status: 200 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const exit = await exec(h, put("app/snap-one_v1.bin", enc.encode("payload")));
  assert.ok(Exit.isSuccess(exit));
  assert.equal(stub.calls.length, 1);
  const [call] = stub.calls;
  assert.equal(call.method, "PUT");
  assert.equal(call.url, "https://s3.example.test/bucket/app/snap-one_v1.bin");
  assert.match(call.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.equal(call.contentType, "application/octet-stream");
  assert.equal(dec.decode(call.body), "payload");
});

test("s3: get returns the response bytes", async () => {
  const stub = stubFetch([new Response(Uint8Array.from([9, 8, 7]), { status: 200 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const exit = await exec(h, get("tic-tac-toe/latest.json"));
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(exit.value, Uint8Array.from([9, 8, 7]));
  assert.equal(stub.calls[0].method, "GET");
  assert.equal(stub.calls[0].url, "https://s3.example.test/bucket/tic-tac-toe/latest.json");
});

test("s3: a 4xx maps to ObjectStoreError with status and body, and is not retried", async () => {
  const stub = stubFetch([new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const error = failureOf(await exec(h, put("a/b.bin", enc.encode("x"))));
  assert.ok(error instanceof ObjectStoreError);
  assert.equal(error.operation, "put");
  assert.equal(error.key, "a/b.bin");
  assert.equal(error.status, 403);
  assert.match(error.detail ?? "", /AccessDenied/);
  assert.equal(stub.calls.length, 1);
});

test("s3: get of a missing object maps 404 without retrying", async () => {
  const stub = stubFetch([new Response("NoSuchKey", { status: 404 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const error = failureOf(await exec(h, get("gone.bin")));
  assert.ok(error instanceof ObjectStoreError);
  assert.equal(error.operation, "get");
  assert.equal(error.status, 404);
  assert.equal(error.detail, "NoSuchKey");
  assert.equal(stub.calls.length, 1);
});

test("s3: a 501 is permanent and is not retried", async () => {
  const stub = stubFetch([new Response("NotImplemented", { status: 501 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const error = failureOf(await exec(h, put("a.bin", enc.encode("x"))));
  assert.ok(error instanceof ObjectStoreError);
  assert.equal(error.status, 501);
  assert.equal(stub.calls.length, 1);
});

test("s3: a 400 RequestTimeout is transient and a later success wins", async () => {
  const stub = stubFetch([
    new Response("<Error><Code>RequestTimeout</Code></Error>", { status: 400 }),
    new Response(null, { status: 200 }),
  ]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const exit = await exec(h, put("a.bin", enc.encode("x")));
  assert.ok(Exit.isSuccess(exit));
  assert.equal(stub.calls.length, 2);
});

test("s3: a persistent 503 is retried three times, then surfaces as ObjectStoreError", async () => {
  const stub = stubFetch([new Response("SlowDown", { status: 503 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const error = failureOf(await exec(h, get("a.bin")));
  assert.ok(error instanceof ObjectStoreError);
  assert.equal(error.status, 503);
  assert.equal(error.detail, "SlowDown");
  assert.equal(stub.calls.length, 4, "one attempt plus three retries");
});

test("s3: transient failures are retried and a later success wins", async () => {
  const stub = stubFetch([
    new Response("busy", { status: 500 }),
    new Error("connection reset"),
    new Response("ok", { status: 200 }),
  ]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const exit = await exec(h, get("flaky.bin"));
  assert.ok(Exit.isSuccess(exit));
  assert.equal(dec.decode(exit.value), "ok");
  assert.equal(stub.calls.length, 3);
  // One event per operation, not per attempt.
  assert.equal(h.events.length, 1);
});

test("s3: a network error surfaces without a status and keeps its cause", async () => {
  const stub = stubFetch([new Error("ECONNREFUSED")]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const error = failureOf(await exec(h, put("a.bin", enc.encode("x"))));
  assert.ok(error instanceof ObjectStoreError);
  assert.equal(error.status, undefined);
  assert.match(String(error.cause), /ECONNREFUSED/);
  assert.equal(stub.calls.length, 4);
});

test("s3: invalid keys are rejected before any request is made", async () => {
  const stub = stubFetch([new Response(null, { status: 200 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  const error = failureOf(await exec(h, get("../other-bucket/x")));
  assert.ok(error instanceof InvalidKeyError);
  assert.equal(error.reason, "parent-traversal");
  assert.equal(stub.calls.length, 0);
});

test("s3: missing credentials fail layer construction with ConfigError", async () => {
  const stub = stubFetch([new Response(null, { status: 200 })]);
  const h = harness(
    { s3BaseUrl: S3.s3BaseUrl, accessKeyId: undefined, secretAccessKey: undefined },
    makeObjectStoreS3,
    s3Options(stub.fetch),
  );
  const error = failureOf(await exec(h, get("a.bin")));
  assert.ok(error instanceof ConfigError);
});

test("s3: events record the outcome, the HTTP error tag and no credentials", async () => {
  const stub = stubFetch([new Response("denied", { status: 403 })]);
  const h = harness(S3, makeObjectStoreS3, s3Options(stub.fetch));
  await exec(h, put("a.bin", enc.encode("abcd")));
  const [event] = h.events;
  assert.ok(event.kind === "backup");
  assert.equal(event.outcome, "error");
  assert.equal(event.errorTag, "ObjectStoreError");
  assert.equal(event.bytes, 4);
  assert.ok(!JSON.stringify(event).includes(S3.secretAccessKey));
});

// ---------------------------------------------------------------------------
// Selection and helpers
// ---------------------------------------------------------------------------

test("live: selects S3 when s3BaseUrl is set and the local stand-in otherwise", async () => {
  const stub = stubFetch([new Response("from-s3", { status: 200 })]);
  const s3 = harness(S3, makeObjectStoreLive, s3Options(stub.fetch));
  const viaS3 = await exec(s3, get("k.bin"));
  assert.ok(Exit.isSuccess(viaS3));
  assert.equal(dec.decode(viaS3.value), "from-s3");
  assert.equal(stub.calls.length, 1);

  await withTempDir(async (dir) => {
    await Deno.writeFile(join(dir, "k.bin"), enc.encode("from-disk"));
    const local = harness(
      { localDir: dir, s3BaseUrl: undefined },
      makeObjectStoreLive,
      s3Options(stub.fetch),
    );
    const viaLocal = await exec(local, get("k.bin"));
    assert.ok(Exit.isSuccess(viaLocal));
    assert.equal(dec.decode(viaLocal.value), "from-disk");
    assert.equal(stub.calls.length, 1, "the local path must not call fetch");
  });
});

test("sha256 matches the known digest of 'abc'", async () => {
  assert.equal(
    await sha256(enc.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("platform/object_store.ts reads no environment variables", async () => {
  const source = await Deno.readTextFile(new URL("../../platform/object_store.ts", import.meta.url));
  assert.ok(!source.includes("Deno.env"));
});
