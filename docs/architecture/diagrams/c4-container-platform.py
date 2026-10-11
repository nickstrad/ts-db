#!/usr/bin/env python3
"""Current C4 model; see the Markdown key for every relationship."""
from canvas import Canvas
cv = Canvas(width=72, height=250)
row = 2
row = cv.box(row, 3, 66, ['Server [Deno process]', 'platform/server.ts; HTTP on 127.0.0.1:8000']) + 2
row = cv.box(row, 3, 66, ['Reader [Deno child process]', 'platform/reader.ts; serialized query handlers']) + 2
row = cv.box(row, 3, 66, ['App databases [SQLite WAL files]', 'DATA_DIR/appId.sqlite; columns and JSON layouts']) + 2
cv.frame(0, 0, row - 1, 71, 'Document DB deployment')
row += 2
row = cv.box(row, 3, 66, ['Typed client SDK [Caller library]', 'sdk/client.ts; type-only app handler imports']) + 2
row = cv.box(row, 3, 66, ['Object storage [External system]', 'S3_BASE_URL bucket or LOCAL_OBJECT_DIR']) + 2
print(cv.render())
