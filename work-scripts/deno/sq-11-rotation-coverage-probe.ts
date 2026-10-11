// sq-11 probe: how often does rotation_test.ts's generator produce each coverage condition, per 300-sample set?
//
// scenarioArb and its helpers are a VERBATIM copy of tests/property/rotation_test.ts (the test does not export
// them). Fidelity: the copy's "cap equality after pruning" verdict at each seed must match the real test's
// verdict (seed 24 FAILS, every other seed in 1..200 passes; from `sq-11-property-seed-sweep.sh`).
//
// Usage (repo root):
//   deno run --allow-read --allow-env work-scripts/deno/sq-11-rotation-coverage-probe.ts
//   PROP_SEEDS=1-200 deno run --allow-read --allow-env work-scripts/deno/sq-11-rotation-coverage-probe.ts

import fc from "fast-check";
import { currentPath, type FileEntry, plan, type RotationPolicy } from "../../core/logging/rotation.ts";

const NUM_RUNS = 300;
const seedsSpec = (Deno.env.get("PROP_SEEDS") ?? "1-200").split("-").map(Number);
const seeds = Array.from({ length: seedsSpec[1] - seedsSpec[0] + 1 }, (_, i) => seedsSpec[0] + i);

// --- verbatim from tests/property/rotation_test.ts ---------------------------------------------------------
const ROLES = ["server", "reader", "restore", "cli"] as const;
const pad = (n: number): string => String(n).padStart(2, "0");
const bucket = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowArb = fc.date({ min: new Date(2020, 0, 1), max: new Date(2035, 0, 1), noInvalidDate: true });
const policyArb: fc.Arbitrary<RotationPolicy> = fc.record({
  keepDays: fc.integer({ min: 0, max: 30 }),
  gzipAfterDays: fc.integer({ min: 0, max: 30 }),
  maxTotalBytes: fc.integer({ min: 0, max: 1500 }),
  maxFileBytes: fc.integer({ min: 1, max: 1000 }),
});
type Aged = { entry: FileEntry; age: number; open: boolean };
type Scenario = { now: Date; policy: RotationPolicy; files: Aged[]; entries: FileEntry[]; profile: string };
function entryArb(
  now: Date,
  policy: RotationPolicy,
  age: fc.Arbitrary<number>,
  maxBytes: number,
): fc.Arbitrary<Aged> {
  return fc.record({
    age,
    hour: fc.integer({ min: 0, max: 23 }),
    role: fc.constantFrom(...ROLES),
    pid: fc.integer({ min: 1, max: 99999 }),
    seq: fc.integer({ min: 0, max: 9 }),
    gz: fc.boolean(),
    bytes: fc.integer({ min: 0, max: maxBytes }),
    mtime: fc.date({ noInvalidDate: true }),
  }).map(({ age, hour, role, pid, seq, gz, bytes, mtime }) => {
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate() - age, hour);
    const dir = bucket(when);
    const base = currentPath(policy, when, role, pid, seq);
    if (!base.includes(`/${dir}/`)) throw new Error(`generator bucket ${dir} disagrees with path ${base}`);
    return { entry: { path: gz ? `${base}.gz` : base, dir, bytes, mtime }, age, open: false };
  });
}
const ageArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 35 }) },
  { weight: 1, arbitrary: fc.integer({ min: -2, max: -1 }) },
);
const profileArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant("wide" as const) },
  { weight: 2, arbitrary: fc.constant("tight" as const) },
  { weight: 1, arbitrary: fc.constant("exact" as const) },
);
const scenarioArb = fc.tuple(nowArb, policyArb, profileArb).chain(([now, base, profile]) => {
  const maxBytes = profile === "tight" ? 4 : 600;
  const policy = profile === "tight" ? { ...base, maxTotalBytes: base.maxTotalBytes % 21 } : base;
  return fc.tuple(
    entryArb(now, policy, fc.constant(0), maxBytes),
    fc.array(entryArb(now, policy, ageArb, maxBytes), { maxLength: 14 }),
  ).map(([open, rest]) => {
    const seen = new Set<string>([open.entry.path]);
    const files: Aged[] = [{ ...open, open: true }];
    for (const f of rest) {
      if (!seen.has(f.entry.path)) {
        seen.add(f.entry.path);
        files.push(f);
      }
    }
    const onDisk = files.filter((f) => f.age === 0 || f.age < policy.keepDays);
    const final: RotationPolicy = profile === "exact"
      ? { ...policy, maxTotalBytes: onDisk.reduce((n, f) => n + f.entry.bytes, 0) }
      : policy;
    // `profile` is added to the copy's return value only (no effect on generated values); used for reporting.
    return { now, policy: final, files, entries: files.map((f) => f.entry), profile };
  });
});
// --- end verbatim -------------------------------------------------------------------------------------------

/** The test's coverage predicates, one per assertion in the generator test, plus the cap-driven-delete count. */
function conditions(runs: Array<{ s: Scenario; p: ReturnType<typeof plan> }>) {
  const capPruned = (s: Scenario, p: ReturnType<typeof plan>) =>
    s.files.some((f: Aged) => f.age > 0 && f.age < s.policy.keepDays && p.delete.includes(f.entry.path));
  return {
    gzipPlanned: runs.some(({ p }) => p.gzip.length > 0),
    deletePlanned: runs.some(({ p }) => p.delete.length > 0),
    capPruned: runs.some(({ s, p }) => capPruned(s, p)),
    // A cap-driven delete happened AND the bytes left after pruning equal the cap exactly.
    capEquality: runs.some(({ s, p }) => {
      const left = s.entries.filter((e: FileEntry) => !p.delete.includes(e.path)).reduce(
        (n: number, e: FileEntry) => n + e.bytes,
        0,
      );
      return capPruned(s, p) && left === s.policy.maxTotalBytes;
    }),
    // The plan's starting total equals the cap, with a non-today directory available to (wrongly) prune.
    initialEqualsCap: runs.some(({ s }) => {
      const onDisk = s.files.filter((f: Aged) => f.age === 0 || f.age < s.policy.keepDays);
      const total = onDisk.reduce((n: number, f: Aged) => n + f.entry.bytes, 0);
      return total === s.policy.maxTotalBytes && onDisk.some((f: Aged) => f.age !== 0);
    }),
  };
}

const names = ["gzipPlanned", "deletePlanned", "capPruned", "capEquality", "initialEqualsCap"] as const;
const hits: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
const profileOfEquality = new Map<string, number>();
const capEqualityPerRun: number[] = [];
let totalRuns = 0;
for (const seed of seeds) {
  const runs = fc.sample(scenarioArb, { numRuns: NUM_RUNS, seed }).map((s) => ({
    s,
    p: plan(s.entries, s.now, s.policy),
  }));
  totalRuns += runs.length;
  const c = conditions(runs);
  for (const n of names) if (c[n]) hits[n].push(seed);
  // Count equality-hitting runs per seed (how many of the 300 samples satisfy the equality condition).
  let eq = 0;
  for (const { s, p } of runs) {
    const capPrunedHere = s.files.some((f: Aged) =>
      f.age > 0 && f.age < s.policy.keepDays && p.delete.includes(f.entry.path)
    );
    const left = s.entries.filter((e: FileEntry) => !p.delete.includes(e.path)).reduce(
      (n: number, e: FileEntry) => n + e.bytes,
      0,
    );
    if (capPrunedHere && left === s.policy.maxTotalBytes) {
      eq++;
      profileOfEquality.set(s.profile, (profileOfEquality.get(s.profile) ?? 0) + 1);
    }
  }
  capEqualityPerRun.push(eq);
}

console.log(
  `seeds ${seeds[0]}..${
    seeds.at(-1)
  } (${seeds.length}), ${NUM_RUNS} samples/seed, ${totalRuns} samples total`,
);
for (const n of names) {
  const seedsOk = hits[n].length;
  console.log(`  ${n.padEnd(18)} generated in ${String(seedsOk).padStart(3)}/${seeds.length} seeds`);
}
const missEquality = seeds.filter((s) => !hits.capEquality.includes(s));
console.log(
  `  seeds where cap-equality is NOT generated (the test's failing assertion): ${
    missEquality.join(", ") || "none"
  }`,
);
const eqs = capEqualityPerRun;
const mean = eqs.reduce((a, b) => a + b, 0) / eqs.length;
const sorted = [...eqs].sort((a, b) => a - b);
console.log(
  `  cap-equality samples per 300-run set: mean ${mean.toFixed(2)}, min ${sorted[0]}, p5 ${
    sorted[Math.floor(sorted.length * 0.05)]
  }, median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted.at(-1)}`,
);
console.log(`  histogram of cap-equality samples per seed: ${
  JSON.stringify(Object.fromEntries(
    [...new Map(eqs.map((v) => [v, 0])).keys()].sort((a, b) => a - b).map((k) => [
      k,
      eqs.filter((x) => x === k).length,
    ]),
  ))
}`);
console.log(
  `  profile of equality samples (all seeds): ${JSON.stringify(Object.fromEntries(profileOfEquality))}`,
);
