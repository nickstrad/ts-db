"""Author DP-01 only. Run from the assigned repository root; format outputs with deno fmt."""
import copy
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / 'pages/public/architectures/tsdb-planes-proposal.json'
CONTENT = ROOT / 'pages/content/tsdb-planes-proposal'
BRIEF = '6c3989e28aed5c5fa60d4f6c33730ce6885d5c9a'
BASE = subprocess.check_output(['git', 'rev-parse', '351a51b'], text=True).strip()
SHIFT = ('A tenant owns zero or more databases (0..N). The database is the unit of placement, isolation, '
         'backup and lifecycle. One-file-per-tenant is superseded in this proposal; the lanes dataset stays unchanged.')
STE_SHIFT = ('A tenant can have zero or more databases. Place, isolate, back up and manage each database separately. '
             'This proposal replaces one file for each tenant with one file for each database. The lanes dataset does not change.')
SOURCES = []


def source(id, path, title, rev=BASE, notes=None):
    s = dict(id=id, title=title, path=path, revision=rev,
             url=f'https://github.com/nickstrad/ts-db/blob/{rev}/{path}')
    if notes:
        s['notes'] = notes
    SOURCES.append(s)


source('src-brief', 'agent-work/items/dp-01-planes/brief.md', 'DP-01 authorized design brief', BRIEF)
source('src-lanes', 'pages/public/architectures/tsdb-lanes-proposal.json', 'Preserved scale-out dataset')
source('src-lanes-inventory', 'pages/content/tsdb-lanes-proposal/inventory.md', 'Scale-out decisions P1–P17')
source('src-router', 'platform/tenants/routing.ts', 'Landed TenantStorageRouter seam; future ControlPlaneRouter')
source('src-classifier', 'platform/sqlite_ffi/classify.ts', 'Landed operation-IR classifier')
source('src-ffi', 'platform/sqlite_ffi/effect.ts', 'Landed scoped FFI and cancellation wrappers')
source('src-storage', 'platform/sqlite.ts', 'Landed Storage, connection gate and deadlines')
source('src-decisions', 'docs/knowledge/decisions.md', 'Router seam and Postgres handwritten SQL decisions')

b = dict(schemaVersion=1, id='tsdb-planes-proposal',
         title='Proposed: control plane / data plane — tenants own many databases',
         revision='dp-01-2026-10-20', defaultDiagramId='planes-context',
         model=dict(elements=[], relationships=[]), diagrams=[], documents=[], sources=SOURCES, terms=[])
elements = {}
relationships = {}
provenance = {}


def doc(id, title, plain, ste, sources):
    b['documents'].append(dict(id=id, title=title, plain=plain + '\n\n' + SHIFT,
                               ste=dict(text=ste + '\n\n' + STE_SHIFT,
                                        issue='ASD-STE100 Issue 9', reviewStatus='draft'),
                               termIds=[], sourceIds=sources))
    return id


def element(id, kind, name, description, ste, parent=None, status='planned',
            sources=None, tech=None, tags=None, notes=None, origin=None, **extra):
    sources = sources or ['src-brief']
    e = dict(id=id, kind=kind, name=name, description=description, status=status,
             tags=tags or [], plannedNotes=notes or [], sourceIds=sources,
             docIds=[doc('doc-' + id, name, description, ste, sources)], **extra)
    if parent:
        e['parentId'] = parent
    if tech:
        e['technology'] = tech
    if kind == 'container':
        e['containerType'] = 'datastore' if id in ['metadata', 'files'] else 'application'
    b['model']['elements'].append(e)
    elements[id] = e
    provenance[id] = origin or description
    return id


def rel(id, src, dst, label, tech, sources=None, status='planned', origin=None, **extra):
    r = dict(id=id, sourceId=src, targetId=dst, label=label, technology=tech, status=status,
             tags=[], plannedNotes=[], docIds=[], sourceIds=sources or ['src-brief'], **extra)
    del r['tags']
    b['model']['relationships'].append(r)
    relationships[id] = r
    provenance[id] = origin or label
    return id


external = ['external']
element('platform', 'softwareSystem', 'Database platform: control plane + data plane',
        'Management uses the control plane. Queries use the data plane. Both address databases by tenant and database identity; clients never select a hosting node.',
        'Use the control plane to manage databases. Use the data plane to query a database. The service selects its node.')
element('operator', 'person', 'Customer administrator', 'Creates tenants and databases, inspects state and requests database lifecycle operations.',
        'Create or remove tenants and databases. Inspect their state. Request a move or a backup.')
element('caller', 'person', 'Customer query client', 'One session can address any authorized database of its tenant by name or ID through the same query endpoint.',
        'Use the same endpoint and session to query any database that you are permitted to use.')
element('backups', 'softwareSystem', 'Per-database backup store',
        'Proposed verified snapshots and optional later WAL frames, keyed by immutable database ID and generation. Retention and erasure are explicit per-database policies.',
        'Keep a verified backup for each database. Identify the database and its generation. Apply its retention and deletion policy.',
        tags=external, sources=['src-brief', 'src-lanes'])
element('control', 'container', 'Control plane — management API',
        'Proposed authenticated management service: tenant/database CRUD, configuration, inspection, provisioning and lifecycle reconciliation. It does not run customer queries.',
        'Authenticate management requests. Create, configure and inspect tenants and databases. Reconcile lifecycle operations.',
        parent='platform', tech='Proposed Deno service; HTTPS JSON')
element('data', 'container', 'Data plane — query gateway',
        'Proposed stable access path: authenticate a session, authorize (tenant, database), resolve placement at open and forward to the owner node. Refresh placement after a move.',
        'Authenticate the session. Check permission for the tenant and database. Find the owner node when the database opens. Refresh the location after a move.',
        parent='platform', tech='Proposed Deno service; HTTPS JSON')
element('metadata', 'container', 'Registry and placement metadata',
        'Proposed Postgres metadata: tenants; databases with unique (tenant_id, name), immutable database_id, state and generation; placement (database_id, owner_node, epoch); durable operation records. Hand-written SQL, no ORM. State transitions use compare-and-swap transactions.',
        'Use Postgres and hand-written SQL. Do not use an ORM. Store each tenant, database, owner node, epoch and operation state. Change related records in one transaction.',
        parent='platform', tech='Postgres; hand-written SQL; no ORM', tags=external,
        sources=['src-brief', 'src-lanes', 'src-decisions'])
element('node', 'container', 'Node execution agent + lane supervisor',
        'Proposed service on each hosting node: validates database ID, owner epoch and active state before admission; enforces per-database gates; provisions files; drains handles; spawns and supervises child-process statement lanes. A shared lane is process fault containment, not a database isolation boundary.',
        'Check database identity, owner epoch and active state before execution. Stop new work for a fenced database. Drain its handles. Manage files and child processes.',
        parent='platform', tech='Proposed Deno process; authenticated internal RPC; child-process IPC', tags=external,
        sources=['src-brief', 'src-lanes'])
element('lanes', 'container', 'Statement lane processes',
        'Proposed child processes execute statements on node-local database files through the landed FFI layer. Handles, write queues, transactions and idempotency records are keyed by database ID, not tenant. A lane can serve several databases; killing it affects those requests but does not merge file lock domains.',
        'Run statements in child processes. Keep handles and write queues for each database separately. A process failure can affect several requests. Each database still has a separate file.',
        parent='platform', tech='Proposed Deno child processes; system libsqlite3 via Deno FFI', tags=external,
        sources=['src-brief', 'src-lanes', 'src-ffi'])
element('files', 'container', 'Isolated database SQLite files',
        'One SQLite database file and its WAL/SHM sidecars per immutable database ID. File paths are server-issued capabilities; user names are not paths. Each file has its own transaction and writer-lock domain. Delete closes handles and removes sidecars too.',
        'Keep one SQLite file for each database. Keep its WAL and SHM files with it. Use a server-issued path. Close handles before removing all these files.',
        parent='platform', tech='Node-local SQLite WAL files', tags=external,
        sources=['src-brief', 'src-router', 'src-lanes'])

# Control-plane internals.
element('management', 'component', 'Management ingress + authorization',
        'Authenticates administrators, checks tenant/database management grants and accepts idempotent operation IDs. Returns durable operation status for asynchronous lifecycle requests.',
        'Authenticate the administrator. Check permission. Accept an operation ID. Return the recorded operation state.',
        parent='control', tech='Proposed HTTPS JSON API')
element('tenant-registry', 'component', 'Tenant registry',
        'Create, configure, inspect and drop tenants. A tenant owns 0..N database records. Tenant deletion is rejected until every owned database has completed deletion; it never silently abandons files.',
        'Create, configure and inspect tenants. A tenant can have no databases or many databases. Reject tenant deletion until all its databases are deleted.',
        parent='control', tech='Proposed registry logic; Postgres hand-written SQL')
element('database-registry', 'component', 'Database registry',
        'Create/drop databases for a tenant; configure and inspect one database. Resolve tenant-scoped names to immutable IDs. Owns desired state and durable operation records; create starts provisioning, while drop starts lifecycle deletion.',
        'Create, configure and inspect a database for a tenant. Resolve its name to its ID. Record the requested state and operation. Start provisioning or deletion.',
        parent='control', tech='Proposed registry logic; Postgres hand-written SQL')
element('provisioner', 'component', 'Database provisioner',
        'Select a node per database; create its file and schema under a non-active generation; verify node readiness; then atomically publish ACTIVE placement. Idempotent reconciliation cleans failed partial files before name reuse.',
        'Select a node. Create and verify the database file. Publish an active placement only after the node is ready. Reconcile partial files if creation fails.',
        parent='control', tech='Proposed reconciler; authenticated internal RPC', sources=['src-brief', 'src-lanes'])
element('lifecycle', 'component', 'Database lifecycle controller',
        'Move, suspend/resume, backup/restore and delete individual databases. Persist operation intent; block opens; fence and drain the source; checkpoint/copy/verify; flip owner and epoch transactionally only after source fencing and target readiness. Require a reachable source to acknowledge fencing in this first design; otherwise leave unavailable. No automatic failover is claimed.',
        'Record each operation. Stop new opens and drain the database. Verify copied data before changing its owner. Require the source to acknowledge the fence. Keep the database unavailable if the source cannot do this.',
        parent='control', tech='Proposed durable state machine; Postgres SQL + internal RPC', sources=['src-brief', 'src-lanes'])

# Query path and node-local execution: components of distinct processes stay typed as such.
element('ingress', 'component', 'Query ingress / result return',
        'Stable query API accepts a tenant-scoped database name or ID and session credentials. Carries a request ID, operation IR, compiled SQL/binds and deadline; returns rows or typed errors through the same access path.',
        'Accept the database name or ID and session credentials. Keep the request ID and deadline. Return rows or an error through the same endpoint.',
        parent='data', tech='Proposed HTTPS JSON API')
element('authorization', 'component', 'Session authentication + database authorization',
        'Authenticate the session and derive trusted tenant identity. Check the requested database belongs to that tenant and is allowed by its grants. Clients cannot supply a trusted tenant, placement epoch or filesystem path. Recheck grants for each database selection.',
        'Authenticate the session. Derive the tenant identity. Check ownership and permission for the selected database. Do not trust client placement or path values.',
        parent='data', tech='Proposed tenant/database authorization')
element('placement-router', 'component', 'Placement router (ControlPlaneRouter extension)',
        'Proposed database → node resolver, keyed by immutable database ID plus epoch. Resolve at open; invalidate cached locations on stale epoch or a move; fail closed on inactive state. The landed TenantStorageRouter seam isolates storage location from Storage, but resolve(tenantId) does not yet accept a database ID or route remotely. The ControlPlaneRouter implementation and database-aware context/API extension are planned.',
        'Resolve the database location when it opens. Refresh a stale location. Reject an inactive database. The router interface exists today. Database selection and remote routing require new code.',
        parent='data', status='mixed', tech='Existing seam; proposed database router',
        notes=['The TenantStorageRouter interface is landed; database-aware ControlPlaneRouter, gateway placement and remote execution are planned.'],
        sources=['src-brief', 'src-router', 'src-decisions'])
element('forwarder', 'component', 'Owner-node forwarder',
        'Send a request to the resolved owner with trusted tenant ID, database ID, epoch, operation IR, SQL/binds, deadline and request ID over authenticated RPC. Return results unchanged. On WrongOwner, refresh and reopen; retries of mutations require per-database request-ID records committed with the mutation. Never blindly replay an ambiguous mutation.',
        'Send the trusted identity, database ID, epoch and statement to the owner. Return the result. Refresh stale placement. Use a database request-ID record before retrying a mutation with an unknown result.',
        parent='data', tech='Proposed authenticated internal RPC', sources=['src-brief', 'src-lanes'])
element('node-admission', 'component', 'Database admission gate + lane supervisor',
        'Node-local planned gate validates owner epoch and database state at each admission, including existing sessions. Per-database quiescing blocks new requests, drains or cancels in-flight work, closes all read/write handles and acknowledges a fence. If a lane must be killed, wait for process exit and fail affected requests; do not claim a fence while an old writer can still run.',
        'Check the database epoch and state on each request. Stop new work when fenced. Drain or cancel work and close all handles. If a process is killed, wait for its exit before acknowledging the fence.',
        parent='node', tech='Proposed node-local gates and child-process supervisor', tags=external,
        sources=['src-brief', 'src-lanes', 'src-storage'])
element('classifier', 'component', 'Statement classifier (landed code)',
        'Existing platform/sqlite_ffi/classify.ts classifies operation IR, not SQL text: bounded plans use blocking execution; unbounded reads use nonblocking execution. Reused unchanged inside proposed lanes; moving it into a lane is not landed.',
        'Classify the operation plan. Use the blocking path for bounded work. Use the nonblocking path for an unbounded read. This code exists. Its execution in a lane is proposed.',
        parent='lanes', status='existing', tech='Existing TypeScript operation-IR classifier', tags=external,
        sources=['src-classifier', 'src-lanes'])
element('execution', 'component', 'Scoped FFI statement execution (landed code)',
        'Existing Deno FFI to system libsqlite3: scoped connections, prepared statements, blocking/nonblocking steps and binding. Reused unchanged in proposed lanes; no separate libsqlite3 container. Deadline wrapper interrupts long reads and waits for execution to settle before reusing the connection.',
        'Use the installed FFI binding to execute a statement. Close scoped resources. Wait for interrupted execution to finish before using its connection again. The proposed lane process does not exist today.',
        parent='lanes', status='existing', tech='Existing Deno FFI; system libsqlite3', tags=external,
        sources=['src-ffi', 'src-storage', 'src-lanes'])
element('deadline', 'component', 'Deadline + interrupt policy',
        'Existing deadline/interrupt behavior is reused; proposed lane watchdog adds supervisor escalation if interruption does not settle. A process kill affects every in-flight request on that lane. Per-database drain acknowledgement waits for completion or confirmed process exit.',
        'Interrupt long reads at the deadline. Wait for execution to finish. The proposed watchdog can ask the supervisor to kill a stuck process. Confirm its exit before acknowledging a drain.',
        parent='lanes', status='mixed', tech='Existing sqlite3_interrupt; proposed lane watchdog', tags=external,
        notes=['Lane watchdog escalation and database-scoped drain acknowledgement are proposed.'],
        sources=['src-ffi', 'src-storage', 'src-lanes', 'src-brief'])

# Model relationships; numbers are stable per model tier and reused by dynamic views.
rel('ctx-manage', 'operator', 'platform', 'Management path → control plane: tenant and database CRUD / lifecycle', 'HTTPS JSON')
rel('ctx-query', 'caller', 'platform', 'Query path → data plane: dynamically access any authorized database', 'HTTPS JSON')
rel('ctx-backup', 'platform', 'backups', 'Per-database verified backup / restore; optional WAL frames later', 'Object-store HTTPS', ['src-brief', 'src-lanes'])
for args in [
    ('c-manage','operator','control','Manage tenants and databases','HTTPS JSON'),
    ('c-query','caller','data','Select any authorized database and query it','HTTPS JSON'),
    ('c-catalog','control','metadata','Tenant/database CRUD, operation state and placement publication','Postgres hand-written SQL'),
    ('c-resolve','data','metadata','Authorize database and resolve active owner / epoch','Postgres hand-written SQL'),
    ('c-lifecycle','control','node','Provision, fence, drain, copy, delete one database','Authenticated internal RPC'),
    ('c-forward','data','node','Execute on owner: tenant ID, database ID, epoch, request ID, plan, SQL, deadline','Authenticated internal RPC'),
    ('c-lane','node','lanes','Admit database-scoped work; supervise child processes','JSON-lines IPC'),
    ('c-files','lanes','files','Execute through landed FFI against the addressed database file','Deno FFI / SQLite WAL'),
    ('c-node-files','node','files','Provision, verify, snapshot, restore and remove database files','Node-local filesystem / SQLite backup'),
    ('c-node-backup','node','backups','Publish or fetch verified per-database snapshot','Object-store HTTPS'),
]:
    rel(*args, sources=['src-brief', 'src-lanes'])
for args in [
    ('cp-request','operator','management','Authorized management request and operation status','HTTPS JSON'),
    ('cp-tenant','management','tenant-registry','Create / drop tenant; configure / inspect','In-process call'),
    ('cp-database','management','database-registry','Create / drop tenant database; configure / inspect','In-process call'),
    ('cp-tenants-sql','tenant-registry','metadata','Tenant records; refuse deletion while databases remain','Postgres hand-written SQL'),
    ('cp-databases-sql','database-registry','metadata','Database names / IDs, desired state and idempotent operation records','Postgres hand-written SQL'),
    ('cp-provision','database-registry','provisioner','Reconcile a new database','Durable operation dispatch'),
    ('cp-lifecycle','database-registry','lifecycle','Move, suspend/resume, backup/restore or drop one database','Durable operation dispatch'),
    ('cp-placement','provisioner','metadata','Reserve identity and node; publish ACTIVE placement after readiness','Postgres SQL transaction / compare-and-swap'),
    ('cp-create-file','provisioner','node','Create and verify one database file on selected node','Authenticated internal RPC'),
    ('cp-operation','lifecycle','metadata','Persist state / tombstone; atomically change owner and epoch','Postgres SQL transaction / compare-and-swap'),
    ('cp-node','lifecycle','node','Fence, quiesce, copy/verify, activate or delete addressed database','Authenticated internal RPC'),
]:
    rel(*args)
for args in [
    ('dp-request','caller','ingress','Query a named database using the same session and endpoint','HTTPS JSON'),
    ('dp-auth','ingress','authorization','Authenticate session and authorize tenant / database selection','In-process call'),
    ('dp-auth-sql','authorization','metadata','Resolve name and verify tenant ownership / database grants','Postgres hand-written SQL'),
    ('dp-route','authorization','placement-router','Resolve authorized database at open; refresh after relocation','Proposed database-aware router call'),
    ('dp-placement','placement-router','metadata','Read ACTIVE database → node and epoch; reject inactive state','Postgres hand-written SQL'),
    ('dp-forward','placement-router','forwarder','Trusted database location and epoch for this request','In-process call'),
    ('dp-owner','forwarder','node-admission','Owner-node request or WrongOwner / inactive response','Authenticated internal RPC'),
    ('dp-classify','node-admission','classifier','Admit and classify operation IR in a selected lane','JSON-lines IPC; proposed lane placement'),
    ('dp-execute','classifier','execution','Choose bounded blocking or unbounded nonblocking step','Existing classifier path choice; planned lane dispatch'),
    ('dp-deadline','execution','deadline','Apply deadline policy and settle interrupted step','Existing binding cancellation; proposed watchdog integration'),
    ('dp-interrupt','deadline','execution','Interrupt at deadline; escalate if step does not settle','Existing sqlite3_interrupt; proposed escalation'),
    ('dp-escalate','deadline','node-admission','Ask supervisor to kill stuck lane; wait for confirmed exit','Proposed watchdog IPC'),
    ('dp-files','execution','files','Read / write only the selected database SQLite file','Existing Deno FFI / SQLite WAL'),
]:
    rel(*args, sources=['src-brief', 'src-lanes'])
# Only call relationships wholly reused as-is are existing. The process deployment stays planned.
for rid, srcs, status, notes in [
    ('dp-files',['src-ffi','src-router'],'existing',[]),
    ('dp-deadline',['src-ffi','src-storage','src-brief'],'mixed',['Existing deadline policy; proposed integration with a lane watchdog.']),
    ('dp-interrupt',['src-ffi','src-lanes'],'mixed',['Existing interrupt call; proposed escalation on a stuck lane.']),
]:
    relationships[rid].update(sourceIds=srcs,status=status,plannedNotes=notes)

legend = dict(title='Key', entries=[
    dict(id='scope',label='System in scope',description='The database platform is highlighted in the context view.',swatch=dict(shape='box',tone='accent',stroke='solid')),
    dict(id='person',label='Person / customer role',description='A customer administrator or query client.',swatch=dict(shape='person',tone='default',stroke='solid')),
    dict(id='box',label='System, process or component',description='Typed C4 element. A library is inside its process, never a separate container.',swatch=dict(shape='box',tone='default',stroke='solid')),
    dict(id='external',label='External or supporting',description='Grey includes supporting elements outside a component scope; it does not imply third-party ownership.',swatch=dict(shape='box',tone='external',stroke='solid')),
    dict(id='boundary',label='Process / fleet boundary',description='A proposed boundary groups related services or node-local execution.',swatch=dict(shape='boundary',tone='muted',stroke='dashed')),
    dict(id='planned',label='Planned or mixed',description='Dashed means planned or existing with planned changes. The card and notes distinguish them.',swatch=dict(shape='box',tone='default',stroke='dashed')),
    dict(id='existing-edge',label='Existing call',description='Solid relationship: reused landed code, not proof a proposed process exists.',swatch=dict(shape='line',tone='default',stroke='solid',arrow='forward')),
    dict(id='planned-edge',label='Proposed relationship',description='Dashed relationship: unbuilt behavior or changes. Edge numbers are model references, not measurements.',swatch=dict(shape='line',tone='default',stroke='dashed',arrow='forward')),
])
edge_numbers = {}
for prefix in ['ctx-', 'c-', 'cp-', 'dp-']:
    edge_numbers.update({r: n for n, r in enumerate((r for r in relationships if r.startswith(prefix)), 1)})


def diagram(id, kind, title, members, edges, plain, ste, scope=None, parent=None, **extra):
    d = dict(id=id, kind=kind, title=title, status='planned',
             nodes=[dict(elementId=e) for e in members],
             edges=[dict(relationshipId=r,displayNumber=edge_numbers[r]) for r in edges],
             docIds=[doc('doc-' + id,title,plain,ste,['src-brief','src-lanes'])],
             sourceIds=['src-brief','src-lanes'], layout=dict(mode='auto',direction='TB'),
             legend=copy.deepcopy(legend), groups=[], related=[], **extra)
    if scope:
        d['scopeId'] = scope
    if parent:
        d['parent'] = dict(diagramId=parent)
    b['diagrams'].append(d)
    return d


context = diagram('planes-context','context','System context: control plane / data plane',
                  ['operator','caller','platform','backups'],[r for r in relationships if r.startswith('ctx-')],
                  'Proposed database service. Two distinct paths are the headline: administrators manage tenants and databases through the control plane; customers query any authorized database through the data plane. Hosting nodes are hidden from clients; the container view separates these processes. This is a design, not deployed behavior.',
                  'Use the management path for lifecycle operations. Use the query path for database access. Clients do not select nodes. Open the container view to see the two planes and hosting nodes.',scope='platform')
containers = diagram('planes-containers','container','Containers: management plane, query plane and hosting nodes',
                     ['operator','caller','control','data','metadata','node','lanes','files','backups'],
                     [r for r in relationships if r.startswith('c-')],
                     'Control plane owns management state in Postgres with hand-written SQL (no ORM). Data plane reads metadata, selects the owner and returns results. A fleet node manages database files and child-process lanes. The node boundary represents one of many nodes, not one tenant. Grey supporting containers are internal to the platform, except the backup service; component-view tags make them grey in this view too.',
                     'The control plane changes metadata. The data plane reads metadata and sends queries to owner nodes. A node runs lanes and holds database files. Grey can mean a supporting internal container.',scope='platform',parent='planes-context')
containers['groups']=[dict(id='g-node',label='Hosting node (one of N; database-scoped placement)',memberIds=['node','lanes','files'],status='planned')]
cp = diagram('planes-control-components','component','Control plane: tenant/database CRUD and lifecycle',
             ['operator','management','tenant-registry','database-registry','provisioner','lifecycle','metadata','node'],
             [r for r in relationships if r.startswith('cp-')],
             'Tenant registry owns tenant CRUD; database registry owns tenant-scoped database CRUD, configure and inspect. Postgres metadata is accessed with hand-written SQL, no ORM. Provisioning publishes only verified files. Lifecycle operations move, suspend/resume, back up, restore or delete one database. Tenant drop is restricted until all its databases are deleted. Operations are durable and idempotent across crashes; the control plane reconciles intermediate states.',
             'Keep tenants and their databases in separate records. Use hand-written SQL in Postgres. Publish a new database only after verification. Record lifecycle work so it can resume after a crash. Reject tenant deletion while databases remain.',scope='control',parent='planes-containers')
dp = diagram('planes-data-components','component','Data plane: dynamic access to the right database node',
             ['caller','ingress','authorization','placement-router','forwarder','metadata','node-admission','classifier','execution','deadline','files'],
             [r for r in relationships if r.startswith('dp-')],
             'A session selects any authorized database by name/ID. Resolve its immutable ID and ACTIVE placement at open. Keep location/epoch as a revocable routing hint, revalidated by owner-node admission on each request; after a move, WrongOwner invalidates it and forces refresh. The data gateway contains ingress, authorization, router and forwarder; grey components execute in the node/lane processes, not the gateway. Existing FFI code is solid; lane deployment remains proposed. Carry operation IR with compiled SQL so the landed classifier can be reused without parsing SQL. The existing router interface takes only tenantId; database-aware selection/context and remote forwarding must be added. Swapping location resolution uses the landed seam without rewriting Storage; the present client API does not already support selecting arbitrary databases.',
             'Select the database by name or ID. Check permission and resolve placement when it opens. The owner checks epoch and state on each request. Refresh a stale location after a move. Grey components run on the hosting node. Pass operation IR to the installed classifier. Add database selection to the existing tenant-only router and client context.',scope='data',parent='planes-containers')


def flow(id, title, entries, plain, ste, parent):
    # Entries are ordered (relationship, direction, label). Derive exact members and static edges.
    edges = list(dict.fromkeys(r for r, _, _ in entries))
    members = list(dict.fromkeys(e for r in edges for e in [relationships[r]['sourceId'],relationships[r]['targetId']]))
    scenario = dict(kind='sequence',id=id+'-sequence',children=[
        dict(kind='interaction',id=f'{id}-s{n}',relationshipId=r,direction=direction,label=label)
        for n,(r,direction,label) in enumerate(entries,1)])
    return diagram(id,'dynamic',title,members,edges,plain,ste,parent=parent,scenario=scenario)


F = 'forward'
R = 'reverse'
flow('flow-create-database','Create database: provision then publish',[
    ('cp-request',F,'Create database for tenant, with operation ID'),
    ('cp-database',F,'Authorize and register requested database name'),
    ('cp-databases-sql',F,'Reserve immutable database ID and unique name; persist PROVISIONING operation'),
    ('cp-provision',F,'Start idempotent provisioning for database ID'),
    ('cp-placement',F,'Reserve selected node; keep placement non-routable'),
    ('cp-create-file',F,'Create database file and schema on selected node under generation token'),
    ('cp-create-file',R,'Acknowledge verified file readiness'),
    ('cp-placement',F,'CAS operation generation: publish ACTIVE owner and initial epoch atomically'),
    ('cp-provision',R,'Return successful operation state'),
    ('cp-database',R,'Return database ID and operation status'),
    ('cp-request',R,'Report ACTIVE database through management endpoint'),
], 'Success scenario. Only after the selected node verifies file/schema creation may the placement become ACTIVE. Identity and operation records are durable before file creation. A retry uses the same operation ID; a crash after creation is reconciled rather than creating a second file. See the separate provisioning-failure scenario.',
     'Record the database and operation before creating the file. Verify the file. Publish the active placement in one metadata transaction. Return the database ID.', 'planes-control-components')
flow('flow-create-failed','Create database — alternative: provisioning fails',[
    ('cp-provision',F,'Resume durable PROVISIONING operation'),
    ('cp-create-file',F,'Attempt file/schema creation'),
    ('cp-create-file',R,'Creation or verification fails; no readiness acknowledgement'),
    ('cp-placement',F,'Keep placement non-routable; record cleanup-required operation'),
    ('cp-create-file',F,'Retry idempotent removal of partial file and sidecars'),
    ('cp-create-file',R,'Acknowledge no partial file remains'),
    ('cp-placement',F,'Record FAILED operation; release reserved name only after cleanup'),
    ('cp-provision',R,'Return failed operation status'),
], 'Named failure alternative, not a second branch of the success tree. If cleanup cannot be confirmed, retain cleanup-required state and the name reservation. No partial file is published or silently orphaned. Durable operation history remains for inspection.',
     'Do not publish an unverified file. Record the failure. Remove partial files. Keep the name reserved until cleanup is confirmed.', 'planes-control-components')
flow('flow-query-right-node','Query: resolve database and execute on its owner',[
    ('dp-request',F,'Session selects one tenant database by name or ID'),
    ('dp-auth',F,'Authenticate and authorize this selection'),
    ('dp-auth-sql',F,'Verify database belongs to trusted tenant and grants allow access'),
    ('dp-auth-sql',R,'Return authorized immutable database ID'),
    ('dp-route',F,'Resolve location at open for this database'),
    ('dp-placement',F,'Read ACTIVE owner and epoch'),
    ('dp-placement',R,'Return node B and current epoch; client need not know node B'),
    ('dp-forward',F,'Use trusted placement and preserve request identity'),
    ('dp-owner',F,'Forward tenant/database IDs, epoch, plan IR, SQL/binds and deadline to node B'),
    ('dp-classify',F,'Admit only current ACTIVE epoch and send IR to node-local lane'),
    ('dp-execute',F,'Choose the execution path from the operation IR'),
    ('dp-deadline',F,'Apply execution deadline policy'),
    ('dp-files',F,'Execute against this database file'),
    ('dp-files',R,'Return rows after statement settles'),
    ('dp-execute',R,'Return completed execution result'),
    ('dp-classify',R,'Return lane result to node admission'),
    ('dp-owner',R,'Return rows to forwarding gateway'),
    ('dp-forward',R,'Return result through router'),
    ('dp-route',R,'Return result through authorization'),
    ('dp-auth',R,'Return result to query ingress'),
    ('dp-request',R,'Return rows to the same client session'),
], 'Success scenario. A later request in the same session can select another database on node A through the same URL. Authorization is per selected database. Statements carry operation IR as well as SQL/binds. Unbounded-read deadline failure and stale-owner failure are separate named scenarios; no timing or throughput measurement is claimed.',
     'Use the same session and endpoint for another database. Check each selected database. Resolve its owner and execute there. Return the result through the same path.', 'planes-data-components')
flow('flow-query-stale','Query — alternative: moved database refreshes placement',[
    ('dp-owner',F,'Send request with old epoch to former owner'),
    ('dp-owner',R,'Reject before executing: WrongOwner / stale epoch'),
    ('dp-forward',R,'Invalidate cached database location'),
    ('dp-placement',F,'Refresh ACTIVE database owner and epoch'),
    ('dp-placement',R,'Return new owner and epoch after completed move'),
    ('dp-forward',F,'Reopen database location at new owner'),
    ('dp-owner',F,'Retry safely with same request ID at new owner; no client node change'),
    ('dp-owner',R,'Return result or recorded per-database mutation outcome'),
], 'Named stale-route alternative. Reject before execution. The illustrated refresh finds a completed move; MOVING/SUSPENDED/DROPPING or unavailable metadata instead returns an unavailable error and does not run SQL. A prior ambiguous mutation result requires request-ID deduplication committed in that database; blind replay is forbidden. Request-ID state moves with the database.',
     'Reject stale placement before execution. Read the new active placement. Use the same request ID. Do not blindly retry a mutation if its result is unknown.', 'planes-data-components')
flow('flow-query-deadline','Query — alternative: long read reaches deadline',[
    ('dp-execute',F,'Classified unbounded read uses nonblocking FFI step'),
    ('dp-deadline',F,'Apply remaining read deadline'),
    ('dp-interrupt',F,'Deadline expires: interrupt the read'),
    ('dp-interrupt',R,'Confirm step settled before connection reuse'),
    ('dp-execute',R,'Return typed deadline failure'),
], 'Named deadline alternative reuses landed FFI cancellation behavior. This scenario assumes interruption settles. If it does not, the proposed watchdog asks the lane supervisor to kill the process and waits for exit; all that lane’s in-flight requests fail, and database fences are not acknowledged early. This is a policy, not a measured latency guarantee.',
     'Interrupt the long read at its deadline. Wait for its execution to finish. Return a deadline error. If the process does not stop, ask the supervisor to kill it and confirm exit.', 'planes-data-components')
flow('flow-move-database','Move database: fence, copy, then flip placement',[
    ('cp-lifecycle',F,'Request move of one database A → B with operation ID'),
    ('cp-operation',F,'CAS ACTIVE → MOVING; persist source A, target B and next epoch; block new opens'),
    ('cp-node',F,'Fence this database on source A; stop all new admissions including existing sessions'),
    ('cp-node',F,'Drain or cancel in-flight work; close all handles; checkpoint after settlement'),
    ('cp-node',R,'Source A confirms durable fence and no live database handles / writers'),
    ('cp-node',F,'Copy closed database snapshot and request-ID state to inactive target B; verify integrity / identity'),
    ('cp-node',R,'Target B confirms verified staged data and readiness; source remains fenced'),
    ('cp-operation',F,'Transaction CAS MOVING operation: flip owner A → B, increment epoch and publish ACTIVE'),
    ('cp-node',F,'Activate target B only after reading new ACTIVE owner / epoch; old epoch stays rejected'),
    ('cp-node',R,'Target B accepts current-epoch access'),
    ('cp-node',F,'Remove fenced source copy and sidecars; reconcile cleanup if needed'),
    ('cp-operation',F,'Record move complete; keep epoch and operation history'),
    ('cp-lifecycle',R,'Report completed move; stale routing will refresh at open'),
], 'Design choice: an offline, per-database move with temporary unavailability. The source must acknowledge a durable fence; otherwise placement does not flip. Recovery reads durable MOVING state before reopening any file. Only after in-flight work settles, all handles close, and target data verifies does one Postgres transaction publish the new ACTIVE epoch. Target admits only after that commit. Source remains fenced even after restart. Cleanup follows activation; its failure never re-enables the old owner. Other databases can remain active, except for the documented shared-lane kill blast radius. Snapshot copy uses a closed/checkpointed database, not a live main-file-only copy; online WAL streaming is deferred.',
     'Stop access to this database. Drain its work and close handles on A. Verify the copied database on B. Change owner and epoch in one transaction. Activate B and remove the old copy. Keep A fenced after a restart.', 'planes-control-components')
flow('flow-move-failed','Move database — alternative: target verification fails before flip',[
    ('cp-node',R,'Source fence confirmed; staged target copy fails integrity check'),
    ('cp-operation',F,'Keep MOVING unavailable and source owner unchanged; record failed attempt'),
    ('cp-node',F,'Remove inactive target copy; require confirmed cleanup'),
    ('cp-node',R,'Confirm target cannot serve and its staged copy is removed'),
    ('cp-operation',F,'CAS rollback: publish source A ACTIVE at a fresh epoch; retain operation failure history'),
    ('cp-node',F,'Explicitly unfence A only after reading rollback ACTIVE epoch'),
    ('cp-lifecycle',R,'Return failed move status; source can serve refreshed opens'),
], 'Named pre-flip failure scenario. If source fencing cannot be confirmed, or target cleanup is not confirmed, leave unavailable and reconcile; do not guess ownership. The illustrated rollback requires the source file intact and verified and no target activation. A failure after placement commit cannot use this rollback: target remains the sole owner and the controller reconciles activation/cleanup, or runs a new fenced move.',
     'Keep the database unavailable after failed verification. Remove the inactive target copy. If the source is intact, publish a fresh epoch for A before removing its fence. After a placement commit, reconcile the new owner instead.', 'planes-control-components')
flow('flow-drop-database','Drop database: remove files then clean registry',[
    ('cp-request',F,'Drop tenant database by ID with operation ID'),
    ('cp-database',F,'Authorize database deletion'),
    ('cp-lifecycle',F,'Start durable database delete operation'),
    ('cp-operation',F,'CAS state → DROPPING; tombstone identity and block opens'),
    ('cp-node',F,'Fence owner and drain/cancel work; close read/write handles on all known copies'),
    ('cp-node',R,'Confirm no in-flight work, live handles or old copies can serve'),
    ('cp-node',F,'Remove main file, WAL/SHM, staged/source remnants and all database backups / WAL archives'),
    ('cp-node',R,'Confirm all database data and backups are removed'),
    ('cp-operation',F,'Remove active placement and live database/name registry records; retain non-routable ID tombstone and operation audit'),
    ('cp-lifecycle',R,'Report database deletion complete'),
    ('cp-database',R,'Return completed drop status'),
    ('cp-request',R,'Acknowledge deletion; tenant and sibling databases remain'),
], 'Success scenario. Delete data before removing routing/registry evidence needed for cleanup. A database ID is never reused; its minimal tombstone is not a live database record. Deletion erases the database’s backups and archived WAL frames too; it does not report success while data cleanup remains pending. All staged copies are tracked by durable operations. Tenant deletion requires zero remaining live or deleting databases; it does not delete siblings implicitly.',
     'Block opens and stop all work for the database. Remove its files and sidecars. Remove its backups and archived WAL frames. Remove active placement and live registry records only after confirmation. Keep a non-routable tombstone. Keep sibling databases.', 'planes-control-components')
flow('flow-drop-failed','Drop database — alternative: file removal is not confirmed',[
    ('cp-node',F,'Attempt idempotent removal after fencing and drain'),
    ('cp-node',R,'Node unavailable or file/backup cleanup not confirmed'),
    ('cp-operation',F,'Retain DROPPING tombstone, placement evidence and pending cleanup operation; deny queries'),
    ('cp-lifecycle',R,'Report deletion pending, not successful; reconcile cleanup with same operation ID'),
], 'Named deletion-failure alternative. Do not clean away registry evidence and leak data. Keep the name reserved and the database unavailable until cleanup succeeds. Repeating a deletion uses the durable operation ID. The normal drop scenario resumes only after acknowledgement.',
     'Keep deletion pending if removal is not confirmed. Do not admit queries. Keep the records needed to remove all copies. Retry cleanup with the same operation ID.', 'planes-control-components')

# Illustrative deployment: uneven distribution, tenant Alpha spans nodes, node A mixes tenants.
for id, name, tech in [('dep-gateway','Gateway host','Linux host'),('dep-management','Management host','Linux host'),('dep-postgres','Metadata host','Postgres host'),('dep-a','Data node A','Linux host'),('dep-b','Data node B','Linux host'),('dep-c','Data node C','Linux host')]:
    element(id,'deploymentNode',name,'Illustrative proposed host; not a claim about the actual droplet.',
            'This is a proposed example host. It does not describe the actual droplet.',tech=tech,environment='illustrative')
for id, name, logical, host, desc in [
    ('dep-query','Shared query endpoint','data','dep-gateway','One stable query access path for all tenant databases.'),
    ('dep-control','Management API','control','dep-management','Tenant and database lifecycle requests.'),
    ('dep-metadata','Registry / placement Postgres','metadata','dep-postgres','Database-keyed owner and epoch records; handwritten SQL.'),
    ('dep-a-agent','Node A execution agent','node','dep-a','Owns Alpha/orders, Alpha/archive and Beta/metrics (three databases).'),
    ('dep-b-agent','Node B execution agent','node','dep-b','Owns Alpha/analytics (one database).'),
    ('dep-c-agent','Node C execution agent','node','dep-c','Owns Beta/sandbox and Gamma/events (two databases).'),
    ('dep-a-lane','Node A statement lane','lanes','dep-a','Illustrative lane; per-database file handles and queues.'),
    ('dep-b-lane','Node B statement lane','lanes','dep-b','Illustrative lane for Alpha/analytics.'),
    ('dep-c-lane','Node C statement lane','lanes','dep-c','Illustrative lane; Beta and Gamma remain separate files.'),
    ('dep-alpha-orders','Alpha / orders.sqlite','files','dep-a','Tenant Alpha database orders: immutable db-a1; independent file and lock domain.'),
    ('dep-alpha-archive','Alpha / archive.sqlite','files','dep-a','Tenant Alpha database archive: immutable db-a2; independent file and lifecycle.'),
    ('dep-beta-metrics','Beta / metrics.sqlite','files','dep-a','Tenant Beta database metrics: immutable db-b1; shares node A, not a file, with Alpha.'),
    ('dep-alpha-analytics','Alpha / analytics.sqlite','files','dep-b','Tenant Alpha database analytics: immutable db-a3; same endpoint as Alpha databases on A.'),
    ('dep-beta-sandbox','Beta / sandbox.sqlite','files','dep-c','Tenant Beta database sandbox: immutable db-b2 on a different node from metrics.'),
    ('dep-gamma-events','Gamma / events.sqlite','files','dep-c','Tenant Gamma database events: immutable db-c1; separate from Beta/sandbox.'),
]:
    element(id,'instance',name,'Illustrative proposed instance. '+desc, 'This is a proposed example. '+desc,
            parent=host,instanceOf=logical,environment='illustrative')
for src,dst,model in [
    ('dep-control','dep-metadata','c-catalog'),('dep-query','dep-metadata','c-resolve'),
    *[( 'dep-query',f'dep-{n}-agent','c-forward') for n in 'abc'],
    *[( 'dep-control',f'dep-{n}-agent','c-lifecycle') for n in 'abc'],
    *[( f'dep-{n}-agent',f'dep-{n}-lane','c-lane') for n in 'abc'],
    ('dep-a-lane','dep-alpha-orders','c-files'),('dep-a-lane','dep-alpha-archive','c-files'),
    ('dep-a-lane','dep-beta-metrics','c-files'),('dep-b-lane','dep-alpha-analytics','c-files'),
    ('dep-c-lane','dep-beta-sandbox','c-files'),('dep-c-lane','dep-gamma-events','c-files'),
]:
    id=f'{src}-to-{dst}'
    rel(id,src,dst,relationships[model]['label'],relationships[model]['technology'],modelRelationshipId=model)
    edge_numbers[id] = len([r for r in relationships if r.startswith('dep-')])
deployment = diagram('planes-deployment','deployment','Deployment: uneven database placement (illustrative)',
                     [e for e in elements if e.startswith('dep-')],[r for r in relationships if r.startswith('dep-')],
                     'Proposed illustrative deployment, not a claim about the actual droplet. Three nodes hold 3, 1 and 2 databases. Alpha owns orders/archive on A and analytics on B; node A hosts both Alpha and Beta. Beta also spans A and C. A registered tenant Delta can have zero databases and therefore no file instance. Counts are examples, not capacity limits or measurements. Postgres stores metadata, not customer SQLite data. All instances are planned even when they reuse landed FFI code.',
                     'This deployment is illustrative. It is not a claim about the actual droplet. Put three database files on A, one on B and two on C. Alpha uses A and B. A holds separate Alpha and Beta files. Delta can have no database. These counts are examples.',parent='planes-containers',environment='illustrative')

# In-context navigation. Dynamic and deployment views use related links, not invalid detail links.
context['nodes'][2]['detail'] = dict(diagramId='planes-containers')
for n in containers['nodes']:
    if n['elementId'] in ['control','data']:
        n['detail'] = dict(diagramId='planes-'+n['elementId']+'-components')
for d in b['diagrams']:
    if d['kind'] == 'dynamic':
        siblings=[x for x in b['diagrams'] if x['kind']=='dynamic' and x['parent']==d['parent'] and x['id']!=d['id']]
        d['related']=[dict(diagramId=x['id'],label=x['title']) for x in siblings]
for d in [context,containers,cp,dp]:
    targets=[x for x in b['diagrams'] if x.get('parent',{}).get('diagramId')==d['id']]
    d['related']=[dict(diagramId=x['id'],label=x['title']) for x in targets]

# Compact card summaries; full explanations remain in the documents above.
summaries = {
    'platform': ('Database platform', 'Control plane manages tenant databases. Data plane routes queries to database owner nodes.'),
    'backups': ('Database backup store', 'Verified snapshots per database ID and generation. Optional WAL frames are future work.'),
    'control': ('Control plane', 'Manage tenants and their databases: CRUD, configuration, provisioning and lifecycle.'),
    'data': ('Data plane', 'One query endpoint. Authorize database selection, resolve placement and return results.'),
    'metadata': ('Postgres metadata', 'Tenants, databases, placement epochs and durable operations. Hand-written SQL; no ORM.'),
    'node': ('Node agent + supervisor', 'Validate database epochs, manage files and supervise child-process statement lanes.'),
    'lanes': ('Statement lanes', 'Proposed child processes. Per-database handles, queues and request-ID state; landed FFI code.'),
    'files': ('Database SQLite files', 'One file and WAL/SHM set per database. Separate transactions and writer locks.'),
    'management': ('Management ingress', 'Authenticate administrators. Check permissions. Record idempotent operations and return status.'),
    'tenant-registry': ('Tenant registry', 'Create, configure and inspect tenants. Drop only after all owned databases are deleted.'),
    'database-registry': ('Database registry', 'Tenant-scoped database CRUD, configure and inspect. Immutable IDs; names are not paths.'),
    'provisioner': ('Database provisioner', 'Select a node, create and verify one database file, then publish its active placement.'),
    'lifecycle': ('Database lifecycle', 'Move, suspend/resume, backup/restore and delete. Fence and drain before changing ownership.'),
    'ingress': ('Query ingress', 'Select any authorized database by name/ID through the same endpoint and session; return results.'),
    'authorization': ('Session + database auth', 'Derive trusted tenant identity. Verify database ownership and grants for each selection.'),
    'placement-router': ('Placement router', 'Database → node and epoch at open. Refresh after moves. Database-aware seam extension is planned.'),
    'forwarder': ('Owner-node forwarder', 'Forward trusted tenant/database IDs, epoch, request ID, operation IR, SQL/binds and deadline.'),
    'node-admission': ('Admission + supervisor', 'Check database state/epoch per request. Gate, drain and close handles before acknowledging a fence.'),
    'classifier': ('Statement classifier', 'Landed operation-IR classifier: bounded blocking path or unbounded nonblocking read.'),
    'execution': ('FFI statement executor', 'Landed scoped libsqlite3 execution. Reused in proposed lanes; no separate library container.'),
    'deadline': ('Deadline / interrupt', 'Landed interrupt and settlement. Lane watchdog escalation and database-drain integration are proposed.'),
}
for id, (name, summary) in summaries.items():
    elements[id]['name'] = name
    elements[id]['description'] = summary
for id, tech in {
    'control':'Proposed Deno management service', 'data':'Proposed Deno query service',
    'node':'Proposed Deno node process', 'lanes':'Proposed Deno child processes / FFI',
    'metadata':'Postgres; hand-written SQL', 'database-registry':'Proposed logic / Postgres SQL',
    'tenant-registry':'Proposed logic / Postgres SQL', 'provisioner':'Proposed reconciler / internal RPC',
    'lifecycle':'Proposed durable state machine', 'authorization':'Proposed session/database policy',
    'placement-router':'Existing seam; proposed database router', 'forwarder':'Proposed authenticated RPC',
    'node-admission':'Proposed node gates / supervisor', 'classifier':'Existing TypeScript / operation IR',
    'execution':'Existing Deno FFI / libsqlite3', 'deadline':'Existing interrupt; proposed watchdog',
}.items():
    elements[id]['technology'] = tech
for d in [context, containers, cp, dp]:
    d['layout']['direction'] = 'LR'

# Supplemental lifecycle policies: explicit behavior without claiming implementation.
doc('doc-lifecycle-policies','Suspend, resume, backup and restore',
    'Suspend uses the same per-database gate and drain as move; SUSPENDED blocks opens and existing-session admissions. Resume requires verified file readiness, ACTIVE state and a fresh epoch. Backup takes a consistent per-database SQLite backup with an identity/generation manifest and verification; it does not copy a live main file alone. Restore stages and verifies a backup before a fenced, drained generation swap and fresh-epoch activation. IDs/authorization must still match; restoring data cannot resurrect deleted grants. Operations use durable IDs and state transitions, never a distributed transaction across SQL and files. This design chooses temporary unavailability and reconciliation over unproven online relocation or failover.',
    'Suspend one database by stopping admission and draining work. Resume it only when its file is verified. Make and verify a consistent database backup. For restore, stop access and verify staged data before replacing the generation. Change the epoch before resuming access. Keep operation records so work can resume after a crash.', ['src-brief','src-lanes'])
elements['lifecycle']['docIds'].append('doc-lifecycle-policies')
cp['docIds'].append('doc-lifecycle-policies')

CONTENT.mkdir(parents=True, exist_ok=True)
BUNDLE.write_text(json.dumps(b,ensure_ascii=False,indent=2)+'\n')
# Inventory maps each item to source identifiers and a precise local design rationale.
lines = ['# DP-01 inventory: `tsdb-planes-proposal`', '', 'Date: 2026-10-20. Builder: `sol-dp-01`. Proposal only; no runtime code is changed.', '',
         SHIFT, '', '## Sources', '', '| Source ID | Commit-pinned path | Use |', '| --- | --- | --- |']
for s in SOURCES:
    lines.append(f'| `{s["id"]}` | [{s["path"]}]({s["url"]}) | {s["title"]} |')
lines += ['', '## Decisions and discrepancies', '',
          '- **DP1 — identity.** Tenant → 0..N databases; immutable database ID is the placement, file, isolation, backup and lifecycle key. Names are unique within a tenant and never file paths. This intentionally supersedes the lanes proposal’s one-file-per-tenant model only here.',
          '- **DP2 — scope/status.** New control/data planes, database-aware routing, files and all deployments are planned. Landed classifier and FFI code are existing; the routing seam is mixed because database-aware remote routing is new, and deadline policy is mixed because watchdog escalation is new. Existing code inside a planned process does not make the process landed (P1/P3/P13).',
          '- **DP3 — context abstraction.** One software system at Level 1 with explicitly separate management and query paths. Level 2 expands it into the control plane, data plane and node-local hosting processes. Postgres is an internal container here (as in the current dataset), not the lanes dataset’s separate registry system (P4). Supporting containers/components are tagged external for SDK component grammar; the key explains that grey does not imply external ownership (D3/P12).',
          '- **DP4 — router truth.** `platform/tenants/routing.ts` supplies the landed TenantStorageRouter capability seam; ControlPlaneRouter is a future implementation, not landed code. Its current `resolve(tenantId)` and tenant-only context cannot already select multiple databases. Database ID/context/client-selection extension is explicit planned work. Location resolution remains behind the seam; the brief’s unchanged Storage/client implementation-swap invariant does not magically add a database-selection API.',
          '- **DP5 — metadata.** Postgres, hand-written SQL, no ORM. Database state and placement/epoch publish atomically using conditional transactions; file/RPC work uses durable operations and reconciliation, not an invented cross-store transaction. Tenant drop is restricted until its databases have completed deletion.',
          '- **DP6 — dynamic access.** Same session/endpoint, database name or ID per selection. Authenticate and authorize the pair; resolve ACTIVE placement at open. Owner validates state/epoch for every admission, so a cached open is not perpetual access. Refresh WrongOwner at reopen; inactive/unknown state fails closed. Forward only server-trusted identities over authenticated RPC.',
          '- **DP7 — relocation.** Chosen offline move: record MOVING, block opens, fence old admissions including sessions, drain/cancel all in-flight work, close handles, verify checkpointed copy, then flip owner+epoch and ACTIVE in one transaction. Target gates activation on committed placement; old owner remains fenced across restart. Source must acknowledge fencing: unreachable source means unavailable, not guessed failover. Confirm process exit after a kill before acknowledging drain. Pre-flip rollback needs verified intact source and confirmed target cleanup, and uses a fresh epoch. After-flip failures reconcile target activation/cleanup; no rollback to stale owner.',
          '- **DP8 — deletion/restore.** Remove files and sidecars/all known copies before live registry cleanup; retain non-routable identity tombstone and operation history. Drop erases backups and archived WAL as well as local data; pending cleanup is never reported as success. Failed cleanup remains DROPPING and reserves the name. Backup/restore and suspend/resume use database gates/generations (see `doc-lifecycle-policies`).',
          '- **DP9 — lane reuse.** Reuse placement table, forwarder, supervisor, statement lanes, per-database request-ID dedup, FFI classifier/deadline and optional WAL-frame vocabulary. Carry operation IR alongside SQL/binds so the classifier never parses SQL (lanes discrepancy 11). No tenant-wide sticky lane set, file, queue or lock. A shared child-process lane has a multi-database failure blast radius; it is not a database isolation boundary.',
          '- **DP10 — omissions.** No invented code-level symbols, latency/capacity measurements, automatic failover, online migration or WAL-shipping implementation. Optional future WAL frames are database/generation keyed; offline verified snapshots suffice for this design. DuckDB event-log analysis and unchanged app/observability paths are omitted for focus (P8). Existing two bundles and their content remain byte-identical.',
          '- **DP11 — documents and flows.** Every diagram and every element has plain and STE Issue 9 draft text (not certified). Each dynamic diagram has one sequence Step tree using model relationships. Failure alternatives are separate named diagrams. Reverse interactions are responses; edge numbers are model references, not timings. New edge numbering is local to this authored design; there is no prior Mermaid numbering to preserve (D1–D5/P1–P5 conventions retained where applicable).',
          '- **DP12 — deployment.** Illustrative only: A=3, B=1, C=2 databases; Alpha spans A/B, Beta spans A/C, A mixes Alpha/Beta. Zero-database Delta has no file. Database files are instances of a logical datastore container, not extra containers. Every deployment edge names its matching logical model relationship.',
          '- **DP13 — registration.** Data-driven `pages/public/catalog.json` requires an added catalog entry, not viewer code. The brief explicitly authorizes the minimal registration change even though that file is omitted from its initial Owns list. Existing default remains current.',
          '', '## Elements', '', '| ID | Kind / status | Source IDs | Document IDs | Grounding / design |', '| --- | --- | --- | --- | --- |']
for e in b['model']['elements']:
    lines.append(f'| `{e["id"]}` | {e["kind"]} / {e["status"]} | '+', '.join('`'+s+'`' for s in e['sourceIds'])+' | '+', '.join('`'+s+'`' for s in e['docIds'])+' | '+provenance[e['id']]+' |')
lines += ['', '## Relationships', '', '| ID | Endpoints | Status | Sources / logical instance | Grounding |', '| --- | --- | --- | --- | --- |']
for r in b['model']['relationships']:
    sources = ', '.join('`'+s+'`' for s in r['sourceIds'])
    if 'modelRelationshipId' in r:
        sources += ' / `'+r['modelRelationshipId']+'`'
    lines.append(f'| `{r["id"]}` | `{r["sourceId"]}` → `{r["targetId"]}` | {r["status"]} | {sources} | {provenance[r["id"]]} |')
lines += ['', '## Views and steps', '', 'Each step below inherits its diagram’s `src-brief` / `src-lanes` provenance. The authored labels specify the proposed protocol; only the identified classifier/FFI operations are landed. Diagrams link their alternatives and parent views.', '']
for d in b['diagrams']:
    lines += [f'### `{d["id"]}` — {d["kind"]}', '', f'Document: `doc-{d["id"]}`. Status: {d["status"]}.', '']
    if 'scenario' in d:
        lines += [f'Step root `{d["scenario"]["id"]}`: sequence.', '', '| Step ID | Relationship / direction | Label / grounding |', '| --- | --- | --- |']
        for s in d['scenario']['children']:
            lines.append(f'| `{s["id"]}` | `{s["relationshipId"]}` / {s["direction"]} | {s["label"]} |')
        lines += ['']
    else:
        lines += ['Members: '+', '.join('`'+n['elementId']+'`' for n in d['nodes'])+'.', '',
                  'Edges: '+', '.join('`'+e['relationshipId']+'`' for e in d['edges'])+'.', '']
lines += ['## Learning preservation handoff', '',
          'The database-aware router caveat (DP4), offline relocation safety conditions (DP7), and shared-lane blast radius (DP9) are durable design findings. This inventory preserves them within builder ownership. Coordinator: link this inventory from `docs/knowledge/decisions.md` / `index.md` after review; those files are outside this unit’s Owns set. No reusable general-purpose script was discovered: `build-dataset.py` is a unit-specific authoring source, not a work-scripts building block.', '']
(CONTENT/'inventory.md').write_text('\n'.join(lines))
