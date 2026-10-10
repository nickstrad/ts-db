#!/usr/bin/env python3
"""Regenerate the terminal-format diagram embeds in docs/architecture/*.terminal.md.

Each embed is marked in the Markdown like this:

    <!-- c4-render: diagrams/c4-context-document-db.py -->
    ```text
    (generated; do not hand-edit)
    ```

Usage, from the repo root:

    python3 docs/architecture/diagrams/render.py           # rewrite every embed
    python3 docs/architecture/diagrams/render.py --check   # fail if any embed is stale

`--check` is what proves a diagram has not drifted from its source. It does not, and cannot,
prove the diagram still matches the code - that is the reviewer's job (see AGENTS.md).
"""

import re
import subprocess
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent
MARKER = re.compile(r"^<!-- c4-render: (\S+) -->$", re.MULTILINE)


def generate(source: Path) -> str:
    result = subprocess.run(
        [sys.executable, str(source)], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        sys.exit(f"{source.name} failed:\n{result.stderr}")
    return result.stdout.rstrip("\n")


def rewrite(text: str, doc: Path) -> str:
    out = []
    pos = 0
    for match in MARKER.finditer(text):
        rel = match.group(1)
        source = (doc.parent / rel).resolve()
        if not source.is_file():
            sys.exit(f"{doc.name}: marker points at missing source {rel}")
        fence = text.find("```text\n", match.end())
        if fence == -1:
            sys.exit(f"{doc.name}: no ```text block after the {rel} marker")
        body = fence + len("```text\n")
        end = text.find("```", body)
        if end == -1:
            sys.exit(f"{doc.name}: unterminated ```text block for {rel}")
        out.append(text[pos:body])
        out.append(generate(source) + "\n")
        pos = end
    out.append(text[pos:])
    return "".join(out)


def main() -> int:
    check = "--check" in sys.argv[1:]
    docs = sorted(DOCS.glob("*.terminal.md"))
    if not docs:
        sys.exit(f"no *.terminal.md files under {DOCS}")
    stale = []
    for doc in docs:
        before = doc.read_text()
        after = rewrite(before, doc)
        if before == after:
            continue
        if check:
            stale.append(doc.name)
        else:
            doc.write_text(after)
            print(f"updated {doc.name}")
    if stale:
        print("stale embeds (run without --check to regenerate): " + ", ".join(stale))
        return 1
    print("all embeds current" if check else "done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
