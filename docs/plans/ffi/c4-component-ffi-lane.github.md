# Component — statement lane process (planned)

Proposed design, not landed code: the FFI execution layer from
[lang-switch-fable.md](../../architecture/lang-switch-fable.md) combined with the scale-out pick F from
[scale-out-final-fable.md](../../architecture/scale-out-final-fable.md). Baseline `main` at `e808983`
(2026-10-12). Solid boxes and solid edges exist on `main`; dashed boxes and dashed edges marked **(planned)**
do not. Both formats are generated from `diagrams/c4-component-ffi-lane.py`; numbered relationships are
identical.

```mermaid
flowchart TB
    subgraph platform["Statement lane process (planned): platform/lane.ts"]
        ipc["Lane IPC endpoint (planned)<br/>[Component]<br/>platform/lane.ts (planned)<br/>JSON-lines from the API process: statements, deadlines, cancels, health; results back"]
        classify["Statement classifier (planned)<br/>[Component]<br/>platform/lane/classify.ts (planned)<br/>Bounded plan (point read, single-row write) stays synchronous; unbounded plan goes nonblocking"]
        sched["Write-first scheduler (planned)<br/>[Component]<br/>platform/lane/schedule.ts (planned)<br/>Semaphore(1) per file; a mutation waits only on its own file, never on read permits; hot-tenant pin"]
        pool["Bounded statement pool (planned)<br/>[Component]<br/>platform/lane/pool.ts (planned)<br/>N permits for nonblocking steps; per-tenant sub-cap and admission; QueueFull per tenant"]
        watchdog["Deadline watchdog (planned)<br/>[Component]<br/>platform/lane/deadline.ts (planned)<br/>Timer per statement; sqlite3_interrupt from the main thread; escalates to the supervisor"]
        handles["Handle LRU / read pool (planned)<br/>[Component]<br/>platform/lane/handles.ts (planned)<br/>Writer handle per file (3 fds), pooled read-only handles (2 fds); leases; idle eviction"]
        reqid["Request-id store (planned)<br/>[Component]<br/>platform/lane/request_ids.ts (planned)<br/>Request id and result written inside the mutation transaction; lookup before a retry"]
        ffi["FFI binding (planned)<br/>[Component]<br/>platform/ffi/sqlite.ts (planned)<br/>Deno.dlopen(libsqlite3): open, prepare, bind, step, step nonblocking, interrupt, finalize"]
        events["Logger / EventSink<br/>[Effect logger/service]<br/>platform/logging/<br/>SQL/tx/queue events; batched JSONL; reused unchanged"]
    end
        api["API process<br/>[Deno process]<br/>platform/server.ts<br/>Lane supervisor (planned): spawns, kills and restarts lanes; forwards statements"]
        lib["System libsqlite3 (planned)<br/>[Shared library]<br/>libsqlite3.so.0<br/>Serialized threading mode; interrupt is safe from another thread"]
        files["Tenant documents<br/>[SQLite 3 WAL files]<br/>TENANTS_DIR/tenantId.db<br/>One file per tenant"]
        jsonl["Lane JSONL (planned)<br/>[Filesystem]<br/>LOG_DIR/lane-N/date/ (planned)<br/>Durable structured records per lane"]
    api -.->|"(1) Statement request: tenant, compiled SQL, binds, deadline, request id; cancel; health (planned)"| ipc
    ipc -.->|"(2) Classify by plan shape (planned)"| classify
    classify -.->|"(3) Bounded statement: synchronous path (planned)"| sched
    classify -.->|"(4) Unbounded statement (list, aggregate, user predicate): nonblocking path (planned)"| pool
    sched -.->|"(5) Lease the writer handle or a read-only handle for the tenant file (planned)"| handles
    pool -.->|"(6) Lease a read-only handle under the per-tenant cap (planned)"| handles
    sched -.->|"(7) Look up the request id before a retry; store id and result in the transaction (planned)"| reqid
    sched -.->|"(8) Blocking step on the lane main thread (6 to 7 µs point read) (planned)"| ffi
    pool -.->|"(9) Nonblocking step on a pool thread (44 to 69 µs; Promise) (planned)"| ffi
    pool -.->|"(10) Register the statement deadline (planned)"| watchdog
    watchdog -.->|"(11) sqlite3_interrupt(db) at the deadline (about 0.4 ms to return) (planned)"| ffi
    watchdog -.->|"(12) Interrupt did not return within the grace period: request lane kill and restart (planned)"| api
    ffi -.->|"(13) dlopen symbols; pointers and buffers (planned)"| lib
    lib -.->|"(14) WAL reads and writes (planned)"| files
    sched -.->|"(15) SQL, transaction and queue events (planned)"| events
    pool -.->|"(16) Statement, cancel and deadline events (planned)"| events
    events -.->|"(17) Batched append; rotation (planned)"| jsonl
    classDef planned stroke-dasharray: 5 3
    classDef person fill:#fff,stroke-width:2px
    classDef external fill:#f4f4f4
    class ipc planned
    class classify planned
    class sched planned
    class pool planned
    class watchdog planned
    class handles planned
    class reqid planned
    class ffi planned
    class api external
    class lib planned
    class files external
    class jsonl planned
```

## Relationships

| #  | From                             | To                               | Relationship                                                                                   |
| -- | -------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1  | API process                      | Lane IPC endpoint (planned)      | Statement request: tenant, compiled SQL, binds, deadline, request id; cancel; health (planned) |
| 2  | Lane IPC endpoint (planned)      | Statement classifier (planned)   | Classify by plan shape (planned)                                                               |
| 3  | Statement classifier (planned)   | Write-first scheduler (planned)  | Bounded statement: synchronous path (planned)                                                  |
| 4  | Statement classifier (planned)   | Bounded statement pool (planned) | Unbounded statement (list, aggregate, user predicate): nonblocking path (planned)              |
| 5  | Write-first scheduler (planned)  | Handle LRU / read pool (planned) | Lease the writer handle or a read-only handle for the tenant file (planned)                    |
| 6  | Bounded statement pool (planned) | Handle LRU / read pool (planned) | Lease a read-only handle under the per-tenant cap (planned)                                    |
| 7  | Write-first scheduler (planned)  | Request-id store (planned)       | Look up the request id before a retry; store id and result in the transaction (planned)        |
| 8  | Write-first scheduler (planned)  | FFI binding (planned)            | Blocking step on the lane main thread (6 to 7 µs point read) (planned)                         |
| 9  | Bounded statement pool (planned) | FFI binding (planned)            | Nonblocking step on a pool thread (44 to 69 µs; Promise) (planned)                             |
| 10 | Bounded statement pool (planned) | Deadline watchdog (planned)      | Register the statement deadline (planned)                                                      |
| 11 | Deadline watchdog (planned)      | FFI binding (planned)            | sqlite3_interrupt(db) at the deadline (about 0.4 ms to return) (planned)                       |
| 12 | Deadline watchdog (planned)      | API process                      | Interrupt did not return within the grace period: request lane kill and restart (planned)      |
| 13 | FFI binding (planned)            | System libsqlite3 (planned)      | dlopen symbols; pointers and buffers (planned)                                                 |
| 14 | System libsqlite3 (planned)      | Tenant documents                 | WAL reads and writes (planned)                                                                 |
| 15 | Write-first scheduler (planned)  | Logger / EventSink               | SQL, transaction and queue events (planned)                                                    |
| 16 | Bounded statement pool (planned) | Logger / EventSink               | Statement, cancel and deadline events (planned)                                                |
| 17 | Logger / EventSink               | Lane JSONL (planned)             | Batched append; rotation (planned)                                                             |

## Runtime notes

Nothing inside this boundary exists on `main` except the logger, which is reused as-is. The lane is the
in-node half of scale-out pick F and the execution layer of the lang-switch study; the file paths are
proposals. The path a statement takes is decided once by the classifier (edge 2): a bounded plan runs
synchronously on the lane's main thread (edges 3, 8), which is faster than today's `node:sqlite` and cannot be
interrupted, so it is reserved for statements that cannot run long; everything else runs on a pool thread
(edges 4, 9) and is cancellable by `sqlite3_interrupt` from the main thread (edge 11), which SQLite documents
as safe from another thread. The watchdog escalates only when an interrupt does not return (edge 12), so a
SIGKILL remains the last resort and the whole lane restarts (about 55 ms measured). The write-first scheduler
keeps the item-15 guarantees per file (`Semaphore(1)`, `BEGIN IMMEDIATE`) and adds the rule that a mutation
never waits on read permits. The handle LRU is MT-04's cache moved into the lane with a read pool beside it;
its capacity derives from the descriptor formula (3 per writer, 2 per reader). The request-id store makes a
forwarded mutation idempotent: a timed-out forward is a lookup on retry, never a replay. Measurements:
`docs/architecture/lang-switch-fable.md` §3; design: `docs/architecture/scale-out-final-fable.md` §Tweaks.
