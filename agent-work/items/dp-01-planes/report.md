# DP-01 builder report

Date: 2026-10-20. Actor: `sol-dp-01`. Branch: `item/dp-01-planes`. Worktree retained at
`/root/Software/tsdb-work/dp01`. No main merge or deployment. The required `agent-work/COORDINATION.md` is
absent in this checkout; the shared event inbox and the other orientation files were read.

Brief commit: `6c3989e28aed5c5fa60d4f6c33730ce6885d5c9a`. Implementation: the commit containing this report;
the completion event and final response supply its exact SHA without a self-referential commit hash.

## Delivered

`tsdb-planes-proposal` adds 44 elements, 54 relationships, 59 plain + STE draft documents and 14 diagrams. The
inventory maps every element, relationship, scenario root and interaction to its sources and documents.

| Kind       | Diagram IDs                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context    | `planes-context`                                                                                                                                                                                     |
| Container  | `planes-containers`                                                                                                                                                                                  |
| Component  | `planes-control-components`, `planes-data-components`                                                                                                                                                |
| Dynamic    | `flow-create-database`, `flow-create-failed`, `flow-query-right-node`, `flow-query-stale`, `flow-query-deadline`, `flow-move-database`, `flow-move-failed`, `flow-drop-database`, `flow-drop-failed` |
| Deployment | `planes-deployment` (`illustrative`)                                                                                                                                                                 |

All dynamic views are ordered `scenario: Step` trees reusing static model relationships, with responses
represented by reverse interactions. Failure alternatives have separate names and diagrams. No measured
performance or production deployment claims are made.

## Registration and scope

The dropdown is data-driven, but a bundle alone is insufficient: `pages/public/catalog.json` lists its
entries. Added exactly one entry and kept `tsdb-current` as default. This is the minimal registration change
explicitly required by Build §8; the initial Owns list omitted that registration file. No viewer code changed.
The existing fixtures still exercise a separate three-entry catalog and an arbitrary default; production now
has three real entries. Per-dataset catalog assertions were extended, scenario integrity checks now cover both
proposals, and browser smoke renders all 14 new diagrams and switches to the new entry and Back.

README edits stay in the dataset/catalog description. Both existing bundles and their content trees are
byte-identical against baseline `351a51b`; checksum evidence follows in the acceptance section.

## Design decisions and reuse

- A tenant owns 0..N databases. Immutable database IDs key placement, isolation, files, backups, queues and
  lifecycle. Names resolve within the trusted tenant; they never become paths. Database selection shares one
  session/endpoint across nodes.
- Postgres metadata uses hand-written SQL, no ORM. Durable operation records coordinate SQL and file/RPC work
  through reconciliation. Tenant deletion is restricted until all its databases finish deletion.
- The landed routing seam is **mixed**, not an already built remote router. Its current tenant-only
  `resolve(tenantId)` requires an explicit database-aware context/selection extension. Swapping location
  resolution remains behind the seam; current clients do not already have an arbitrary-database API.
- Reuse the lanes proposal’s placement epochs, forwarding, supervisor, child-process statement lanes,
  request-ID deduplication, and FFI classifier/deadline vocabulary. The FFI binding and IR classifier code are
  **existing**; lanes and database-aware remote behavior are **planned**. Deadline policy is **mixed** because
  supervisor escalation is proposed. Pass operation IR alongside compiled SQL/binds to preserve the landed
  classifier contract.
- Move is explicitly offline per database: record MOVING, deny new opens, fence admissions including existing
  sessions, drain/cancel work, close handles, checkpoint/copy/verify, and only then atomically publish the new
  owner and epoch. Require source fence acknowledgement; no automatic failover from an unreachable source.
  Target activation checks the committed placement. Confirm process exit after a lane kill. Before-flip
  rollback requires intact source and confirmed target cleanup; after-flip recovery reconciles the new owner.
- Drop removes file/sidecars, staged/source copies and backups/archived WAL before registry cleanup. Keep
  non-routable ID tombstones and durable operation audit. Failed cleanup remains unavailable and pending.
  Suspend/resume and backup/restore policies are documented on the lifecycle component.
- Deliberately drop tenant-sticky lane sets, tenant-wide files/queues/locks and unchanged DuckDB/observability
  detail. Defer online WAL streaming; verified database snapshots suffice for the chosen move protocol. Child
  processes contain failures, but killing a shared lane can affect several databases’ in-flight work.
- Context keeps standard C4 abstraction: two labelled paths into one system; the container view splits the
  control plane, data plane and hosting fleet. Supporting internal components are grey to meet SDK grammar,
  and the key explains their ownership. No library is invented as a container.

## Visual inspection

Captured and inspected desktop canvases at 1600×1000 and the container view at 390×844. Shortened card
summaries while retaining full explanations, and changed main views to left-to-right for a clearer overview.
The context, container, both component views, move flow and illustrative deployment have committed screenshots
under `screenshots/`. The mobile document width is 390 with scroll width 390: no page-wide overflow.

The existing viewer opens at actual size and offers Fit, zoom and pan. Fit makes large views an overview; use
actual size/zoom and the explanation panel to read detail, especially on mobile. No viewer changes were made.
Screenshots capture Fit views; full plain and STE text remains available in the inspector.

## Validation history

The first decoder check found one missing accent swatch in the new context legend; fixed it. The first full
Pages check then passed 162 unit tests and 26 browser tests. During visual refinements, I accidentally ran two
checks against the same preview port: one collided with the occupied port, and the overlapping build also
interrupted one diagram load in the other run. Final acceptance runs serially against the completed dataset;
no checks or timeouts were weakened. Final outputs are below.

## Learning assessment and reviewer handoff

Durable findings are preserved inside the authorized inventory (DP4 router truth, DP7 fencing/relocation, DP9
lane blast radius). Coordinator: link the inventory from `docs/knowledge/index.md` and `decisions.md` after
review; those files are outside builder ownership. No general reusable script was found. The unit-only
`build-dataset.py` preserves the authored dataset source; run it from this worktree and format the two outputs
with the root Deno config. It pins the brief commit and baseline explicitly.

Ready for the specified independent Astra design review and one fresh Sol repair round if requested. Review
focus: database-aware API seam, relocation fencing and recovery ordering, all-data drop semantics, and the
chosen C4 context abstraction. This report is the builder’s handoff, not an independent PASS verdict.

## Final acceptance outputs

Commands run with the brief’s Node/Deno PATH and HOME=/root.

```text
$ cd pages && npm ci
added 51 packages, and audited 52 packages in 2s
13 packages are looking for funding
found 0 vulnerabilities

$ npm run check
> tsc -b
 Test Files  5 passed (5)
      Tests  162 passed (162)
✓ built in 1.04s
  26 passed (51.9s)
```

```text
$ deno task fmt:check
Task fmt:check deno fmt --check
Checked 292 files

$ deno task lint
Task lint deno lint
Checked 183 files
```

```text
$ git diff --exit-code 351a51b -- [both old bundles and content trees]
(no output; exit 0)

SHA-256 baseline and working file match:
0a736cb8d39de3df1c8d4a438d1a1c80ee0ab4a4e962ff69700b07a0298f2f77  tsdb-current.json
04c7f6f300bdc58be126bebf7521056995d3317a079f3ba4fe995d96122089b9  tsdb-lanes-proposal.json
```

Additional full root CI (exit 0):

```text
$ deno task ci
Task ci deno task fmt:check && deno task lint && deno task check && deno task test && deno task test:prop
Task fmt:check deno fmt --check
Task lint deno lint
Task check deno check core/errors.ts platform/services.ts platform/server.ts platform/reader.ts scripts/demo.ts scripts/explain.ts scripts/restore.ts tests/core_test.ts tests/types.ts tests/errors_exhaustiveness.ts tests/integration.ts
Task test deno test --v8-flags=--expose-gc -A tests/unit/**/*.ts tests/core_test.ts
ok | 687 passed | 0 failed | 1 ignored (5m3s)
Task test:prop deno test --v8-flags=--expose-gc -A tests/property/**/*.ts
ok | 84 passed | 0 failed (3m18s)
```

The one ignored root unit test is reported by the existing suite. No tests were weakened.

The unit-specific authoring script was rerun and formatted; `git diff --exit-code` against the staged bundle
and inventory returned no output (exit 0), verifying reproducibility.
