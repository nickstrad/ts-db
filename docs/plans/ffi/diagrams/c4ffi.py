#!/usr/bin/env python3
"""Shared generator for the FFI design's C4 diagrams (docs/plans/ffi/).

Same two formats and the same conventions as docs/architecture/ (see docs/architecture/AGENTS.md),
reusing its `canvas.py` drawer. The one addition is a per-node and per-edge `planned` flag, because
these diagrams describe a proposed design: anything not on `main` carries the literal word
"(planned)" in its label, a dashed box in the terminal format, and the `planned` class or a dashed
edge in the Mermaid format.

Node tuple:  (id, title, kind, path, detail, inside_boundary, planned)
Edge tuple:  (from_id, to_id, label, planned)
"""
import sys
from html import escape
from pathlib import Path
from textwrap import wrap

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'architecture' / 'diagrams'))
from canvas import Canvas  # noqa: E402

HEADER = ('Proposed design, not landed code: the FFI execution layer from '
          '[lang-switch-fable.md](../../architecture/lang-switch-fable.md) combined with the scale-out '
          'pick F from [scale-out-final-fable.md](../../architecture/scale-out-final-fable.md). Baseline '
          '`main` at `e808983` (2026-10-12). Solid boxes and solid edges exist on `main`; dashed boxes '
          'and dashed edges marked **(planned)** do not. Both formats are generated from '
          '`diagrams/{name}.py`; numbered relationships are identical.')


def picture(nodes, boundary):
    cv = Canvas(width=72, height=320)
    row = 2
    for inside in (True, False):
        group = [n for n in nodes if n[5] == inside]
        if not inside:
            cv.frame(0, 0, row, 71, boundary)
            row += 2
        for offset in range(0, len(group), 2):
            bottoms = []
            for col, (_, title, kind, path, detail, _, planned) in enumerate(group[offset:offset + 2]):
                lines = [part for line in [title, '[' + kind + ']', path, detail]
                         for part in wrap(line, 28, break_on_hyphens=False)]
                bottoms.append(cv.box(row, 3 + col * 35, 32, lines, planned=planned))
            row = max(bottoms) + 2
    return cv.render()


def mermaid(nodes, edges, boundary):
    lines = ['flowchart TB', '    subgraph platform["' + boundary + '"]']
    for inside in (True, False):
        for id, title, kind, path, detail, within, _ in nodes:
            if within == inside:
                label = '<br/>'.join(escape(s, quote=True) for s in [title, '[' + kind + ']', path, detail])
                lines.append('        ' + id + '["' + label + '"]')
        if inside:
            lines.append('    end')
    for i, (a, b, label, planned) in enumerate(edges, 1):
        arrow = '-.->' if planned else '-->'
        suffix = ' (planned)' if planned else ''
        lines.append(f'    {a} {arrow}|"({i}) {label}{suffix}"| {b}')
    lines += ['    classDef planned stroke-dasharray: 5 3',
              '    classDef person fill:#fff,stroke-width:2px',
              '    classDef external fill:#f4f4f4']
    for id, _, kind, _, _, inside, planned in nodes:
        if planned:
            lines.append(f'    class {id} planned')
        elif kind == 'Person':
            lines.append(f'    class {id} person')
        elif not inside:
            lines.append(f'    class {id} external')
    return '\n'.join(lines)


def document(github, name, title, boundary, nodes, edges, notes):
    text = '# ' + title + '\n\n' + HEADER.format(name=name) + '\n\n'
    if github:
        text += '```mermaid\n' + mermaid(nodes, edges, boundary) + '\n```\n'
    else:
        text += '<!-- c4-render: diagrams/' + name + '.py -->\n\n```text\n' + picture(nodes, boundary) + '\n```\n'
    names = {n[0]: n[1] for n in nodes}
    text += '\n## Relationships\n\n| # | From | To | Relationship |\n| - | --- | --- | --- |\n'
    for i, (a, b, label, planned) in enumerate(edges, 1):
        text += f'| {i} | {names[a]} | {names[b]} | {label}{" (planned)" if planned else ""} |\n'
    return text + '\n## Runtime notes\n\n' + notes + '\n'


def main(name, title, boundary, nodes, edges, notes):
    if '--github' in sys.argv:
        print(document(True, name, title, boundary, nodes, edges, notes), end='')
    elif '--terminal' in sys.argv:
        print(document(False, name, title, boundary, nodes, edges, notes), end='')
    else:
        print(picture(nodes, boundary))
