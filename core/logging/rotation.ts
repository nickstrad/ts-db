// TEMPORARY SCAFFOLD for property-test experiment (item 12) — to be replaced by the real item 06 implementation. Do not build on this.

export type Role = "server" | "reader" | "restore" | "cli";

export interface FileEntry {
  path: string;
  dir: string;
  bytes: number;
  mtime: number;
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

export interface RetentionPlan {
  gzip: string[];
  delete: string[];
  keep: string[];
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function currentPath(
  policy: RetentionPolicy,
  now: Date,
  role: Role,
  pid: number,
  seq: number,
): string {
  const date = formatDate(now);
  const hour = String(now.getHours()).padStart(2, "0");
  return `logs/${role}/${date}/events-${hour}-${pid}-${seq}.jsonl`;
}

export function shouldRoll(
  state: { bytesWritten: number; lastRollDate: Date },
  now: Date,
  bytesWritten: number,
  policy: RetentionPolicy,
): "no" | "size" | "date" | "hour" {
  // Check hour boundary
  if (state.lastRollDate.getHours() !== now.getHours()) {
    return "hour";
  }

  // Check date boundary
  if (state.lastRollDate.getDate() !== now.getDate()) {
    return "date";
  }

  // Check size
  if (bytesWritten > policy.maxFileBytes) {
    return "size";
  }

  return "no";
}

export function plan(
  entries: FileEntry[],
  now: Date,
  policy: RetentionPolicy,
): RetentionPlan {
  const result: RetentionPlan = {
    gzip: [],
    delete: [],
    keep: [],
  };

  const today = formatDate(now);
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - policy.keepDays);
  const cutoffStr = formatDate(cutoffDate);
  const gzipCutoffDate = new Date(now);
  gzipCutoffDate.setDate(gzipCutoffDate.getDate() - policy.gzipAfterDays);
  const gzipCutoffStr = formatDate(gzipCutoffDate);

  // Group files by directory (date)
  const filesByDir = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    if (!filesByDir.has(entry.dir)) filesByDir.set(entry.dir, []);
    filesByDir.get(entry.dir)!.push(entry);
  }

  // Sort directories by date
  const sortedDirs = Array.from(filesByDir.keys()).sort();

  for (const dir of sortedDirs) {
    const files = filesByDir.get(dir)!;

    // Invariant 1: today's directory is never gzipped or deleted
    if (dir === today) {
      for (const file of files) result.keep.push(file.path);
      continue;
    }

    // Files older than keepDays should be deleted
    if (dir < cutoffStr) {
      for (const file of files) result.delete.push(file.path);
      continue;
    }

    // Files between gzipCutoff and today should be gzipped
    if (dir < gzipCutoffStr && dir > cutoffStr) {
      for (const file of files) result.gzip.push(file.path);
      continue;
    }

    // Everything else is kept
    for (const file of files) result.keep.push(file.path);
  }

  // Invariant 5: when maxTotalBytes is exceeded, prune oldest dated directories
  let totalBytes = 0;
  for (const dir of sortedDirs) {
    for (const file of filesByDir.get(dir)!) {
      totalBytes += file.bytes;
    }
  }

  if (totalBytes > policy.maxTotalBytes) {
    for (let i = 0; i < sortedDirs.length; i++) {
      const dir = sortedDirs[i];

      // Never delete today's directory
      if (dir === today) continue;

      // Remove all files from this directory from keep/gzip and add to delete
      const dirSize = filesByDir.get(dir)!.reduce((sum, f) => sum + f.bytes, 0);

      for (const file of filesByDir.get(dir)!) {
        // Remove from keep or gzip
        const keepIdx = result.keep.indexOf(file.path);
        if (keepIdx >= 0) result.keep.splice(keepIdx, 1);
        const gzipIdx = result.gzip.indexOf(file.path);
        if (gzipIdx >= 0) result.gzip.splice(gzipIdx, 1);

        // Add to delete if not already there
        if (!result.delete.includes(file.path)) {
          result.delete.push(file.path);
        }
      }

      totalBytes -= dirSize;

      if (totalBytes <= policy.maxTotalBytes) break;
    }
  }

  // Invariant 3: gzip ∩ delete = ∅
  for (const path of result.delete) {
    const gzipIdx = result.gzip.indexOf(path);
    if (gzipIdx >= 0) result.gzip.splice(gzipIdx, 1);
  }

  // Invariant 4: gzip ∪ delete ∪ keep is exactly the input set
  const allPaths = new Set(entries.map((e) => e.path));
  const resultPaths = new Set([...result.gzip, ...result.delete, ...result.keep]);

  // Add any missing paths to keep
  for (const path of allPaths) {
    if (!resultPaths.has(path)) {
      result.keep.push(path);
    }
  }

  return result;
}
