#!/usr/bin/env python3
"""Current C4 model; see the Markdown key for every relationship."""
from canvas import Canvas
cv = Canvas(width=72, height=250)
row = 2
row = cv.box(row, 3, 66, ['Document DB [Software system]', 'platform/server.ts + platform/reader.ts']) + 2
cv.frame(0, 0, row - 1, 71, 'Document DB platform')
row += 2
row = cv.box(row, 3, 66, ['App developer [Person]', 'app/schema.ts and app/functions.ts']) + 2
row = cv.box(row, 3, 66, ['Player / API caller [Person]', 'sdk/client.ts; scripts/demo.ts']) + 2
row = cv.box(row, 3, 66, ['Operator [Person]', 'Admin backups and offline restore']) + 2
row = cv.box(row, 3, 66, ['Object storage [External system]', 'S3 bucket or local object-store directory']) + 2
row = cv.box(row, 3, 66, ['DuckDB analyst [External system]', 'scripts/duckdb/*.sql over explicitly ingested logs']) + 2
row = cv.box(row, 3, 66, ['k6 load generator [External system]', 'perf/smoke.js and load scenarios']) + 2
print(cv.render())
