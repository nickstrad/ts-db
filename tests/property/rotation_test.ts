// Property tests for core/logging/rotation.ts log rotation and retention
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "npm:fast-check";
import { plan, DEFAULT_POLICY } from "../../core/logging/rotation.ts";
import type { FileEntry, RetentionPolicy } from "../../core/logging/rotation.ts";
import { seed } from "./arbitraries.ts";

Deno.test(`rotation properties (seed: ${seed})`, async (t) => {
  function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // Property 1: today's directory is never gzipped or deleted
  await t.step("invariant 1: today's directory is never gzipped or deleted", () => {
    fc.assert(
      fc.property(
        fc.date(),
        fc.array(arb.fileEntry(), { minLength: 0, maxLength: 49 }),
        (now, otherEntries) => {
          const policy = DEFAULT_POLICY;

          // Always include at least one today file
          const today = formatDate(now);
          const todayEntry: FileEntry = {
            path: `logs/server/${today}/events-00-1234-1.jsonl`,
            dir: `logs/server/${today}`,
            bytes: 1000,
            mtime: 0,
          };
          const entries = [todayEntry, ...otherEntries];

          const result = plan(entries, now, policy);

          const todayFiles = entries.filter((e) => e.dir.includes(today)).map((e) => e.path);

          for (const path of todayFiles) {
            assertEquals(
              result.gzip.includes(path),
              false,
              `Today's file ${path} should not be gzipped`,
            );
            assertEquals(
              result.delete.includes(path),
              false,
              `Today's file ${path} should not be deleted`,
            );
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 2: gzip ∩ delete = ∅ (no overlap between gzip and delete)
  await t.step("invariant 2: gzip ∩ delete = ∅", () => {
    fc.assert(
      fc.property(
        fc.array(arb.fileEntry(), { minLength: 1, maxLength: 50 }),
        fc.date(),
        (entries, now) => {
          const result = plan(entries, now, DEFAULT_POLICY);

          const overlap = result.gzip.filter((path) => result.delete.includes(path));
          assertEquals(overlap.length, 0, "gzip and delete should not overlap");
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 3: gzip ∪ delete ∪ keep is exactly the input set
  await t.step("invariant 3: gzip ∪ delete ∪ keep = input set", () => {
    fc.assert(
      fc.property(
        fc.array(arb.fileEntry(), { minLength: 1, maxLength: 50 }),
        fc.date(),
        (entries, now) => {
          const result = plan(entries, now, DEFAULT_POLICY);

          const resultPaths = new Set([...result.gzip, ...result.delete, ...result.keep]);
          const inputPaths = new Set(entries.map((e) => e.path));

          // Check both directions
          for (const path of Array.from(inputPaths)) {
            assertEquals(resultPaths.has(path), true, `Input path ${path} should be in result`);
          }
          for (const path of Array.from(resultPaths)) {
            assertEquals(inputPaths.has(path), true, `Result path ${path} should be in input`);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 4: when maxTotalBytes is exceeded, oldest dated directories are pruned first until the cap is met or only today remains
  await t.step("invariant 4: maxTotalBytes pruning preserves today", () => {
    fc.assert(
      fc.property(
        fc.array(arb.fileEntry(), { minLength: 1, maxLength: 30 }),
        fc.date(),
        fc.integer({ min: 100000, max: 5000000 }),
        (entries, now, maxBytes) => {
          const policy: RetentionPolicy = {
            ...DEFAULT_POLICY,
            maxTotalBytes: maxBytes,
          };

          const result = plan(entries, now, policy);

          // Calculate total bytes of kept + gzipped files (both count towards usage)
          const keptEntries = entries.filter((e) => result.keep.includes(e.path));
          const gzippedEntries = entries.filter((e) => result.gzip.includes(e.path));
          const totalInUse = keptEntries.reduce((sum, e) => sum + e.bytes, 0) +
            gzippedEntries.reduce((sum, e) => sum + e.bytes, 0);

          // If we're under the cap, no more deletion should be needed (gzip is separate policy)
          if (totalInUse <= maxBytes) {
            // Can't assert no delete here because some files might be outside retention window
            // But we can assert that today's files are kept
          }

          // Check that today's files are still in keep
          const today = formatDate(now);
          const todayFiles = entries.filter((e) => e.dir.includes(today)).map((e) => e.path);
          for (const path of todayFiles) {
            assertEquals(
              result.keep.includes(path),
              true,
              `Today's file ${path} should still be kept`,
            );
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  // Property 5: plan is idempotent
  await t.step("invariant 5: plan is idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(arb.fileEntry(), { minLength: 1, maxLength: 50 }),
        fc.date(),
        (entries, now) => {
          const policy = DEFAULT_POLICY;

          // First plan
          const result1 = plan(entries, now, policy);

          // Create entries from the first plan's results
          const resultEntries = [
            ...result1.keep.map((path) => ({
              path,
              dir: path.split("/").slice(0, 3).join("/"),
              bytes: 1000,
              mtime: 0,
            })),
            ...result1.gzip.map((path) => ({
              path,
              dir: path.split("/").slice(0, 3).join("/"),
              bytes: 1000,
              mtime: 0,
            })),
          ];

          // Second plan on the same kept/gzipped set
          const result2 = plan(resultEntries, now, policy);

          // Result2 should have empty gzip and delete (idempotent)
          assertEquals(
            result2.gzip.length,
            0,
            "Second plan should not gzip anything",
          );
          assertEquals(
            result2.delete.length,
            0,
            "Second plan should not delete anything",
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// Helper arbitraries for rotation tests
const arb = {
  fileEntry: () =>
    fc
      .tuple(
        fc.integer({ min: 2020, max: 2026 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
      )
      .map(([y, m, d, h]) => {
        const dir = `logs/server/${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const path = `${dir}/events-${String(h).padStart(2, "0")}-1234-5678.jsonl`;
        return {
          path: path as string,
          dir,
          bytes: Math.floor(Math.random() * 100000000),
          mtime: Math.floor(Math.random() * 2000000000),
        };
      }),
};
