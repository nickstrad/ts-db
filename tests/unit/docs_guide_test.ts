import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { OPTIONS } from "../../platform/config.ts";
import { CATALOG } from "../../platform/analysis/catalog.ts";

const guide = readFileSync(new URL("../../docs.md", import.meta.url), "utf8");
const options = new Map<string, string>(OPTIONS.map((option) => [option.envVar, option.defaultLabel]));
const config = JSON.parse(readFileSync(new URL("../../deno.json", import.meta.url), "utf8"));
const headings = [
  "Installation",
  "Configuration",
  "Core concepts",
  "SDK walkthrough",
  "Running the server",
  "Backups and restore",
  "Observability",
  "Troubleshooting",
];

// scripts/demo.ts uses BASE_URL for its client target; it is not a platform config option.
const nonConfigNames = new Set(["BASE_URL"]);

test("guide: every environment-shaped token is a declared option", () => {
  const names = guide.match(/\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|PORT)\b/g) ?? [];
  assert.ok(names.length > 0, "expected configuration references");
  for (const name of names) {
    assert.ok(options.has(name) || nonConfigNames.has(name), `Unknown config option: ${name}`);
  }
});

test("guide: stated defaults match OPTIONS exactly", () => {
  const defaults = [...guide.matchAll(/`([A-Z][A-Z0-9_]*)`\s+\(default\s+`([^`]+)`\)/g)];
  assert.ok(defaults.length > 0, "expected explicit default references");
  for (const [, name, value] of defaults) {
    assert.ok(options.has(name), `Unknown default option: ${name}`);
    assert.equal(value, options.get(name), `Default mismatch for ${name}`);
  }
});

test("guide: analysis query names belong to the landed catalog", () => {
  const observability = guide.split("## Observability\n")[1]?.split("## Troubleshooting\n")[0];
  assert.ok(observability, "expected observability section");
  // The one-line catalog entries identify query names independently of CATALOG, so a typo or
  // removed catalog key fails rather than disappearing from a regex built from known keys.
  const names = [...observability.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1]);
  for (const match of observability.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+|trace)`/g)) {
    names.push(match[1]);
  }
  for (const match of guide.matchAll(/deno task logs:query\s+([\w-]+)/g)) names.push(match[1]);
  for (const match of guide.matchAll(/\/admin\/logs\/analysis\/([\w-]+)/g)) names.push(match[1]);
  assert.ok(names.length > 0, "expected named analysis queries");
  for (const name of names) assert.ok(Object.hasOwn(CATALOG, name), `Unknown analysis query: ${name}`);
  assert.deepEqual(
    [...observability.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1]).sort(),
    Object.keys(CATALOG).sort(),
    "guide must describe every catalog query exactly once",
  );
});

test("guide: every deno task exists", () => {
  const tasks = [...guide.matchAll(/deno task ([\w:-]+)/g)];
  assert.ok(tasks.length > 0, "expected runnable tasks");
  for (const [, name] of tasks) {
    assert.ok(Object.hasOwn(config.tasks, name), `Unknown deno task: ${name}`);
  }
});

test("guide: config links to README without duplicating its options table", () => {
  assert.ok(guide.includes("README.md#configuration"));
  assert.doesNotMatch(guide, /^\s*\|.*\bEnv var\b.*\|\s*$/gim);
});

test("guide: the eight H2 headings are present in order, with no extras", () => {
  assert.deepEqual([...guide.matchAll(/^## (.+)$/gm)].map((match) => match[1]), headings);
});
