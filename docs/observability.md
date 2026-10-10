# Observability and Logging

## Overview

The platform captures structured events in JSONL format and ingests them into a DuckDB append-only event log for analysis and debugging. The event log tracks HTTP requests, SQL queries, transactions, backups, queue depth, and system lifecycle events.

## Log Directory Layout

```text
logs/
  server/2026-10-10/events-14-31887-001.jsonl
  reader/2026-10-10/events-14-31902-001.jsonl
  duckdb/events.duckdb
```

Logs are organized by role (`server`, `reader`, `restore`, `cli`) and date (`YYYY-MM-DD`), with individual files rolled hourly or by size.

## Retention Policy

The retention sweeper runs daily to apply the following policy:

- **keepDays**: 14 — files older than 14 days are deleted
- **gzipAfterDays**: 2 — files older than 2 days are compressed with gzip
- **maxTotalBytes**: 2 GiB — total log directory size cap
- **maxFileBytes**: 64 MiB — individual file size before rolling

Today's directory and currently-open log files are never touched by the sweeper.

Run the sweeper manually with:

```sh
deno task logs:sweep           # Apply the retention policy
deno task logs:sweep --dry-run # Preview what would be deleted/gzipped
```

## DuckDB Event Table Pruning

**Out of scope for this phase.** The DuckDB event file (`logs/duckdb/events.duckdb`) grows until an explicit future `logs:compact` command is added. This is by design: event tables are append-only, and manual pruning via SQL is avoided in the current implementation. The `_ingest_state` table tracks which JSONL files have been ingested, ensuring idempotent ingest across restarts.
