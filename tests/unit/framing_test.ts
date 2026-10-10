import { test } from "node:test";
import assert from "node:assert/strict";
import { Either } from "effect";
import { decoder } from "../../core/ipc/framing.ts";

function right<A>(result: Either.Either<A, unknown>): A {
  assert.ok(Either.isRight(result), `expected Right, got ${JSON.stringify(result)}`);
  return (result as Either.Right<unknown, A>).right;
}

function left<E>(result: Either.Either<unknown, E>): E {
  assert.ok(Either.isLeft(result), `expected Left, got ${JSON.stringify(result)}`);
  return (result as Either.Left<E, unknown>).left;
}

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
  // The decoder takes opaque strings, so a chunk boundary that would fall mid-codepoint if the
  // input were raw bytes (e.g. inside a UTF-8 encoded emoji) must not corrupt or lose data: the
  // string halves are just concatenated.
  const message = '{"name":"\u{1F600}"}';
  const mid = Math.floor(message.length / 2);
  const d = decoder();
  assert.deepEqual(right(d.push(message.slice(0, mid))), []);
  assert.deepEqual(right(d.push(message.slice(mid) + "\n")), [message]);
  assert.deepEqual(right(d.finish()), undefined);
});

test("empty lines are skipped", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('\n\n{"id":1}\n\n{"id":2}\n\n')), ['{"id":1}', '{"id":2}']);
  assert.deepEqual(right(d.finish()), undefined);
});

test("oversize buffer fails with message-too-large", () => {
  const d = decoder(10);
  const result = d.push("x".repeat(11));
  const error = left(result);
  assert.equal((error as { reason: string }).reason, "message-too-large");
});

test("truncated trailing buffer fails at finish", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1}\n{"incomplete"')), ['{"id":1}']);
  const error = left(d.finish());
  assert.equal((error as { reason: string }).reason, "truncated-message");
});

test("a whitespace-only trailing buffer is not truncated", () => {
  const d = decoder();
  assert.deepEqual(right(d.push('{"id":1}\n   ')), ['{"id":1}']);
  assert.deepEqual(right(d.finish()), undefined);
});

test("default maxBytes is 2 MiB, matching today's behavior", () => {
  const d = decoder();
  const underLimit = d.push("x".repeat(2_000_000));
  assert.ok(Either.isRight(underLimit));
  const overLimit = d.push("x");
  const error = left(overLimit);
  assert.equal((error as { reason: string }).reason, "message-too-large");
});
