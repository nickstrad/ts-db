#!/usr/bin/env python3
"""Current C4 model; see the Markdown key for every relationship."""
from canvas import Canvas
cv = Canvas(width=72, height=250)
row = 2
row = cv.box(row, 3, 66, ['Server [Deno process]', 'platform/server.ts; compatibility logging to stderr']) + 2
row = cv.box(row, 3, 66, ['Reader [Deno child process]', 'platform/reader.ts; LoggingReaderLive + ConfigLive']) + 2
row = cv.box(row, 3, 66, ['JSONL log directory [Filesystem]', 'LOG_DIR/reader/YYYY-MM-DD/events-HH-pid-seq.jsonl']) + 2
row = cv.box(row, 3, 66, ['Process stderr [Output stream]', 'Optional server SQL traces; IPC warnings and errors']) + 2
row = cv.box(row, 3, 66, ['Explicit ingest caller [Deno process]', 'Composes platform/eventlog/ingest.ts manually']) + 2
row = cv.box(row, 3, 66, ['Event-log database [DuckDB file]', 'EVENTLOG_DUCKDB; default DATA_DIR/eventlog.duckdb']) + 2
row = cv.box(row, 3, 66, ['k6 results [Filesystem]', 'logs/k6/run-id/raw.json and summary.json']) + 2
cv.frame(0, 0, row - 1, 71, 'Document DB observability')
row += 2
row = cv.box(row, 3, 66, ['DuckDB analyst [External system]', 'scripts/duckdb/*.sql; after ingest closes writer']) + 2
row = cv.box(row, 3, 66, ['k6 binary [External system]', 'perf/smoke.js and perf load scenarios']) + 2
print(cv.render())
