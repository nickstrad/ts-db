#!/usr/bin/env python3
"""Level 1 — the platform with the FFI execution layer and tenant cells in context."""
from c4ffi import main

NAME = 'c4-context-ffi'
TITLE = 'System Context — FFI execution layer and tenant cells'
BOUNDARY = 'Document DB platform'
NODES = [
    ('db', 'Document DB platform', 'Software system', 'platform/',
     'Deno API nodes; statement lanes with FFI to libsqlite3 (planned); DuckDB event-log child', True, False),
    ('registry', 'Central registry and placement', 'Software system, part of the platform',
     'platform/tenants/; placement table (planned)',
     'Postgres: tenants, hashed keys, sessions; tenant-to-node placement with leases and epochs (planned)',
     True, False),
    ('developer', 'App developer', 'Person', 'app/; sdk/', 'Declares schemas and Effect handlers', False, False),
    ('caller', 'Application caller', 'Person', 'sdk/client.ts', 'Players and authenticated tenant users', False, False),
    ('operator', 'Platform operator', 'Person', 'scripts/',
     'Tenants, auth, backups; placement moves (planned)', False, False),
    ('objects', 'Object storage', 'External system', 'S3_BASE_URL or LOCAL_OBJECT_DIR',
     'Immutable snapshots and manifests; WAL frames (planned, phase two)', False, False),
    ('analytics', 'Analytics consumer', 'External system', 'scripts/logs.ts; scripts/duckdb/',
     'Named catalog or offline SQL', False, False),
]
EDGES = [
    ('developer', 'db', 'Schema and named handlers (TypeScript)', False),
    ('caller', 'db', 'HTTP JSON; bearer credentials; X-Trace-Id; served by the owning node or forwarded', False),
    ('operator', 'db', 'Admin HTTP / CLI; tenant, backup and placement-move operations', False),
    ('db', 'registry', 'Postgres protocol; auth and tenant SQL; placement lookup and lease heartbeat', False),
    ('db', 'objects', 'S3 HTTPS or local files; snapshots and manifests; WAL frames', False),
    ('db', 'analytics', 'Query results; derived event-log rows', False),
]
NOTES = ('What exists on `main`: one API node holding every SQLite handle through `node:sqlite`, the Postgres '
         'registry for tenants, keys and sessions, the DuckDB reader child, snapshot backups to object storage. '
         'What is planned, inside the same system boundary: statement lanes (child processes) that execute '
         'SQLite through Deno FFI to the system `libsqlite3`, a placement table in the existing Postgres so any '
         'node can forward a request to the tenant\'s owner, and WAL frames shipped to object storage after the '
         'snapshot path. No new external system is introduced: the forwarded hop is node-to-node inside the '
         'platform, and the caller contract (`createClient(baseURL, appId, token)`) is unchanged. k6 and the '
         'migration/tenant CLIs are unchanged and omitted here for focus; see '
         '`docs/architecture/c4-context-document-db.github.md` for the audited landed context.')

if __name__ == '__main__':
    main(NAME, TITLE, BOUNDARY, NODES, EDGES, NOTES)
