# PG-01 independent review

Verdict: **NITS**

Reviewer: Codex Astra, actor `astra-pg-01-review`, 2026-10-15. Reviewed `git diff 2d30330 cbfaefc`
(implementation `72d1eb7`). Scope: PG-01 Build steps and Acceptance only; no PG-02 completion requirement.
Only this report is changed by the review.

## Findings

1. **Low — wrong authoring formatter command**, `pages/README.md:90`. The documented
   `deno fmt pages/public pages/content` resolves the nested npm project's default formatting configuration,
   whereas the acceptance task uses root `deno.json`. Running the read-only equivalent
   `deno fmt --check pages/public pages/content` reports two unformatted inventory files, while both root
   `deno task fmt:check` and the explicit-config equivalent pass. Following the instructions therefore
   reformats accepted inventories incompatibly with root CI. Fix the instruction to
   `deno fmt --config deno.json pages/public pages/content` (run at the repo root). This is already explained
   correctly in `docs/knowledge/gotchas.md`; make the user-facing instruction agree.

No blocking code, bundle-fidelity, isolation, or workflow finding.

## Acceptance evidence

Environment for all Node/Deno commands:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.deno/bin:$PATH"
```

Commands ran in the assigned review worktree unless a directory is specified. Outputs below are trimmed.

```text
cd pages && npm ci && npm run check
added 162 packages, and audited 163 packages in 10s
found 0 vulnerabilities
typecheck: tsc -b [exit 0]
Test Files 3 passed (3)
Tests 57 passed (57)
vite v8.3.4 building client environment for production...
631 modules transformed
dist/index.html                   0.74 kB
dist/assets/worker-fK_a81c_.js  1,423.60 kB
dist/assets/index-8_F78LtJ.css    30.94 kB
dist/assets/index-Bj29f_lp.js    764.52 kB
built in 3.33s
sync.sh --check: zero diff against c4-sdk a1929e43b4f72229524f2ee24a7e88de10ce8879
(67 files; 9 with a lint-ignore header)
Chromium: 6 passed (15.8s)
[exit 0]

deno task fmt:check
Checked 352 files [exit 0]
deno task lint
Checked 240 files [exit 0]
deno task check
[all configured entrypoints checked; exit 0]

pages/vendor/c4-sdk/sync.sh --check
zero diff against c4-sdk a1929e43b4f72229524f2ee24a7e88de10ce8879
(67 files; 9 with a lint-ignore header) [exit 0]

deno fmt --check pages/public pages/content
error: Found 2 not formatted files in 5 files [exit 1; finding 1]

deno fmt --check --config deno.json pages/public pages/content
Checked 5 files [exit 0]
```

Non-failing npm output included Vite plugin timing advice and Playwright's NO_COLOR/FORCE_COLOR warning.

### Independent vendor re-derivation

I did not rely only on the implementation's sync script. Commands:

```sh
mkdir -p /tmp/pg01-review/export
git -C /root/Software/c4-sdk archive a1929e43b4f72229524f2ee24a7e88de10ce8879 src/index.ts src/core src/lib/c4 LICENSE THIRD_PARTY_NOTICES.md | tar -x -C /tmp/pg01-review/export
deno fmt --config "$PWD/deno.json" /tmp/pg01-review/export
deno lint --config "$PWD/deno.json" --json /tmp/pg01-review/export > /tmp/pg01-review/export-lint.json
```

The initial lint intentionally reports the upstream violations. I independently grouped those diagnostics and
added only the exact sorted rule names:

```python
import json, pathlib
diags = json.load(open('/tmp/pg01-review/export-lint.json'))
rules = {}
for d in diags['diagnostics']:
    p = d['filename'].removeprefix('file://')
    rules.setdefault(p, set()).add(d['code'])
for p, r in rules.items():
    f = pathlib.Path(p)
    f.write_text('// deno-lint-ignore-file ' + ' '.join(sorted(r)) + '\n' + f.read_text())
```

```sh
deno fmt --config "$PWD/deno.json" /tmp/pg01-review/export
diff -rq --exclude=sync.sh --exclude=PROVENANCE.md /tmp/pg01-review/export pages/vendor/c4-sdk
```

Result: **67 files, nine lint-ignore headers; no diff, exit 0**. Post-processing is exactly Deno formatting
with root configuration and those headers, followed by formatting again. LICENSE is unchanged. No
application/demo/config/test files from upstream were copied.

### Isolation, ownership, and npm swap

These searches returned no matches (rg exit 1 means no matches):

```sh
git diff 2d30330 cbfaefc --name-only | rg -v '^(pages/|.github/workflows/pages.yml|README.md|docs/knowledge/|agent-work/items/pg-01-pages/)'
git ls-files '*.ts' '*.tsx' '*.json' ':!:pages/**' | xargs -r rg -n 'vendor/c4-sdk'
rg -n '(\.\./)+(core|platform|sdk)/' pages --glob '!package-lock.json' --glob '!vendor/**'
git ls-files pages | rg '/(node_modules|dist|.vite)/'
```

`rg -n 'c4-sdk|vendor/' pages/src` shows actual SDK imports only in `src/sdk.ts`, using `c4-sdk`,
`c4-sdk/core`, and `c4-sdk/styles.css`. Other occurrences are comments. Reviewed the Vite/TypeScript aliases
and import paths as well. Root README changes are confined to the new site section; no frozen root
configuration or product files changed. `git status --short` was empty after all build/check/browser work,
before this report.

The npm-swap instructions match the verified upstream consumer template and `sdk-build.mjs`: remove aliases
and vendor files, install the published package, retain the explicit stylesheet import, inject a module Worker
from `c4-sdk/layout-worker.js?url`, and remove the sync step. The source worker is currently bundled by Vite;
the package build rewrites its default URL relative to document.baseURI, so the explicit factory is essential
and correctly documented. The package emits the combined/scoped CSS, including React Flow and the other source
styles; keeping the CSS import is correct. No private SDK API is consumed. This is a contract review, not
execution of PG-03 or a claim that version 0.1.0 is published.

## Content fidelity

Independently parsed the six pinned Mermaid sources, their terminal relationship tables, both bundles, and
both inventories. Checked every source node mapping, every relationship number/label/endpoint, current
statuses, mixed plannedNotes, and inventory coverage. Terminal and Mermaid relationship tables agree.

| View                      | Source nodes → bundle nodes | Source edges → bundle edges |
| ------------------------- | --------------------------: | --------------------------: |
| Current context           |                       7 → 7 |                       6 → 6 |
| Current request path      |                       8 → 8 |                       7 → 7 |
| Current observability     |                       8 → 8 |                     10 → 10 |
| Current server components |                     19 → 19 |                     38 → 38 |
| Proposed context          |                       7 → 7 |                       6 → 6 |
| Proposed containers       |                       9 → 8 |                       9 → 8 |

The last reduction is intentional and documented: the shared library is not a container; source edge 5 becomes
the technology of relationship `ctr-6`, and source edge 6 connects lanes directly to files. Its display number
remains 6 and the key explains the gap. No dependency meaning is lost.

Explicit spot-checks against BOTH formats (in addition to the exhaustive relationship comparison):

| Source mapping                                  | Bundle mapping and observation                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Current context: caller, edge 2                 | `caller`, `ctx-2`: HTTP JSON/bearer/X-Trace-Id; existing                                                        |
| Current platform: server → files, edge 3        | `server` → `files`, `ctr-3`: FFI reads and serialized mutations; existing                                       |
| Current observability: reader → duck, edge 4    | `reader` → `eventlog`, `obs-4`: transactional ingest and catalog SELECT; existing                               |
| Current components: docread → classify, edge 13 | `document-reader` → `classifier`, `comp-13`; existing                                                           |
| Current components: ffi → files, edge 38        | `ffi-binding` → `files`, `comp-38`; existing                                                                    |
| Proposed containers: api → lanes, edge 4        | `api` → `lanes`, `ctr-4`; planned IPC/deadline/cancel/kill                                                      |
| Proposed containers: api → files, edge 7        | `ctr-7`: stale node:sqlite text corrected to landed FFI; mixed because the future lane design retires this edge |
| Proposed context: db → objects, edge 5          | `ctx-5`: mixed, with WAL shipping explicitly planned                                                            |

All 33 current elements and 61 relationships are existing. The proposed bundle has 13 elements and 14
relationships: lanes and peer are planned; API/platform/registry/object storage retain existing duties with
explicit planned additions. FFI binding, classifier and deadline/interrupt are landed, not falsely
reclassified as future work. Current document reads bypass the DuckDB child as the source requires. No
libsqlite3 container or timing measurement in a label was found. The measurement document retains historical
provenance and the caveat that a bounded plan is not a wall-clock guarantee.

Diagrams have plain and STE draft documents, legends and available context → container → component detail
links. Inventories cover every element/relationship and document the cross-view abstraction choices, including
sibling containers' external tags and the SDK-as-supporting-system conversion. PG-02 views are explicitly
deferred, not acceptance failures.

Source validation: all **29 source records** have commit-pinned GitHub URLs. For each parsed URL I ran
`git cat-file -e <sha>:<path>`; all succeed, and the source files read for comparison are from those commits.
Current uses `2d30330ed2c0aa967fb737827e43a7cbb8714e59`; proposal diagrams use
`81d9936df084763c1577f37bd844b4ff00b95fdc`, with separately pinned study and landed-FFI references.

All **27 distinct URLs** additionally returned HTTP **200** to parallel Python urllib HEAD requests (20-second
timeout, eight workers); results are in `/tmp/pg01-review/urls.log`.

## Viewer and workflow

In addition to the six passing repository Playwright tests, I ran:

```sh
cd pages
npm run preview -- --host 127.0.0.1 --port 4327 --strictPort
node /tmp/pg01-review/browser.mjs
```

The scratch browser script imports Chromium from `/root/Software/c4-sdk/node_modules/playwright/index.mjs`,
loads the production site under `/ts-db/`, waits for `[data-layout-ready]`, reloads every valid route, and
asserts the missing-route text.

```text
architectures/tsdb-current/diagrams/components-server 1 canvases
architectures/tsdb-ffi-proposal/diagrams/ffi-containers 1 canvases
compare/context/ffi-context 2 canvases
missing diagram: Not Found; page errors: []
```

Captured and inspected full-page screenshots at 1600×1000 and 390×844: `/tmp/pg01-review/compare.png`,
`/tmp/pg01-review/narrow.png`. Desktop has two separate canvases; narrow layout stacks the panes. Canvases
show a zoomed/pannable portion of the graph with Fit controls; the relationship text alternatives and
explanation panels remain available. No claim of automated exhaustive visual accessibility testing.

Workflow inspection: main push/manual dispatch, Node 22, lockfile cache, npm ci/typecheck/tests, and the same
`npm run build` command. Upload is `pages/dist`, with only the specified index-to-404 copy added.
configure-pages@v5 has no enablement option, API call, or repository-setting mutation. Upload/deploy actions
match the brief. No actual deployment or Pages enablement was attempted.

## Limits and hand-offs

- PG-03 package installation and hosted GitHub Actions execution were not performed. They are outside this
  read-only review; deployment remains the documented human gate.
- No ts-db runtime test suite was run: the requested root acceptance checks are fmt/lint/typecheck.
- STE texts remain declared drafts; this is not an ASD-STE100 certification.
- Coordinator: assign the one-line README correction to a fresh repair unit and independently review its
  delta. No product change was made here.
- Learning assessment: the formatter trap is already recorded in project knowledge, so no new knowledge file
  is needed. The existing c4-sdk sibling-container/external-tag hand-off remains relevant but is not a PG-01
  blocker. Scratch scripts and screenshots are review evidence, not new maintained tooling.
- Leave this review worktree for coordinator inspection and cleanup. No merge or main push is authorized by
  this verdict.

## Independent comparison command

Executed `python3 /tmp/pg01-review/fidelity.py` with the following scratch script; all assertions passed. The
initial scratch-parser runs needed two corrections (heading splitting and limiting the proposed FFI fold to
the proposed view); these were reviewer-script errors, not product failures.

```python
import json,re,subprocess,pathlib
pairs=[('tsdb-current','2d30330','docs/architecture/', [('context','c4-context-document-db'),('containers-platform','c4-container-platform'),('containers-observability','c4-container-observability'),('components-server','c4-component-server')]),('tsdb-ffi-proposal','81d9936','docs/plans/ffi/', [('ffi-context','c4-context-ffi'),('ffi-containers','c4-container-ffi')])]
for dataset,sha,base,views in pairs:
 b=json.load(open('pages/public/architectures/'+dataset+'.json')); inv=pathlib.Path('pages/content/'+dataset+'/inventory.md').read_text()
 elements={e['id']:e for e in b['model']['elements']}; rels={e['id']:e for e in b['model']['relationships']}
 for did,stem in views:
  g,t=[subprocess.check_output(['git','show',sha+':'+base+stem+'.'+suffix+'.md'],text=True) for suffix in ['github','terminal']]
  rows=lambda text:[tuple(x.strip() for x in line.strip('|').split('|')) for line in text.splitlines() if re.match(r'^\|\s*\d+\s*\|',line)]
  assert rows(g)==rows(t),stem
  nodes=re.findall(r'^\s+(\w+)\["([^"]+)"\]',g,re.M)
  d=next(d for d in b['diagrams'] if d['id']==did)
  section=inv.split('→ diagram `'+did+'`')[1].split('\n## ')[0]
  mapping={}
  for line in section.splitlines():
   cols=[c.strip() for c in line.strip('|').split('|')]
   if len(cols)>2 and re.fullmatch(r'`\w+`',cols[0]) and cols[2].startswith('`'):
    mapping[cols[0].strip('`')]=cols[2].strip('`')
  for sid,label in nodes:
   if dataset=='tsdb-ffi-proposal' and sid=='ffi': continue
   assert sid in mapping,(did,sid)
   assert mapping[sid] in [n['elementId'] for n in d['nodes']],(did,sid)
  assert len(nodes)-(did=='ffi-containers')==len(d['nodes']),did
  edges={e['displayNumber']:rels[e['relationshipId']] for e in d['edges']}
  for num,fr,to,label in rows(g):
   n=int(num)
   if did=='ffi-containers' and n==5:
    assert label.replace(' (planned)','')==edges[6]['technology']; continue
   r=edges[n]
   expected=label.replace(' (planned)','') if dataset.endswith('proposal') else label
   if did=='ffi-containers' and n==7: expected='Reads and serialized mutations through the FFI binding (today; moves into the lanes)'
   assert r['label']==expected,(did,n,r['label'],expected)
  for sid,arrow,num,target in re.findall(r'^\s+(\w+)\s+(-->|-\.->)\|"\((\d+)\).*?"\| (\w+)',g,re.M):
   n=int(num)
   if did=='ffi-containers' and n==5:continue
   source=mapping[sid] if not (did=='ffi-containers' and sid=='ffi') else 'lanes'
   assert (edges[n]['sourceId'],edges[n]['targetId'])==(source,mapping[target]),(did,n)
  print(did,': source nodes',len(nodes),'->',len(d['nodes']),'bundle nodes; source edges',len(rows(g)),'->',len(edges),'bundle edges; both formats agree; labels/endpoints/numbers match documented conversions')
 assert all('`'+x['id']+'`' in inv for x in [*elements.values(),*rels.values()])
 if dataset=='tsdb-current':assert all(x['status']=='existing' for x in [*elements.values(),*rels.values()])
 for x in [*elements.values(),*rels.values()]:
  assert not re.search(r'\d+\s*(?:ms|µs|seconds)\b',x.get('label','')+x.get('name',''))
  if x['status']=='mixed': assert x['plannedNotes']
 print(dataset,': inventory complete; statuses, mixed notes and timing-label check passed')
```
