/**
 * Property tests for `core/eventlog/offsets.ts` (plan item 21): exactly-once ingestion across
 * arbitrary interleavings of appends, truncations, rewrites, deletions and ingest runs.
 *
 * The suite drives a small simulated log tree. Each ingest run is the same composition
 * `platform/eventlog/ingest.ts` performs — `planFile` per source file in order, then insert,
 * dedupe flagged lines (against what is in, and earlier lines of the same run, as `rowsSql` does),
 * quarantine, and move the row — with DuckDB replaced by in-memory sets. The
 * planner is the real one; only the storage is simulated.
 *
 * Lines are `L<id>.<id>.`: a fresh id per written line, repeated so that a fragment glued to another
 * fragment (a truncation mid-line followed by an append) cannot spell some *other* valid line. Such
 * frankenlines are malformed, as is generated noise (which can include multi-byte UTF-8, so a
 * truncation can split a character). A valid line stands for a record with an `eventId`; a
 * malformed one for a line the platform quarantines.
 *
 * Properties, checked after every ingest run:
 *
 * Op weights and `size: "max"` are tuned so every adversarial case occurs hundreds of times per
 * run; the adversarial test prints those counts and fails if any falls below a floor.
 *
 * 1. **Complete**: every complete line in every file has been ingested (valid) or quarantined
 *    (malformed).
 * 2. **Exactly once**: no valid id is ever inserted twice, across any history.
 * 3. **At most once per generation**: no `(file, generation, offset)` is consumed twice; a
 *    generation changes only when the planner reports a rewrite.
 * 4. **Idempotent**: a second run straight after inserts nothing, quarantines nothing, and leaves
 *    every state row identical (`lastIngestedAt` included, though the clock moved).
 * 5. **Rewrite detection is exact**: the planner reports `rewritten` iff the file no longer starts
 *    with the bytes that were ingested from it (oracle: a shadow copy of the consumed prefix).
 * 6. Offsets only ever sit on line boundaries, and an `append` never starts before the recorded
 *    offset.
 *
 * An append-only property states the strongest form for the normal case: with no truncation or
 * rewrite, every complete line — valid or malformed — is consumed exactly once, and no rewrite is
 * ever reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fc from "fast-check";
import {
  completeLines,
  type FilePlan,
  type IngestStateRow,
  parseSourceFile,
  planFile,
} from "../../core/eventlog/offsets.ts";
import { check, titled } from "./arbitraries.ts";

const FILES = [
  "reader/2026-10-10/events-12-5151-001.jsonl",
  "server/2026-10-10/events-12-4242-001.jsonl",
  "server/2026-10-10/events-12-4242-002.jsonl",
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VALID = /^L(\d+)\.\1\.$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type LineKind = { kind: "valid" } | { kind: "crlf" } | { kind: "blank" } | { kind: "noise"; text: string };

type Op =
  | { op: "append"; file: number; lines: LineKind[]; cut?: number }
  | { op: "truncate"; file: number; at: number }
  | { op: "tear"; file: number; at: number; lines: LineKind[] }
  | { op: "chop"; file: number; bytes: number; settle: boolean }
  | { op: "rewrite"; file: number; keep: number[]; fresh: number }
  | { op: "remove"; file: number }
  | { op: "ingest" }
  | { op: "failedIngest" };

const fileArb = fc.integer({ min: 0, max: FILES.length - 1 });

/**
 * A position as a fraction of a file. Uniform on purpose: `fc.double` favours 0, 1 and denormals,
 * which would put nearly every cut on a file boundary instead of mid-line.
 */
const fractionArb = fc.integer({ min: 0, max: 1000 }).map((permille) => permille / 1000);

/** Noise never contains `L`, digits or `.`, so it can never complete a valid line. */
const noiseArb = fc.string({
  unit: fc.constantFrom("?", "{", "}", '"', " ", "x", ",", "é", " ", "\r"),
  minLength: 1,
  maxLength: 6,
});

const lineArb: fc.Arbitrary<LineKind> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: "valid" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "crlf" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "blank" as const }) },
  { weight: 2, arbitrary: noiseArb.map((text) => ({ kind: "noise" as const, text })) },
);

const appendArb: fc.Arbitrary<Op> = fc.record(
  {
    op: fc.constant("append" as const),
    file: fileArb,
    lines: fc.array(lineArb, { minLength: 0, maxLength: 4 }),
    cut: fractionArb,
  },
  { requiredKeys: ["op", "file", "lines"] },
);

const adversarialOpArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: appendArb },
  { weight: 5, arbitrary: fc.constant({ op: "ingest" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant("truncate" as const),
      file: fileArb,
      at: fractionArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("rewrite" as const),
      file: fileArb,
      keep: fc.array(fc.nat({ max: 50 }), { maxLength: 6 }),
      fresh: fc.integer({ min: 0, max: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("tear" as const),
      file: fileArb,
      at: fractionArb,
      lines: fc.array(lineArb, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant("chop" as const),
      file: fileArb,
      bytes: fc.integer({ min: 1, max: 4 }),
      settle: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("remove" as const), file: fileArb }) },
  { weight: 1, arbitrary: fc.constant({ op: "failedIngest" as const }) },
);

const appendOnlyOpArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: appendArb },
  { weight: 1, arbitrary: fc.constant({ op: "ingest" as const }) },
);

// ---------------------------------------------------------------------------
// The simulated world
// ---------------------------------------------------------------------------

/** What one simulated run did. */
interface RunResult {
  inserted: string[];
  quarantined: number;
  consumed: number;
  plans: Map<string, FilePlan>;
}

class World {
  readonly files = new Map<string, Uint8Array>();
  /** The rest of a line whose start was written by a cut append; written by the next append. */
  readonly held = new Map<string, Uint8Array>();
  readonly state = new Map<string, IngestStateRow>();
  /** Oracle: the bytes consumed from each file's current generation. */
  readonly shadow = new Map<string, Uint8Array>();
  readonly generation = new Map<string, number>();
  readonly insertedCount = new Map<string, number>();
  readonly consumedKeys = new Map<string, number>();
  readonly quarantined = new Set<string>();
  /** Every complete line ever written by an append, for the append-only property. */
  readonly written: string[] = [];
  private nextId = 1;
  private clock = Date.UTC(2026, 9, 10, 12);

  fresh(): string {
    const id = this.nextId++;
    return `L${id}.${id}.`;
  }

  apply(op: Op): void {
    switch (op.op) {
      case "append":
        return this.append(op.file, op.lines, op.cut);
      case "truncate": {
        const path = FILES[op.file];
        const bytes = this.files.get(path);
        if (bytes === undefined) return;
        this.files.set(path, bytes.slice(0, Math.floor(op.at * bytes.length)));
        return; // a held fragment survives: the next append glues it on, adversarially
      }
      case "chop": {
        // A short write the writer retries: the last few bytes (typically an ingested line's
        // terminator) vanish from disk and are re-sent by the next append. If an ingest runs in
        // between, that append completes an *old* line again — the case the sticky dedupe flag is for.
        const path = FILES[op.file];
        const bytes = this.files.get(path);
        if (bytes === undefined) return;
        const at = Math.max(0, bytes.length - op.bytes);
        this.held.set(path, concat(bytes.slice(at), this.held.get(path) ?? new Uint8Array()));
        this.files.set(path, bytes.slice(0, at));
        return;
      }
      case "tear":
        // A writer that dies mid-line and a writer that resumes appending: the torn line and the
        // next append fuse into one malformed line.
        this.apply({ op: "truncate", file: op.file, at: op.at });
        return this.append(op.file, op.lines, undefined);
      case "rewrite":
        return this.rewrite(op.file, op.keep, op.fresh);
      case "remove":
        this.files.delete(FILES[op.file]);
        this.held.delete(FILES[op.file]);
        return;
      case "ingest":
      case "failedIngest":
        return; // driven by the property body, which checks results
    }
  }

  private append(file: number, lines: LineKind[], cut: number | undefined): void {
    const path = FILES[file];
    let text = "";
    for (const line of lines) {
      if (line.kind === "valid") text += `${this.fresh()}\n`;
      else if (line.kind === "crlf") text += `${this.fresh()}\r\n`;
      else if (line.kind === "blank") text += "\n";
      else text += `${line.text}\n`;
    }
    for (const line of text.split("\n").slice(0, -1)) this.written.push(line);
    let bytes = concat(this.held.get(path) ?? new Uint8Array(), encoder.encode(text));
    this.held.delete(path);
    if (cut !== undefined && bytes.length > 0) {
      const at = Math.floor(cut * bytes.length);
      this.held.set(path, bytes.slice(at));
      bytes = bytes.slice(0, at);
    }
    this.files.set(path, concat(this.files.get(path) ?? new Uint8Array(), bytes));
  }

  /** A new history for the file: some of its own complete lines, reordered, plus fresh ones. */
  private rewrite(file: number, keep: number[], fresh: number): void {
    const path = FILES[file];
    const bytes = this.files.get(path) ?? new Uint8Array();
    const existing = completeLines(bytes, 0).lines.map((span) =>
      decoder.decode(bytes.subarray(span.start, span.end))
    );
    const picked: string[] = [];
    const used = new Set<number>();
    for (const k of keep) {
      if (existing.length === 0) break;
      const index = k % existing.length;
      if (used.has(index)) continue;
      used.add(index);
      picked.push(existing[index]);
    }
    for (let i = 0; i < fresh; i++) picked.push(this.fresh());
    this.files.set(path, encoder.encode(picked.map((line) => `${line}\n`).join("")));
    this.held.delete(path);
  }

  /**
   * One ingest run, composed like `ingest.ts`. With `commit: false` the run fails at `COMMIT`:
   * quarantine was already written (it precedes the commit), everything else rolls back.
   */
  ingest(commit = true): RunResult {
    this.clock += 60_000;
    const now = new Date(this.clock).toISOString();
    const before = new Set(this.insertedCount.keys());
    /** Valid ids already met in this run, in file-then-offset order: `rowsSql`'s `occurrence`. */
    const seen = new Set<string>();
    const result: RunResult = { inserted: [], quarantined: 0, consumed: 0, plans: new Map() };
    const nextState = new Map<string, IngestStateRow>();
    const nextShadow = new Map<string, Uint8Array>();
    const nextGeneration = new Map<string, number>();
    const consumed: string[] = [];

    const order = [...this.files.keys()].sort();
    for (const path of order) {
      assert.ok(parseSourceFile(path) !== undefined);
      const bytes = this.files.get(path)!;
      const previous = this.state.get(path);
      const plan = planFile(path, previous, bytes, sha256, now);
      result.plans.set(path, plan);

      // Property 5: rewrite detection matches the oracle exactly.
      if (previous !== undefined) {
        const shadow = this.shadow.get(path)!;
        const changed = bytes.length < shadow.length || !sameBytes(bytes.subarray(0, shadow.length), shadow);
        const reported = plan.decision.kind === "read" && plan.decision.mode === "rewritten";
        assert.equal(reported, changed, `rewrite detection for ${path}`);
      } else {
        assert.ok(plan.decision.kind === "skip" || plan.decision.mode === "new");
      }
      // Property 6: offsets.
      if (plan.decision.kind === "read" && plan.decision.mode === "append") {
        assert.equal(plan.decision.from, previous!.bytesIngested);
      }
      for (const span of plan.lines) {
        assert.ok(
          plan.decision.kind === "read" && span.start >= plan.decision.from && span.end < plan.end + 1,
        );
      }
      if (plan.nextState === undefined) continue;
      const end = plan.nextState.bytesIngested;
      assert.ok(end === 0 || bytes[end - 1] === 0x0a, "offset is a line boundary");
      assert.equal(plan.nextState.prefixSha256, sha256(bytes.subarray(0, end)));

      const rewritten = plan.decision.kind === "read" && plan.decision.mode === "rewritten";
      if (plan.decision.kind === "read" && plan.decision.rewrite !== undefined) {
        coverage[plan.decision.rewrite] += 1;
      }
      const generation = (this.generation.get(path) ?? 0) + (rewritten ? 1 : 0);
      for (const span of plan.lines) {
        const text = decoder.decode(bytes.subarray(span.start, span.end));
        consumed.push(`${path}#${generation}#${span.start}`);
        const match = VALID.exec(text);
        if (match === null) {
          if (text.includes("L")) coverage.frankenlines += 1;
          this.quarantined.add(`${path}#${text}`); // written before COMMIT, so kept on failure too
          result.quarantined += 1;
        } else if (
          plan.decision.kind === "read" && plan.decision.dedupe && (before.has(text) || seen.has(text))
        ) {
          coverage.deduplicated += 1; // the platform's anti-join on eventId
          if (!rewritten) coverage.stickyDeduplicated += 1;
        } else {
          result.inserted.push(text);
        }
        if (match !== null) seen.add(text);
      }
      result.consumed += plan.lines.length;
      nextState.set(path, plan.nextState);
      nextShadow.set(path, bytes.slice(0, end));
      nextGeneration.set(path, generation);
    }

    if (!commit) return { ...result, inserted: [] };
    for (const text of result.inserted) this.insertedCount.set(text, (this.insertedCount.get(text) ?? 0) + 1);
    for (const key of consumed) this.consumedKeys.set(key, (this.consumedKeys.get(key) ?? 0) + 1);
    for (const [path, row] of nextState) this.state.set(path, row);
    for (const [path, bytes] of nextShadow) this.shadow.set(path, bytes);
    for (const [path, generation] of nextGeneration) this.generation.set(path, generation);
    return result;
  }

  /** Properties 1-3 against the world as it is now. */
  assertExactlyOnce(): void {
    for (const [path, bytes] of this.files) {
      for (const span of completeLines(bytes, 0).lines) {
        const text = decoder.decode(bytes.subarray(span.start, span.end));
        if (VALID.test(text)) {
          assert.ok(this.insertedCount.has(text), `${text} in ${path} was never ingested`);
        } else {assert.ok(
            this.quarantined.has(`${path}#${text}`),
            `malformed ${JSON.stringify(text)} not quarantined`,
          );}
      }
    }
    for (const [text, count] of this.insertedCount) assert.equal(count, 1, `${text} inserted ${count} times`);
    for (const [key, count] of this.consumedKeys) assert.equal(count, 1, `${key} consumed ${count} times`);
  }
}

/**
 * How often the adversarial cases actually occurred, summed over a whole property run. A property
 * that passes because its generator never produced a truncation proves nothing, so the adversarial
 * test asserts each of these is non-trivial.
 */
const coverage = {
  truncated: 0,
  "prefix-mismatch": 0,
  deduplicated: 0,
  /** Deduplicated in a later run, because an earlier run detected a rewrite. */
  stickyDeduplicated: 0,
  frankenlines: 0,
};

/** Runs `ops`, checking every property after each ingest; ends with a final ingest. */
function simulate(ops: readonly Op[]): World {
  const world = new World();
  for (const op of [...ops, { op: "ingest" as const }]) {
    if (op.op === "failedIngest") {
      world.ingest(false);
      continue;
    }
    if (op.op === "chop" && op.settle) {
      // Ingest, lose the tail, ingest again: the rewrite run sees an *ingested* line torn open.
      ingestAndCheck(world);
      world.apply(op);
      ingestAndCheck(world);
      continue;
    }
    world.apply(op);
    if (op.op === "ingest") ingestAndCheck(world);
  }
  return world;
}

/** One ingest run, then properties 1-4. */
function ingestAndCheck(world: World): void {
  world.ingest();
  world.assertExactlyOnce();
  // Property 4: idempotence.
  const state = structuredClone([...world.state]);
  const again = world.ingest();
  assert.deepEqual(
    { inserted: again.inserted, quarantined: again.quarantined, consumed: again.consumed },
    { inserted: [], quarantined: 0, consumed: 0 },
    "a second run straight after ingests nothing",
  );
  assert.deepEqual([...world.state], state, "a second run leaves every state row identical");
  // A file whose tail is a partial line plans a read that finds nothing; no plan may commit.
  for (const plan of again.plans.values()) assert.equal(plan.nextState, undefined);
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test(
  titled("exactly-once ingestion across adversarial append/truncate/rewrite/remove/ingest interleavings"),
  () => {
    for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) coverage[key] = 0;
    check(
      fc.property(
        fc.array(adversarialOpArb, { minLength: 1, maxLength: 60, size: "max" }),
        (ops) => void simulate(ops),
      ),
    );
    console.log(`offsets adversarial coverage: ${JSON.stringify(coverage)}`);
    // The sticky case needs a rewrite, a later append to the same file, and an old line in it.
    const floors: Record<keyof typeof coverage, number> = {
      truncated: 100,
      "prefix-mismatch": 100,
      deduplicated: 100,
      stickyDeduplicated: 25,
      frankenlines: 100,
    };
    for (const [key, floor] of Object.entries(floors) as [keyof typeof coverage, number][]) {
      assert.ok(coverage[key] >= floor, `only ${coverage[key]} ${key} cases`);
    }
  },
);

test(
  titled("append-only histories: every complete line is consumed exactly once and no rewrite is reported"),
  () => {
    check(fc.property(fc.array(appendOnlyOpArb, { minLength: 1, maxLength: 60, size: "max" }), (ops) => {
      const world = simulate(ops);
      // After the final ingest, a held fragment is the only thing not on disk; everything written
      // in full and completed is consumed once.
      const consumedTotal = [...world.consumedKeys.values()].reduce((a, b) => a + b, 0);
      const onDisk = [...world.files.values()].reduce(
        (n, bytes) => n + completeLines(bytes, 0).lines.length,
        0,
      );
      assert.equal(consumedTotal, onDisk);
      for (const generation of world.generation.values()) assert.equal(generation, 0);
      // A written line that is not ingested must still be in flight: part of the file's
      // unterminated tail followed by the held rest of the append (a cut may hold back several).
      const inFlight = new Set<string>();
      for (const [path, bytes] of world.files) {
        const tail = bytes.subarray(completeLines(bytes, 0).end);
        const rest = decoder.decode(concat(tail, world.held.get(path) ?? new Uint8Array()));
        for (const line of rest.split("\n")) inFlight.add(line.replace(/\r$/, ""));
      }
      for (const line of world.written) {
        const text = line.replace(/\r$/, "");
        if (!VALID.test(text) || world.insertedCount.has(text)) continue;
        assert.ok(inFlight.has(text), `${text} neither ingested nor still in flight`);
      }
    }));
  },
);

test(
  titled("chunk-split invariance: ingesting after every chunk consumes the same lines as one read"),
  () => {
    check(fc.property(
      fc.array(fc.oneof(fc.constant("L1.1."), fc.constant(""), noiseArb), { maxLength: 12 }),
      fc.array(fc.nat(), { maxLength: 10 }),
      (lineTexts, cutPoints) => {
        const all = encoder.encode(lineTexts.map((line) => `${line}\n`).join(""));
        const cuts = [...new Set(cutPoints.map((c) => c % (all.length + 1)))].sort((a, b) => a - b);
        let state: IngestStateRow | undefined;
        const seen: string[] = [];
        for (const cut of [...cuts, all.length]) {
          const bytes = all.subarray(0, cut);
          const plan = planFile("f", state, bytes, sha256, "2026-10-10T12:00:00.000Z");
          for (const span of plan.lines) seen.push(decoder.decode(bytes.subarray(span.start, span.end)));
          state = plan.nextState ?? state;
        }
        const whole = completeLines(all, 0).lines.map((span) =>
          decoder.decode(all.subarray(span.start, span.end))
        );
        assert.deepEqual(seen, whole);
        assert.equal(state?.bytesIngested ?? 0, all.length);
      },
    ));
  },
);
