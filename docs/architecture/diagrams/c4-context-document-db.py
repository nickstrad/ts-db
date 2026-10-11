#!/usr/bin/env python3
"""Source for c4-context-document-db.terminal.md (C4 Level 1 — System Context)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from canvas import Canvas  # noqa: E402

cv = Canvas(width=70, height=34)

# Three columns of width 22, gap 2: centres at 11, 35 and 59.
C1, C2, C3 = 11, 35, 59

cv.box(0, 0, 22, [
    "App developer",
    "[Person]",
    "",
    "declares a schema",
    "and the handlers",
    "in app/; runs it",
], bottom=(11,))
cv.box(0, 24, 22, [
    "Player",
    "[Person]",
    "",
    "plays tic-tac-toe",
    "via the sample app",
    "or the CLI demo",
], bottom=(11,))
cv.box(0, 48, 22, [
    "Platform operator",
    "[Person]",
    "",
    "triggers backups;",
    "inspects logs with",
    "offline SQL tools",
], bottom=(11,))

cv.down(8, C1, "(1)")
cv.down(8, C2, "(2)")
cv.down(8, C3, "(3)")

system_bottom = cv.box(10, 0, 70, [
    "Document DB platform                            [this system]",
    "",
    "Deno + TypeScript document database. An app declares a schema",
    "and named handlers; the platform compiles document operations",
    "to SQLite SQL for writes and DuckDB SQL for reads. A caller",
    "sends a handler name and JSON args - never SQL.",
], top=(C1, C2, C3), bottom=(C1, C2, C3))

cv.down(system_bottom + 1, C1, "(4)")
cv.down(system_bottom + 1, C2, "(5)")
cv.up(system_bottom + 1, C3, "(6)")

row = system_bottom + 3
cv.box(row, 0, 22, [
    "S3-compatible",
    "object storage",
    "[External system]",
    "",
    "immutable snapshot",
    "+ manifest objects",
], top=(11,))
cv.box(row, 24, 22, [
    "DuckDB analytics",
    "consumer",
    "[External system]",
    "",
    "SQL on JSONL;",
    "tables post-ingest",
], top=(11,))
cv.box(row, 48, 22, [
    "k6 load generator",
    "[External system]",
    "",
    "k6 v0.56.0; smoke,",
    "mutation, query,",
    "mixed (03 and 14)",
], top=(11,))

print(cv.render(limit=70))
