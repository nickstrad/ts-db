# PG-02b independent review — FAIL

Reviewer: Codex Astra, actor `astra-pg-02b-review`, 2026-10-15.
Reviewed `git diff f52c817 1017b81`, including builder `7a667a7` and coordinator metadata fixup
`1017b81`. Acceptance authority: Nick’s direction and amendment, read verbatim; builder brief and PG-02b
plan section also read. Product files were not edited.

## Findings

1. **P2 — Restore bounded streaming before lifting catalog metadata.** `pages/src/catalog.ts:31`
   calls `response.arrayBuffer()` before checking actual body size at line 34. If Content-Length is absent,
   understated, or describes a compressed response, the wrapper consumes the entire decoded response before
   the SDK can enforce its 262144-byte limit. Reproduction below supplies a stream without Content-Length:
   all 1048576 bytes are consumed, with no cancellation. The existing SDK reader instead checks each chunk
   and cancels as soon as the limit is exceeded. A stream that continues after crossing the limit keeps this
   wrapper waiting and buffering instead of promptly surfacing the size error. Finite oversized responses
   eventually produce the correct SDK error, but that does not preserve the resource bound.
   **Fix:** read incrementally with a bounded accumulator, cancel/release the original reader at the limit,
   and surface the same size error (or return a bounded oversized response for the SDK to reject). Preserve
   abort handling. Add tests for missing/understated Content-Length, early cancellation, invalid UTF-8/JSON,
   and finite oversized input. Do not edit the vendored SDK. This is a correctness finding about the new
   wrapper, not an ownership-policy objection.

## Explicit assessment of the SDK deviation

**FAIL on wrapper robustness because of finding 1; PASS on the injection design and mechanical swap.**
`loadArchitectures` now accepts a fetch function and creates its loader per call. This uses the existing public
`createFetchLoader` API. Imports remain `c4-sdk`, `c4-sdk/core`, and `c4-sdk/styles.css`; layout and hash route
ports are unchanged. The in-memory route port is gone. No new deep SDK imports or vendor coupling were added.
Deleting the vendor copy, dropping aliases, installing the dependency, and wiring the worker factory remains
mechanical, subject to the README’s existing removal of the interim sync check.

A separate `site.json` would avoid response rewriting but adds another request/configuration source and
changes the explicit catalog-default contract. Ordering the catalog current-first is simpler but loses the
requested independent `defaultId` behavior. Neither is materially better enough to justify changing the
accepted contract here. Recommendation: retain fetch injection and `defaultId`, fix the bounded reader, and
cover it with focused regression tests. The duplicated size constant is a maintenance consideration for PG-03.

Non-catalog requests preserve the original input/init and Response identity (unit test passes). Other unknown
catalog keys still reach and fail the strict SDK schema. Invalid JSON and finite oversized catalogs surface
SDK errors in the browser, independently verified below. The defect is the buffering before those errors.

## Acceptance assessment

- **Scope PASS:** no changes under `pages/vendor/`, `pages/public/architectures/`, `pages/content/`, `.github/`,
  or `docs/`. Catalog diff adds only `defaultId`. Root README changes only its architecture-site section.
  The two coordinator metadata replacements remove stale framing and are appropriate. SDK deviation assessed
  above, rather than rejected merely for exceeding deletion-only ownership.
- **Direction PASS:** dropdown maps all entries by title, defaults to `defaultId`, and falls back to first
  entry when absent. Invalid explicit defaults report an authoring error, as documented. Single provider/view;
  no comparison route, pairing logic, or in-memory port remains. Old comparison URLs independently return
  Not Found. Bundle statuses and historical inventory text are byte-unchanged.
- **N=3 PASS:** unit and browser fixtures use both real bundles plus a tiny third bundle under tests only;
  third entry is the default, proving this is not first-entry coincidence. App loading, selection, and
  recovery links iterate/search the catalog; no production path hardcodes two entries.
- **Sticky chrome PASS:** branch smoke passed; independent production-preview checks at 1280×720 and 390×720
  scrolled the lanes-components page to its midpoint. Dropdown and Back were wholly inside the viewport;
  switching to current and Back from mid-page worked. Screenshots were captured and visually inspected.
  At 1280px dropdown y=13.5, Back y=13, scrollY=1968; at 390px dropdown y=9, Back y=58, scrollY=1950.
- **Deep links PASS:** both architectures’ component diagrams reload with one finished canvas and the correct
  selected entry. Unknown architecture/diagram IDs show Not Found.
- **Known notes:** Chromium keyboard smoke passes; this does not establish other browsers’ native-select
  behavior. Long breadcrumbs extend into the horizontally scrollable bar (seen in screenshots); Back and Up
  remain visible at initial horizontal position. This is not a blocker to the specified sticky controls.
  Failure of any loaded bundle still stops the site as before; no unrelated redesign requested.

## Commands and trimmed outputs

All commands ran in this worktree, using:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.deno/bin:$PATH"
cd pages && npm ci && npm run check
```

```text
added 162 packages; audited 163; found 0 vulnerabilities
Typecheck: tsc -b, exit 0
Test Files 5 passed (5); Tests 103 passed (103)
vite v8.3.4: 632 modules transformed; built in 3.43s
sync.sh --check: zero diff against c4-sdk a1929e43b4f72229524f2ee24a7e88de10ce8879
67 files; 9 with a lint-ignore header
Playwright: 11 passed (33.4s)
```

At repo root:

```sh
deno task fmt:check && deno task lint && deno task check
```

```text
Task fmt:check deno fmt --check
Checked 357 files
Task lint deno lint
Checked 243 files
Task check deno check ...
All 11 configured entrypoints checked, exit 0
```

```sh
git diff --name-only f52c817 1017b81 -- pages/vendor pages/public/architectures pages/content .github docs
command grep -rni "PROPOSED_ID\|compare\|side by side\|current vs proposed" pages/src pages/tests pages/README.md pages/index.html pages/package.json
awk '/^## Architecture diagrams site/{p=1;next} /^## /{p=0} p' README.md | command grep -ni "PROPOSED_ID\|compare\|side by side\|current vs proposed"
git status --short
```

All print nothing (grep exit 1 means no matches). The unrelated k6 “compares” text is outside acceptance scope.

Independent stream reproduction, from repo root:

```sh
node --experimental-strip-types --input-type=module <<'JS'
import {liftDefaultId} from "./pages/src/catalog.ts";
let pulls=0, cancelled=false;
const stream=new ReadableStream({pull(c){pulls++; if(pulls<=16)c.enqueue(new Uint8Array(65536));else c.close();},cancel(){cancelled=true;}});
const lifted=liftDefaultId("/catalog.json",async()=>new Response(stream));
const response=await lifted.fetch("/catalog.json");
console.log(JSON.stringify({pulls,cancelled,bufferedBytes:(await response.arrayBuffer()).byteLength,limit:262144}));
JS
```

```text
{"pulls":17,"cancelled":false,"bufferedBytes":1048576,"limit":262144}
```

Independent browser preview, from `pages/`:

```sh
npx vite preview --base /ts-db/ --host 127.0.0.1 --port 4327 --strictPort
```

The following independent inline Playwright check used cached Chromium, against that preview:

```sh
node --input-type=module <<'JS'
import {chromium} from "@playwright/test";
import assert from "node:assert/strict";
const browser=await chromium.launch();
const base="http://127.0.0.1:4327/ts-db/";
for(const width of [1280,390]) {
 const page=await browser.newPage({viewport:{width,height:720}});
 const picker=page.getByRole("combobox",{name:"Architecture"});
 const back=page.getByRole("navigation",{name:"Diagram navigation"}).getByRole("button",{name:"Back"});
 await page.goto(base+"#/architectures/tsdb-lanes-proposal/diagrams/lanes-components");
 await page.locator("[data-layout-ready]").waitFor();
 await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight/2));
 await page.waitForTimeout(150);
 const bounds={width,scroll:await page.evaluate(()=>scrollY),picker:await picker.boundingBox(),back:await back.boundingBox()};
 for(const b of [bounds.picker,bounds.back]) assert(b && b.y>=0 && b.y+b.height<=720 && b.x>=0 && b.x+b.width<=width);
 assert(bounds.scroll>720);
 await page.screenshot({path:`/tmp/pg02b-review-${width}.png`});
 await picker.selectOption("tsdb-current");
 await page.waitForURL(/tsdb-current\/diagrams\/context$/);
 await page.locator("[data-layout-ready]").waitFor();
 await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight/2));
 await back.click();
 await page.waitForURL(/tsdb-lanes-proposal\/diagrams\/lanes-components$/);
 console.log("sticky/switch/Back PASS",JSON.stringify(bounds));
 await page.close();
}
const page=await browser.newPage();
for(const [id,diagram] of [["tsdb-current","components-server"],["tsdb-lanes-proposal","lanes-components"]]){
 await page.goto(base+`#/architectures/${id}/diagrams/${diagram}`);
 await page.locator("[data-layout-ready]").waitFor();
 await page.reload();await page.locator("[data-layout-ready]").waitFor();
 assert.equal(await page.getByRole("combobox").inputValue(),id);
 console.log("reload PASS",id,diagram);
}
for(const hash of ["#/architectures/nope/diagrams/context","#/architectures/tsdb-current/diagrams/nope","#/compare/context/lanes-context"]){
 await page.goto(base+hash);await page.getByText(/Not Found/).first().waitFor();console.log("Not Found PASS",hash);
}
for(const [name,body,headers] of [["invalid","{",{}],["oversize"," ".repeat(262145),{}],["unknown",JSON.stringify({defaultId:"x",entries:[],extra:true}),{}]]){
 await page.route("**/catalog.json",r=>r.fulfill({body,headers,contentType:"application/json"}));
 await page.goto(base);await page.getByRole("alert").waitFor();console.log(name,await page.getByRole("alert").innerText());
 await page.unroute("**/catalog.json");
}
await browser.close();
JS
```

The sticky checks passed at both widths. The reload loop passed for current, then this reviewer harness
failed because unlabelled `getByRole("combobox")` matched both Architecture and Document on the proposal.
This was a harness error, not a product failure. The remaining checks were rerun with the exact labelled
selector, as follows:

```sh
node --input-type=module <<'JS'
import {chromium} from "@playwright/test";
import assert from "node:assert/strict";
const browser=await chromium.launch();
try {
 const page=await browser.newPage();
 const base="http://127.0.0.1:4327/ts-db/";
 for(const [id,diagram] of [["tsdb-current","components-server"],["tsdb-lanes-proposal","lanes-components"]]){
  await page.goto(base+`#/architectures/${id}/diagrams/${diagram}`);
  await page.locator("[data-layout-ready]").waitFor();
  await page.reload();await page.locator("[data-layout-ready]").waitFor();
  assert.equal(await page.getByRole("combobox",{name:"Architecture",exact:true}).inputValue(),id);
  console.log("reload PASS",id,diagram);
 }
 for(const hash of ["#/architectures/nope/diagrams/context","#/architectures/tsdb-current/diagrams/nope","#/compare/context/lanes-context"]){
  await page.goto(base+hash);await page.getByText(/Not Found/).first().waitFor();console.log("Not Found PASS",hash);
 }
 for(const [name,body] of [["invalid","{"],["oversize"," ".repeat(262145)],["unknown",JSON.stringify({defaultId:"x",entries:[],extra:true})]]){
  await page.route("**/catalog.json",r=>r.fulfill({body,contentType:"application/json"}));
  await page.goto(base);await page.getByRole("alert").waitFor();console.log(name,await page.getByRole("alert").innerText());
  await page.unroute("**/catalog.json");
 }
} finally {await browser.close();}
JS
```

```text
reload PASS tsdb-current components-server
reload PASS tsdb-lanes-proposal lanes-components
Not Found PASS #/architectures/nope/diagrams/context
Not Found PASS #/architectures/tsdb-current/diagrams/nope
Not Found PASS #/compare/context/lanes-context
invalid: Resource is not valid UTF-8 JSON.
oversize: Resource exceeds the 262144-byte limit.
unknown: unrecognized_keys, keys [extra] (also empty entries validation error)
```

## Limits and hand-offs

No live Pages deployment, unpublished npm swap, Firefox/WebKit, or full root integration/performance suite
was exercised; this review ran the requested root checks and complete Pages checks. Screenshots are ephemeral
`/tmp/pg02b-review-1280.png` and `/tmp/pg02b-review-390.png`, visually inspected at both sizes.

Coordinator: assign finding 1 to a fresh repair unit and obtain a fresh delta review. Preserve in project
knowledge that fetch preprocessing must retain the SDK’s streaming resource bounds; metadata injection itself
requires no additional npm migration work. Update the existing knowledge index’s obsolete side-by-side site
description in the authorized docs follow-up. No environment knowledge or reusable work script was discovered;
review probes are specific to this item and are preserved above. Only this report is committed. Leave this
review worktree for coordinator inspection and subsequent removal; no landing or main push is performed.
