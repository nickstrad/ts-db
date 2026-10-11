#!/usr/bin/env python3
"""Source for c4-container-platform.terminal.md (C4 Level 2 — Container, request path)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from canvas import Canvas  # noqa: E402

cv = Canvas(width=72, height=48)

SRV, RDR = 17, 54   # centres of the left (server) and right (reader) columns
BACKUP = 6          # left-hand routing channel for the backup path

client_bottom = cv.box(0, 3, 30, [
    "Typed client SDK",
    "[library, caller process]",
    "",
    "sdk/client.ts (item 10) +",
    "an import type of the",
    "app's handler map. Sends a",
    "name + X-Trace-Id, no SQL.",
], bottom=(14,))

row = cv.down(client_bottom + 1, SRV, "(1)", rows=4)

server_bottom = cv.box(row, 3, 30, [
    "Server process",
    "[Deno process] :8000",
    "",
    "platform/server.ts",
    "HTTP API, auth, mutation",
    "handlers, SQLite writer",
    "per app, backup fiber,",
    "ingest timer. No DuckDB.",
], bottom=(3, 14), right=(3,))
reader_bottom = cv.box(row, 40, 30, [
    "Reader process",
    "[Deno child process]",
    "",
    "platform/reader.ts",
    "query handlers + DuckDB,",
    "event-log ingest. Root:",
    "reader_layers.ts (33).",
    "Never imports node:sqlite.",
], bottom=(14,))
cv.right(row + 3, 33, 39, "(2)")

cv.down(server_bottom + 1, SRV, "(3)")
cv.down(reader_bottom + 1, RDR, "(4)", rows=server_bottom - reader_bottom + 2)

sqlite_bottom = cv.box(server_bottom + 3, 10, 60, [
    "App SQLite files     [SQLite 3, WAL mode, STRICT tables]",
    "<DATA_DIR>/<appId>.sqlite  (+ -wal, -shm)",
    "",
    "One file per app: tic-tac-toe (columns layout) and",
    "tic-tac-toe-json (one doc TEXT column). The schema",
    "descriptor lives in the file; drift fails loudly.",
], top=(7, 44))

# The backup path leaves the server, passes the SQLite files, and exits the boundary.
frame_bottom = sqlite_bottom + 2
cv.frame(row - 3, 0, frame_bottom, 71, "Platform host")
cv.g[row - 3][SRV] = "┬"

cv.put(server_bottom + 1, BACKUP + 2, "(5)")
cv.channel(server_bottom + 1, frame_bottom, BACKUP)
cv.g[frame_bottom][BACKUP] = "┬"
cv.g[frame_bottom + 1][BACKUP] = "▼"

cv.box(frame_bottom + 2, 3, 34, [
    "S3-compatible object store",
    "[External system]",
    "",
    "an S3_BASE_URL bucket, or",
    "the local ./object-store",
    "stand-in directory",
    "apps/<appId>/: snapshot,",
    "manifest, latest.json",
], top=(3,))

print(cv.render())
