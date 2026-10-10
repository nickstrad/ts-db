import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentPath,
  defaultRotationPolicy,
  type FileEntry,
  InvalidDateBucketError,
  InvalidLogRoleError,
  plan,
  type RollState,
  type RotationPolicy,
  shouldRoll,
} from "../../core/logging/rotation.ts";

// ---------------------------------------------------------------------------
// currentPath
// ---------------------------------------------------------------------------

test("currentPath builds logs/<role>/<date>/events-<hour>-<pid>-<seq>.jsonl with zero-padding", () => {
  const now = new Date(2026, 9, 10, 14, 5, 0); // 2026-10-10 14:05 local
  const path = currentPath(defaultRotationPolicy, now, "server", 31887, 1);
  assert.equal(path, "logs/server/2026-10-10/events-14-31887-001.jsonl");
});

test("currentPath rejects a role outside the known set", () => {
  const now = new Date(2026, 9, 10, 14, 5, 0);
  assert.throws(
    () => currentPath(defaultRotationPolicy, now, "worker", 1, 1),
    InvalidLogRoleError,
  );
});

// ---------------------------------------------------------------------------
// shouldRoll
// ---------------------------------------------------------------------------

function openedAt(dateBucket: string, hourBucket: string): RollState {
  return {
    dir: `logs/server/${dateBucket}`,
    dateBucket,
    hourBucket,
    openedAt: new Date(2026, 9, 9, 23, 0, 0),
  };
}

test("shouldRoll returns 'date' on a day boundary", () => {
  const state = openedAt("2026-10-09", "23");
  const now = new Date(2026, 9, 10, 0, 5, 0); // next day, just past midnight
  assert.equal(shouldRoll(state, now, 0, defaultRotationPolicy), "date");
});

test("shouldRoll returns 'hour' when the day matches but the hour changed", () => {
  const state = openedAt("2026-10-10", "13");
  const now = new Date(2026, 9, 10, 14, 0, 1);
  assert.equal(shouldRoll(state, now, 0, defaultRotationPolicy), "hour");
});

test("shouldRoll returns 'size' once bytesWritten crosses maxFileBytes", () => {
  const state = openedAt("2026-10-10", "14");
  const now = new Date(2026, 9, 10, 14, 30, 0);
  const smallFilePolicy: RotationPolicy = { ...defaultRotationPolicy, maxFileBytes: 100 };
  assert.equal(shouldRoll(state, now, 100, smallFilePolicy), "size");
  assert.equal(shouldRoll(state, now, 99, smallFilePolicy), "no");
});

test("shouldRoll prefers 'date' over 'size' when both conditions hold", () => {
  const state = openedAt("2026-10-09", "23");
  const now = new Date(2026, 9, 10, 0, 5, 0);
  const smallFilePolicy: RotationPolicy = { ...defaultRotationPolicy, maxFileBytes: 10 };
  assert.equal(shouldRoll(state, now, 1_000, smallFilePolicy), "date");
});

test("shouldRoll prefers 'hour' over 'size' when both conditions hold", () => {
  const state = openedAt("2026-10-10", "13");
  const now = new Date(2026, 9, 10, 14, 0, 0);
  const smallFilePolicy: RotationPolicy = { ...defaultRotationPolicy, maxFileBytes: 10 };
  assert.equal(shouldRoll(state, now, 1_000, smallFilePolicy), "hour");
});

test("shouldRoll returns 'no' when nothing has changed", () => {
  const state = openedAt("2026-10-10", "14");
  const now = new Date(2026, 9, 10, 14, 30, 0);
  assert.equal(shouldRoll(state, now, 1_000, defaultRotationPolicy), "no");
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

const NOW = new Date(2026, 9, 10, 14, 0, 0); // today = 2026-10-10
const TODAY = "2026-10-10";

function entry(path: string, dir: string, bytes: number, mtime: Date): FileEntry {
  return { path, dir, bytes, mtime };
}

test("invariant (a): today's directory is never gzipped or deleted, regardless of file age", () => {
  const entries = [
    entry(`logs/server/${TODAY}/events-00-1-001.jsonl`, TODAY, 10, new Date(2026, 9, 10, 0, 0)),
    entry(`logs/server/${TODAY}/events-09-1-002.jsonl`, TODAY, 10, new Date(2026, 9, 10, 9, 0)),
    entry(`logs/server/${TODAY}/events-14-1-003.jsonl`, TODAY, 10, new Date(2026, 9, 10, 14, 0)),
  ];
  const result = plan(entries, NOW, defaultRotationPolicy);
  assert.deepEqual(result.gzip, []);
  assert.deepEqual(result.delete, []);
  assert.deepEqual(result.keep, entries.map((e) => e.path).sort());
});

test("invariant (b): the currently-open file is never in gzip or delete", () => {
  const openPath = currentPath(defaultRotationPolicy, NOW, "server", 1, 3);
  const entries = [
    entry(`logs/server/${TODAY}/events-09-1-001.jsonl`, TODAY, 10, new Date(2026, 9, 10, 9, 0)),
    entry(openPath, TODAY, 10, new Date(2026, 9, 10, 14, 0)), // newest mtime: currently open
    entry("logs/server/2026-09-01/events-00-1-001.jsonl", "2026-09-01", 10, new Date(2026, 8, 1)),
  ];
  const result = plan(entries, NOW, defaultRotationPolicy);
  assert.ok(result.keep.includes(openPath));
  assert.ok(!result.gzip.includes(openPath));
  assert.ok(!result.delete.includes(openPath));
});

test("invariant (c): gzip and delete are disjoint across day-age boundaries", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 10, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-09/events-00-1-001.jsonl", "2026-10-09", 10, new Date(2026, 9, 9)), // age 1: keep
    entry("logs/server/2026-10-08/events-00-1-001.jsonl", "2026-10-08", 10, new Date(2026, 9, 8)), // age 2: gzip
    entry("logs/server/2026-09-27/events-00-1-001.jsonl", "2026-09-27", 10, new Date(2026, 8, 27)), // age 13: gzip
    entry("logs/server/2026-09-26/events-00-1-001.jsonl", "2026-09-26", 10, new Date(2026, 8, 26)), // age 14: delete
    entry("logs/server/2026-09-01/events-00-1-001.jsonl", "2026-09-01", 10, new Date(2026, 8, 1)), // age 39: delete
  ];
  const result = plan(entries, NOW, defaultRotationPolicy);
  const intersection = result.gzip.filter((p) => result.delete.includes(p));
  assert.deepEqual(intersection, []);
  assert.deepEqual(result.gzip, [
    "logs/server/2026-09-27/events-00-1-001.jsonl",
    "logs/server/2026-10-08/events-00-1-001.jsonl",
  ]);
  assert.deepEqual(result.delete, [
    "logs/server/2026-09-01/events-00-1-001.jsonl",
    "logs/server/2026-09-26/events-00-1-001.jsonl",
  ]);
  assert.deepEqual(result.keep, [
    "logs/server/2026-10-09/events-00-1-001.jsonl",
    "logs/server/2026-10-10/events-14-1-001.jsonl",
  ]);
});

test("invariant (d): gzip ∪ delete ∪ keep is exactly the input set, no overlaps or omissions", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 10, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-09/events-00-1-001.jsonl", "2026-10-09", 10, new Date(2026, 9, 9)),
    entry("logs/server/2026-09-26/events-00-1-001.jsonl", "2026-09-26", 10, new Date(2026, 8, 26)),
  ];
  const result = plan(entries, NOW, defaultRotationPolicy);
  const union = [...result.gzip, ...result.delete, ...result.keep].sort();
  assert.deepEqual(union, entries.map((e) => e.path).sort());
  assert.equal(new Set(union).size, union.length);
});

test("invariant (e): maxTotalBytes exceeded prunes oldest non-today directories first", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 50, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-09/events-00-1-001.jsonl", "2026-10-09", 100, new Date(2026, 9, 9)), // age 1: keep-pending
    entry("logs/server/2026-10-08/events-00-1-001.jsonl", "2026-10-08", 100, new Date(2026, 9, 8)), // age 2: gzip-pending
    entry("logs/server/2026-10-07/events-00-1-001.jsonl", "2026-10-07", 100, new Date(2026, 9, 7)), // age 3: gzip-pending
    entry("logs/server/2026-10-06/events-00-1-001.jsonl", "2026-10-06", 100, new Date(2026, 9, 6)), // age 4: gzip-pending
  ];
  const policy: RotationPolicy = { ...defaultRotationPolicy, maxTotalBytes: 200 };
  const result = plan(entries, NOW, policy);

  // oldest three (06, 07, 08) are pruned into delete; 09 (next-oldest) survives untouched.
  assert.deepEqual(result.delete, [
    "logs/server/2026-10-06/events-00-1-001.jsonl",
    "logs/server/2026-10-07/events-00-1-001.jsonl",
    "logs/server/2026-10-08/events-00-1-001.jsonl",
  ]);
  assert.deepEqual(result.gzip, []);
  assert.deepEqual(result.keep, [
    "logs/server/2026-10-09/events-00-1-001.jsonl",
    "logs/server/2026-10-10/events-14-1-001.jsonl",
  ]);
});

test("invariant (e): a cap large enough for everything keeps all non-today decisions untouched", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 50, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-08/events-00-1-001.jsonl", "2026-10-08", 100, new Date(2026, 9, 8)),
  ];
  const result = plan(entries, NOW, defaultRotationPolicy); // 2 GiB cap
  assert.deepEqual(result.gzip, ["logs/server/2026-10-08/events-00-1-001.jsonl"]);
  assert.deepEqual(result.delete, []);
});

test("invariant (e): a cap too small for any non-today bytes prunes down to only today remaining", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 50, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-09/events-00-1-001.jsonl", "2026-10-09", 100, new Date(2026, 9, 9)),
    entry("logs/server/2026-10-08/events-00-1-001.jsonl", "2026-10-08", 100, new Date(2026, 9, 8)),
  ];
  const policy: RotationPolicy = { ...defaultRotationPolicy, maxTotalBytes: 10 };
  const result = plan(entries, NOW, policy);
  assert.deepEqual(result.gzip, []);
  assert.deepEqual(result.delete, [
    "logs/server/2026-10-08/events-00-1-001.jsonl",
    "logs/server/2026-10-09/events-00-1-001.jsonl",
  ]);
  assert.deepEqual(result.keep, ["logs/server/2026-10-10/events-14-1-001.jsonl"]);
});

test("plan is idempotent: re-running on the post-plan file set yields empty gzip and delete", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 10, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-09/events-00-1-001.jsonl", "2026-10-09", 10, new Date(2026, 9, 9)), // keep
    entry("logs/server/2026-10-08/events-00-1-001.jsonl", "2026-10-08", 10, new Date(2026, 9, 8)), // gzip
    entry("logs/server/2026-09-26/events-00-1-001.jsonl", "2026-09-26", 10, new Date(2026, 8, 26)), // delete
  ];
  const first = plan(entries, NOW, defaultRotationPolicy);
  assert.notDeepEqual(first.gzip, []);
  assert.notDeepEqual(first.delete, []);

  // Post-plan file set per plan §4.2's on-disk layout: `delete` paths are gone, and each `gzip`
  // source persists in its dated directory as `<path>.gz` (smaller — it was compressed).
  const gzipped = new Set(first.gzip);
  const deleted = new Set(first.delete);
  const remaining = entries
    .filter((e) => !deleted.has(e.path))
    .map((e) => gzipped.has(e.path) ? entry(`${e.path}.gz`, e.dir, Math.ceil(e.bytes / 5), e.mtime) : e);

  const second = plan(remaining, NOW, defaultRotationPolicy);
  assert.deepEqual(second.gzip, []);
  assert.deepEqual(second.delete, []);
  assert.deepEqual(second.keep, remaining.map((e) => e.path).sort());
});

test("already-compressed .gz files are never re-gzipped but are still deleted past keepDays", () => {
  const entries = [
    entry("logs/server/2026-10-08/events-00-1-001.jsonl.gz", "2026-10-08", 4, new Date(2026, 9, 8)), // age 2: keep
    entry("logs/server/2026-09-26/events-00-1-001.jsonl.gz", "2026-09-26", 4, new Date(2026, 8, 26)), // age 14: delete
  ];
  const result = plan(entries, NOW, defaultRotationPolicy);
  assert.deepEqual(result.gzip, []);
  assert.deepEqual(result.delete, ["logs/server/2026-09-26/events-00-1-001.jsonl.gz"]);
  assert.deepEqual(result.keep, ["logs/server/2026-10-08/events-00-1-001.jsonl.gz"]);
});

test(".gz bytes still count toward maxTotalBytes when pruning under the cap", () => {
  const entries = [
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 50, new Date(2026, 9, 10, 14)),
    entry("logs/server/2026-10-09/events-00-1-001.jsonl", "2026-10-09", 100, new Date(2026, 9, 9)),
    entry("logs/server/2026-10-08/events-00-1-001.jsonl.gz", "2026-10-08", 100, new Date(2026, 9, 8)),
  ];
  const policy: RotationPolicy = { ...defaultRotationPolicy, maxTotalBytes: 150 };
  const result = plan(entries, NOW, policy);
  // total = 250 > 150: the oldest non-today dir (10-08, holding the .gz) is pruned first.
  assert.deepEqual(result.delete, ["logs/server/2026-10-08/events-00-1-001.jsonl.gz"]);
  assert.deepEqual(result.gzip, []);
  assert.deepEqual(result.keep, [
    "logs/server/2026-10-09/events-00-1-001.jsonl",
    "logs/server/2026-10-10/events-14-1-001.jsonl",
  ]);
});

test("plan throws InvalidDateBucketError for a full-path dir instead of silently keeping", () => {
  const entries = [
    entry("logs/server/2026-09-01/old.jsonl", "logs/server/2026-09-01", 10, new Date(2026, 8, 1)),
  ];
  assert.throws(() => plan(entries, NOW, defaultRotationPolicy), InvalidDateBucketError);
});

test("plan throws InvalidDateBucketError for a non-date dir", () => {
  const entries = [entry("logs/server/latest/old.jsonl", "latest", 10, new Date(2026, 8, 1))];
  assert.throws(() => plan(entries, NOW, defaultRotationPolicy), InvalidDateBucketError);
});

test("plan throws InvalidDateBucketError for an impossible calendar date", () => {
  const entries = [
    entry("logs/server/2026-02-30/old.jsonl", "2026-02-30", 10, new Date(2026, 1, 28)),
  ];
  assert.throws(() => plan(entries, NOW, defaultRotationPolicy), InvalidDateBucketError);
});

test("cap pruning treats same-date directories across roles as one pruning unit", () => {
  const entries = [
    entry("logs/server/2026-10-08/events-00-1-001.jsonl", "2026-10-08", 100, new Date(2026, 9, 8)),
    entry("logs/reader/2026-10-08/events-00-2-001.jsonl", "2026-10-08", 100, new Date(2026, 9, 8)),
    entry("logs/server/2026-10-10/events-14-1-001.jsonl", TODAY, 50, new Date(2026, 9, 10, 14)),
  ];
  const policy: RotationPolicy = { ...defaultRotationPolicy, maxTotalBytes: 150 };
  const result = plan(entries, NOW, policy);
  // 250 bytes > 150, but removing either 100-byte dir alone would meet the cap — both prune
  // because they share one date-bucket pruning unit.
  assert.deepEqual(result.delete, [
    "logs/reader/2026-10-08/events-00-2-001.jsonl",
    "logs/server/2026-10-08/events-00-1-001.jsonl",
  ]);
  assert.deepEqual(result.keep, ["logs/server/2026-10-10/events-14-1-001.jsonl"]);
});
