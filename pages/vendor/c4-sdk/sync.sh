#!/usr/bin/env bash
# Interim c4-sdk copy for the ts-db Pages site (see PROVENANCE.md and ../../README.md).
#
# Re-creates this directory's copied files from ONE upstream c4-sdk commit and applies the
# only post-processing ts-db needs: the root `deno fmt --check` and `deno lint` scan pages/,
# and deno.json is frozen, so the copy must satisfy them as-is.
#
#   sync.sh <40-hex-sha>          replace the copy with that commit (then update PROVENANCE.md)
#   sync.sh --check [<sha>]       rebuild in a temp dir and diff against the committed copy;
#                                 <sha> defaults to the "Upstream commit" line in PROVENANCE.md;
#                                 exits 1 on any difference
#
# Post-processing, in order (deterministic for a given deno version):
#   1. deno fmt with the ts-db root deno.json (lineWidth 110) over every copied file;
#   2. deno lint with the same config; each .ts/.tsx file that still reports diagnostics gets
#      ONE first line `// deno-lint-ignore-file <rule> ...` naming exactly the rules that fired;
#   3. both tools are re-run and must pass.
# No other edit is made. Hand edits to the copied files are forbidden: --check would fail.
#
# Environment:
#   C4_SDK_REPO  local c4-sdk clone holding the commit (default /root/Software/c4-sdk)
#   C4_SDK_URL   fetched shallowly when C4_SDK_REPO is not a git repository
#                (default https://github.com/nickstrad/c4-sdk.git)
set -euo pipefail
export LC_ALL=C NO_COLOR=1

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
config="$root/deno.json"
repo="${C4_SDK_REPO:-/root/Software/c4-sdk}"
url="${C4_SDK_URL:-https://github.com/nickstrad/c4-sdk.git}"
copied=(src/index.ts src/core src/lib/c4 LICENSE THIRD_PARTY_NOTICES.md)

die() {
  printf 'sync.sh: %s\n' "$*" >&2
  exit 2
}

[[ -f $config ]] || die "ts-db root deno.json not found at $config"
command -v deno >/dev/null || die "deno is not on PATH (export PATH=\"\$HOME/.deno/bin:\$PATH\")"
command -v jq >/dev/null || die "jq is not on PATH"

mode=sync
if [[ ${1:-} == --check ]]; then
  mode=check
  shift
fi
sha="${1:-}"
if [[ -z $sha && $mode == check ]]; then
  sha="$(sed -nE 's/^- Upstream commit: `([0-9a-f]{40})`.*$/\1/p' "$here/PROVENANCE.md" | head -n 1)"
fi
[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "need a full 40-hex upstream commit SHA (got '${sha}')"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
out="$work/copy"
mkdir -p "$out"

# 1. Export exactly the copied paths at that commit.
source_repo="$repo"
if ! git -C "$source_repo" rev-parse --git-dir >/dev/null 2>&1; then
  source_repo="$work/upstream"
  git init -q "$source_repo"
  git -C "$source_repo" fetch -q --depth 1 "$url" "$sha"
fi
git -C "$source_repo" cat-file -e "${sha}^{commit}" 2>/dev/null ||
  die "commit $sha is not in $source_repo; run: git -C $source_repo fetch origin"
git -C "$source_repo" archive --format=tar "$sha" -- "${copied[@]}" | tar -x -C "$out"

# 2. Format with the root configuration.
deno fmt --quiet --config "$config" "$out"

# 3. Name the lint rules that still fire, per file, in a first-line ignore directive.
lint_json="$(deno lint --config "$config" --json "$out" 2>/dev/null || true)"
[[ "$(jq '.errors | length' <<<"$lint_json")" == 0 ]] || die "deno lint could not parse the copy: $lint_json"
headers="$work/headers.tsv"
jq -r '.diagnostics | group_by(.filename) | .[]
  | [(.[0].filename | sub("^file://"; "")), ([.[].code] | unique | join(" "))] | @tsv' \
  <<<"$lint_json" >"$headers"
while IFS=$'\t' read -r file rules; do
  [[ -n $file ]] || continue
  { printf '// deno-lint-ignore-file %s\n' "$rules"; cat -- "$file"; } >"$file.next"
  mv -- "$file.next" "$file"
done <"$headers"

# 4. Both root tools must now accept the copy unchanged.
deno fmt --quiet --config "$config" "$out"
deno fmt --quiet --check --config "$config" "$out" || die "copy is not fmt-clean after post-processing"
deno lint --quiet --config "$config" "$out" || die "copy is not lint-clean after post-processing"

count="$(find "$out" -type f | wc -l | tr -d ' ')"
if [[ $mode == check ]]; then
  if diff -ru -x sync.sh -x PROVENANCE.md -- "$out" "$here"; then
    printf 'sync.sh --check: zero diff against c4-sdk %s (%s files; %s with a lint-ignore header)\n' \
      "$sha" "$count" "$(wc -l <"$headers" | tr -d ' ')"
  else
    printf 'sync.sh --check: the committed copy differs from c4-sdk %s after post-processing\n' "$sha" >&2
    exit 1
  fi
else
  rm -rf -- "$here/src" "$here/LICENSE" "$here/THIRD_PARTY_NOTICES.md"
  cp -R -- "$out/." "$here/"
  printf 'sync.sh: copied c4-sdk %s (%s files). Lint-ignore headers:\n' "$sha" "$count"
  sed "s|^$out/||" "$headers"
  printf 'Update PROVENANCE.md (Upstream commit line, date, counts) to match.\n'
fi
