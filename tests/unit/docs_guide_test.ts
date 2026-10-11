import { test } from "node:test";
import assert from "node:assert/strict";
import { OPTIONS } from "../../platform/config.ts";

const guide = await Deno.readTextFile(new URL("../../docs.md", import.meta.url));
const requiredHeadings = [
  "## Installation",
  "## Configuration",
  "## Core concepts",
  "## SDK walkthrough",
  "## Running the server",
  "## Backups and restore",
  "## Observability",
  "## Troubleshooting",
];

test("guide has the required H2 sections in order", () => {
  const headings = [...guide.matchAll(/^## .+$/gm)].map(([heading]) => heading);
  assert.deepEqual(headings, requiredHeadings);
});

Deno.test("every documented environment variable is in OPTIONS", () => {
  const optionNames = new Set<string>(OPTIONS.map((option) => option.envVar));
  // Non-config protocol/header names may be documented in uppercase without being options.
  const nonConfigNames = new Set<string>([]);
  const mentions = new Set(guide.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bPORT\b/g) ?? []);
  for (const mention of mentions) {
    assert(
      optionNames.has(mention) || nonConfigNames.has(mention),
      `documented env-style token ${mention} is not an OPTIONS envVar`,
    );
  }
});

Deno.test("documented defaults match OPTIONS defaultLabel exactly", () => {
  const optionByEnv = new Map<string, (typeof OPTIONS)[number]>(
    OPTIONS.map((option) => [option.envVar, option]),
  );
  const documented = [...guide.matchAll(/`([A-Z][A-Z0-9_]+)` \(default `([^`]+)`\)/g)];
  for (const [, envVar, value] of documented) {
    const option = optionByEnv.get(envVar);
    assert.ok(option, `default mentions unknown option ${envVar}`);
    assert.equal(value, option.defaultLabel, `wrong default documented for ${envVar}`);
  }
  assert(documented.length > 0, "guide should state defaults using the parity-checked format");
});

function namesFromPlan(plan: string): Set<string> {
  const section = plan.split("### 4.3 Named analysis queries (item 23)")[1]?.split("\n### ")[0] ?? "";
  return new Set([...section.matchAll(/`([a-z][a-z0-9-]+)`/g)].map(([, name]) => name));
}

async function catalogNames(): Promise<Set<string>> {
  const catalogUrl = new URL("../../platform/analysis/catalog.ts", import.meta.url);
  if (!(await Deno.stat(catalogUrl).then(() => true, () => false))) {
    // Item 23 is absent in this branch. Keep the guide checked against its plan catalog until it lands.
    const plan = await Deno.readTextFile(
      new URL("../../docs/plans/effect-port-and-observability.md", import.meta.url),
    );
    return namesFromPlan(plan);
  }
  try {
    const module = await import(catalogUrl.href) as Record<string, unknown>;
    const names = new Set<string>();
    const visit = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== "object" || depth > 5) return;
      for (const [key, nested] of Object.entries(value)) {
        if (/^[a-z][a-z0-9-]+$/.test(key)) names.add(key);
        visit(nested, depth + 1);
      }
    };
    visit(module);
    return names;
  } catch (error) {
    throw new Error(`could not read analysis catalog at ${catalogUrl}: ${error}`);
  }
}

Deno.test("backticked analysis names are catalog keys (or plan keys before item 23 lands)", async () => {
  const catalog = await catalogNames();
  const section =
    guide.split("Named analyses from the plan are one key per question:")[1]?.split("\n\n")[0] ?? "";
  const documented = new Set([...section.matchAll(/`([a-z][a-z0-9-]+)`/g)].map(([, name]) => name));
  assert.equal(documented.size, 10);
  for (const name of documented) assert(catalog.has(name), `analysis name ${name} is not a catalog key`);
});

Deno.test("every deno task named in the guide exists", async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile(new URL("../../deno.json", import.meta.url))) as {
    tasks: Record<string, string>;
  };
  for (const [, task] of guide.matchAll(/deno task ([A-Za-z0-9:_-]+)/g)) {
    assert(Object.hasOwn(denoConfig.tasks, task), `deno task ${task} does not exist`);
  }
});

Deno.test("guide links to README configuration and does not copy the options table", () => {
  assert(/\]\(README\.md#configuration\)/i.test(guide));
  assert(!/^\|.*Env var.*\|$/im.test(guide), "guide must not include a table with an Env var column");
});
