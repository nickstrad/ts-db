/**
 * Sweep PROP_SEED over the property suite and report failing test titles by seed.
 *
 * Usage: deno run -A work-scripts/deno/prop-seed-sweep.ts [--start N] [--count N] [--jobs N]
 * Each child runs the repository task `deno task test:prop` with one PROP_SEED.
 */

interface SeedResult {
  seed: number;
  exitCode: number;
  failures: Map<string, string[]>;
  output: string;
}

function option(name: string, fallback: number): number {
  const index = Deno.args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(Deno.args[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

const start = option("start", 1);
const count = option("count", 200);
const jobs = option("jobs", 3);
if (!Number.isSafeInteger(start + count - 1)) throw new Error("seed range is not safe");

async function runSeed(seed: number): Promise<SeedResult> {
  const command = new Deno.Command("deno", {
    args: ["task", "test:prop"],
    env: { PROP_SEED: String(seed) },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const output = `${new TextDecoder().decode(stdout)}${new TextDecoder().decode(stderr)}`;
  let file = "(suite startup)";
  const failures = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const fileMatch = line.match(/^running \d+ tests? from \.\/tests\/property\/([^ ]+)$/);
    if (fileMatch) file = `tests/property/${fileMatch[1]}`;
    const testMatch = line.match(/^(.*?) \[seed=-?\d+\] \.\.\. (FAILED|ok|ignored)(?: |$)/);
    if (testMatch && testMatch[2] === "FAILED") {
      const key = `${file} :: ${testMatch[1]}`;
      failures.set(key, [...(failures.get(key) ?? []), line]);
    }
  }
  if (code !== 0 && failures.size === 0) {
    failures.set(`${file} :: (process failed without a parsed test failure)`, [
      `exit ${code}; see captured output below`,
    ]);
  }
  return { seed, exitCode: code, failures, output };
}

const results: SeedResult[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (true) {
    const index = next++;
    if (index >= count) return;
    const seed = start + index;
    const result = await runSeed(seed);
    results[index] = result;
    if (result.exitCode !== 0) {
      console.log(`FAIL seed=${seed} (${result.failures.size} failure group(s))`);
      for (const [test, details] of result.failures) {
        console.log(`  ${test}\n    ${details.join("\n    ")}`);
      }
      console.log(`--- full output for seed ${seed} ---\n${result.output}\n--- end output ---`);
    } else if ((index + 1) % 10 === 0 || index + 1 === count) {
      console.log(`completed ${index + 1}/${count} seeds`);
    }
  }
}

console.log(`PROP_SEED sweep: ${start}..${start + count - 1}, ${jobs} concurrent workers`);
await Promise.all(Array.from({ length: Math.min(jobs, count) }, () => worker()));

const failingSeeds = new Map<string, number[]>();
for (const result of results) {
  for (const test of result.failures.keys()) {
    failingSeeds.set(test, [...(failingSeeds.get(test) ?? []), result.seed]);
  }
}
console.log("\nInvariant / test                                              Result");
console.log("------------------------------------------------------------  ------------------------------");
if (failingSeeds.size === 0) {
  console.log(`all property tests                                             clean across ${count} seeds`);
} else {
  for (const [test, seeds] of [...failingSeeds].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${test.padEnd(60)}  seeds ${seeds.join(", ")}`);
  }
}
console.log(`\nSummary: ${count} seeds; ${results.filter((r) => r.exitCode === 0).length} clean; ${results.filter((r) => r.exitCode !== 0).length} failed.`);
