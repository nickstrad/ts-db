# Container — observability path

Audited against landed main `643b706` on 2026-10-11 (item 27); updated for FFI-06 at `5c2a499` on 2026-10-14.
Both formats are generated from `diagrams/c4-container-observability.py`; numbered relationships are
identical. All boxes describe landed code.

```mermaid
flowchart TB
    subgraph platform["Platform observability"]
        server["Server process<br/>[Deno process]<br/>platform/server.ts<br/>LoggingLive; HTTP, handler, SQL, tx and lifecycle"]
        reader["Reader process<br/>[Deno child process]<br/>platform/reader.ts; reader_layers.ts<br/>Reader logging; ingest-then-sweep; live analysis"]
        jsonl["Structured event sources<br/>[Filesystem]<br/>LOG_DIR/role/date/events-*.jsonl<br/>Server/reader JSONL; quarantine beside source"]
        duck["Derived event log<br/>[DuckDB file]<br/>EVENTLOG_DUCKDB<br/>Schema v2; typed events (sql_events.path), watermarks, k6_points"]
        cli["Logs CLI<br/>[Deno process]<br/>scripts/logs.ts<br/>Ingest/list/query/sweep; named catalog"]
        loader["k6 point loader<br/>[Deno process]<br/>perf/ingest_k6.ts<br/>Loads raw points into k6_points (item 25)"]
        results["k6 artifacts<br/>[Filesystem]<br/>logs/k6/run-id/<br/>raw.json and summary.json"]
    end
        k6["k6 load generator<br/>[External process]<br/>perf/*.js<br/>HTTP load; JSON metric output"]
    server -->|"(1) Append structured JSONL through dropping queue"| jsonl
    reader -->|"(2) Append reader-role JSONL; stdout reserved for RPC"| jsonl
    server -->|"(3) JSONL ingest/analysis RPC; timer and admin HTTP"| reader
    reader -->|"(4) Transactional ingest (adds sql_events.path if missing); shared-instance catalog SELECT"| duck
    reader -->|"(5) After committed ingest: seal tails, gzip/delete safe files"| jsonl
    cli -->|"(6) Offline ingest or read-only catalog SELECT"| duck
    cli -->|"(7) Offline ingest-then-sweep; dry-run plans only"| jsonl
    k6 -->|"(8) Raw points and summary JSON"| results
    results -->|"(9) Read raw.json for selected run id"| loader
    loader -->|"(10) Insert k6_points; catalog compares overlapping HTTP buckets"| duck
    classDef planned stroke-dasharray: 5 3
    classDef person fill:#fff,stroke-width:2px
    classDef external fill:#f4f4f4
    class k6 external
```

## Relationships

| #  | From              | To                       | Relationship                                                                           |
| -- | ----------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| 1  | Server process    | Structured event sources | Append structured JSONL through dropping queue                                         |
| 2  | Reader process    | Structured event sources | Append reader-role JSONL; stdout reserved for RPC                                      |
| 3  | Server process    | Reader process           | JSONL ingest/analysis RPC; timer and admin HTTP                                        |
| 4  | Reader process    | Derived event log        | Transactional ingest (adds sql_events.path if missing); shared-instance catalog SELECT |
| 5  | Reader process    | Structured event sources | After committed ingest: seal tails, gzip/delete safe files                             |
| 6  | Logs CLI          | Derived event log        | Offline ingest or read-only catalog SELECT                                             |
| 7  | Logs CLI          | Structured event sources | Offline ingest-then-sweep; dry-run plans only                                          |
| 8  | k6 load generator | k6 artifacts             | Raw points and summary JSON                                                            |
| 9  | k6 artifacts      | k6 point loader          | Read raw.json for selected run id                                                      |
| 10 | k6 point loader   | Derived event log        | Insert k6_points; catalog compares overlapping HTTP buckets                            |

## Runtime notes

Item 23 provides the named catalog and logs CLI; item 25 provides the k6 loader and join acceptance test.
MT-10 wires the reader analysis RPC and shares the ingest instance so later commits remain visible. The server
never opens DuckDB. The standalone CLI queries read-only and can fail while a writer owns the file; use the
live admin route during serving. Ingest and analysis handles are independently scoped connections on the
shared native instance. Document reads run in-process against application SQLite files; they do not use the
reader event-log database. Retention bounds JSONL only, requires committed watermarks and matching hashes, and
never touches today or the reader sink open path. Derived tables are never pruned; logs:compact remains future
work. Gzipped retained sources are not re-ingested by the current scanner. No load-performance result is
claimed by this diagram. FFI-06: the sql event now persists its SQLite execution path (blocking or
nonblocking) in the JSONL line (core/events.ts KIND_KEYS) and in a nullable sql_events.path column
(core/eventlog/ddl.ts). Ingest runs ALTER TABLE sql_events ADD COLUMN IF NOT EXISTS path on every open, so an
older v2 file gains the column on its next ingest without a schema-version bump; older rows hold NULL. The
named catalog gains deadline-hits-per-handler-hour (platform/analysis/catalog.ts), which counts
StatementDeadlineError sql events by app, handler and UTC hour with the path; until an older log is
re-ingested, that one query fails on the missing column. The perf/ffi_*.ts harnesses and the deadline scenario
in tests/integration.ts add no container: the harnesses drive the FFI binding directly, and the scenario runs
the existing server, logs ingest and logs query.
