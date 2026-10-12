#!/usr/bin/env python3
"""Level 3 — inside one statement lane process: the execution path from IPC to libsqlite3."""
from c4ffi import main

NAME = 'c4-component-ffi-lane'
TITLE = 'Component — statement lane process (planned)'
BOUNDARY = 'Statement lane process (planned): platform/lane.ts'
NODES = [
    ('ipc', 'Lane IPC endpoint (planned)', 'Component', 'platform/lane.ts (planned)',
     'JSON-lines from the API process: statements, deadlines, cancels, health; results back', True, True),
    ('classify', 'Statement classifier (planned)', 'Component', 'platform/lane/classify.ts (planned)',
     'Bounded plan (point read, single-row write) stays synchronous; unbounded plan goes nonblocking',
     True, True),
    ('sched', 'Write-first scheduler (planned)', 'Component', 'platform/lane/schedule.ts (planned)',
     'Semaphore(1) per file; a mutation waits only on its own file, never on read permits; hot-tenant pin',
     True, True),
    ('pool', 'Bounded statement pool (planned)', 'Component', 'platform/lane/pool.ts (planned)',
     'N permits for nonblocking steps; per-tenant sub-cap and admission; QueueFull per tenant', True, True),
    ('watchdog', 'Deadline watchdog (planned)', 'Component', 'platform/lane/deadline.ts (planned)',
     'Timer per statement; sqlite3_interrupt from the main thread; escalates to the supervisor', True, True),
    ('handles', 'Handle LRU / read pool (planned)', 'Component', 'platform/lane/handles.ts (planned)',
     'Writer handle per file (3 fds), pooled read-only handles (2 fds); leases; idle eviction', True, True),
    ('reqid', 'Request-id store (planned)', 'Component', 'platform/lane/request_ids.ts (planned)',
     'Request id and result written inside the mutation transaction; lookup before a retry', True, True),
    ('ffi', 'FFI binding (planned)', 'Component', 'platform/ffi/sqlite.ts (planned)',
     'Deno.dlopen(libsqlite3): open, prepare, bind, step, step nonblocking, interrupt, finalize', True, True),
    ('events', 'Logger / EventSink', 'Effect logger/service', 'platform/logging/',
     'SQL/tx/queue events; batched JSONL; reused unchanged', True, False),
    ('api', 'API process', 'Deno process', 'platform/server.ts',
     'Lane supervisor (planned): spawns, kills and restarts lanes; forwards statements', False, False),
    ('lib', 'System libsqlite3 (planned)', 'Shared library', 'libsqlite3.so.0',
     'Serialized threading mode; interrupt is safe from another thread', False, True),
    ('files', 'Tenant documents', 'SQLite 3 WAL files', 'TENANTS_DIR/tenantId.db',
     'One file per tenant', False, False),
    ('jsonl', 'Lane JSONL (planned)', 'Filesystem', 'LOG_DIR/lane-N/date/ (planned)',
     'Durable structured records per lane', False, True),
]
EDGES = [
    ('api', 'ipc', 'Statement request: tenant, compiled SQL, binds, deadline, request id; cancel; health', True),
    ('ipc', 'classify', 'Classify by plan shape', True),
    ('classify', 'sched', 'Bounded statement: synchronous path', True),
    ('classify', 'pool', 'Unbounded statement (list, aggregate, user predicate): nonblocking path', True),
    ('sched', 'handles', 'Lease the writer handle or a read-only handle for the tenant file', True),
    ('pool', 'handles', 'Lease a read-only handle under the per-tenant cap', True),
    ('sched', 'reqid', 'Look up the request id before a retry; store id and result in the transaction', True),
    ('sched', 'ffi', 'Blocking step on the lane main thread (6 to 7 µs point read)', True),
    ('pool', 'ffi', 'Nonblocking step on a pool thread (44 to 69 µs; Promise)', True),
    ('pool', 'watchdog', 'Register the statement deadline', True),
    ('watchdog', 'ffi', 'sqlite3_interrupt(db) at the deadline (about 0.4 ms to return)', True),
    ('watchdog', 'api', 'Interrupt did not return within the grace period: request lane kill and restart', True),
    ('ffi', 'lib', 'dlopen symbols; pointers and buffers', True),
    ('lib', 'files', 'WAL reads and writes', True),
    ('sched', 'events', 'SQL, transaction and queue events', True),
    ('pool', 'events', 'Statement, cancel and deadline events', True),
    ('events', 'jsonl', 'Batched append; rotation', True),
]
NOTES = ('Nothing inside this boundary exists on `main` except the logger, which is reused as-is. The lane is '
         'the in-node half of scale-out pick F and the execution layer of the lang-switch study; the file '
         'paths are proposals. The path a statement takes is decided once by the classifier (edge 2): a '
         'bounded plan runs synchronously on the lane\'s main thread (edges 3, 8), which is faster than '
         'today\'s `node:sqlite` and cannot be interrupted, so it is reserved for statements that cannot run '
         'long; everything else runs on a pool thread (edges 4, 9) and is cancellable by '
         '`sqlite3_interrupt` from the main thread (edge 11), which SQLite documents as safe from another '
         'thread. The watchdog escalates only when an interrupt does not return (edge 12), so a SIGKILL '
         'remains the last resort and the whole lane restarts (about 55 ms measured). The write-first '
         'scheduler keeps the item-15 guarantees per file (`Semaphore(1)`, `BEGIN IMMEDIATE`) and adds the '
         'rule that a mutation never waits on read permits. The handle LRU is MT-04\'s cache moved into the '
         'lane with a read pool beside it; its capacity derives from the descriptor formula (3 per writer, 2 '
         'per reader). The request-id store makes a forwarded mutation idempotent: a timed-out forward is a '
         'lookup on retry, never a replay. Measurements: `docs/architecture/lang-switch-fable.md` §3; '
         'design: `docs/architecture/scale-out-final-fable.md` §Tweaks.')

if __name__ == '__main__':
    main(NAME, TITLE, BOUNDARY, NODES, EDGES, NOTES)
