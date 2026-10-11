/**
 * The retention sweeper (plan item 24): the half of retention that touches the disk.
 *
 * `core/logging/rotation.plan` (items 06, 12) already decides, purely and property-tested, which
 * files to gzip, delete and keep. This module only gathers the inventory that decision runs on and
 * then executes it. Deleting files is the risky half, so the shape here is: *inventory → plan →
 * safety rails → validate → apply*, with every step before "apply" side-effect free, and `dryRun`
 * stopping right after validation.
 *
 * ```text
 *   inventory(root) ─> rotation.plan ─> applySafetyRails ─> validatePlan ─> apply ─> lifecycle event
 *     (read only)        (pure)           (open file,          (containment,   (delete, gzip,
 *                                          rejected.jsonl)      shape, today)   rmdir)      dry-run stops ↑
 * ```
 *
 * ## Safety rails
 *
 * - **Containment.** Every planned path is `resolve`d and must sit strictly under the resolved
 *   `LOG_DIR`, and must have exactly the shape `<root>/<role>/<YYYY-MM-DD>/<file>` with a known
 *   role and an event-log file name. So `LOG_DIR/duckdb/events.duckdb`, `LOG_DIR/k6/…` and anything
 *   outside the root are refused even if a plan names them. A dated directory that is a symlink
 *   out of the tree is refused by a `realPath` check on each file's parent. One bad path refuses
 *   the *whole* plan before anything is touched, and emits an `error` lifecycle event.
 * - **Today's directory** (and anything dated later) is never in a plan; `validatePlan` re-checks
 *   that independently of `rotation.plan` as defence in depth. A future-dated directory (clock skew,
 *   a restored backup) is held out of `rotation.plan` entirely and reported as `futureDated`, so it
 *   can neither be touched nor make `validatePlan` refuse the rest of the sweep.
 * - **Resolved paths only.** `applyPlan` normalises every planned path with `resolve` and hands
 *   *only* that to the filesystem and to the lifecycle event. `resolve` is lexical, so a raw
 *   `LOG_DIR/server/link/../<date>/<file>` that was validated as `LOG_DIR/server/<date>/<file>`
 *   would otherwise be executed by the OS as "follow `link`, then go up" — somewhere else entirely.
 * - **The open file.** The caller passes the paths its sink holds open (`FileSink.openPath`); they
 *   are moved to `keep` whatever the plan said. This only matters across a date boundary — an open
 *   file is otherwise in today's directory — and only for this process's own sink. A sweep run from
 *   another process (the CLI) relies on the today rule alone.
 * - **Identity.** The inventory records each file's size and mtime. A file that changed between
 *   inventory and apply is skipped, not touched. (Item 36 builds the stronger "ingest committed
 *   past the whole tail" gate on top of this seam; nothing here knows about ingest.)
 * - **Gzip is atomic and verified.** `<file>.gz.<pid>.tmp` is written and fsynced, renamed to
 *   `<file>.gz`, decompressed and hashed against the source, and only then is the source removed. A
 *   crash at any point leaves the original intact, plus at worst a complete `.gz` that the next
 *   sweep verifies or a `.tmp` that is swept once it is an hour old.
 * - **Recheck before every destructive step.** Immediately before removing a file (a plain delete, or
 *   the source after its gzip is verified) its parent directory is `realPath`ed again and must still
 *   be inside the real `LOG_DIR`, and the file must still be the regular file, size and mtime the
 *   inventory saw. That closes the window a symlink swap or an append could use between `validatePlan`
 *   and the delete. (A check-then-unlink race can only be narrowed, not removed, without `openat`.)
 * - **Durability.** The directory is fsynced after the `.gz` rename and before its source is removed
 *   (so a crash cannot persist the removal without the rename), and every touched directory is
 *   fsynced once more when the sweep is done. A filesystem that cannot fsync a directory is skipped,
 *   not an error.
 * - Anything else in a dated directory (an operator's notes, a subdirectory, a symlink) is never
 *   inventoried or touched, and keeps its directory from being removed.
 *
 * Only `events-<HH>-<pid>-<seq>.jsonl[.gz]` and the ingest quarantine file `rejected.jsonl` are
 * inventoried. `rejected.jsonl` ages out with its directory but is never gzipped: ingest appends to
 * it, and compressing a file that something else appends to would lose lines.
 *
 * ## Ingest ordering (state of play, for item 36)
 *
 * `platform/eventlog/ingest.ts` matches only `*.jsonl` (`.jsonl.gz` is skipped), so a gzipped file
 * is never ingested. Nothing in this module checks that a file's tail was ingested before gzip; the
 * only protection is the age gap (`gzipAfterDays`, default 7 in config). Item 36 owns closing that.
 * So this item implements the plan's second option for gzip-vs-ingest: ingest *skips* `.gz`.
 *
 * `_ingest_state` pruning is handed off, not done. `ingest.ts` (its `readState` FOLLOW-UP) says item 24
 * owns deleting a row when its source file leaves the tree, but that table lives in the reader's
 * single-writer DuckDB file and this module is a file-only sweeper that also runs in the server and
 * the CLI. It reports exactly which sources it gzipped or deleted (`SweepReport`, the lifecycle
 * event) and item 36's ingest-then-sweep coordinator, which holds the DuckDB connection, is where
 * that list is turned into row deletions.
 *
 * ## Scheduling
 *
 * `startRetentionSweeper` is the `forkScoped` fiber: one sweep immediately, then one per day. It
 * never fails — a sweep's typed failures are already `error` events, and defects are caught and
 * reported the same way — so a bad day cannot stop tomorrow's sweep. Wiring it into the server's
 * root is item 22's file and not done here.
 *
 * A dry run that succeeds emits no event: the event sink writes a file, and a dry run must change
 * nothing on disk. The report carries the plan for the caller (the `logs:sweep` CLI, item 23) to
 * print. A dry run that *fails* (unsafe root, unreadable tree, a plan that fails a rail) still emits
 * its `error` lifecycle event: a refusal is exactly what an operator needs on record, and that
 * event is the only thing a dry run ever writes.
 *
 * ## Events
 *
 * One `lifecycle` event per real sweep, phase `retention-sweep` (`warn` if anything was skipped).
 * A sweep that is interrupted mid-apply emits `retention-sweep-interrupted` instead, with what had
 * been done so far; a refused or failed one emits `retention-sweep-failed`. Every one of them
 * carries `gzippedCount`, `deletedCount` and `keptCount` next to its path lists: files gzipped,
 * files deleted, and inventoried files left exactly as they were.
 */
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { Cause, Clock, Data, Duration, Effect, Schedule, type Scope } from "effect";
import { lifecycleEvent, type Role } from "../../core/events.ts";
import {
  currentPath,
  type FileEntry,
  type LogRole,
  plan as rotationPlan,
  type RetentionPlan,
  type RotationPolicy,
} from "../../core/logging/rotation.ts";
import { Config, EventSink, type LoggingConfig } from "../services.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A planned path (or the root itself) failed a safety rail; **nothing was touched**. Like
 * `SinkIoError`, deliberately not in `core/errors.ts`: it is sweeper-internal and surfaces only as
 * an `error` lifecycle event and this typed failure.
 */
export class RetentionPathError extends Data.TaggedError("RetentionPathError")<{
  readonly reason:
    | "root-unsafe"
    | "not-absolute"
    | "outside-root"
    | "unexpected-shape"
    | "not-inventoried"
    | "today-or-future"
    | "symlink-escape";
  readonly path: string;
  readonly root: string;
}> {}

/** Reading the log tree failed before anything was changed. */
export class RetentionIoError extends Data.TaggedError("RetentionIoError")<{
  readonly operation: "inventory" | "realpath";
  readonly path: string;
  readonly cause: unknown;
}> {}

export type RetentionError = RetentionPathError | RetentionIoError;

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const ROLES: readonly LogRole[] = ["server", "reader", "restore", "cli"];
const EVENT_FILE = /^events-\d{2}-\d+-\d{3,}\.jsonl(\.gz)?$/;
const QUARANTINE_FILE = "rejected.jsonl";
/** A gzip in progress: `<file>.gz.<pid>.tmp`. Never matches an ingest source or a finished `.gz`. */
const PARTIAL_FILE = /^events-\d{2}-\d+-\d{3,}\.jsonl\.gz\.\d+\.tmp$/;
/** A `.tmp` older than this belongs to a sweep that died; a younger one may be in progress. */
const STALE_PARTIAL_MS = 60 * 60 * 1000;

function isDateBucket(name: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** One `<root>/<role>/<YYYY-MM-DD>` directory and every name in it, inventoried or not. */
export interface DatedDir {
  readonly path: string;
  readonly role: LogRole;
  readonly date: string;
  readonly names: readonly string[];
}

export interface Inventory {
  /** The resolved `LOG_DIR` everything below is under. */
  readonly root: string;
  /** What `rotation.plan` is fed: event files and quarantine files, `dir` = bare date bucket. */
  readonly entries: readonly FileEntry[];
  /** `.gz.<pid>.tmp` leftovers of a gzip that did not finish. Never fed to `rotation.plan`. */
  readonly partials: readonly FileEntry[];
  readonly dirs: readonly DatedDir[];
}

/** The date bucket `now` falls in, taken from `rotation.currentPath` so the two cannot disagree. */
function todayBucket(policy: RotationPolicy, now: Date): string {
  return currentPath(policy, now, "server", 0, 1).split("/")[2];
}

/** The resolved root, or `RetentionPathError` if it is empty or the filesystem root. */
function resolveRoot(logDir: string): Effect.Effect<string, RetentionPathError> {
  const root = resolve(logDir);
  if (logDir.trim() === "" || dirname(root) === root) {
    return Effect.fail(new RetentionPathError({ reason: "root-unsafe", path: logDir, root }));
  }
  return Effect.succeed(root);
}

/**
 * Walks `<root>/<role>/<YYYY-MM-DD>/` for the four roles. Read only. Symlinks are not followed
 * and not inventoried, a missing role directory is simply empty, and non-date directories are
 * ignored (which is what keeps `logs/k6` and `logs/duckdb` out of the plan).
 */
export function inventory(root: string): Effect.Effect<Inventory, RetentionIoError> {
  return Effect.tryPromise({
    try: async () => {
      const entries: FileEntry[] = [];
      const partials: FileEntry[] = [];
      const dirs: DatedDir[] = [];
      for (const role of ROLES) {
        const rolePath = resolve(root, role);
        const dated: string[] = [];
        try {
          for await (const entry of Deno.readDir(rolePath)) {
            if (entry.isDirectory && !entry.isSymlink && isDateBucket(entry.name)) dated.push(entry.name);
          }
        } catch (cause) {
          if (cause instanceof Deno.errors.NotFound) continue;
          throw cause;
        }
        for (const date of dated.sort()) {
          const dirPath = resolve(rolePath, date);
          const names: string[] = [];
          for await (const entry of Deno.readDir(dirPath)) {
            names.push(entry.name);
            if (!entry.isFile || entry.isSymlink) continue;
            const isEvent = EVENT_FILE.test(entry.name) || entry.name === QUARANTINE_FILE;
            if (!isEvent && !PARTIAL_FILE.test(entry.name)) continue;
            const path = resolve(dirPath, entry.name);
            const info = await Deno.lstat(path);
            if (!info.isFile) continue;
            const file: FileEntry = { path, dir: date, bytes: info.size, mtime: info.mtime ?? new Date(0) };
            (isEvent ? entries : partials).push(file);
          }
          dirs.push({ path: dirPath, role, date, names: names.sort() });
        }
      }
      return { root, entries, partials, dirs };
    },
    catch: (cause) => new RetentionIoError({ operation: "inventory", path: root, cause }),
  });
}

// ---------------------------------------------------------------------------
// Plan: rotation.plan, then the safety rails that need facts rotation cannot know
// ---------------------------------------------------------------------------

/**
 * Applies the rails that depend on things `rotation.plan` cannot see:
 * - a path some sink holds open is kept, whatever the plan said;
 * - `rejected.jsonl` is never gzipped (it ages out with its directory but ingest appends to it).
 *
 * Pure. `openPaths` are compared after `resolve`, so a relative or unnormalised path still matches.
 */
export function applySafetyRails(plan: RetentionPlan, openPaths: readonly string[]): RetentionPlan {
  const open = new Set(openPaths.map((p) => resolve(p)));
  const isQuarantine = (p: string) => p.endsWith(`${sep}${QUARANTINE_FILE}`);
  const gzip: string[] = [];
  const del: string[] = [];
  const keep = new Set(plan.keep);
  for (const path of plan.gzip) {
    if (open.has(resolve(path)) || isQuarantine(path)) keep.add(path);
    else gzip.push(path);
  }
  for (const path of plan.delete) {
    if (open.has(resolve(path))) keep.add(path);
    else del.push(path);
  }
  return { gzip, delete: del, keep: [...keep].sort() };
}

/** Dated directories that would hold nothing once `deleted` (absolute paths) are gone. */
export function emptiedDirs(
  dirs: readonly DatedDir[],
  deleted: ReadonlySet<string>,
  today: string,
): readonly string[] {
  return dirs
    .filter((d) => d.date < today && d.names.every((name) => deleted.has(resolve(d.path, name))))
    .map((d) => d.path)
    .sort();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Refuses the plan unless every path in `gzip` and `delete` is an inventoried file of the right
 * shape strictly inside `root`, outside today's (and later) directories, and not reached through a
 * symlinked directory. Fails with the first offender; the caller has changed nothing yet.
 */
export function validatePlan(
  root: string,
  plan: Pick<RetentionPlan, "gzip" | "delete">,
  known: ReadonlySet<string>,
  today: string,
): Effect.Effect<void, RetentionPathError | RetentionIoError> {
  const refuse = (reason: RetentionPathError["reason"], path: string) =>
    Effect.fail(new RetentionPathError({ reason, path, root }));
  return Effect.gen(function* () {
    const rootReal = yield* realPath(root);
    for (const path of [...plan.gzip, ...plan.delete]) {
      if (!path.startsWith(sep)) return yield* refuse("not-absolute", path);
      const abs = resolve(path);
      if (!abs.startsWith(root + sep)) return yield* refuse("outside-root", path);
      const [role, date, name, ...extra] = relative(root, abs).split(sep);
      const shaped = ROLES.includes(role as LogRole) && isDateBucket(date ?? "") && name !== undefined &&
        extra.length === 0 &&
        (EVENT_FILE.test(name) || name === QUARANTINE_FILE || PARTIAL_FILE.test(name));
      if (!shaped) return yield* refuse("unexpected-shape", path);
      if (date >= today) return yield* refuse("today-or-future", path);
      if (!known.has(abs)) return yield* refuse("not-inventoried", path);
      const parentReal = yield* realPath(dirname(abs));
      if (parentReal !== undefined && rootReal !== undefined && !parentReal.startsWith(rootReal + sep)) {
        return yield* refuse("symlink-escape", path);
      }
    }
  });
}

/** `realPath`, or `undefined` if the path is already gone (an absent file is handled at apply). */
function realPath(path: string): Effect.Effect<string | undefined, RetentionIoError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await Deno.realPath(path);
      } catch (cause) {
        if (cause instanceof Deno.errors.NotFound) return undefined;
        throw cause;
      }
    },
    catch: (cause) => new RetentionIoError({ operation: "realpath", path, cause }),
  });
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** A planned action that was not carried out, and why. Not an error: the sweep carries on. */
export interface SkippedAction {
  readonly path: string;
  readonly action: "gzip" | "delete" | "rmdir" | "fsync";
  readonly reason: string;
}

/** What a sweep did. All paths are relative to `LOG_DIR` and `/`-separated. */
export interface SweepReport {
  readonly dryRun: boolean;
  /** The plan after the safety rails; with `dryRun` this is everything that *would* happen. */
  readonly plan: RetentionPlan;
  /** Dated directories the plan would leave empty (and a real sweep removes). */
  readonly emptiedDirs: readonly string[];
  /** Dated directories newer than today: held out of the plan, never touched, and no obstacle. */
  readonly futureDated: readonly string[];
  /** What actually happened. All empty on a dry run. */
  readonly gzipped: readonly string[];
  readonly deleted: readonly string[];
  readonly removedDirs: readonly string[];
  readonly skipped: readonly SkippedAction[];
}

async function sha256Of(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function digestFile(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  return sha256Of(file.readable);
}

/** SHA-256 of what `path` decompresses to; rejects if it is not a complete gzip stream. */
async function digestGzip(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  return sha256Of(file.readable.pipeThrough(new DecompressionStream("gzip")));
}

async function compressTo(src: string, tmp: string, mtime: Date): Promise<void> {
  const input = await Deno.open(src, { read: true });
  const output = await Deno.open(tmp, { write: true, createNew: true });
  try {
    for await (const chunk of input.readable.pipeThrough(new CompressionStream("gzip"))) {
      let written = 0;
      while (written < chunk.byteLength) written += await output.write(chunk.subarray(written));
    }
    await output.syncData();
  } finally {
    output.close();
  }
  // The `.gz` keeps the original's mtime so file age stays meaningful after compression.
  await Deno.utime(tmp, mtime, mtime);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

/** Why `path` is no longer the file the inventory saw, or `undefined` if it still is. */
async function changedSince(path: string, entry: FileEntry): Promise<string | undefined> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return "missing";
    throw cause;
  }
  if (!info.isFile) return "not a regular file";
  if (info.size !== entry.bytes || info.mtime?.getTime() !== entry.mtime.getTime()) {
    return "changed since inventory";
  }
  return undefined;
}

/** What the destructive steps recheck against, taken once after the plan validated. */
interface Guard {
  readonly root: string;
  /** `realPath(root)`, or `undefined` if the root has vanished. */
  readonly rootReal: string | undefined;
}

/**
 * Why `path` may no longer be removed, or `undefined` if it still may: it is not a resolved path,
 * its parent directory no longer resolves to where the inventory put it (a symlink was swapped in),
 * or it is no longer the file the inventory saw. Called immediately before each removal.
 */
async function recheck(guard: Guard, path: string, entry: FileEntry): Promise<string | undefined> {
  if (resolve(path) !== path) return "path is not resolved";
  if (guard.rootReal === undefined) return "log root is gone";
  let parentReal: string;
  try {
    parentReal = await Deno.realPath(dirname(path));
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return "missing";
    throw cause;
  }
  if (parentReal !== resolve(guard.rootReal, relative(guard.root, dirname(path)))) {
    return "parent directory is not where the inventory found it";
  }
  return changedSince(path, entry);
}

/** `fsync` returns these when a filesystem (or platform) cannot sync a directory at all. */
const DIR_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM"]);

/**
 * fsyncs directory `path` so renames and unlinks inside it are durable. A filesystem or platform
 * that cannot sync a directory (or a directory that is already gone) is not a problem: `undefined`.
 * Anything else is an I/O note for the caller to report. Exported for the unit tests.
 */
export async function syncDir(path: string): Promise<string | undefined> {
  const unsupported = (cause: unknown) => {
    const code = (cause as { code?: unknown } | null)?.code;
    return cause instanceof Deno.errors.PermissionDenied ||
      (typeof code === "string" && DIR_SYNC_UNSUPPORTED.has(code));
  };
  const note = (cause: unknown) =>
    unsupported(cause) ? undefined : `io error: ${cause instanceof Error ? cause.message : String(cause)}`;
  let dir: Deno.FsFile;
  try {
    dir = await Deno.open(path, { read: true });
  } catch (cause) {
    return cause instanceof Deno.errors.NotFound ? undefined : note(cause);
  }
  try {
    await dir.sync();
    return undefined;
  } catch (cause) {
    return note(cause);
  } finally {
    dir.close();
  }
}

/** Returns a skip reason, or `undefined` once `path` is gone. Never throws. */
async function deleteOne(path: string, entry: FileEntry, guard: Guard): Promise<string | undefined> {
  try {
    const refused = await recheck(guard, path, entry);
    if (refused !== undefined) return refused;
    await Deno.remove(path);
    return undefined;
  } catch (cause) {
    return `io error: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

/**
 * The last step of a gzip: removes the source once its `.gz` is verified. The directory is synced
 * first so the rename cannot be lost while the removal survives, and the path is rechecked
 * immediately before the unlink, since the gzip and its verification took real time.
 */
async function removeVerifiedSource(
  guard: Guard,
  path: string,
  entry: FileEntry,
): Promise<string | undefined> {
  const note = await syncDir(dirname(path));
  if (note !== undefined) return `gzip not durable: ${note}`;
  const refused = await recheck(guard, path, entry);
  if (refused !== undefined) return refused;
  await Deno.remove(path);
  return undefined;
}

/** Returns a skip reason, or `undefined` once `<path>.gz` exists, verified, and `path` is gone. */
async function gzipOne(path: string, entry: FileEntry, guard: Guard): Promise<string | undefined> {
  const dst = `${path}.gz`;
  const tmp = `${dst}.${Deno.pid}.tmp`;
  try {
    const refused = await recheck(guard, path, entry);
    if (refused !== undefined) return refused;
    const expected = await digestFile(path);
    if (await exists(dst)) {
      // Left by an interrupted sweep (rename done, source not yet removed). Trust it only if it
      // decompresses to exactly the source; otherwise leave both files for a human.
      const actual = await digestGzip(dst).catch(() => undefined);
      if (actual !== expected) return "a different .gz already exists";
      return await removeVerifiedSource(guard, path, entry);
    }
    try {
      await compressTo(path, tmp, entry.mtime);
      await Deno.rename(tmp, dst);
    } catch (cause) {
      await Deno.remove(tmp).catch(() => {});
      throw cause;
    }
    if (await digestGzip(dst) !== expected) {
      await Deno.remove(dst);
      return "gzip verification failed";
    }
    return await removeVerifiedSource(guard, path, entry);
  } catch (cause) {
    return `io error: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

async function removeEmptyDir(path: string): Promise<string | undefined> {
  try {
    // Non-recursive on purpose: a directory that gained a file since the inventory is left alone.
    await Deno.remove(path);
    return undefined;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    return `io error: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const PHASE = "retention-sweep";

function emitLifecycle(
  role: Role,
  level: "info" | "warn" | "error",
  phase: string,
  detail: unknown,
): Effect.Effect<void, never, EventSink> {
  return Effect.gen(function* () {
    const sink = yield* EventSink;
    const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* sink.emit(lifecycleEvent({
      eventId: crypto.randomUUID(),
      ts,
      level,
      role,
      pid: Deno.pid,
      traceId: `retention-${crypto.randomUUID()}`,
      phase,
      detail,
    }));
  });
}

/** What a sweep changed: `kept` is every inventoried file left exactly as it was found. */
interface Counts {
  readonly gzippedCount: number;
  readonly deletedCount: number;
  readonly keptCount: number;
}

/** Counts for a failure before anything was inventoried or touched. */
const NOTHING_DONE: Counts = { gzippedCount: 0, deletedCount: 0, keptCount: 0 };

function emitFailure(
  role: Role,
  root: string,
  error: RetentionError,
  counts: Counts = NOTHING_DONE,
): Effect.Effect<void, never, EventSink> {
  const { _tag: errorTag, ...fields } = error;
  return emitLifecycle(role, "error", `${PHASE}-failed`, {
    errorTag,
    root,
    ...fields,
    ...counts,
    // `cause` is a non-enumerable property on tagged errors and a foreign object besides.
    cause: "cause" in error ? String(error.cause) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  /** The resolved `LOG_DIR`. */
  readonly root: string;
  readonly inventory: Inventory;
  /** What to do, as absolute paths. `gzip` and `delete` are validated in full before any change. */
  readonly plan: RetentionPlan;
  readonly today: string;
  readonly role: Role;
  readonly dryRun?: boolean;
}

/**
 * Validates `plan` against `root` and the inventory, then executes it: delete, then gzip (so a full
 * disk frees space first), then remove emptied dated directories, then fsync what was touched. A
 * path that fails a safety rail refuses the whole plan: an `error` lifecycle event is emitted and
 * `RetentionPathError` returned, with nothing changed. Per-file problems (a file that changed, an
 * I/O error) are skipped and reported, not fatal.
 *
 * Validation sees the caller's spelling of each path; execution sees only its `resolve`d form, so
 * what was validated is exactly what is touched and what the events name.
 *
 * Emits one `lifecycle` event naming exactly what was gzipped and deleted, with counts. None on a
 * successful `dryRun` (a failed one still emits its `error` event). If the fiber is interrupted
 * mid-apply, a `retention-sweep-interrupted` event records the state reached, including the one
 * file whose operation was in flight; that operation, being crash-safe, may still finish.
 */
export function applyPlan(
  options: ApplyOptions,
): Effect.Effect<SweepReport, RetentionPathError | RetentionIoError, EventSink> {
  const { root, role, today, inventory: inv } = options;
  const rel = (path: string) => relative(root, path).split(sep).join("/");
  const byPath = new Map([...inv.entries, ...inv.partials].map((e) => [e.path, e]));
  const inventoried = byPath.size;

  return Effect.gen(function* () {
    yield* validatePlan(root, options.plan, new Set(byPath.keys()), today);
    // From here on only these resolved paths exist: `link/../<date>/<file>` passed validation as
    // `<date>/<file>`, and the OS must never be given the spelling it would resolve differently.
    const resolved = (paths: readonly string[]) => [...new Set(paths.map((p) => resolve(p)))].sort();
    const plan: RetentionPlan = {
      gzip: resolved(options.plan.gzip),
      delete: resolved(options.plan.delete),
      keep: resolved(options.plan.keep),
    };
    const emptied = emptiedDirs(inv.dirs, new Set(plan.delete), today);
    const futureDated = inv.dirs.filter((d) => d.date > today).map((d) => rel(d.path)).sort();
    const reportPlan: RetentionPlan = {
      gzip: plan.gzip.map(rel),
      delete: plan.delete.map(rel),
      keep: plan.keep.map(rel),
    };

    if (options.dryRun === true) {
      return {
        dryRun: true,
        plan: reportPlan,
        emptiedDirs: emptied.map(rel),
        futureDated,
        gzipped: [],
        deleted: [],
        removedDirs: [],
        skipped: [],
      } satisfies SweepReport;
    }

    const guard: Guard = { root, rootReal: yield* realPath(root) };
    const skipped: SkippedAction[] = [];
    const deleted: string[] = [];
    const gzipped: string[] = [];
    const removedDirs: string[] = [];
    let inFlight: string | undefined;
    const counts = (): Counts => ({
      gzippedCount: gzipped.length,
      deletedCount: deleted.length,
      keptCount: inventoried - gzipped.length - deleted.length,
    });
    const run = (
      action: "gzip" | "delete",
      paths: readonly string[],
      op: (path: string, entry: FileEntry, guard: Guard) => Promise<string | undefined>,
      done: string[],
    ) =>
      Effect.forEach(paths, (path) =>
        Effect.promise(() => {
          inFlight = rel(path);
          return op(path, byPath.get(path)!, guard);
        }).pipe(
          Effect.map((reason) => {
            inFlight = undefined;
            if (reason === undefined) done.push(rel(path));
            else skipped.push({ path: rel(path), action, reason });
          }),
        ), { discard: true });

    const apply = Effect.gen(function* () {
      yield* run("delete", plan.delete, deleteOne, deleted);
      yield* run("gzip", plan.gzip, gzipOne, gzipped);

      // Directories empty only because of what we actually deleted, plus any that were already empty.
      const goneNow = new Set(deleted.map((p) => resolve(root, p)));
      yield* Effect.forEach(
        emptiedDirs(inv.dirs, goneNow, today),
        (dir) =>
          Effect.promise(() => removeEmptyDir(dir)).pipe(
            Effect.map((reason) => {
              if (reason === undefined) removedDirs.push(rel(dir));
              else skipped.push({ path: rel(dir), action: "rmdir", reason });
            }),
          ),
        { discard: true },
      );

      // Per-file durability was handled in `gzipOne`; this makes the unlinks and rmdirs durable too.
      const touched = new Set(
        [...deleted, ...gzipped, ...removedDirs].map((p) => dirname(resolve(root, p))),
      );
      yield* Effect.forEach(
        [...touched].sort(),
        (dir) =>
          Effect.promise(() => syncDir(dir)).pipe(
            Effect.map((reason) => {
              if (reason !== undefined) skipped.push({ path: rel(dir), action: "fsync", reason });
            }),
          ),
        { discard: true },
      );
    }).pipe(
      Effect.onInterrupt(() =>
        emitLifecycle(role, "warn", `${PHASE}-interrupted`, {
          root,
          interrupted: true,
          inFlight,
          gzipped,
          deleted,
          removedDirs,
          skipped,
          futureDated,
          ...counts(),
        })
      ),
    );
    yield* apply;

    const report: SweepReport = {
      dryRun: false,
      plan: reportPlan,
      emptiedDirs: emptied.map(rel),
      futureDated,
      gzipped,
      deleted,
      removedDirs,
      skipped,
    };
    yield* emitLifecycle(role, skipped.length > 0 || futureDated.length > 0 ? "warn" : "info", PHASE, {
      root,
      gzipped,
      deleted,
      removedDirs,
      skipped,
      futureDated,
      ...counts(),
    });
    return report;
  }).pipe(
    // A refusal happens before the first change: everything inventoried was kept.
    Effect.tapError((error) =>
      emitFailure(role, root, error, { gzippedCount: 0, deletedCount: 0, keptCount: inventoried })
    ),
  );
}

export interface SweepOptions {
  /** `Config.logging.dir` (`LOG_DIR`). Resolved here; the root is refused if empty or `/`. */
  readonly logDir: string;
  readonly policy: RotationPolicy;
  /** The role stamped on the `lifecycle` event: `"server"` for the fiber, `"cli"` for `logs:sweep`. */
  readonly role: Role;
  /** Plan and validate, but change nothing. Emits no event unless the sweep fails. */
  readonly dryRun?: boolean;
  /** Paths this process's sink(s) hold open — `FileSink.openPath`. Kept whatever the plan says. */
  readonly openPaths?: Effect.Effect<readonly string[]>;
}

/**
 * One sweep, as of the current `Clock` time: inventory `LOG_DIR`, run `rotation.plan`, apply the
 * safety rails, validate, then (unless `dryRun`) apply. See the module doc for the rails.
 */
export function sweep(
  options: SweepOptions,
): Effect.Effect<SweepReport, RetentionError, EventSink> {
  return Effect.gen(function* () {
    const root = yield* resolveRoot(options.logDir).pipe(
      Effect.tapError((e) => emitFailure(options.role, e.root, e)),
    );
    const inv = yield* inventory(root).pipe(
      Effect.tapError((e) => emitFailure(options.role, root, e)),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const now = new Date(nowMs);
    const today = todayBucket(options.policy, now);

    const open = options.openPaths === undefined ? [] : yield* options.openPaths;
    // A directory dated after today (clock skew, a restored backup) is not retention's to judge:
    // `rotation.plan` would let the size cap delete it, `validatePlan` would then refuse the whole
    // plan, and one stray directory would stop every other file from ever being swept.
    const future = inv.entries.filter((e) => e.dir > today);
    const railed = applySafetyRails(
      rotationPlan(inv.entries.filter((e) => e.dir <= today), now, options.policy),
      open,
    );
    // A leftover `.tmp` from a gzip that died is garbage once it is old enough that nothing can
    // still be writing it — except in today's directory, which is never touched.
    const stale = inv.partials
      .filter((p) => p.dir < today && nowMs - p.mtime.getTime() >= STALE_PARTIAL_MS)
      .map((p) => p.path);
    const toDelete = [...railed.delete, ...stale].sort();

    return yield* applyPlan({
      root,
      inventory: inv,
      plan: {
        gzip: railed.gzip,
        delete: toDelete,
        keep: [...railed.keep, ...future.map((e) => e.path)].sort(),
      },
      today,
      role: options.role,
      dryRun: options.dryRun,
    });
  });
}

/** `RotationPolicy` from the `LOG_*` configuration. */
export function policyFromConfig(logging: LoggingConfig): RotationPolicy {
  return {
    keepDays: logging.retentionDays,
    gzipAfterDays: logging.gzipAfterDays,
    maxTotalBytes: logging.maxTotalBytes,
    maxFileBytes: logging.maxFileBytes,
  };
}

/** `sweep` over `Config.logging`. This is what the daily fiber and the `logs:sweep` CLI run. */
export function sweepConfigured(
  options: Pick<SweepOptions, "role" | "dryRun" | "openPaths">,
): Effect.Effect<SweepReport, RetentionError, Config | EventSink> {
  return Effect.flatMap(Config, (config) =>
    sweep({
      ...options,
      logDir: config.logging.dir,
      policy: policyFromConfig(config.logging),
    }));
}

export interface SweeperOptions extends Pick<SweepOptions, "role" | "openPaths"> {
  /** Time between sweeps, after the one at startup. Defaults to one day. */
  readonly every?: Duration.DurationInput;
}

/**
 * Sweeps once now, then every `every` (default one day), in a fiber tied to the caller's scope.
 * Never fails: a typed failure is already an `error` event, a defect is reported as one here, and
 * either way the next sweep still runs. Interruption (scope close) is not swallowed.
 */
export function startRetentionSweeper(
  options: SweeperOptions,
): Effect.Effect<void, never, Scope.Scope | Config | EventSink> {
  const once = sweepConfigured({ role: options.role, openPaths: options.openPaths }).pipe(
    Effect.asVoid,
    Effect.ignore,
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause) ? Effect.failCause(cause) : emitLifecycle(
        options.role,
        "error",
        `${PHASE}-failed`,
        { errorTag: "RetentionDefect", cause: Cause.pretty(cause) },
      )
    ),
  );
  return Effect.asVoid(Effect.forkScoped(
    Effect.repeat(once, Schedule.spaced(options.every ?? Duration.days(1))),
  ));
}
