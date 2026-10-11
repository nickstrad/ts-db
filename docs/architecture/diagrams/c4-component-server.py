#!/usr/bin/env python3
"""Current C4 model; see the Markdown key for every relationship."""
from canvas import Canvas
cv = Canvas(width=72, height=250)
row = 2
row = cv.box(row, 3, 66, ['HTTP dispatch and shutdown [Component]', 'platform/server.ts; Deno.serve and backup timer']) + 2
row = cv.box(row, 3, 66, ['Static app registry [Component]', 'platform/registry.ts; loadApps and trace']) + 2
row = cv.box(row, 3, 66, ['SQLiteWriter facade [Component]', 'platform/sqlite.ts; scoped makeStorage per app']) + 2
row = cv.box(row, 3, 66, ['ReaderRPC facade [Component]', 'platform/ipc.ts; scoped makeReaderConnection']) + 2
row = cv.box(row, 3, 66, ['Backups facade [Component]', 'platform/backup.ts; makeBackupRunner']) + 2
row = cv.box(row, 3, 66, ['Object-store facade [Component]', 'platform/object_store.ts; ObjectStoreLive']) + 2
row = cv.box(row, 3, 66, ['Configuration [Component]', 'platform/config.ts; ConfigLive and legacy defaults']) + 2
row = cv.box(row, 3, 66, ['Pure kernel [Library]', 'core/schema.ts, plan.ts, compile/*, errors.ts, ipc/*']) + 2
cv.frame(0, 0, row - 1, 71, 'Server process: platform/server.ts')
row += 2
row = cv.box(row, 3, 66, ['App databases [SQLite WAL files]', 'DATA_DIR/appId.sqlite']) + 2
row = cv.box(row, 3, 66, ['Reader [Deno child process]', 'platform/reader.ts']) + 2
row = cv.box(row, 3, 66, ['Object storage [External system]', 'S3 bucket or local directory']) + 2
print(cv.render())
