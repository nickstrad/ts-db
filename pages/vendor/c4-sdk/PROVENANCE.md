# Provenance of the interim c4-sdk copy

This directory is a **temporary, ts-db-owned copy** of the c4-sdk source, used by the Pages site until c4-sdk
`0.1.0` is published to npm (Nick's direction, relayed by Twin on 2026-10-14). It is consumed only through the
package specifiers `c4-sdk`, `c4-sdk/core` and `c4-sdk/styles.css`, mapped to this copy by
`pages/vite.config.ts` and `pages/tsconfig*.json`, from the single module `pages/src/sdk.ts`. Nothing else in
ts-db imports it. At the swap, delete this whole directory: see
[`pages/README.md`, "Swap to the npm package"](../../README.md#swap-to-the-npm-package).

## Upstream

- Upstream repository: <https://github.com/nickstrad/c4-sdk> (local clone `/root/Software/c4-sdk`), branch
  `main`.
- Upstream commit: `a1929e43b4f72229524f2ee24a7e88de10ce8879`
- Commit subject and date: "docs: record package review and bundler lessons", 2026-10-15T00:01:58Z. It
  contains the landed P-02 package distribution (merge `393c5e9`); `package.json` there is version
  `0.1.0-beta.1`.
- Copied: 2026-10-15, by PG-01 (`opus-pg-01`, branch `item/pg-01-pages`), with `./sync.sh` in this directory.
- License: MIT, Copyright (c) 2026 Nick Strad ([`LICENSE`](LICENSE)); bundled third-party terms in
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Both are copied unchanged in content.

`sync.sh --check` reads the commit from the "Upstream commit" line above. Keep that line's format.

## What is copied (67 files)

| Upstream path            | Files | Role                                                                  |
| ------------------------ | ----: | --------------------------------------------------------------------- |
| `src/index.ts`           |     1 | The `c4-sdk` entry (React components, adapters, types)                |
| `src/core/**`            |     2 | The `c4-sdk/core` entry (decode, scene, navigation, types)            |
| `src/lib/c4/**`          |    62 | Everything both entries import, the layout worker and the stylesheets |
| `LICENSE`                |     1 | MIT license                                                           |
| `THIRD_PARTY_NOTICES.md` |     1 | Third-party license notices                                           |

That is 65 source files plus the two notices. (The PG plan's inventory said "`src/lib/c4/**` (63 files)"; the
tree at this commit has 62 there, and 65 source files in total, as the plan also says.) The copy imports only
`react`, `@xyflow/react` (and its `dist/style.css`), `elkjs/lib/elk-api` and `elkjs/lib/elk-worker.min.js`,
`zod`, `react-markdown` and `@base-ui/react/dialog`, pinned in `pages/package.json` to the versions c4-sdk's
lockfile resolves.

Not copied, on purpose: `src/App.tsx`, `src/main.tsx`, `src/components/`, `src/lib/utils.ts`, demos, tests,
fixtures, configuration and build scripts.

## Post-processing (the only changes to upstream bytes)

The ts-db root `deno fmt --check` and `deno lint` scan `pages/`, and `deno.json` is frozen, so the copy must
pass them as committed. `sync.sh` applies, in order, with deno 2.9.5 and the root `deno.json` (`lineWidth`
110, recommended lint rules):

1. `deno fmt` over every copied file (`.ts`, `.tsx`, `.css`, `.md`; `LICENSE` has no extension and is
   untouched). Formatting changes quotes, semicolons and line breaks, never behavior.
2. `deno lint`, then one first line `// deno-lint-ignore-file <rules>` in each file that still reports, naming
   exactly the rules that fired:

   | File                                               | Rules ignored                  |
   | -------------------------------------------------- | ------------------------------ |
   | `src/lib/c4/react/hooks/useDiagramMeasurements.ts` | `no-window` `no-window-prefix` |
   | `src/lib/c4/react/views/CanvasNode.tsx`            | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/ContextView.tsx`           | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/DeploymentTreeView.tsx`    | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/DiagramFallback.tsx`       | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/DocumentationView.tsx`     | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/NavigationView.tsx`        | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/StepControlsView.tsx`      | `jsx-button-has-type`          |
   | `src/lib/c4/react/views/StepListView.tsx`          | `jsx-button-has-type`          |

3. `deno fmt --check` and `deno lint` again; both must pass.

No file is edited by hand. A different deno version could format differently; then `sync.sh --check` reports
the difference, and re-running `sync.sh <commit>` with the new version and re-recording it here is the fix.

## Verify

```sh
export PATH="$HOME/.deno/bin:$PATH"
pages/vendor/c4-sdk/sync.sh --check       # zero diff against the commit above, or exit 1
```

`npm run check` in `pages/` runs the same check. It needs the upstream commit locally (`C4_SDK_REPO`, default
`/root/Software/c4-sdk`), or fetches it from `C4_SDK_URL` when that is not a git checkout.
