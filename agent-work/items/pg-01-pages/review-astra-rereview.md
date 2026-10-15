# PG-01 delta re-review

Verdict: **PASS**. No new findings; the original formatter finding is closed.

Reviewer: Codex Astra, actor `astra-pg-01-rereview`, 2026-10-15. Reviewed
`cbfaefc..8043f49b3187a1853290b0bc4d4b5751e2d6b622`: coordinator fix `27d032f` and Sonnet fix `8043f49`. Read
Nick's correction at `/root/fable-pg01-ffi-label.md` and the first report from
`origin/review/pg-01-astra:agent-work/items/pg-01-pages/review-astra.md` (report commit `3c2d2d1`).

## Findings and scope

The original PG-01 Build/Acceptance scope holds. This delta closes its sole NITS finding and does not
invalidate its conclusions about fidelity, isolation, vendor provenance, routing or workflow. PG-02 and PG-03
remain outside scope. The original full source audit, URL checks and visual inspection were not repeated; this
is a delta review, with fresh checks below. No deployment, Pages enablement or runtime suite was performed.

- **Formatter finding closed:** `pages/README.md:94` now gives
  `deno fmt --config deno.json pages/public pages/content`, explicitly from the repo root. The root
  `fmt:check` task is `deno fmt --check` without paths; root configuration sets width 110 with no pages
  exclusion. Its recursive scan covers pages source/content; ignored build/dependency directories are
  excluded. Debug output confirms root `deno.json` selection and 352 files. The explicit-config read-only
  equivalent also passes on all five dataset/catalog/inventory files.
- **Requested naming:** catalog and bundle use `tsdb-lanes-proposal` and exactly "Proposed: statement lanes
  and tenant placement (scale-out)". README, inventory, dataset note and context prose distinguish the unbuilt
  scale-out design from landed FFI-01 to FFI-08 in `tsdb-current`.
- **Content invariant:** independently parsed the old bundle with `git show cbfaefc:...` and the new bundle
  from disk. The entire `model` objects are equal: all 13 elements and 14 relationships, every ID, status,
  endpoint, property and planned note are unchanged. The current bundle is byte-identical.
- **Exhaustive bundle delta:** the two parsed proposal bundles compare equal after normalizing only the
  dataset ID/title, mapping `ffi-context → lanes-context` and `ffi-containers → lanes-containers`, the context
  diagram title, context-document introductory wording, and source display titles. Diagram default, parent and
  detail references follow the same mapping. Diagram statuses, nodes, edges, source IDs, revision strings,
  paths and pinned URLs are unchanged. Both catalog entries' IDs and titles match the bundles loaded through
  their catalog URLs.
- **Mechanics invariant:** application changes are confined to `PROPOSED_ID` and the dataset-note string.
  Side-by-side logic, route grammar and SDK wiring are unchanged. Route, bundle and browser expectations
  consistently use the new IDs. The inventory explicitly records that old proposal deep links are not
  redirected; this follows the requested rename and is not a new defect.

## Fresh validation

Environment:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.deno/bin:$PATH"
```

| Command                                                          | Result                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd pages && npm ci && npm run check`                            | PASS: 162 packages installed, zero vulnerabilities; TypeScript check; 3 test files / 57 tests; production build; vendor sync; 6 Chromium tests (13.8s). |
| `cd pages && npx playwright test`                                | PASS: 6 Chromium tests (13.6s), separately run as requested.                                                                                            |
| Root `deno task fmt:check` (no paths)                            | PASS: 352 files.                                                                                                                                        |
| Root `deno task lint` (no paths)                                 | PASS: 240 files.                                                                                                                                        |
| `deno fmt --check --config deno.json pages/public pages/content` | PASS: 5 files.                                                                                                                                          |
| `git diff --check cbfaefc 8043f49`                               | PASS.                                                                                                                                                   |
| Independent parsed-bundle and catalog assertions described above | PASS.                                                                                                                                                   |

Vendor sync reports zero diff against c4-sdk `a1929e43b4f72229524f2ee24a7e88de10ce8879` (67 files, nine
lint-ignore headers). Build emitted to ignored `pages/dist/`. Non-failing warnings were Vite plugin timing
advice and Playwright's NO_COLOR/FORCE_COLOR warning.

The exact required search printed nothing and exited 1 (no matches):

```sh
command grep -rn "ffi-proposal\|FFI proposal\|Proposed: FFI" pages README.md docs/knowledge --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=dist
```

Product files remained untouched; `git status --short` was empty after validation before this report.

## Learning and handoff

No new durable environment finding or reusable script emerged. The formatter trap is already documented in
`docs/knowledge/gotchas.md`; rename rationale and old-link behavior are preserved in inventory decision P11.
No ownership-expanding knowledge edit is needed. This report is the sole authorized committed change.

Coordinator: inspect this report and clean up this review worktree after inspection. PASS grants no separate
deployment authority; the original human Pages-enablement gate remains. No merge or main push was performed.
