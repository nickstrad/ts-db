#!/usr/bin/env python3
"""Generate both C4 Markdown formats for docs/plans/ffi/ from their Python sources; --check verifies.

A copy of docs/architecture/diagrams/render.py pointed at this folder, so the FFI design's diagrams
follow the same generated-not-hand-edited rule. The drawer itself is shared (canvas.py is imported from
docs/architecture/diagrams by c4ffi.py).
"""
from pathlib import Path
import subprocess
import shutil
import sys

DOCS = Path(__file__).resolve().parent.parent


def main():
    check = '--check' in sys.argv[1:]
    stale = []
    deno = Path.home() / '.deno/bin/deno'
    deno_cmd = shutil.which('deno') or (str(deno) if deno.exists() else 'deno')
    for source in sorted((DOCS / 'diagrams').glob('c4-*.py')):
        for kind in ('github', 'terminal'):
            out = subprocess.check_output([sys.executable, str(source), '--' + kind], text=True)
            out = subprocess.check_output([deno_cmd, 'fmt', '--ext', 'md', '-'], input=out, text=True)
            target = DOCS / (source.stem + '.' + kind + '.md')
            if target.exists() and target.read_text() == out:
                continue
            if check:
                stale.append(target.name)
            else:
                target.write_text(out)
                print('updated ' + target.name)
    if stale:
        print('stale diagrams: ' + ', '.join(stale))
        return 1
    print('all diagrams current' if check else 'done')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
