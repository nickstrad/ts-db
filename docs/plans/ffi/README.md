# FFI execution layer — C4 diagrams

Status: proposed design, for study · Author: Fable 5.1 (with nickstrad) · Date: 2026-10-12 · Branch:
`docs/ffi-c4` · Baseline: `main` at `e808983`.

These diagrams draw the design that comes out of two studies: the language-switch research, which concluded
that Deno can run SQLite statements off the event loop and cancel them through FFI to the system `libsqlite3`
([lang-switch-fable.md](../../architecture/lang-switch-fable.md)), and the scale-out ranking's pick F,
placement-routed tenant cells with process lanes
([scale-out-final-fable.md](../../architecture/scale-out-final-fable.md)). Nothing here is landed. Solid boxes
and solid edges exist on `main`; dashed boxes and dashed edges carry the literal word **(planned)**, per the
repo's [C4 conventions](../../architecture/AGENTS.md). The audited diagrams of what runs today are under
[docs/architecture/](../../architecture/README.md).

## Diagrams

| Level | Diagram                            | What it shows                                                                                                                                                                                                       | GitHub                                    | Terminal                                      |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| 1     | System Context                     | The platform as one system with its people and external systems; the Postgres registry gains a placement table; object storage gains WAL frames. No new external system.                                            | [github](c4-context-ffi.github.md)        | [terminal](c4-context-ffi.terminal.md)        |
| 2     | Container — data node with lanes   | One data node: the API process (auth, placement router, forwarder, lane supervisor), the statement lanes, the FFI-loaded `libsqlite3`, tenant files, the DuckDB reader child; peer node and object storage outside. | [github](c4-container-ffi.github.md)      | [terminal](c4-container-ffi.terminal.md)      |
| 3     | Component — statement lane process | Inside one lane: IPC endpoint, statement classifier, write-first scheduler, bounded statement pool, deadline watchdog, handle LRU / read pool, request-id store, FFI binding, logger.                               | [github](c4-component-ffi-lane.github.md) | [terminal](c4-component-ffi-lane.terminal.md) |

Read them in a terminal with `glow docs/plans/ffi/<name>.terminal.md`. Both formats are generated from the
sources in [`diagrams/`](diagrams/), which reuse the drawer in `docs/architecture/diagrams/canvas.py`:

```sh
python3 docs/plans/ffi/diagrams/render.py           # regenerate both formats
python3 docs/plans/ffi/diagrams/render.py --check   # non-zero exit if either format is stale
```

## What exists today and what is proposed

| Exists on `main`                                                                                                                                | Proposed (dashed, "planned")                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| One API process opening every tenant file through `node:sqlite`; per-file `Semaphore(1)`; 64-entry leased handle LRU; global 32-permit read cap | Statement lanes: supervised child processes that own the files; per-lane handle LRU and read pool; per-tenant admission |
| Postgres registry for tenants, hashed keys, sessions; `TenantStorageRouter` seam with `"control-plane"` reserved                                | `placement` table (tenant → node, lease, epoch); placement router and forwarder in the API process                      |
| DuckDB reader child over JSON-lines IPC with supervised restart                                                                                 | The same child pattern reused for lanes                                                                                 |
| Snapshot backups (`VACUUM INTO` on the writer lock) to object storage                                                                           | Snapshots from a read-only connection; WAL frames to object storage as phase two                                        |
| `Worker.terminate()` cannot stop a statement; cancellation = kill a lane (about 55 ms)                                                          | FFI `nonblocking` step on a pool thread plus `sqlite3_interrupt` from the main thread (about 0.4 ms)                    |

## Key flows

Edge numbers refer to the diagram named in each heading.

### A point read (Level 3, Component)

1. The API process authenticates, resolves the tenant, finds it owned locally, and sends the compiled SQL,
   bind values, deadline and request id to the tenant's lane (1).
2. The classifier sees a bounded plan, an indexed lookup returning at most one row, and takes the synchronous
   path (2, 3).
3. The scheduler leases a read-only handle for the tenant file from the lane's pool (5) and runs a blocking
   step on the lane's main thread (8, 13, 14). Measured 6 to 7 µs per read, faster than today's `node:sqlite`
   at 9 µs, because there is no thread hop.
4. The result goes back over IPC (1, reverse) and the handle returns to the pool. A synchronous step cannot be
   interrupted, which is why only bounded plans take this path.

### A long query with a deadline and interrupt (Level 3, Component)

1. Same arrival (1). The classifier sees an unbounded plan, a list query with a user-controlled predicate or
   an aggregate, and takes the nonblocking path (2, 4).
2. The pool checks the per-tenant sub-cap and the lane's permit count; a tenant that has exhausted its cap
   gets a typed QueueFull for that tenant only (4). It leases a read-only handle (6) and registers the
   statement's deadline with the watchdog (10).
3. The step runs on a pool thread through the FFI `nonblocking` symbol (9, 13, 14); the lane's main thread
   stays free and keeps serving point reads and IPC.
4. At the deadline the watchdog calls `sqlite3_interrupt(db)` from the main thread (11); the step returns
   `SQLITE_INTERRUPT` in about 0.4 ms and the caller gets a typed deadline error.
5. If the step has not returned within a grace period after the interrupt, the watchdog asks the supervisor to
   kill the lane (12). That is the last resort, not the first.

### A forwarded mutation (Level 2, Container)

1. Any node authenticates the request and derives the tenant from the credential (1, 2). The placement cache
   says another node owns the tenant.
2. The API process forwards the request to the owner with the trusted tenant id, the placement epoch and a
   request id (3). The client contract is unchanged.
3. The owner checks its lease and the epoch. A stale epoch answers WrongOwner; the forwarder refreshes the
   placement once and retries. A valid request goes to the tenant's lane (4).
4. In the lane the mutation takes only its own file's writer lock (write-first scheduler), stores the request
   id with its result inside the same transaction, and commits (5, 6).
5. If the forward times out, the retry presents the same request id; the lane answers from the request-id
   store instead of running the handler again.

### A lane kill and restart (Level 2 and Level 3)

1. A statement misses its deadline and the interrupt does not return (Level 3, edge 12). The supervisor in the
   API process sends SIGKILL to the lane (Level 2, edge 4).
2. The process exits in about 4 ms; every in-flight statement on that lane fails with a typed lane-restart
   error. Mutations in flight are resolved on retry through the request-id store, never replayed blind.
3. The supervisor spawns a replacement lane with the same sticky tenant set; it answers its first request
   about 51 ms after spawn. Other lanes, the API process and the reader child are untouched.
4. Measured on vm-1 on 2026-10-12 with `work-scripts/deno/lane-kill-latency.ts`; see the lang-switch study
   §3.1.

## Where the numbers come from

All latencies quoted on the diagrams are from the proof-of-concept runs committed in
[`docs/architecture/lang-switch-fable-data/`](../../architecture/lang-switch-fable-data/) and summarised in
[lang-switch-fable.md §3](../../architecture/lang-switch-fable.md). The design rationale for placement, lanes,
write-first scheduling and the request-id store is in the scale-out set:
[scale-out-final-fable.md](../../architecture/scale-out-final-fable.md) (final ranking and tweaks),
[scale-out-fable.md](../../architecture/scale-out-fable.md) (independent pass),
[scale-out-review-fable.md](../../architecture/scale-out-review-fable.md) (review of the Opus and Astra sets)
and [scale-out-sources-fable.md](../../architecture/scale-out-sources-fable.md) (external sources).

## Not drawn

- The observability path (server and lane JSONL into the DuckDB event log) is unchanged apart from one JSONL
  directory per lane; see `docs/architecture/c4-container-observability.github.md`.
- A Level 3 view of the API process after the change. Its new components, placement router, forwarder and lane
  supervisor, are named on the Level 2 box; a component diagram belongs with the plan item that builds them.
- Level 4. No type structure here needs it.
