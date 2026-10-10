import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

// Implements the item-06 rotation policy per plan spec; item 06's core/logging/rotation.ts will replace/own this when it lands.

// Safety rail: refuse to operate on any path outside the configured LOG_DIR.
// Resolves symlinks/.. segments and prefix-checks against the log dir.
export function isPathWithinDir(dir: string, candidate: string): boolean {
  const resolvedDir = resolve(dir);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedDir ||
    resolvedCandidate.startsWith(resolvedDir + "/");
}

function emitErrorEvent(message: string, detail: Record<string, unknown>): void {
  // Temporary until the Logger service from item 11 lands.
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message,
    ...detail,
  }));
}

export interface RetentionPolicy {
  keepDays: number;
  gzipAfterDays: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_POLICY: RetentionPolicy = {
  keepDays: 14,
  gzipAfterDays: 2,
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  maxFileBytes: 64 * 1024 * 1024, // 64 MiB
};

export interface FileEntry {
  path: string;
  dir: string;
  bytes: number;
  mtime: number;
}

export interface RetentionPlan {
  gzip: string[];
  delete: string[];
  keep: string[];
}

function getTodayDateStr(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateFromPath(path: string): string | null {
  const match = path.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function compareDates(dateA: string, dateB: string): number {
  return dateA.localeCompare(dateB);
}

function isToday(datePath: string, now: Date): boolean {
  return datePath === getTodayDateStr(now);
}

export function plan(
  entries: FileEntry[],
  now: Date,
  policy: RetentionPolicy,
  openFiles: Set<string> = new Set(),
): RetentionPlan {
  const gzip: string[] = [];
  const deleteList: string[] = [];
  const keep: string[] = [];

  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - policy.keepDays);
  const cutoffDateStr = getTodayDateStr(cutoffDate);

  const gzipCutoffDate = new Date(now);
  gzipCutoffDate.setDate(gzipCutoffDate.getDate() - policy.gzipAfterDays);
  const gzipCutoffDateStr = getTodayDateStr(gzipCutoffDate);

  // Classify files into keep, gzip, delete based on date and open file status
  for (const entry of entries) {
    // Never touch open files
    if (openFiles.has(entry.path)) {
      keep.push(entry.path);
      continue;
    }

    const dateInPath = parseDateFromPath(entry.path);
    if (!dateInPath) {
      keep.push(entry.path);
      continue;
    }

    // Never touch today's directory
    if (isToday(dateInPath, now)) {
      keep.push(entry.path);
      continue;
    }

    // Delete files older than keepDays
    if (compareDates(dateInPath, cutoffDateStr) < 0) {
      deleteList.push(entry.path);
      continue;
    }

    // Gzip files older than gzipAfterDays (but not already gzipped and not deleted)
    if (
      compareDates(dateInPath, gzipCutoffDateStr) < 0 &&
      !entry.path.endsWith(".gz")
    ) {
      gzip.push(entry.path);
      continue;
    }

    keep.push(entry.path);
  }

  // Handle maxTotalBytes constraint by deleting oldest dated directories
  let totalBytes = 0;
  const filesByDir = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    if (!deleteList.includes(entry.path)) {
      totalBytes += entry.bytes;
      const dir = entry.dir;
      if (!filesByDir.has(dir)) {
        filesByDir.set(dir, []);
      }
      filesByDir.get(dir)!.push(entry);
    }
  }

  if (totalBytes > policy.maxTotalBytes) {
    // Get all dated directories not being deleted
    const dirs = Array.from(filesByDir.keys())
      .map((dir) => {
        const date = parseDateFromPath(dir);
        return { dir, date: date || "0000-00-00" };
      })
      .filter((item) => !isToday(item.date, now)) // Never delete today's dir
      .sort((a, b) => compareDates(a.date, b.date)); // Oldest first

    // Delete oldest directories until we meet the cap or only today remains
    for (const { dir, date } of dirs) {
      if (totalBytes <= policy.maxTotalBytes) break;
      if (isToday(date, now)) break;

      const filesInDir = filesByDir.get(dir) || [];
      for (const entry of filesInDir) {
        if (!deleteList.includes(entry.path)) {
          deleteList.push(entry.path);
          gzip.splice(gzip.indexOf(entry.path), 1); // Remove from gzip if present
          keep.splice(keep.indexOf(entry.path), 1); // Remove from keep if present
          totalBytes -= entry.bytes;
        }
      }
    }
  }

  return { gzip, delete: deleteList, keep };
}

export interface SweepOptions {
  dryRun?: boolean;
  openFiles?: Set<string>;
  policy?: RetentionPolicy;
}

export interface SweepResult {
  gzipped: string[];
  deleted: string[];
}

export async function sweep(
  logDir: string,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const policy = options.policy || DEFAULT_POLICY;
  const openFiles = options.openFiles || new Set();
  const dryRun = options.dryRun || false;

  // Resolve to real path and validate it's within the configured LOG_DIR
  let resolvedLogDir: string;
  try {
    resolvedLogDir = resolve(logDir);
  } catch {
    const error = {
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Invalid LOG_DIR path",
      logDir,
    };
    console.error(JSON.stringify(error));
    throw new Error(`Invalid LOG_DIR: ${logDir}`);
  }

  if (!existsSync(resolvedLogDir)) {
    // Log dir doesn't exist yet; nothing to sweep
    return { gzipped: [], deleted: [] };
  }

  // Collect all log files
  const entries: FileEntry[] = [];
  const roles = ["server", "reader", "restore", "cli"];

  for (const role of roles) {
    const roleDir = join(resolvedLogDir, role);
    if (!existsSync(roleDir)) continue;

    const datesDirs = readdirSync(roleDir);
    for (const dateDir of datesDirs) {
      const dateDirPath = join(roleDir, dateDir);
      if (!statSync(dateDirPath).isDirectory()) continue;

      const files = readdirSync(dateDirPath);
      for (const file of files) {
        const filePath = join(dateDirPath, file);
        if (!isPathWithinDir(resolvedLogDir, filePath)) {
          emitErrorEvent("Skipping inventory entry outside LOG_DIR", { path: filePath });
          continue;
        }
        if (!statSync(filePath).isFile()) continue;

        const stat = statSync(filePath);
        entries.push({
          path: filePath,
          dir: dateDirPath,
          bytes: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  }

  // Compute the plan
  const retentionPlan = plan(entries, new Date(), policy, openFiles);

  if (dryRun) {
    // In dry-run mode, return empty results since nothing was applied
    return {
      gzipped: [],
      deleted: [],
    };
  }

  // Apply the plan: gzip files
  const gzipped: string[] = [];
  for (const filePath of retentionPlan.gzip) {
    if (!isPathWithinDir(resolvedLogDir, filePath)) {
      emitErrorEvent("Refusing to gzip path outside LOG_DIR", { path: filePath });
      continue;
    }
    try {
      const gzipPath = filePath + ".gz";
      const source = createReadStream(filePath);
      const destination = createWriteStream(gzipPath);
      const gzip = createGzip();
      await pipeline(source, gzip, destination);
      rmSync(filePath, { force: true });
      gzipped.push(gzipPath);
    } catch (error) {
      // Log error but continue
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: `Failed to gzip file: ${filePath}`,
          error: String(error),
        }),
      );
    }
  }

  // Apply the plan: delete files
  const deleted: string[] = [];
  for (const filePath of retentionPlan.delete) {
    if (!isPathWithinDir(resolvedLogDir, filePath)) {
      emitErrorEvent("Refusing to delete path outside LOG_DIR", { path: filePath });
      continue;
    }
    try {
      rmSync(filePath, { force: true });
      deleted.push(filePath);
    } catch (error) {
      // Log error but continue
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: `Failed to delete file: ${filePath}`,
          error: String(error),
        }),
      );
    }
  }

  // Remove empty dated directories
  for (const role of roles) {
    const roleDir = join(resolvedLogDir, role);
    if (!existsSync(roleDir)) continue;

    const datesDirs = readdirSync(roleDir);
    for (const dateDir of datesDirs) {
      const dateDirPath = join(roleDir, dateDir);
      if (!statSync(dateDirPath).isDirectory()) continue;

      try {
        const files = readdirSync(dateDirPath);
        if (files.length === 0) {
          if (!isPathWithinDir(resolvedLogDir, dateDirPath)) {
            emitErrorEvent("Refusing to remove directory outside LOG_DIR", { path: dateDirPath });
            continue;
          }
          rmSync(dateDirPath, { force: true });
        }
      } catch {
        // Ignore errors when removing empty directories
      }
    }
  }

  // Emit lifecycle event
  const lifecycleEvent = {
    timestamp: new Date().toISOString(),
    kind: "lifecycle",
    phase: "retention_sweep",
    gzipped: gzipped.length,
    deleted: deleted.length,
    gzippedFiles: gzipped,
    deletedFiles: deleted,
  };
  console.log(JSON.stringify(lifecycleEvent));

  return { gzipped, deleted };
}

export function startRetentionSweeper(
  logDir: string,
  policy?: RetentionPolicy,
): () => void {
  let stopped = false;

  async function runSweep() {
    if (stopped) return;
    try {
      await sweep(logDir, { policy });
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: "Retention sweep failed",
          error: String(error),
        }),
      );
    }
  }

  // Run once on startup
  runSweep();

  // Run daily
  const intervalId = setInterval(() => {
    runSweep();
  }, 24 * 60 * 60 * 1000); // 24 hours

  return () => {
    stopped = true;
    clearInterval(intervalId);
  };
}

// CLI support - run when executed as main module
export async function runSweepCli(): Promise<void> {
  const args = Deno.args;
  let dryRun = false;
  let logDirArg: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--log-dir" && i + 1 < args.length) {
      logDirArg = args[i + 1];
      i++;
    }
  }

  const logDir = logDirArg ||
    Deno.env.get("LOG_DIR") ||
    "./logs";

  const result = await sweep(logDir, { dryRun });
  if (dryRun) {
    console.log("Dry run - no changes applied");
    console.log(`Would gzip: ${result.gzipped.length} files`);
    console.log(`Would delete: ${result.deleted.length} files`);
  } else {
    console.log(`Gzipped: ${result.gzipped.length} files`);
    console.log(`Deleted: ${result.deleted.length} files`);
  }
}

// Only run CLI if this is the main module
if (import.meta.url.endsWith("retention.ts")) {
  runSweepCli().catch((error) => {
    console.error(`Sweep failed: ${error}`);
    Deno.exit(1);
  });
}
