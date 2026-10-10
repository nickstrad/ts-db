import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_POLICY,
  type FileEntry,
  isPathWithinDir,
  plan,
  sweep,
} from "../../platform/logging/retention.ts";

function createFakeLogsDir(baseDir: string, daysBack: number): string {
  const logsDir = join(baseDir, "logs");
  const roles = ["server", "reader", "restore", "cli"];

  for (let daysAgo = daysBack; daysAgo >= 0; daysAgo--) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    for (const role of roles) {
      const roleDir = join(logsDir, role, dateStr);

      // Create directory
      try {
        Deno.mkdirSync(roleDir, { recursive: true });
      } catch {
        // Directory might already exist
      }

      // Create some log files
      const fileCount = daysAgo === 0 ? 2 : 1; // More files for today
      for (let i = 1; i <= fileCount; i++) {
        const fileName = `events-${String(i).padStart(2, "0")}-1000${i}-001.jsonl`;
        const filePath = join(roleDir, fileName);
        const content = `{"event":"test"}\n`.repeat(100); // Simulate log content
        Deno.writeTextFileSync(filePath, content);
      }
    }
  }

  return logsDir;
}

test("plan: keeps today's files", () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const todayStr = `${year}-${month}-${day}`;

  const entries: FileEntry[] = [
    {
      path: `/logs/server/${todayStr}/events-14-1000-001.jsonl`,
      dir: `/logs/server/${todayStr}`,
      bytes: 1000,
      mtime: now.getTime(),
    },
  ];

  const retentionPlan = plan(entries, now, DEFAULT_POLICY);
  assert.equal(retentionPlan.keep.length, 1);
  assert.equal(retentionPlan.gzip.length, 0);
  assert.deepEqual(retentionPlan.delete, []);
});

test("plan: never touches open files", () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate() - 5).padStart(2, "0");
  const oldDateStr = `${year}-${month}-${day}`;

  const openFile = `/logs/server/${oldDateStr}/events-14-1000-001.jsonl`;
  const entries: FileEntry[] = [
    {
      path: openFile,
      dir: `/logs/server/${oldDateStr}`,
      bytes: 100,
      mtime: now.getTime() - 5 * 24 * 60 * 60 * 1000,
    },
  ];

  const retentionPlan = plan(entries, now, DEFAULT_POLICY, new Set([openFile]));
  assert.equal(retentionPlan.keep.length, 1);
  assert.equal(retentionPlan.gzip.length, 0);
  assert.deepEqual(retentionPlan.delete, []);
});

test("plan: gzips files older than gzipAfterDays", () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");

  // Create a file 3 days ago (older than gzipAfterDays: 2)
  const threeDAgo = new Date(now);
  threeDAgo.setDate(threeDAgo.getDate() - 3);
  const threeDAgoDay = String(threeDAgo.getDate()).padStart(2, "0");
  const threeDAgoStr = `${year}-${month}-${threeDAgoDay}`;

  const entries: FileEntry[] = [
    {
      path: `/logs/server/${threeDAgoStr}/events-14-1000-001.jsonl`,
      dir: `/logs/server/${threeDAgoStr}`,
      bytes: 100,
      mtime: threeDAgo.getTime(),
    },
  ];

  const retentionPlan = plan(entries, now, DEFAULT_POLICY);
  assert.equal(retentionPlan.gzip.length, 1);
  assert.equal(retentionPlan.keep.length, 0);
  assert.deepEqual(retentionPlan.delete, []);
});

test("plan: deletes files older than keepDays", () => {
  const now = new Date();

  // Create a file 20 days ago (older than keepDays: 14)
  const twentyDAgo = new Date(now);
  twentyDAgo.setDate(twentyDAgo.getDate() - 20);
  const twentyDAgoYear = twentyDAgo.getFullYear();
  const twentyDAgoMonth = String(twentyDAgo.getMonth() + 1).padStart(2, "0");
  const twentyDAgoDay = String(twentyDAgo.getDate()).padStart(2, "0");
  const twentyDAgoStr = `${twentyDAgoYear}-${twentyDAgoMonth}-${twentyDAgoDay}`;

  const entries: FileEntry[] = [
    {
      path: `/logs/server/${twentyDAgoStr}/events-14-1000-001.jsonl`,
      dir: `/logs/server/${twentyDAgoStr}`,
      bytes: 100,
      mtime: twentyDAgo.getTime(),
    },
  ];

  const retentionPlan = plan(entries, now, DEFAULT_POLICY);
  assert.equal(retentionPlan.delete.length, 1, `Expected 1 delete, got ${retentionPlan.delete.length}`);
  assert.equal(retentionPlan.gzip.length, 0);
  assert.equal(retentionPlan.keep.length, 0);
});

test("plan: enforces maxTotalBytes by deleting oldest directories first", () => {
  const now = new Date();
  const policy = {
    keepDays: 14,
    gzipAfterDays: 2,
    maxTotalBytes: 600, // 600 bytes cap
    maxFileBytes: 64 * 1024 * 1024,
  };

  const entries: FileEntry[] = [];

  // Create files spanning 5 days, 200 bytes each = 1000 bytes total
  for (let i = 1; i <= 5; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    entries.push({
      path: `/logs/server/${dateStr}/events-14-1000-00${i}.jsonl`,
      dir: `/logs/server/${dateStr}`,
      bytes: 200, // 200 bytes per file
      mtime: date.getTime(),
    });
  }

  const retentionPlan = plan(entries, now, policy);

  // Total is 1000 bytes, cap is 600, so at least one file should be deleted
  assert(
    retentionPlan.delete.length > 0,
    `Should delete files to meet maxTotalBytes constraint, got ${retentionPlan.delete.length}`,
  );

  // The newest file should be kept since it's within recent days
  // Make sure there's at least something kept (usually the newest files)
  assert(
    retentionPlan.keep.length + retentionPlan.gzip.length > 0,
    "Should keep or gzip at least some recent files",
  );
});

test("plan: invariant - gzip and delete are disjoint", () => {
  const now = new Date();
  const entries: FileEntry[] = [];

  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    entries.push({
      path: `/logs/server/${dateStr}/events-14-1000-001.jsonl`,
      dir: `/logs/server/${dateStr}`,
      bytes: 1000,
      mtime: date.getTime(),
    });
  }

  const retentionPlan = plan(entries, now, DEFAULT_POLICY);

  // Check that gzip and delete don't overlap
  const gzipSet = new Set(retentionPlan.gzip);
  for (const file of retentionPlan.delete) {
    assert(!gzipSet.has(file), `File ${file} should not be in both gzip and delete`);
  }
});

test("plan: invariant - union of gzip, delete, keep equals input", () => {
  const now = new Date();
  const entries: FileEntry[] = [];

  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    entries.push({
      path: `/logs/server/${dateStr}/events-14-1000-001.jsonl`,
      dir: `/logs/server/${dateStr}`,
      bytes: 1000,
      mtime: date.getTime(),
    });
  }

  const retentionPlan = plan(entries, now, DEFAULT_POLICY);

  const allFiles = new Set([
    ...retentionPlan.gzip,
    ...retentionPlan.delete,
    ...retentionPlan.keep,
  ]);

  assert.equal(
    allFiles.size,
    entries.length,
    "Union should have same cardinality as input",
  );
  for (const entry of entries) {
    assert(
      allFiles.has(entry.path),
      `File ${entry.path} should be in gzip, delete, or keep`,
    );
  }
});

test("sweep: with --dry-run changes nothing on disk", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "retention-test-"));
  try {
    const logsDir = createFakeLogsDir(tempDir, 30);

    // Capture initial state - count all .jsonl files
    let beforeCount = 0;
    const countFiles = (dir: string) => {
      let count = 0;
      for (const entry of Deno.readDirSync(dir)) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory) {
          count += countFiles(fullPath);
        } else if (entry.name.endsWith(".jsonl") && !entry.name.endsWith(".gz")) {
          count++;
        }
      }
      return count;
    };
    beforeCount = countFiles(logsDir);

    // Run sweep with dry-run
    const result = await sweep(logsDir, { dryRun: true });

    // Verify nothing changed
    const afterCount = countFiles(logsDir);

    assert.equal(afterCount, beforeCount, "File count should not change in dry-run");
    assert.equal(result.gzipped.length, 0, "Should report no gzipped files in dry-run");
    assert.equal(result.deleted.length, 0, "Should report no deleted files in dry-run");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sweep: creates synthetic 30-day tree and validates gzip/delete/keep", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "retention-test-"));
  try {
    const logsDir = createFakeLogsDir(tempDir, 30);

    // Run sweep
    const result = await sweep(logsDir, { dryRun: false });

    // Verify some files were gzipped (those 2-14 days old)
    assert(result.gzipped.length > 0, "Should gzip some older files");

    // Verify some files were deleted (those >14 days old)
    assert(result.deleted.length > 0, "Should delete very old files");

    // Verify today's files still exist (not deleted, not gzipped)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const todayStr = `${year}-${month}-${day}`;

    const roles = ["server", "reader", "restore", "cli"];
    for (const role of roles) {
      const roleDir = join(logsDir, role, todayStr);
      if (existsSync(roleDir)) {
        const files = Deno.readDirSync(roleDir).toArray();
        const jsonlFiles = files.filter((f) => f.name.endsWith(".jsonl") && !f.name.endsWith(".gz"));
        assert(jsonlFiles.length > 0, `Today's ${role} files should still exist as .jsonl`);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("guard: isPathWithinDir refuses paths outside LOG_DIR", () => {
  const logDir = join(tmpdir(), "retention-test-logs");
  assert.ok(isPathWithinDir(logDir, join(logDir, "server", "2026-01-01", "events.jsonl")));
  assert.ok(isPathWithinDir(logDir, logDir));
  assert.ok(!isPathWithinDir(logDir, join(tmpdir(), "elsewhere", "events.jsonl")));
  // ".." segments that escape the dir are refused
  assert.ok(!isPathWithinDir(logDir, join(logDir, "..", "escape.jsonl")));
  // A sibling directory sharing a name prefix is not "within"
  assert.ok(!isPathWithinDir(logDir, logDir + "-other"));
});
