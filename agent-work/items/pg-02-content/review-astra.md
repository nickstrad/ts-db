# PG-02 independent review

Verdict: **NITS**

Reviewer: Codex Astra, actor `astra-pg-02-review`, 2026-10-15. Reviewed `git diff b789441 6e0859a` against the
PG-02 brief and c4-sdk §3.1/Milestone B. Read-only product review; this report is the only review change.

## Findings

1. **Low — STE drops a classifier condition**, `pages/public/architectures/tsdb-lanes-proposal.json:4438`. The
   classifier STE says “a select by _id” is bounded. The landed classifier requires an equality filter **and
   no aggregate**; a count/countBy with an _id filter remains unbounded
   (`platform/sqlite_ffi/classify.ts:47`). The plain explanation immediately above is correct. Fix the STE to
   say “A select with an _id equality filter and no aggregate is bounded” and explicitly keep aggregates
   unbounded. Simplification must preserve this execution-path distinction.
2. **Low — component prose overstates the timing implication**, same bundle, line **4411**
   (`doc-lanes-components.plain`). “Only statements that cannot run long take it” reads as a wall-clock
   assurance about the synchronous path. Milestone B explicitly rejects that implication under I/O stalls. The
   point-read and measurements documents already supply the right caveat, but this independently displayed
   explanation should agree. Replace it with “Only plans classified as bounded take this path; that
   classification does not guarantee a wall-clock bound.” No timing measurement in a diagram label or dynamic
   step was found.

These are bounded prose corrections; no blocking structural, scope, routing or test failure was found.
Recommend a fresh fixup and delta review under the repository's NITS protocol.

## Acceptance commands and trimmed outputs

Environment for Node/Deno commands:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.deno/bin:$PATH"
```

Ran from the assigned worktree:

```text
cd pages && npm ci && npm run check
added 162 packages, and audited 163 packages in 9s
found 0 vulnerabilities
tsc -b: exit 0
Test Files 4 passed (4)
Tests 99 passed (99)
vite v8.3.4: 631 modules transformed; built in 2.78s
sync.sh --check: zero diff against c4-sdk a1929e43b4f72229524f2ee24a7e88de10ce8879
(67 files; 9 with a lint-ignore header)
Playwright: 11 passed (23.8s)
exit 0

deno task fmt:check && deno task lint
Task fmt:check deno fmt --check
Checked 353 files
Task lint deno lint
Checked 241 files
exit 0
```

The root formatter ran without path arguments. Browser output had only the NO_COLOR/FORCE_COLOR warning.
Existing strict decoder tests remain intact: both bundles decode with zero diagnostics.

```sh
git diff --name-only b789441 6e0859a
command grep -rn "ffi-proposal\|FFI proposal\|Proposed: FFI" pages README.md --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=dist
git status --short --branch
```

Diff paths: the authorized item brief; pages README; both inventories; both bundles; routes, smoke and new
views tests. Nothing under vendor, sdk.ts, .github, docs/knowledge, or any unauthorized path. The wording grep
printed nothing (exit 1, no matches). Status was clean before this report.

## Bundle invariants and coverage

Independently parsed both baseline bundles with `git show`, compared by ID with the new JSON, and compared
inventory decision blocks. Exact comparison command:

```sh
python3 - <<'PY'
import json, subprocess
for ds in ['tsdb-current', 'tsdb-lanes-proposal']:
    p = f'pages/public/architectures/{ds}.json'
    old = json.loads(subprocess.check_output(['git', 'show', f'b789441:{p}']))
    new = json.load(open(p))
    print(ds)
    for key in ['elements', 'relationships']:
        ix = {x['id']: x for x in new['model'][key]}
        changes = [(x['id'], [k for k in set(x) | set(ix.get(x['id'], {}))
                    if x.get(k) != ix.get(x['id'], {}).get(k)])
                   for x in old['model'][key] if x != ix.get(x['id'])]
        print(key, len(old['model'][key]), 'changes', changes)
    print('diagrams', [(d['id'], d['kind']) for d in new['diagrams']])
PY
```

Output: current 33 elements and 61 relationships unchanged in full; proposal 13 pre-existing elements
unchanged except `api.tags` and `files.tags`; all 14 pre-existing relationships unchanged in full. No ID,
status, label, endpoint or planned note changed. The tags implement the documented SDK supporting container
rule (P12), not a status change. D1–D5 and P1/P3–P5 are byte-identical; P2 only replaces its future PG-02
reference with the now-present lane binding and folded edge, preserving the decision.

| Dataset             | Decoded kinds                                      |
| ------------------- | -------------------------------------------------- |
| tsdb-current        | landscape, context, container, component, code     |
| tsdb-lanes-proposal | context, container, component, dynamic, deployment |

The current bundle adds only the landscape/code material and necessary navigation/revision metadata. Its
landscape reuses the context's seven people/systems and six relationships, inventing no running system. All 32
current and 28 proposal documents have plain and STE text. STE remains Issue 9, draft, not certified.

## Source fidelity

Read with:

```sh
git show 81d9936:docs/plans/ffi/c4-component-ffi-lane.github.md
git show 81d9936:docs/plans/ffi/c4-component-ffi-lane.terminal.md
git show 81d9936:docs/plans/ffi/README.md
git show main:platform/document_reader.ts
```

Compared the lane inventory and actual JSON with both source formats. All 13 source nodes map to 12 drawn
members: libsqlite3 folds into the binding. Both source relationship tables have all 17 numbered edges; the
bundle has 16, numbered 1–12 and 14–17: source 13 is the technology of 14. No source node/edge disappears
without a mapping. Terminal boxes have no arrows; its relationship table is the edge authority.

Explicit spot checks against **both** Mermaid and terminal:

| Source                    | Bundle mapping                   | Result                                                                |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| ipc and edge 1, API → IPC | lane-ipc; lane-1                 | Planned request endpoint, payload and direction preserved             |
| classify and edge 2       | lane-classifier; lane-2          | Landed classifier existing; new IPC call planned                      |
| watchdog and edge 11      | lane-watchdog; lane-11           | Mixed watchdog; landed interrupt call existing; timing moved to prose |
| watchdog → API, edge 12   | lane-12                          | Planned kill escalation, separate from successful interrupt           |
| ffi/lib and edges 13–14   | lane-ffi; lane-14                | Library folded, symbols in technology, WAL relationship retained      |
| events/jsonl and edge 17  | lane-logger; lane-jsonl; lane-17 | Existing reusable logger; planned lane destination and append         |

Scheduler, watchdog and handle cache are mixed with explicit planned duties. IPC, statement pool, request-id
store and lane JSONL are planned. Binding/classifier/logger code is existing; documents explicitly say the
lane process itself is unbuilt and existing code currently runs in the API process. The watchdog combines
landed deadline/interrupt/grace handling with proposed supervisor escalation, so mixed is appropriate.

Read all eight scenario trees against the README's four flows. Point read follows arrival, classification,
lease, blocking read, response/release. Deadline follows admission, lease, registration, nonblocking
execution, interrupt and deadline error; a concurrent point read is a parallel branch. QueueFull and kill
escalation are separate scenarios. Forwarding and owner execution are split into linked views to avoid falsely
drawing the owner's work in the receiving node; stale epoch and committed-request retry are separate
alternatives. Kill/restart fails in-flight requests and respawns the same tenant set, with no claimed restart
measurement. Interaction IDs are distinct, model relationships reused, and reverse interactions are responses.
The added endpoint-membership tests cover every dynamic scenario.

Deployment uses environment `illustrative`; two hypothetical data nodes each hold two lane instances. All
deployment members/edges are planned. Documents explicitly deny that it is the actual droplet topology. The
landscape and deployment introduce no claim of a newly running production system.

The source-linked code view sits under `document-reader`. Independently compared these five members with
`main:platform/document_reader.ts`: `querySqlite` (143), `makeDocumentReaderClient` (411), `native` (79),
`nativeNow` (86), `messageOf` (134). Names, parameters, explicit return types and visibility match: the first
two are public exports; the other three private helpers. The source file at pinned `2d30330` is byte-identical
to main. Imported symbols are explicitly external, not fabricated lane classes.

## Viewer verification

Ran the production preview independently:

```sh
cd pages
npm run preview -- --host 127.0.0.1 --port 4187 --strictPort
# vite preview --base /ts-db/ --host 127.0.0.1 --port 4187 --strictPort
```

In addition to the 11 Playwright smoke tests, used Chromium via a Node stdin script with
`import { chromium } from 'playwright'`, iterating each bundle's new views, navigating to
`http://127.0.0.1:4187/ts-db/#/architectures/<dataset>/diagrams/<id>` and waiting for
`page.locator('[data-layout-ready]').waitFor()`. All 12 new views rendered: landscape, code, lane component,
eight dynamic scenarios and deployment. The smoke test also clicked Components in side-by-side mode and
verified `#/compare/components-server/lanes-components` with two ready canvases.

Dynamic selection was tested with these exact browser operations after launching Chromium:

```js
await page.goto(
  "http://127.0.0.1:4187/ts-db/#/architectures/tsdb-lanes-proposal/diagrams/flow-long-query-interrupt?step=lq-interrupt",
);
await page.locator("[data-layout-ready]").waitFor();
const select = page.getByRole("combobox", { name: "Scenario step" });
console.log("selected", await select.inputValue());
await page.getByRole("button", { name: "Next selection" }).click();
console.log("next", page.url(), await select.inputValue());
await page.reload();
await page.locator("[data-layout-ready]").waitFor();
console.log("reloaded", await select.inputValue());
```

Output: selected `lq-interrupt`; Next changed the hash query to `?step=lq-interrupted` and selected that step;
reload retained `lq-interrupted`. The SDK exposes step deep links and this consumer preserves them. Inspected
screenshots at 1440×1000 and 390×844: controls and scenario text render and wrap; the large graph uses a
pan/zoom canvas, with only part visible at its initial zoom. This was a focused visual spot check, not an
exhaustive visual audit of every diagram.

## Limits and hand-offs

No GitHub Pages enablement/deployment, full ts-db runtime test suite, real lane execution or topology
verification was attempted; these are outside this content review. No claim of STE certification. The report
covers the specified snapshots, not future changes in main or the SDK.

Coordinator: assign the two prose corrections and a fresh delta reviewer. Preserve the existing documented
handoff that lane requests carry SQL while the landed classifier needs operation IR or its class; PG-02
correctly records this open design point instead of inventing a protocol. Durable learning remains in this
committed report because docs/knowledge is outside review ownership. No reusable script warrants addition.
Leave this worktree for coordinator inspection and subsequent cleanup. No merge authority is implied.
