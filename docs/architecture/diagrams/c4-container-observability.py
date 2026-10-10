#!/usr/bin/env python3
"""Source for c4-container-observability.terminal.md (C4 Level 2 — Container, log path)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from canvas import Canvas  # noqa: E402

cv = Canvas(width=72, height=50)

SRV, RDR = 17, 54

srv_bottom = cv.box(2, 3, 30, [
    "Server process",
    "[Deno process]",
    "",
    "emits http, sql, tx,",
    "queue, backup and",
    "lifecycle events; runs",
    "the retention sweeper",
    "(item 24)",
], bottom=(14,))
cv.box(2, 40, 30, [
    "Reader process",
    "[Deno child process]",
    "",
    "emits sql, tx and",
    "ingest events; owns the",
    "only DuckDB handle, so",
    "it also runs the",
    "event-log ingest",
], bottom=(14,))

row = cv.down(srv_bottom + 1, SRV, "(1)")
cv.down(srv_bottom + 1, RDR, "(2)")

jsonl_bottom = cv.box(row, 3, 67, [
    "JSONL log directories                   [filesystem] (item 11)",
    "<LOG_DIR>/<role>/<YYYY-MM-DD>/events-<HH>-<pid>-<seq>.jsonl",
    "",
    "role = server | reader | restore | cli. One JSON object per",
    "line. Rolls on date, hour or 64 MiB. Sweep (item 24, planned):",
    "gzip after 7 days, keep 30 days, 1 GiB cap; today's dir kept.",
    "Written by platform/logging/{logger,file_sink}.ts; mounted by",
    "the reader entrypoint since item 16; server mounts in item 22.",
], top=(14, 51), bottom=(51,))

row = cv.down(jsonl_bottom + 1, RDR, "(3)")

cv.box(row, 3, 30, [
    "k6 results  (items",
    "03, 14) [filesystem]",
    "",
    "logs/k6/<run-id>/",
    "raw.json, summary.json",
    "written by the k6",
    "binary, not by Deno",
], right=(4,))
duck_bottom = cv.box(row, 40, 30, [
    "DuckDB event log",
    "(item 21) [DuckDB file]",
    "",
    "EVENTLOG_DUCKDB, default",
    "<DATA_DIR>/eventlog.duckdb",
    "append-only tables plus",
    "_ingest_state offsets;",
    "INSERT only",
], planned=True, top=(14,), bottom=(14,))
cv.right(row + 4, 33, 39, "(4)")

row = cv.up(duck_bottom + 1, RDR, "(5)")

cli_bottom = cv.box(row, 40, 30, [
    "logs CLI   (item 23)",
    "scripts/logs.ts",
    "",
    "ingest | query | list |",
    "sweep. Named analysis",
    "queries only - never",
    "caller-supplied SQL",
], planned=True, top=(14,))

cv.frame(0, 0, cli_bottom + 2, 71, "Document DB platform - observability path")

print(cv.render())
