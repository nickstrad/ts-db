# Plan: ts-db architecture diagrams site — `pages/` with an interim c4-sdk copy

Status: approved by Nick (2026-10-14 ~19:11 CDT, relayed by Twin in `/root/fable-c4-docs-go.md`; build
delegated to Opus per `/root/fable-c4-docs-delegate-opus.md`) · Author: Fable 5.1 (coordinator
`fable-ffi-coordinator`) · Date: 2026-10-15 · Target: `item/PG-NN-slug` branches off `main`, landed on `main`
· Baseline: `main` at `2d30330` (FFI campaign complete) · c4-sdk source: `origin/main` of
`/root/Software/c4-sdk`, HEAD `a1929e43b4f72229524f2ee24a7e88de10ce8879` when this plan was written (the
builder re-verifies and records the exact SHA it copies).

## 0. Direction (Nick's words, in substance)

- The site lives in the ts-db repo: a `pages/` folder with a diagrams folder/link holding the C4 diagrams of
  ts-db, supporting both current and proposed diagrams (originally side by side; superseded by the dropdown
  amendment below), meant to be leveraged when designing features, not for diagrams-only communication.
- Interim consumption: a dedicated directory holds a **copy of the c4-sdk React code**, built by the Pages
  app, with no imports of that code from anywhere else in ts-db, so the later swap is exactly "delete the
  directory
  - add the npm dependency". The copy is the source until Twin relays that `c4-sdk` 0.1.0 is on npm.
- **Selector (Nick, 2026-10-14 ~20:47 CDT, `/root/fable-pg-dropdown.md`):** the site is a dropdown of N
  architectures defaulting to the current one, never structured as explicitly one current + one proposed. The
  catalog is a list of peer entries (today `tsdb-current`, `tsdb-lanes-proposal`; later more variants);
  "current" is only the default entry, not a structural role. Per-element `existing | planned | mixed`
  statuses stay as data inside each architecture. **Amendment (Nick, 2026-10-14 ~20:48 CDT,
  `/root/fable-pg-dropdown-amend.md`):** no side-by-side comparison for now — one architecture is shown at a
  time, chosen from the dropdown; existing comparison scaffolding is removed. The top-level chrome
  (architecture dropdown and navigation/back controls) is sticky, pinned while the page scrolls.
- C4-09 (c4-sdk's own copy-consumer tooling) is cancelled; this is a ts-db-owned bridge
  ([c4-react.md](c4-react.md), c4-sdk `docs/plans/implementation.md` §2).

## 1. Facts the builders must respect

| Topic                 | Constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root Deno toolchain   | `deno.json` is frozen (no new tasks, no `exclude`). `deno fmt --check` (lineWidth 110) and `deno lint` (recommended) scan **every** directory under the repo except `node_modules/` — probed 2026-10-15: `vendor/`, hidden dirs and plain dirs are all checked. Everything committed under `pages/` must therefore be fmt- and lint-clean; the vendored copy is made so by its sync script (see PG-01). `deno task check` lists explicit files and is unaffected                                |
| `.gitignore`          | Ignores `dist/`, `build/`, `out/`, `data/`, `store/`, `tmp/`, `logs/`, `node_modules/` **at any depth**. Do not name a content directory `data/` or `store/`; put bundles under `public/architectures/`. Never commit build output                                                                                                                                                                                                                                                              |
| Node                  | Node 22.23.2 and npm 10.9.8 under nvm (`/root/.nvm/versions/node/v22.23.2/bin`), the exact version c4-sdk targets. `pages/` is an npm project with its own `package.json` + `package-lock.json`; root scripts stay Deno                                                                                                                                                                                                                                                                         |
| c4-sdk import surface | The package contract (c4-sdk `docs/api/public-api.md`) is `c4-sdk` (= `src/index.ts`), `c4-sdk/core` (= `src/core/index.ts`), `c4-sdk/styles.css`, `c4-sdk/layout-worker.js`. The interim copy is consumed through **the same specifiers** via Vite/TS aliases, never through deep `src/lib/...` paths, so the swap is mechanical. `src/lib/c4/index.ts` (the wider historical barrel) is not the contract                                                                                      |
| What to copy          | `src/lib/c4/**` (62 files), `src/core/**`, `src/index.ts`, `LICENSE` (MIT, Nick Strad), `THIRD_PARTY_NOTICES.md` — 65 source files; they import only `react`, `@xyflow/react` (+ its `dist/style.css`), `elkjs/lib/elk-api`, `zod`, `react-markdown`, `@base-ui/react/dialog`; nothing from `src/components`, `src/lib/utils.ts` or the `@/` alias. Components import their own CSS (`canvas.css`, `deployment.css`, `documentation.css`, `dynamic.css`); the host imports `styles/c4.css` once |
| Layout worker         | In source mode `createElkLayoutPort()` with no factory works: `client.ts` does `new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})`, which Vite bundles. The npm build rewrites that to `layout-worker.js` next to the host's base URI, and the verified consumer passes a factory built from `c4-sdk/layout-worker.js?url`. Confine SDK wiring to one host module so the swap edits one file                                                                                 |
| Versions              | Pin what c4-sdk pins: react/react-dom 19.3.0, @xyflow/react 12.12.0, elkjs 0.12.0, zod ^4.6.7, react-markdown 10.1.0, @base-ui/react ^1.9.0, vite 8.3.4, typescript 6.0.3, @vitejs/plugin-react ^6.1.1                                                                                                                                                                                                                                                                                          |
| Bundle format         | `ArchitectureBundle` v1 (c4-sdk plan §3; strict Zod in `schema/decode`; `decodeArchitecture` from `c4-sdk/core` is the oracle). `status: existing \| planned \| mixed`; `mixed` requires `plannedNotes`. Catalog = `{entries:[{id,title,url}]}`; entry `id` must equal the bundle `id`                                                                                                                                                                                                          |
| Hosting               | GitHub Pages at `https://nickstrad.github.io/ts-db/` (base `/ts-db/`, hash routes). Pages is **not yet enabled** on the repo (API 404 on 2026-10-15): enabling it is Nick's/Twin's action; the workflow therefore also supports `workflow_dispatch`. Pushes use SSH, so the `workflow` token scope does not apply                                                                                                                                                                               |
| ts-db protocol        | AGENTS.md unit-of-work rules; cross-family review (Opus build → Astra review); one item = one implementation commit; brief committed with `git add -f agent-work/items/<item>/brief.md`; `deno task ci` stays green                                                                                                                                                                                                                                                                             |

## 2. Content sources (pin by commit, link by commit URL)

| Dataset             | Source                                                                                                                                                                                                                                 | Status in the bundle                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsdb-current`      | `docs/architecture/` on `main` `2d30330`: context (`c4-context-document-db`), platform containers, observability containers, server components; audited at `0b82504`                                                                   | `existing`. The FFI execution layer (binding, classifier, deadline, 504) **is landed** — the current diagrams already draw it                                                                     |
| `tsdb-ffi-proposal` | `docs/plans/ffi/` on `origin/docs/ffi-c4` `81d9936` (context, container with lanes, lane component; README's four flows), rationale `docs/architecture/lang-switch-fable.md` on `research/fable-lang-switch` `d97bcf8` (not on `main`) | `planned`/`mixed`. Lanes, placement, WAL shipping remain proposed; the FFI binding and deadline parts those diagrams marked "(planned)" are now existing on `main` — convert with that correction |

Conversion rules are c4-sdk plan Milestone B: a mapping inventory (source node/edge number → JSON id → doc
ids) per dataset; Mermaid vs terminal discrepancies become review notes; `libsqlite3` is an implementation
dependency of a process, not a container; timing numbers go in documents with provenance, never in labels; a
point read does not prove a wall-clock bound; do not invent code-level FFI classes for unbuilt code.

## 3. Items

| Item   | Scope                                                                                                                                                                                                                                                                          | Model (build → review)         | Status                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG-01  | `pages/` scaffold, vendored c4-sdk copy with sync/provenance, viewer app with current/proposed/side-by-side, Pages workflow, `tsdb-current` (4 diagrams) and `tsdb-ffi-proposal` context + container, docs                                                                     | Opus 5.5 → Astra               | **landed** on `main` 2026-10-15: merge `b789441` (Opus 5.5 build `72d1eb7` → Astra NITS `3c2d2d1` → coordinator README fixup `27d032f` → **Nick's label correction** `/root/fable-pg01-ffi-label.md`: dataset renamed `tsdb-lanes-proposal` → Sonnet fixup `8043f49` → Astra delta re-review PASS `1ee2580`). Copy = c4-sdk `a1929e4`. Human gate still open: enable GitHub Pages |
| PG-02  | Proposed dataset completion (lane component, dynamic flows: point read, deadline/interrupt, forwarded mutation, kill/restart; illustrative deployment; landscape; one code view of `platform/document_reader.ts`), STE review pass                                             | Opus 5.5 → Astra               | **landed** on `main` 2026-10-15: merge `f52c817` (Opus 5.5 build `6e0859a` → Astra NITS `45ebadf`, two prose findings → coordinator fixup `412a616` → Astra delta re-review PASS `8485cd4`). All seven C4 kinds decode: current = landscape, context, 2 containers, component, code; proposal = context, container, component, deployment, 8 dynamic flows                        |
| PG-02b | Architecture selector: sticky top chrome with a dropdown of N catalog entries defaulting to the current one; one architecture shown at a time; remove the side-by-side comparison scaffolding and the current-vs-proposed framing from UI and copy; routes/tests/README follow | Opus 5.5 → Astra               | **dispatched** 2026-10-15 to Opus 5.5 (`opus-pg-02b`, `item/pg-02b-selector` off `f52c817`, worktree `/root/Software/tsdb-work/pg02b`); Astra review follows                                                                                                                                                                                                                      |
| PG-03  | Swap: delete `pages/vendor/c4-sdk`, add `c4-sdk@0.1.0` dependency, remove aliases, worker factory from `c4-sdk/layout-worker.js?url`, re-run checks                                                                                                                            | Sonnet / Sol → top-tier review | only when Twin relays the npm publish                                                                                                                                                                                                                                                                                                                                             |

Human gates: enabling GitHub Pages on the repo (Nick/Twin); the first deploy is externally visible.

### PG-01 — Pages scaffold, interim c4-sdk copy, viewer, first datasets

- **Branch / worktree:** `item/pg-01-pages` off `main` `2d30330` · `/root/Software/tsdb-work/pg01` · actor
  `opus-pg-01`.
- **Owns:** `pages/**`, `.github/workflows/pages.yml`, `agent-work/items/pg-01-pages/**`, one short
  "Architecture diagrams site" section in root `README.md` (do not touch its Configuration table),
  `docs/knowledge/{index,decisions,gotchas}.md` entries for durable learnings.
- **Reads:** everything else; never edits `core/`, `platform/`, `sdk/`, `app/`, `tests/`, `scripts/`, `perf/`,
  `deno.json`, `docs/architecture/`.
- **Layout (target):**

  ```text
  pages/
    README.md                      what this is, how to run, the exact npm-swap checklist
    package.json, package-lock.json, tsconfig*.json, vite.config.ts, index.html
    vendor/c4-sdk/                 the copy — delete wholesale at swap time
      PROVENANCE.md                upstream URL, exact SHA, date, file list, post-processing applied
      sync.sh                      re-copies from a given SHA and post-processes; --check = zero diff
      LICENSE, THIRD_PARTY_NOTICES.md
      src/index.ts, src/core/**, src/lib/c4/**
    src/                           the viewer: shell, dataset switch, side-by-side, sdk.ts (all SDK wiring)
    public/catalog.json
    public/architectures/tsdb-current.json, tsdb-ffi-proposal.json
    content/<dataset>/inventory.md conversion inventories and review notes
    tests/                         bundle validation + any browser smoke
  ```

- **Acceptance evidence:** `cd pages && npm ci && npm run check` green (typecheck, bundle validation test that
  decodes both bundles with zero error diagnostics, production build at base `/ts-db/`);
  `pages/vendor/c4-sdk/sync.sh --check` reports zero diff against the recorded SHA; root
  `deno task fmt:check`, `deno task lint`, `deno task check` green with `pages/` present;
  `grep -r "vendor/c4-sdk" --include=*.ts
  --include=*.tsx . | grep -v ^pages/` is empty; no file in `pages/`
  imports from `core/`, `platform/` or `sdk/`; the viewer shows the current and proposed context diagrams side
  by side; the Pages workflow builds the same artifact CI would (`npm ci` + build + `404.html` fallback);
  every claim about a diagram element is traceable through the inventory to a commit-pinned source URL.

### PG-02b — Architecture selector with N entries, sticky chrome, no comparison view

- **Scoping:** after PG-02. Viewer only; no data-model change (PG-01's catalog `entries` array already
  supports N).
- **Model:** **Opus 5.5 → Astra** (viewer routing logic).
- **Branch / worktree:** `item/pg-02b-selector` · `/root/Software/tsdb-work/pg02b` · actor `opus-pg-02b`.
- **Owns:** `pages/src/**` (in `pages/src/sdk.ts` only the removal of comparison-only helpers such as the
  in-memory route port; the SDK import wiring stays), `pages/tests/**`, `pages/public/catalog.json`
  (`defaultId` only), `pages/README.md`, root `README.md` site section (framing wording only),
  `agent-work/items/pg-02b-selector/**`.
- **Work:** a sticky top bar (pinned while the page scrolls) holding a labelled, keyboard-reachable dropdown
  that lists every catalog entry by title and defaults to the catalog's `defaultId` (fallback: first entry),
  plus the navigation/back controls (the SDK's `DiagramNavigation` or equivalent) so switching architecture
  and going back work from anywhere in a diagram; one architecture shown at a time; remove the compare mode,
  its `#/compare/...` route, pairing logic and comparison-only tests; remove `PROPOSED_ID`-style constants and
  every "current vs proposed" / "side by side" label from UI and copy (per-element status wording inside
  bundles is data and stays); adding a third catalog entry must work with no code change (test with a
  three-entry fixture catalog).
- **Acceptance evidence:** `cd pages && npm run check` green with updated route and smoke tests (three-entry
  fixture; a smoke test scrolls a tall diagram and asserts the dropdown and back control stay in the
  viewport); root `deno task
  fmt:check`/`lint` green;
  `command grep -rn "PROPOSED_ID\|compare\|side by side\|Side by side\|current vs proposed" pages/src pages/tests pages/README.md README.md`
  empty.

## 4. Risks

| # | Risk                                                                                             | Handling                                                                                                                                                                     |
| - | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Root `deno fmt`/`deno lint` reject the copied c4-sdk code                                        | `sync.sh` post-processes deterministically (`deno fmt` on the copy, `// deno-lint-ignore-file` header where needed); provenance records it; `--check` proves reproducibility |
| 2 | Deep imports into the copy leak outside `pages/`, making the swap non-mechanical                 | Acceptance grep; aliases are the only path; SDK wiring in one `sdk.ts`                                                                                                       |
| 3 | Proposed diagrams overstate what is planned now that FFI-01..08 landed                           | Conversion notes mark the landed parts `existing` with source links to `main`; reviewer checks against `platform/`                                                           |
| 4 | Pages not enabled: the push-triggered workflow fails until Nick flips the setting                | Reported as a human gate; `workflow_dispatch` lets Twin trigger the first deploy                                                                                             |
| 5 | npm install needs the network; registry hiccups (kb: optional platform binaries 404 transiently) | Retry; pin versions to c4-sdk's lockfile                                                                                                                                     |
