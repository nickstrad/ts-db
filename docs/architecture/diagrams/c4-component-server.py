#!/usr/bin/env python3
"""Generated-box source; relationships are numbered in the companion Markdown key."""
from canvas import Canvas
from textwrap import wrap

NODES = [('http',
  ['HTTP API',
   '[Component] (items 22, 34)',
   'platform/http/',
   'router.ts, auth.ts, handlers.ts',
   'Bearer auth; body cap; X-Trace-Id ingress;',
   'handler spans (item 34); typed errors'],
  False,
  True),
 ('life',
  ['Server lifecycle',
   '[Component] (items 22, 32)',
   'platform/server.ts',
   'Scoped HTTP listener; backup and ingest-sweep',
   'timers; reader-exit watch; signals'],
  False,
  True),
 ('apps',
  ['AppServices',
   '[Effect service] (item 22)',
   'platform/registry.ts',
   'AppServicesLive: platform/layers.ts',
   'One Storage + Backups stack per app'],
  False,
  True),
 ('registry',
  ['AppRegistry',
   '[Effect service] (item 22)',
   'platform/registry.ts',
   'Config apps -> schema, handlers, token, SQLite path'],
  False,
  True),
 ('storage',
  ['Storage',
   '[Effect service] (item 15)',
   'platform/sqlite.ts',
   'Per-app scoped SQLite handle; serialized mutation/snapshot queue'],
  False,
  True),
 ('backups',
  ['Backups',
   '[Effect service] (item 19)',
   'platform/backup.ts',
   'Per-app snapshot, verification, hash and publication'],
  False,
  True),
 ('rpc',
  ['ReaderClient',
   '[Effect service] (items 17, 34)',
   'platform/ipc.ts',
   'Scoped child; Deferred replies; queue cap',
   'and deadline; caller trace captured per call'],
  False,
  True),
 ('objects',
  ['ObjectStore',
   '[Effect service] (item 18)',
   'platform/object_store.ts',
   'Local files or signed S3; transient S3 retries'],
  False,
  True),
 ('logs',
  ['Logger + EventSink',
   '[Effect logger/service] (11)',
   'platform/logging/',
   'logger.ts, file_sink.ts',
   'Dropping queue; JSONL batches; scope finalizer drains'],
  False,
  True),
 ('config',
  ['Config',
   '[Effect service] (item 08)',
   'platform/config.ts',
   'Validated environment options; startup failure on invalid config'],
  False,
  True),
 ('ids',
  ['IdGen',
   '[Effect service]',
   'platform/sqlite.ts',
   'IdGenLive: random UUIDs',
   'Clock: Effect runtime service'],
  False,
  True),
 ('reader',
  ['Reader process', '[Deno child process]', 'platform/reader.ts',
   'Root: platform/reader_layers.ts (item 33)'],
  False,
  False),
 ('files',
  ['App SQLite files', '[SQLite 3, WAL]', '<DATA_DIR>/<appId>.sqlite'],
  False,
  False),
 ('store',
  ['Object storage',
   '[External system/filesystem]',
   'S3_BASE_URL or OBJECT_STORE_DIR',
   'apps/<appId>/'],
  False,
  False),
 ('jsonl',
  ['JSONL directories', '[filesystem]', '<LOG_DIR>/server/<date>/'],
  False,
  False)]
TITLE = 'Server process - PlatformLive (items 22, 32)'

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
