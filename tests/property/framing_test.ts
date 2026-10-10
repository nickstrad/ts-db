/**
 * Property tests for `core/ipc/framing.ts` (plan item 12, work 4).
 *
 * `MessageTooLarge` in the plan is `IpcError{ reason: "message-too-large" }`. The decoder's limit applies to
 * the *unterminated residue* left after each push (a complete line in a single chunk is never "too large"),
 * and the failure is deferred to the next `push`/`finish` — the oracle below models exactly that from the
 * concatenated stream, independently of the decoder's buffering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { Either } from "effect";
import { decoder } from "../../core/ipc/framing.ts";
import type { IpcError } from "../../core/errors.ts";
import { check, SEED, titled } from "./arbitraries.ts";

/** Characters chosen to stress framing: JSON punctuation, whitespace, CR, multi-unit emoji, no "\n". */
const ALPHABET = ["{", "}", '"', ":", ",", "a", "Z", "0", " ", "\t", "\r", "é", "日", "😀", "\\", "\u0000"];
const messageArb = fc.string({ unit: fc.constantFrom(...ALPHABET), maxLength: 24 });

/** Cuts `text` at sorted points (duplicates give empty chunks, and cuts may split a surrogate pair). */
function split(text: string, cuts: readonly number[]): string[] {
  const points = [0, ...[...cuts].sort((a, b) => a - b), text.length];
  return points.slice(1).map((end, i) => text.slice(points[i], end));
}
const cutsFor = (length: number) => fc.array(fc.integer({ min: 0, max: length }), { maxLength: 12 });

function splitArb(text: string): fc.Arbitrary<string[]> {
  return cutsFor(text.length).map((cuts) => split(text, cuts));
}

const rightOf = <A>(r: Either.Either<A, IpcError>): A => {
  assert.ok(Either.isRight(r), `expected Right, got ${JSON.stringify(Either.isLeft(r) ? r.left : r)}`);
  return (r as Either.Right<IpcError, A>).right;
};

test(titled("generators: splits include empty chunks, mid-message cuts and blank messages"), () => {
  const samples = fc.sample(
    fc.array(messageArb, { maxLength: 6 }).chain((msgs) =>
      splitArb(msgs.map((m) => m + "\n").join("")).map((chunks) => ({ msgs, chunks }))
    ),
    { numRuns: 300, seed: SEED },
  );
  assert.ok(samples.some((s) => s.chunks.some((c) => c === "")), "no empty chunk");
  assert.ok(samples.some((s) => s.msgs.some((m) => m === "")), "no blank message");
  assert.ok(samples.some((s) => s.chunks.length > s.msgs.length + 1), "no mid-message cut");
});

test(
  titled("chunk-split invariance: any split of the concatenation yields exactly the non-empty messages"),
  () => {
    const input = fc.array(messageArb, { maxLength: 8 }).chain((msgs) =>
      splitArb(msgs.map((m) => m + "\n").join("")).map((chunks) => ({ msgs, chunks }))
    );
    check(fc.property(input, ({ msgs, chunks }) => {
      const d = decoder(64); // every message is <= 24 units, so the cap is never the reason for a Left
      const out: string[] = [];
      for (const chunk of chunks) out.push(...rightOf(d.push(chunk)));
      rightOf(d.finish());
      assert.deepStrictEqual(out, msgs.filter((m) => m !== ""));
      // And the one-chunk decoding is the same thing: the split is unobservable.
      const whole = decoder(64);
      assert.deepStrictEqual(rightOf(whole.push(msgs.map((m) => m + "\n").join(""))), out);
    }));
  },
);

test(titled("push and finish never throw, whatever the chunks, cap or call order"), () => {
  const op = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.string({ unit: fc.constantFrom(...ALPHABET, "\n"), maxLength: 40 }).map((c) => ({ c })),
    },
    { weight: 1, arbitrary: fc.constant("finish" as const) },
  );
  check(fc.property(fc.integer({ min: 0, max: 50 }), fc.array(op, { maxLength: 20 }), (cap, ops) => {
    const d = decoder(cap);
    for (const o of ops) {
      const result: Either.Either<unknown, IpcError> = o === "finish" ? d.finish() : d.push(o.c);
      assert.ok(Either.isEither(result));
      if (Either.isLeft(result)) {
        assert.equal(result.left._tag, "IpcError");
        assert.ok(result.left.reason === "message-too-large" || result.left.reason === "truncated-message");
      }
    }
  }));
});

test(
  titled(
    "an unterminated run longer than the cap always yields MessageTooLarge, before any truncation error",
  ),
  () => {
    const input = fc.integer({ min: 0, max: 30 }).chain((cap) =>
      fc.tuple(
        fc.constant(cap),
        fc.string({ unit: fc.constantFrom(...ALPHABET), minLength: cap + 1, maxLength: cap + 20 }),
      )
        .chain(([c, run]) => splitArb(run).map((chunks) => ({ cap: c, chunks })))
    );
    check(fc.property(input, ({ cap, chunks }) => {
      const d = decoder(cap);
      for (const chunk of chunks) assert.ok(Either.isEither(d.push(chunk)));
      const fin = d.finish();
      assert.ok(Either.isLeft(fin));
      if (Either.isRight(fin)) return;
      assert.equal(fin.left.reason, "message-too-large");
      assert.equal(fin.left.detail, "IPC message too large");
      // Latched: the decoder keeps refusing.
      const again = d.push("ok\n");
      assert.ok(Either.isLeft(again) && again.left.reason === "message-too-large");
    }));
  },
);

test(
  titled(
    "oversize oracle: too-large iff some push leaves a residue over the cap; lines before it still arrive",
  ),
  () => {
    const chunkArb = fc.string({ unit: fc.constantFrom(...ALPHABET, "\n", "\n"), maxLength: 16 });
    check(
      fc.property(fc.integer({ min: 0, max: 12 }), fc.array(chunkArb, { maxLength: 8 }), (cap, chunks) => {
        // Oracle: after chunk k the decoder holds the stream's text after its last newline.
        let stream = "";
        let overAt = -1;
        const expectedLines: string[] = [];
        let consumed = 0; // index in `stream` up to which lines were already emitted
        chunks.forEach((chunk, k) => {
          if (overAt >= 0) return;
          stream += chunk;
          const lastNl = stream.lastIndexOf("\n");
          for (const line of stream.slice(consumed, lastNl + 1).split("\n").slice(0, -1)) {
            if (line !== "") expectedLines.push(line);
          }
          consumed = lastNl + 1;
          if (stream.length - consumed > cap) overAt = k;
        });
        const residue = stream.slice(consumed);

        const d = decoder(cap);
        const lines: string[] = [];
        let failedAt = -1;
        chunks.forEach((chunk, k) => {
          const r = d.push(chunk);
          if (Either.isRight(r)) lines.push(...r.right);
          else if (failedAt < 0) failedAt = k;
        });
        const fin = d.finish();

        assert.deepStrictEqual(
          lines,
          expectedLines,
          "complete lines are delivered, in order, up to the oversize point",
        );
        if (overAt >= 0) {
          // Deferred: the push that crossed the cap succeeds; the next push (or finish) reports it.
          assert.ok(failedAt === -1 || failedAt > overAt, "failure must not precede the oversize chunk");
          assert.ok(Either.isLeft(fin) && fin.left.reason === "message-too-large");
          if (overAt < chunks.length - 1) assert.equal(failedAt, overAt + 1);
        } else {
          assert.equal(failedAt, -1);
          if (residue.trim() === "") assert.ok(Either.isRight(fin));
          else assert.ok(Either.isLeft(fin) && fin.left.reason === "truncated-message");
        }
      }),
    );
  },
);
