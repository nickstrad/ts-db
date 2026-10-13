/**
 * Boundary tests (plan item 26): the architectural layering rules, asserted by scanning source
 * text so the boundaries cannot rot silently.
 *
 * Rules (from the item-26 spec):
 * - no file in `core/` imports `platform/`, `sdk/`, `node:*` or `npm:*`, or references `Deno.`;
 * - no `console.*` outside `platform/logging/` (documented degradation path) and `scripts/`;
 * - no `Deno.env` outside `platform/config.ts`;
 * - nothing under `platform/` mentions `node:sqlite` (FFI-04; it replaced "`platform/duckdb.ts` and
 *   `platform/reader.ts` never mention `node:sqlite`"), except the FFI binding's own prose, listed
 *   by exact path, which may contrast the binding with that driver but never import it;
 * - nothing under `tests/` mentions `node:sqlite`, except an explicit, exact-path allow-list (below);
 * - neither process's runtime module graph (`platform/server.ts`, `platform/reader.ts`) reaches
 *   `node:sqlite`;
 * - `platform/sqlite.ts` never mentions `@duckdb/node-api`;
 * - no `throw new Error` in `core/` or `platform/` (errors go through the tagged channel).
 *
 * Scoping notes, deliberate:
 * - The `console.*` and `Deno.env` rules cover the shipped library (`core/`, `platform/`, `sdk/`,
 *   `app/`). `tests/` is scaffolding (coverage reports, skip notices), `scripts/` are CLIs, and
 *   `work-scripts/`/`perf/` are operator tooling — all legitimately use `console` and env. The spec
 *   blesses `scripts/` for `console.*` explicitly; the same reasoning scopes the other
 *   non-shipped trees out, rather than failing on them.
 * - Comments are stripped before scanning, so prose about a boundary (e.g. "the pre-port
 *   `platform/compiler.ts`") is not flagged; string literals are kept, so import specifiers are.
 *   The `node:sqlite` rules are the exception: they read raw text, comments included, every file
 *   type, because one process must never open a file through two SQLite copies (FFI plan §1.2,
 *   `docs/knowledge/gotchas.md`), and a comment that names the old driver is either stale or
 *   explains an exemption that belongs on a list. An allow-list entry that no longer mentions the
 *   driver fails too, so the lists only change by a visible diff.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** All files under `dir` whose name passes `keep`, recursively, as repo-relative paths. */
async function filesUnder(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(join(ROOT, dir))) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory) out.push(...await filesUnder(rel, keep));
    else if (entry.isFile && keep(entry.name)) out.push(rel);
  }
  return out.sort();
}

/** All `.ts` files under `dir`, recursively, as repo-relative paths. */
function tsFiles(dir: string): Promise<string[]> {
  return filesUnder(dir, (name) => name.endsWith(".ts"));
}

const sources = new Map<string, string>();
async function load(rel: string): Promise<string> {
  let src = sources.get(rel);
  if (src === undefined) {
    src = await Deno.readTextFile(join(ROOT, rel));
    sources.set(rel, src);
  }
  return src;
}

/**
 * Remove `//` and `/* ... *\/` comments, keeping code and string literals (so import
 * specifiers stay visible to the import rules).
 */
function noComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      out += "\n";
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Static and dynamic import specifiers in comment-free code. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\s+(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) specs.push(m[1] ?? m[2]);
  return specs;
}

/** The first line matching `re`, trimmed, or undefined. */
function firstMatchLine(code: string, re: RegExp): string | undefined {
  for (const line of code.split("\n")) {
    if (re.test(line)) return line.trim().slice(0, 120);
  }
  return undefined;
}

async function violations(
  rels: string[],
  check: (rel: string, code: string) => string | undefined,
): Promise<string[]> {
  const found: string[] = [];
  for (const rel of rels) {
    const hit = check(rel, noComments(await load(rel)));
    if (hit !== undefined) found.push(`${rel}: ${hit}`);
  }
  return found;
}

/** The shipped library the `console.*`/`Deno.env` rules guard. */
const LIB = ["core", "platform", "sdk", "app"];

Deno.test("boundaries: core/ imports nothing from platform/, sdk/, node:* or npm:* and never references Deno.", async () => {
  const bad = await violations(await tsFiles("core"), (_rel, code) => {
    for (const spec of importSpecifiers(code)) {
      if (
        spec.includes("platform/") || spec.includes("sdk/") || spec.startsWith("node:") ||
        spec.startsWith("npm:")
      ) {
        return `forbidden import ${JSON.stringify(spec)}`;
      }
    }
    const line = firstMatchLine(code, /\bDeno\./);
    return line === undefined ? undefined : `Deno.* reference: ${line}`;
  });
  assert.deepEqual(bad, []);
});

Deno.test("boundaries: no console.* in the shipped library outside platform/logging/", async () => {
  const rels: string[] = [];
  for (const dir of LIB) rels.push(...await tsFiles(dir));
  const bad = await violations(
    rels.filter((rel) => !rel.startsWith("platform/logging/")),
    (_rel, code) => {
      const line = firstMatchLine(code, /\bconsole\.\w+/);
      return line === undefined ? undefined : `console usage: ${line}`;
    },
  );
  assert.deepEqual(bad, []);
});

Deno.test("boundaries: no Deno.env in the shipped library outside platform/config.ts", async () => {
  const rels: string[] = [];
  for (const dir of LIB) rels.push(...await tsFiles(dir));
  const bad = await violations(
    rels.filter((rel) => rel !== "platform/config.ts"),
    (_rel, code) => {
      const line = firstMatchLine(code, /\bDeno\.env\b/);
      return line === undefined ? undefined : `Deno.env usage: ${line}`;
    },
  );
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// One SQLite copy per process: node:sqlite (FFI-04)
// ---------------------------------------------------------------------------

const NODE_SQLITE = "node:sqlite";

/**
 * Files under `platform/` that may name `node:sqlite` in prose, never import it: the FFI binding's
 * own documentation, which explains the binding by contrast with that driver (its cost, its NUL
 * truncation, the two-copies rule). `platform/sqlite_ffi/` belongs to FFI-01/FFI-03, so FFI-04
 * exempts these by exact path instead of rewording them.
 */
const PLATFORM_PROSE_ONLY: readonly string[] = [
  "platform/sqlite_ffi/README.md",
  "platform/sqlite_ffi/database.ts",
  "platform/sqlite_ffi/effect.ts",
  "platform/sqlite_ffi/library.ts",
  "platform/sqlite_ffi/mod.ts",
];

/**
 * Files under `tests/` that may import `node:sqlite`. Each uses it only on databases nothing else
 * in the process opens: `:memory:` or its own temp files, never a file a server, `Storage` or the
 * document reader has open.
 * - The two oracle suites: a different SQLite build is a better oracle than the one under test.
 * - The binding's own suites: `node:sqlite` is their parity and behaviour oracle (coordinator
 *   ruling at FFI-04 dispatch).
 */
const TESTS_MAY_IMPORT: readonly string[] = [
  "tests/property/json_number_test.ts",
  "tests/property/sqlite_oracle_test.ts",
  "tests/unit/sqlite_ffi_effect_test.ts",
  "tests/unit/sqlite_ffi_perf_test.ts",
];

/**
 * Files under `tests/` that may name `node:sqlite` without importing it.
 * - This file: it states the rule.
 * - `tests/unit/eventlog_test.ts`: asserts the event-log modules never contain the specifier.
 * - `tests/integration.ts`, `tests/property/decode_test.ts`: prose only; outside FFI-04's files, so
 *   listed here rather than reworded (a later docs pass can shrink the list).
 */
const TESTS_MAY_NAME: readonly string[] = [
  "tests/integration.ts",
  "tests/property/decode_test.ts",
  "tests/unit/boundaries_test.ts",
  "tests/unit/eventlog_test.ts",
];

/** Whether `rel`'s code (comments stripped; `.ts` only) imports `node:sqlite`. */
function importsNodeSqlite(rel: string, src: string): boolean {
  return rel.endsWith(".ts") && importSpecifiers(noComments(src)).includes(NODE_SQLITE);
}

/**
 * Every file under `dir` that mentions `node:sqlite` (raw text) but is not allowed to, every allowed
 * file that imports it without being allowed to import, and every list entry that no longer
 * mentions it (or no longer exists).
 */
async function nodeSqliteViolations(
  dir: string,
  mayImport: readonly string[],
  mayName: readonly string[],
): Promise<string[]> {
  const bad: string[] = [];
  const files = await filesUnder(dir, () => true);
  for (const rel of files) {
    const src = await load(rel);
    if (!src.includes(NODE_SQLITE)) continue;
    if (mayImport.includes(rel)) continue;
    if (!mayName.includes(rel)) bad.push(`${rel}: mentions ${NODE_SQLITE}`);
    else if (importsNodeSqlite(rel, src)) bad.push(`${rel}: imports ${NODE_SQLITE} (listed as prose only)`);
  }
  for (const rel of [...mayImport, ...mayName]) {
    if (!files.includes(rel)) bad.push(`${rel}: listed, but no such file`);
    else if (!(await load(rel)).includes(NODE_SQLITE)) bad.push(`${rel}: listed, but no longer mentions it`);
  }
  return bad;
}

Deno.test("boundaries: nothing under platform/ mentions node:sqlite, except the binding's prose", async () => {
  assert.deepEqual(await nodeSqliteViolations("platform", [], PLATFORM_PROSE_ONLY), []);
});

Deno.test("boundaries: nothing under tests/ mentions node:sqlite, except the exact-path allow-list", async () => {
  assert.deepEqual(await nodeSqliteViolations("tests", TESTS_MAY_IMPORT, TESTS_MAY_NAME), []);
});

/** Every specifier `entry` reaches at runtime (`deno info --json`, dynamic imports included). */
async function runtimeGraph(entry: string): Promise<Set<string>> {
  const { stdout, code } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", entry],
    cwd: ROOT,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  assert.equal(code, 0, `deno info ${entry}`);
  type Dependency = { code?: { specifier?: string } };
  const graph = JSON.parse(new TextDecoder().decode(stdout)) as {
    roots: string[];
    modules: { specifier: string; dependencies?: Dependency[] }[];
  };
  const bySpecifier = new Map(graph.modules.map((module) => [module.specifier, module]));
  const reached = new Set<string>();
  const pending = [...graph.roots];
  while (pending.length > 0) {
    const specifier = pending.pop()!;
    if (reached.has(specifier)) continue;
    reached.add(specifier);
    for (const dependency of bySpecifier.get(specifier)?.dependencies ?? []) {
      if (dependency.code?.specifier) pending.push(dependency.code.specifier);
    }
  }
  return reached;
}

Deno.test("boundaries: neither process's runtime module graph reaches node:sqlite", async () => {
  const local = (rel: string) => new URL(rel, `file://${ROOT}`).href;
  // Each walk must reach the module that proves it walked the right graph, or it proves nothing.
  for (
    const [entry, witness] of [
      ["platform/server.ts", "platform/sqlite_ffi/database.ts"],
      ["platform/reader.ts", "platform/duckdb.ts"],
    ] as const
  ) {
    const reached = await runtimeGraph(entry);
    assert.ok(reached.has(local(witness)), `${entry}: the walk never reached ${witness}; it is broken`);
    assert.equal(reached.has(NODE_SQLITE), false, `${entry} reaches ${NODE_SQLITE} at runtime`);
  }
});

Deno.test("boundaries: the SQLite side never mentions @duckdb/node-api", async () => {
  assert.equal((await load("platform/sqlite.ts")).includes("@duckdb/node-api"), false);
});

Deno.test("boundaries: no `throw new Error` in core/ or platform/ — errors go through the tagged channel", async () => {
  const rels = [...await tsFiles("core"), ...await tsFiles("platform")];
  const bad = await violations(rels, (_rel, code) => {
    const line = firstMatchLine(code, /\bthrow\s+new\s+Error\b/);
    return line === undefined ? undefined : `untyped throw: ${line}`;
  });
  assert.deepEqual(bad, []);
});
