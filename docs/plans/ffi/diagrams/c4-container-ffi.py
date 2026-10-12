#!/usr/bin/env python3
"""Level 2 — one data node: API process, statement lanes, FFI to libsqlite3, files, reader child."""
from c4ffi import main

NAME = 'c4-container-ffi'
TITLE = 'Container — data node with statement lanes'
BOUNDARY = 'Data node (one of N, placement-routed)'
NODES = [
    ('api', 'API process', 'Deno process', 'platform/server.ts; platform/http/',
     'HTTP auth and tenant context; placement router, forwarder and lane supervisor (planned)', True, False),
    ('lanes', 'Statement lanes (planned)', 'Deno child processes', 'platform/lane.ts (planned)',
     'Sticky tenant-to-lane; bounded statement pool with deadlines; handle LRU; write-first scheduler',
     True, True),
    ('ffi', 'System libsqlite3 (planned)', 'Shared library via Deno FFI, one per lane',
     'libsqlite3.so.0; platform/ffi/sqlite.ts (planned)',
     'Blocking step for bounded statements; nonblocking step plus sqlite3_interrupt for the rest', True, True),
    ('files', 'Tenant documents', 'SQLite 3 WAL files', 'TENANTS_DIR/tenantId.db',
     'One file per tenant; writer handle 3 fds, read-only handle 2', True, False),
    ('reader', 'Reader process', 'Deno child process', 'platform/reader.ts',
     'Event-log DuckDB; ingest and named analysis', True, False),
    ('client', 'Typed client SDK', 'Library in caller process', 'sdk/client.ts',
     'Named handlers, bearer, X-Trace-Id', False, False),
    ('pg', 'Central registry and placement', 'Postgres 17 process/store',
     'platform/tenants/; placement table (planned)',
     'Tenants, hashed keys, sessions; tenant-to-node, lease, epoch (planned)', False, False),
    ('peer', 'Peer data node (planned)', 'Deno process on another host', 'same containers as this node',
     'Owner of the tenants not placed here', False, True),
    ('objects', 'Object storage', 'External system / filesystem', 'S3_BASE_URL or LOCAL_OBJECT_DIR',
     'Snapshots and manifests; WAL frames (planned)', False, False),
]
EDGES = [
    ('client', 'api', 'HTTP JSON + bearer + trace', False),
    ('api', 'pg', 'Postgres protocol; auth and registry SQL; placement lookup and lease heartbeat', False),
    ('api', 'peer', 'Forwarded request over HTTP: trusted tenant id, epoch, request id', True),
    ('api', 'lanes', 'JSON-lines IPC: compiled SQL, binds, deadline, request id; cancel; SIGKILL on a missed deadline', True),
    ('lanes', 'ffi', 'Deno.dlopen symbols: blocking step; nonblocking step; sqlite3_interrupt', True),
    ('ffi', 'files', 'WAL reads and writes; BEGIN IMMEDIATE per mutation; VACUUM INTO from a read-only connection', True),
    ('api', 'files', 'node:sqlite reads and serialized mutations (today; moves into the lanes)', False),
    ('api', 'reader', 'JSONL IPC ping/ingest/analysis', False),
    ('api', 'objects', 'Snapshot verification/hash and publication; WAL frames', False),
]
NOTES = ('Today the API process opens every tenant file itself through `node:sqlite` (edge 7) and the reader '
         'child is the only other process. In the proposed design the API process keeps HTTP, auth, the '
         'reader client and the backup pipeline, gains the placement router and forwarder (edges 2 and 3) and '
         'a lane supervisor (edge 4), and stops touching tenant files; edge 7 is retired when the lanes land. '
         'A lane is a supervised child process in the pattern of the reader child (`platform/ipc.ts`, '
         '`platform/layers.ts`): JSON-lines over stdio, killed and respawned by the supervisor. Lanes exist '
         'because a child process is the only unit that can be killed mid-statement (Worker.terminate() '
         'waited 24.9 s), that isolates a native crash from the API, and that has its own descriptor table; '
         'they are not the cancellation mechanism, which is `sqlite3_interrupt` inside the lane (edge 5). '
         'Each lane loads the system `libsqlite3.so.0` with `Deno.dlopen` (edge 5): a blocking step for '
         'statements with a bounded plan (measured 6 to 7 µs per point read) and a nonblocking step on a '
         'pool thread for the rest (44 to 69 µs, cancellable in about 0.4 ms). The hot write never waits '
         'behind reads: a mutation takes only its own file\'s writer lock, and snapshots run on a read-only '
         'connection (edge 6). Placement (edges 2 and 3) is the scale-out pick F: a `placement` table beside '
         'the tenant row, lease-fenced, epoch-versioned; a node that receives a tenant it does not own answers '
         'WrongOwner and the forwarder refreshes once. Measurements and sources: '
         '`docs/architecture/lang-switch-fable.md` §3, `docs/architecture/scale-out-final-fable.md`.')

if __name__ == '__main__':
    main(NAME, TITLE, BOUNDARY, NODES, EDGES, NOTES)
