#!/usr/bin/env python3
"""Generated-box source; relationships are numbered in the companion Markdown key."""
from canvas import Canvas
from textwrap import wrap

NODES = [('server',
  ['Server process',
   '[Deno process]',
   'platform/server.ts',
   'LoggingLive (items 11, 22)',
   'HTTP, handler, SQL, tx, queue, backup and lifecycle records; hourly ingest timer (item 32)'],
  False,
  True),
 ('reader',
  ['Reader process',
   '[Deno child process]',
   'platform/reader.ts',
   'Root: reader_layers.ts (item 33)',
   'LoggingReaderLive (16); query SQL, tx and lifecycle records; hosts ingest-then-sweep'],
  False,
  True),
 ('jsonl',
  ['JSONL log directories',
   '[filesystem] (item 11)',
   '<LOG_DIR>/<role>/<date>/',
   'events-<HH>-<pid>-',
   '<seq>.jsonl',
   'Roles: server, reader. rejected.jsonl beside a source holds quarantined lines'],
  False,
  True),
 ('duck',
  ['Event-log artifact',
   '[DuckDB file] (items 21, 33, 35)',
   'EVENTLOG_DUCKDB',
   'Default: <DATA_DIR>/eventlog.duckdb',
   'Schema v2; derived from JSONL; opened by the reader on the first ingest; never pruned'],
  False,
  True),
 ('results',
  ['k6 results', '[filesystem] (03, 14)', 'logs/k6/<run-id>/', 'raw.json, summary.json'],
  False,
  True),
 ('cli',
  ['Logs CLI + analysis catalog',
   '[planned] (item 23)',
   'scripts/logs.ts',
   'platform/analysis/catalog.ts',
   'Absent; analysis RPC answers UnknownAnalysisQuery'],
  True,
  True),
 ('k6',
  ['k6 load generator', '[External process]', 'perf/*.js', 'HTTP scenarios; JSON output'],
  False,
  False)]
TITLE = 'Platform observability - files and processes'

cv = Canvas(width=72, height=180)
row = 2
for inside in (True, False):
    group = [node for node in NODES if node[3] == inside]
    if not inside:
        cv.frame(0, 0, row, 71, TITLE)
        row += 2
    for offset in range(0, len(group), 2):
        bottoms = []
        for column, (_, lines, planned, _) in enumerate(group[offset:offset + 2]):
            wrapped = [
                part for line in lines
                for part in (wrap(line, 28, break_on_hyphens=False) or [""])
            ]
            bottoms.append(cv.box(row, 3 + column * 35, 32, wrapped, planned=planned))
        row = max(bottoms) + 2
print(cv.render())
