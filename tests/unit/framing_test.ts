import { test } from "node:test";
import assert from "node:assert/strict";
import { Either } from "effect";
import { decoder } from "../../core/ipc/framing.ts";
import { lines } from "../../platform/ipc.ts";
import { IpcError } from "../../core/errors.ts";

function right<A>(result: Either.Either<A, unknown>): A {
  assert.ok(Either.isRight(result), `expected Right, got ${JSON.stringify(result)}`);
  return (result as Either.Right<unknown, A>).right;
}

function left<E>(result: Either.Either<unknown, E>): E {
  assert.ok(Either.isLeft(result), `expected Left, got ${JSON.stringify(result)}`);
  return (result as Either.Left<E, unknown>).left;
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const utf8 = new TextEncoder();

test("single message", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1}\n')), ['{"id":1}']);
  assert.deepEqual(right(d.finish()), undefined);
});

test("multiple messages in one chunk", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1}\n{"id":2}\n{"id":3}\n')), [
    '{"id":1}',
    '{"id":2}',
    '{"id":3}',
  ]);
  assert.deepEqual(right(d.finish()), undefined);
});

test("message split across chunks", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1,"na')), []);
  assert.deepEqual(right(d.push('me":"alice"}\n')), ['{"id":1,"name":"alice"}']);
  assert.deepEqual(right(d.finish()), undefined);
});

test("split mid-multibyte-character", () => {
  // 😀 (U+1F600) is a surrogate pair at string indices 9-10. Splitting BETWEEN the surrogates
  // leaves a dangling high surrogate at the end of the first chunk; the decoder must
  // concatenate the halves without corrupting the character.
  const message = '{"name":"😀"}';
  assert.equal(message.length, 13);
  const d = decoder();
  assert.deepEqual(right(d.push(message.slice(0, 10))), []);
  assert.deepEqual(right(d.push(message.slice(10) + "\n")), [message]);
  assert.deepEqual(right(d.finish()), undefined);
});

test("stream boundary: raw bytes split mid-UTF-8-sequence decode correctly", async () => {
  // The decoder takes opaque strings; byte-to-string decoding happens only at the stream
  // boundary in platform/ipc.ts (TextDecoderStream), not inside the decoder. 😀 is
  // F0 9F 98 80 in UTF-8 (bytes 9-12 of the encoded message), so splitting the raw byte
  // stream at byte 10 lands mid-sequence.
  const raw = utf8.encode('{"name":"😀"}\n');
  assert.equal(raw[9], 0xf0);
  const out: string[] = [];
  for await (const line of lines(byteStream([raw.slice(0, 10), raw.slice(10)]))) out.push(line);
  assert.deepEqual(out, ['{"name":"😀"}']);
});

test("empty lines are skipped", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('\n\n{"id":1}\n\n{"id":2}\n\n')), ['{"id":1}', '{"id":2}']);
  assert.deepEqual(right(d.finish()), undefined);
});

test("oversize buffer fails with message-too-large", () => {
  // The oversize error is deferred to the next push()/finish() so that complete lines
  // extracted from the offending chunk are delivered first (legacy order: yield, then throw).
  const d = decoder(10);
  assert.deepEqual(right(d.push('{"a":1}\n' + "x".repeat(11))), ['{"a":1}']);
  const error = left(d.finish());
  assert.equal(error.reason, "message-too-large");
  assert.equal(error.detail, "IPC message too large");
});

test("lines() delivers complete lines before raising the oversize error", async () => {
  // Regression: a complete reply in the same chunk as a >2MB unterminated remainder must
  // resolve its consumer before the framing error is raised (legacy yielded lines inside the
  // extraction loop, then hit the size check).
  const chunk = utf8.encode('{"id":1}\n' + "x".repeat(2_000_001));
  const out: string[] = [];
  let thrown: unknown;
  try {
    for await (const line of lines(byteStream([chunk]))) out.push(line);
  } catch (e) {
    thrown = e;
  }
  assert.deepEqual(out, ['{"id":1}']);
  assert.ok(thrown instanceof IpcError, `expected IpcError, got ${thrown}`);
  assert.equal((thrown as IpcError).reason, "message-too-large");
});

test("framing errors carry a human-readable detail", () => {
  // NOTE: the oversize error is deferred, so the first push returns Right([]);
  // the error surfaces on the next push()/finish().
  const d = decoder(5);
  d.push("x".repeat(6));
  const oversizeError = left(d.finish());
  assert.equal(oversizeError.reason, "message-too-large");
  assert.equal(oversizeError.detail, "IPC message too large");

  const d2 = decoder();
  d2.push('{"incomplete"');
  const truncatedError = left(d2.finish());
  assert.equal(truncatedError.reason, "truncated-message");
  assert.equal(truncatedError.detail, "Truncated IPC message");

  // Data.TaggedError renders .message only from an explicit `message` payload field, which the
  // error taxonomy deliberately does not declare (errors carry structured fields, not
  // pre-formatted messages); the structured `detail` above is what item 17 matches on.
  assert.equal(oversizeError.message, "");
});

test("truncated trailing buffer fails at finish", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1}\n{"incomplete"')), ['{"id":1}']);
  const error = left(d.finish());
  assert.equal(error.reason, "truncated-message");
  assert.equal(error.detail, "Truncated IPC message");
});

test("a whitespace-only trailing buffer is not truncated", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1}\n   ')), ['{"id":1}']);
  assert.deepEqual(right(d.finish()), undefined);
});

test("default maxBytes is 2 MB, matching today's behavior", () => {
  // 2_000_000 is 2 MB, not 2 MiB (2_097_152); the legacy constant is kept exactly.
  const d = decoder();
  const underLimit = d.push("x".repeat(2_000_000));
  assert.ok(Either.isRight(underLimit));
  const overLimit = d.push("x");
  assert.deepEqual(right(overLimit), []); // oversize error is deferred to finish()
  const error = left(d.finish());
  assert.equal(error.reason, "message-too-large");
});
