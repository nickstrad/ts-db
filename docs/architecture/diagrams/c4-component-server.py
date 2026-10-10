#!/usr/bin/env python3
"""Source for c4-component-server.terminal.md (C4 Level 3 — Component, server process)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from canvas import Canvas  # noqa: E402

cv = Canvas(width=72, height=70)

L, LW = 10, 26           # left column origin and width
R, RW = 42, 27           # right column origin and width
LC, RC = L + 12, R + 13  # column centres: 22 and 55
CH = 6                   # routing channel for edges that skip a tier

http_bottom = cv.box(2, 3, 66, [
    "HTTP API   platform/http/{router,auth,handlers}.ts  (item 22)",
    "",
    "GET /health;  POST /apps/:appId/:kind/:name;",
    "POST /admin/backup/:appId;  POST /admin/logs/ingest;",
    "POST /admin/logs/analysis/:name",
    "Bearer auth, 64 KiB body cap, X-Trace-Id in and out,",
    "toHttpStatus(error) replaces today's blanket HTTP 400.",
], planned=True, bottom=(3, 19, 52))

row = cv.down(http_bottom + 1, LC, "(1)")
cv.down(http_bottom + 1, RC, "(2)")

storage_bottom = cv.box(row, L, LW, [
    "Storage   (item 15)",
    "platform/sqlite.ts",
    "",
    "scoped node:sqlite",
    "handle, Semaphore(1)",
    "write queue, BEGIN",
    "IMMEDIATE per mutation",
], planned=False, top=(12,), bottom=(12,))
cv.box(row, R, RW, [
    "ReaderClient  (item 17)",
    "platform/ipc.ts",
    "",
    "scoped child process,",
    "Deferred correlation",
    "map, per-call timeout,",
    "QueueFullError cap",
], planned=False, top=(13,))

row = cv.up(storage_bottom + 1, LC, "(6)")

backups_bottom = cv.box(row, L, LW, [
    "Backups   (item 19)",
    "platform/backup.ts",
    "",
    "snapshot -> verify ->",
    "hash -> PUT object ->",
    "PUT manifest -> only",
    "then latest.json",
], planned=True, top=(12,), right=(4,))
cv.box(row, R, RW, [
    "ObjectStore   (item 18)",
    "platform/object_store",
    "",
    "ObjectStoreLocal or",
    "ObjectStoreS3, chosen",
    "by Config; retrying",
    "put / get",
], planned=False)
cv.right(row + 4, L + LW, R - 1, "(5)")
backups_tap = row + 4

row = backups_bottom + 2
registry_bottom = cv.box(row, L, LW, [
    "AppRegistry (item 22)",
    "platform/registry.ts",
    "",
    "appId -> schema,",
    "functions, token and",
    "file path; no Deno.env",
    "of its own",
], planned=True, bottom=(12,))
cv.box(row, R, RW, [
    "Logger + EventSink (11)",
    "platform/logging/*.ts",
    "",
    "Effect Logger -> JSONL",
    "sink; dropping queue,",
    "never fails a mutation.",
    "Sweeper: 24 (planned)",
], bottom=(13,))
registry_tap = row + 4

# Two edges from the HTTP API skip the tier below it, so they route down the channel.
cv.channel(http_bottom + 1, registry_tap, CH)
cv.tap(backups_tap, CH, L - 1, "(3)")
cv.tap(registry_tap, CH, L - 1, "(4)", last=True)

row = cv.up(registry_bottom + 1, LC, "(7)")
cv.up(registry_bottom + 1, RC, "(7)")

config_bottom = cv.box(row, L, 59, [
    "Config   platform/config.ts   (item 08)",
    "",
    "The only module that reads Deno.env. One options table",
    "(name, env var, type, default) validated with Effect",
    "Schema; fails at layer construction, not at first use.",
    "Used by the logging layer today; server.ts ports in 22.",
], top=(12, 45), bottom=(12, 45))

row = cv.up(config_bottom + 1, LC, "(8)")
cv.up(config_bottom + 1, RC, "(8)")

core_bottom = cv.box(row, L, 59, [
    "core/ + platform/services.ts   (items 02, 04-09, 21)",
    "",
    "landed (items 02, 04-09): errors.ts  schema.ts  plan.ts",
    "events.ts  compile/{dialect,ddl,select,write,decode}.ts",
    "logging/rotation.ts  ipc/framing.ts; services.ts tags",
    "planned (item 21): eventlog/{ddl,offsets}.ts",
    "No Deno.*, no node:*, no npm:*, no platform/ or sdk/.",
], top=(12, 45))

cv.frame(0, 0, core_bottom + 2, 71,
         "Server process - Effect layers (PlatformLive, item 22, planned)")

print(cv.render())
