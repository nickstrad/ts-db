#!/usr/bin/env python3
"""Generated-box source; relationships are numbered in the companion Markdown key."""
from canvas import Canvas
from textwrap import wrap

NODES = [('server',
  ['Server process',
   '[Deno process]',
   'platform/server.ts',
   'LoggingLive (items 11, 22)',
   'HTTP, SQL, tx, queue, backup and lifecycle records'],
  False,
  True),
 ('reader',
  ['Reader process',
   '[Deno child process]',
   'platform/reader.ts',
   'LoggingReaderLive (16)',
   'Query SQL, tx and lifecycle records; no ingest wiring'],
  False,
  True),
 ('jsonl',
  ['JSONL log directories',
   '[filesystem] (item 11)',
   '<LOG_DIR>/<role>/<date>/',
   'events-<HH>-<pid>-',
   '<seq>.jsonl',
   'Runtime roles: server, reader'],
  False,
  True),
 ('duck',
  ['Event-log artifact',
   '[DuckDB file] (item 21)',
   'EVENTLOG_DUCKDB',
   'Default: <DATA_DIR>/eventlog.duckdb',
   'Created when ingest service is explicitly built; not by entrypoints'],
  False,
  True),
 ('results',
  ['k6 results', '[filesystem] (03, 14)', 'logs/k6/<run-id>/', 'raw.json, summary.json'],
  False,
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
