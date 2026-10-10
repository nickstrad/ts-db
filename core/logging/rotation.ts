/**
 * Pure rotation and retention policy for the JSONL event log (plan item 06).
 *
 * This module is PURE: no platform globals, no built-in runtime modules, no filesystem access. It
 * only computes paths and plans against a policy; the risky part — actually gzipping or deleting
 * files on disk — is deliberately left to the (not-yet-written) sweeper that executes a
 * `RetentionPlan`.
 *
 * On-disk layout (see docs/plans/effect-port-and-observability.md §4.2):
 *   logs/<role>/<YYYY-MM-DD>/events-<HH>-<pid>-<seq>.jsonl
 * `role` is one of the four known roles. `YYYY-MM-DD` and `HH` are the local calendar date and
 * hour at the moment the file was opened (local time, not UTC — logs should read in the operator's
 * wall clock). `seq` is zero-padded to 3 digits, matching the plan's worked example.
 * A gzipped file stays in its dated directory and gains a `.gz` suffix:
 *   logs/<role>/<YYYY-MM-DD>/events-<HH>-<pid>-<seq>.jsonl.gz
 */
import { Data } from "effect";

/** The four processes that write their own event log stream. */
export type LogRole = "server" | "reader" | "restore" | "cli";

const KNOWN_ROLES: ReadonlySet<LogRole> = new Set(["server", "reader", "restore", "cli"]);

/** `role` did not match one of the four known log roles. Roles are code-supplied, never caller input. */
export class InvalidLogRoleError extends Data.TaggedError("InvalidLogRoleError")<{
  readonly role: string;
}> {}

/** A `FileEntry.dir` was not a bare `YYYY-MM-DD` date bucket. Thrown by `plan` so a mis-shaped
 * inventory fails loudly instead of being silently kept forever. */
export class InvalidDateBucketError extends Data.TaggedError("InvalidDateBucketError")<{
  readonly dir: string;
}> {}

/** Rotation and retention thresholds. All byte and day values are inclusive lower bounds for the
 * state they name (e.g. a file exactly `maxFileBytes` old is already due to roll). */
export interface RotationPolicy {
  /** Dated directories older than this (in days, relative to `now`) are deleted outright. */
  readonly keepDays: number;
  /** Dated directories at least this old, but within `keepDays`, are gzipped. */
  readonly gzipAfterDays: number;
  /** Total bytes across all log files — including today's directory — before the oldest dated
   * directories are pruned back under the cap. */
  readonly maxTotalBytes: number;
  /** Bytes written to the open file before it rolls. */
  readonly maxFileBytes: number;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const defaultRotationPolicy: RotationPolicy = {
  keepDays: 14,
  gzipAfterDays: 2,
  maxTotalBytes: 2 * GIB,
  maxFileBytes: 64 * MIB,
};

/** State of the currently-open log file, as tracked by whatever last called `currentPath`. */
export interface RollState {
  /** The full dated directory the open file lives in: `logs/<role>/<YYYY-MM-DD>`. This is a path,
   * not the bare `YYYY-MM-DD` bucket — contrast `FileEntry.dir`, which is the bucket alone. */
  readonly dir: string;
  /** The `YYYY-MM-DD` the file was opened in. */
  readonly dateBucket: string;
  /** The zero-padded `HH` the file was opened in. */
  readonly hourBucket: string;
  /** The `now` the file was opened with. Carried for diagnostics; not consulted by `shouldRoll`. */
  readonly openedAt: Date;
}

/** Why `shouldRoll` returned other than `"no"`. Checked in this precedence order: a date or hour
 * change always wins over a size threshold, since rolling for date/hour already opens a fresh file
 * and makes the size check moot. */
export type RollReason = "no" | "size" | "date" | "hour";

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

function dateBucketOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

function hourBucketOf(d: Date): string {
  return pad(d.getHours(), 2);
}

/** The path the open log file should have right now, given `role`, `pid`, and a per-file `seq`. */
export function currentPath(
  policy: RotationPolicy,
  now: Date,
  role: string,
  pid: number,
  seq: number,
): string {
  if (!KNOWN_ROLES.has(role as LogRole)) {
    throw new InvalidLogRoleError({ role });
  }
  void policy; // reserved for future per-role path policy; unused today.
  const date = dateBucketOf(now);
  const hour = hourBucketOf(now);
  return `logs/${role}/${date}/events-${hour}-${pid}-${pad(seq, 3)}.jsonl`;
}

/** Whether the open file described by `state` should roll, and why. Date and hour changes take
 * precedence over the size threshold (see `RollReason`). */
export function shouldRoll(
  state: RollState,
  now: Date,
  bytesWritten: number,
  policy: RotationPolicy,
): RollReason {
  if (dateBucketOf(now) !== state.dateBucket) return "date";
  if (hourBucketOf(now) !== state.hourBucket) return "hour";
  if (bytesWritten >= policy.maxFileBytes) return "size";
  return "no";
}

/** One file on disk under `logs/<role>/<dir>/`. `dir` is the bare `YYYY-MM-DD` date bucket —
 * NOT the full `logs/<role>/<YYYY-MM-DD>` path (contrast `RollState.dir`). A malformed bucket
 * fails `plan` loudly via `InvalidDateBucketError` rather than being silently kept. */
export interface FileEntry {
  readonly path: string;
  readonly dir: string;
  readonly bytes: number;
  readonly mtime: Date;
}

/** The result of `plan`: which files to compress, which to remove, and which to leave untouched.
 * Every input path appears in exactly one of the three lists. Lists are sorted for determinism. */
export interface RetentionPlan {
  readonly gzip: readonly string[];
  readonly delete: readonly string[];
  readonly keep: readonly string[];
}

const DATE_BUCKET_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Parse a `YYYY-MM-DD` date bucket to a local-midnight `Date`. Rejects anything that is not a
 * real calendar date in bucket shape — including full `logs/<role>/<date>` paths — with
 * `InvalidDateBucketError`, so `plan` fails loudly instead of silently keeping the entry. */
function parseDateBucket(bucket: string): Date {
  if (!DATE_BUCKET_PATTERN.test(bucket)) {
    throw new InvalidDateBucketError({ dir: bucket });
  }
  const [y, m, d] = bucket.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (dateBucketOf(date) !== bucket) {
    // Pattern-shaped but not a real date, e.g. 2026-02-30 (`Date` overflows into March).
    throw new InvalidDateBucketError({ dir: bucket });
  }
  return date;
}

/** Whole days between dated directory `dir` and `today`, both `YYYY-MM-DD`. Computed via local
 * midnight Date objects (not a fixed millisecond divisor) so a DST transition day still counts as
 * exactly one day. */
function ageInDays(dir: string, today: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseDateBucket(today).getTime() - parseDateBucket(dir).getTime()) / msPerDay);
}

/**
 * Compute the retention plan for `entries` as of `now`.
 *
 * Today's dated directory is always kept in full — it holds the currently-open file, which is
 * never gzipped or deleted. Non-today directories are deleted once they are `keepDays` old or more,
 * gzipped once they are `gzipAfterDays` old or more (and not yet due for deletion), and otherwise
 * kept. A path already ending in `.gz` was compressed by an earlier sweep and is gzip-ineligible:
 * it falls through to `keep`, while its bytes still count toward `maxTotalBytes` and it remains
 * eligible for age-based `delete`. If the bytes still on disk (kept + gzip-pending) exceed
 * `maxTotalBytes`, whole non-today directories are moved to `delete` oldest-first — overriding any
 * gzip decision for that directory — until the total is back under the cap or only today's
 * directory remains.
 *
 * Idempotent: re-running `plan` with the same `now` against the post-plan file set — `delete`
 * paths gone, each `gzip` source replaced in place by `<path>.gz` per §4.2's on-disk layout —
 * yields an empty `gzip` and `delete`. See `tests/unit/rotation_test.ts`'s idempotency case.
 *
 * Throws `InvalidDateBucketError` if any entry's `dir` is not a bare `YYYY-MM-DD` date bucket.
 */
export function plan(
  entries: readonly FileEntry[],
  now: Date,
  policy: RotationPolicy,
): RetentionPlan {
  const today = dateBucketOf(now);

  const byDir = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const list = byDir.get(entry.dir);
    if (list) list.push(entry);
    else byDir.set(entry.dir, [entry]);
  }
  // NOTE: the pruning unit is the bare date bucket, so same-date directories across roles
  // (e.g. server/2026-10-08 and reader/2026-10-08) prune as a single unit. Whole-directory
  // pruning inherently overshoots the cap; the wider unit is within spec ("oldest dated
  // directories pruned first") but worth knowing when sizing `maxTotalBytes`.

  const gzipSet = new Set<string>();
  const deleteSet = new Set<string>();
  const keepSet = new Set<string>();

  /** Bytes still on disk per non-today directory (keep- or gzip-pending), oldest-first. */
  const onDiskNonToday: Array<{ dir: string; bytes: number }> = [];
  let total = 0;

  for (const [dir, list] of byDir) {
    const bytes = list.reduce((sum, e) => sum + e.bytes, 0);
    if (dir === today) {
      for (const entry of list) keepSet.add(entry.path);
      total += bytes;
      continue;
    }

    const age = ageInDays(dir, today);
    if (age >= policy.keepDays) {
      for (const entry of list) deleteSet.add(entry.path);
      continue;
    }

    if (age >= policy.gzipAfterDays) {
      for (const entry of list) {
        // §4.2: already compressed by an earlier sweep — gzip-ineligible, falls through to keep.
        if (entry.path.endsWith(".gz")) keepSet.add(entry.path);
        else gzipSet.add(entry.path);
      }
    } else {
      for (const entry of list) keepSet.add(entry.path);
    }
    onDiskNonToday.push({ dir, bytes });
    total += bytes;
  }

  onDiskNonToday.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  for (const { dir, bytes } of onDiskNonToday) {
    if (total <= policy.maxTotalBytes) break;
    for (const entry of byDir.get(dir)!) {
      gzipSet.delete(entry.path);
      keepSet.delete(entry.path);
      deleteSet.add(entry.path);
    }
    total -= bytes;
  }

  return {
    gzip: [...gzipSet].sort(),
    delete: [...deleteSet].sort(),
    keep: [...keepSet].sort(),
  };
}
