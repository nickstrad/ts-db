# c4-react: design and implementation plan

Status: proposed plan; no application or library has been built by this task. Date: 2026-10-12. Working
branch: `plan/c4-react`. Working name and package names are provisional.

## 1. Outcome and boundaries

Build a standalone React library for interactive C4 diagrams and a Vite reference application under `pages/`.
A user opens an architecture, selects an element to read its explanation, follows its detail link to another
diagram, and uses breadcrumbs or Back to return. A URL can identify a diagram, an element or a dynamic
interaction. The same library must render an unrelated project's JSON without modification.

The required stack is Vite, React, TypeScript, Tailwind CSS and shadcn/ui. JSON is the content contract; Zod
validates it at runtime. React components express the presentation and composition of all seven diagram types,
not a second, competing source of architecture data. An application can supply a JSON object to a component or
load a JSON file. No architecture content is embedded in the library's JSX.

The first milestone explains both the current ts-db architecture and the proposed Deno FFI architecture. These
are separate, clearly named datasets. The milestone is an explanation of the FFI proposal, not a decision to
implement it or endorse every claim in its research. The earlier Postgres-only exploration is out of scope;
the app data remains in separate SQLite files in both datasets.

Non-goals for v1: a visual architecture editor, source-code reverse engineering, collaborative editing,
authentication, a backend database, executing user-supplied React/MDX, complete UML support, live runtime
telemetry, replacing the existing Mermaid/terminal documentation, or a full STE compliance checker. Do not
publish a site or npm package as part of the build without separate authorization.

### All seven types are first-class

| Diagram          | Scope and representation                                                              | React entry point   | Required acceptance fixture                              |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| System Landscape | People and systems across an organisation; optional group boundaries                  | `SystemLandscape`   | Two systems with different owners and shared callers     |
| System Context   | One software system and its people/external systems                                   | `SystemContext`     | Full FFI context conversion                              |
| Container        | Applications and data stores within one system, plus external collaborators           | `ContainerDiagram`  | Current server/reader/files and proposed statement lanes |
| Component        | Components within one container and its collaborators                                 | `ComponentDiagram`  | Current API components; proposed lane components         |
| Code             | Selected types/functions/tables inside a component; members and typed relationships   | `CodeDiagram`       | Current document-reader functions, grounded in source    |
| Dynamic          | Ordered interactions over model elements; numbered communication-diagram presentation | `DynamicDiagram`    | Cancel an FFI statement, then escalate if necessary      |
| Deployment       | Nested infrastructure nodes, concrete instances, infrastructure services, environment | `DeploymentDiagram` | An explicitly illustrative two-node FFI deployment       |

The four static levels and three supporting types follow the
[C4 diagram taxonomy](https://c4model.com/diagrams). Dynamic and deployment diagrams are alternate views, not
levels five and six of a drill-down tree. Code views support C4's selected implementation detail, not an
entire language grammar. [C4 code scope](https://c4model.com/diagrams/code).

## 2. Location, packages and extraction

Everything needed to build and consume the new project lives beneath `pages/`; no import reaches into `core/`,
`platform/`, the root Deno configuration or an agent worktree. The only ts-db-specific material is
reference-app content and its provenance records. Use an npm workspace with its own lockfile and a pinned Node
engine, selected and verified at bootstrap. Root ts-db scripts remain unchanged.

```text
pages/
  package.json, package-lock.json, tsconfig.base.json
  README.md, CONTRIBUTING.md
  apps/viewer/
    package.json, vite.config.ts, index.html
    src/
      main.tsx
      containers/            application shell and dataset picker
      views/                 presentational shell
      hooks/                 loading and app composition
      routing/               React Router adapter
      ui/                    generated shadcn/ui primitives
      styles/                Tailwind entry and app theme
    public/catalog.json
    public/architectures/
      tsdb-current.json
      tsdb-ffi-proposal.json
      generic-example.json
  packages/model/
    src/schema/              Zod schemas and inferred public types
    src/validate/            reference, hierarchy and C4 validation
    src/navigation/          route codec, transitions, breadcrumb selectors
    src/scene/               pure projections and layout input/output contracts
    src/index.ts
    schema/c4-bundle-v1.schema.json
    test/
  packages/react/
    src/contracts/           shared presentation props and adapter ports
    src/views/               props-only diagram, node, edge, legend and docs views
    src/hooks/               controller, selection, layout and interaction hooks
    src/containers/          composition of hooks and views
    src/adapters/flow/       React Flow canvas and node/edge adapters
    src/styles/              scoped CSS, tokens, explicit CSS export
    src/index.ts
    test/
  packages/layout-elk/
    src/                     worker, worker client and ELK adapter
    test/
  fixtures/                  seven-type conformance fixtures, valid/invalid JSON
  content/                   source inventory, glossary, review notes, STE checklist
  tests/e2e/                 browser, accessibility and screenshot checks
  tests/consumer/            external package-consumption smoke fixture
  docs/                      authoring, embedding, schema and extension guides
```

`@c4-react/model` has no React, DOM, router, ELK or ts-db imports. `@c4-react/react` depends on the model;
React/ReactDOM are peer dependencies. `@c4-react/layout-elk` implements an injected `LayoutEngine` port and is
optional for consumers that supply positions. The viewer composes all three. Build the packages with
declaration files and ESM exports; use Vite library mode where appropriate and externalise peer dependencies.
Test the packed packages in a consumer outside this workspace, including emitted CSS and the worker URL.
[Vite library builds](https://vite.dev/guide/build#library-mode).

The library ships namespaced CSS/custom properties and no global reset. The reference app uses Tailwind and
shadcn/ui for its panels, buttons, sheet, tabs and breadcrumbs. Consumers do not have to scan library source
with Tailwind to see styled diagrams. Allow view slots and theme tokens without importing the app's `@/ui`
alias. Extraction should mean moving `pages/` to a new repository, not rewriting imports.

## 3. JSON contract

### 3.1 Model, diagrams and documents

Use a versioned, self-contained `ArchitectureBundle`. Model identities describe architecture; diagram
membership describes a view of it. Layout positions and React Flow IDs are derived state and never the
identity of a system or component. Two datasets can use the same logical IDs without sharing mutable state.

The following is the normative v1 schema design. The implementation item turns it into strict Zod objects,
infers TypeScript types, and generates distributable JSON Schema. Required fields are listed first; `?` means
optional. Unspecified optional arrays default to empty during normalisation, without mutating input.

| Record        | Fields                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle        | `schemaVersion: 1`, `id: Id`, `title: string`, `revision: string`, `defaultDiagramId: Id`, `model: {elements: Element[], relationships: Relationship[]}`, `diagrams: Diagram[]`, `documents: Document[]`, `sources: Source[]`; optional `terms: Term[]`                   |
| Element base  | `id`, `kind`, `name`, `description`, `status`; optional `technology`, `parentId`, `tags: string[]`, `docIds: Id[]`, `sourceIds: Id[]`, `plannedNotes: string[]`                                                                                                           |
| Relationship  | `id`, `sourceId`, `targetId`, `label`, `status`; optional `technology`, `kind` (default `dependency`; also `association`, `inheritance`, `implementation`, `composition`), `docIds`, `sourceIds`, `plannedNotes`, `modelRelationshipId` (deployment only)                 |
| Diagram base  | `id`, `kind`, `title`, `status`, `nodes: Member[]`, `edges: EdgeRef[]`, `legend: LegendSpec`; optional `scopeId`, `parent: Target`, `related: Link[]`, `groups: Group[]`, `docIds`, `sourceIds`, `layout: LayoutSpec`                                                     |
| Member        | `elementId`; optional `detail: Target`, `related: Link[]`, `position: {x: finite number, y: finite number}`, `size: {width: positive number, height: positive number}`                                                                                                    |
| EdgeRef       | `relationshipId`; optional `displayNumber: positive integer` (source-document numbering, never dynamic execution order)                                                                                                                                                   |
| Target / Link | Target is `{diagramId, elementId?}` within this bundle; Link adds a required `label`                                                                                                                                                                                      |
| Group         | `id`, `label`, `memberIds: Id[]`, `status`; optional `parentGroupId`. This is a visual boundary, not another model element                                                                                                                                                |
| LayoutSpec    | `mode` is `auto` or `manual`; `direction` is `TB` or `LR`; optional bounded positive `spacing`. No arbitrary ELK option bag in content                                                                                                                                    |
| Document      | `id`, `title`, `plain: string`, `ste: {text: string, issue: string, reviewStatus: ReviewStatus, reviewer?: string, reviewedAt?: ISO-date}`; optional `termIds: Id[]`, `sourceIds`. ReviewStatus is `draft` or `reviewed`                                                  |
| Source        | `id`, `title`, `url` (HTTPS or safe relative resource); optional `revision`, `path`, `notes`. No credentials, local absolute paths or executable URLs                                                                                                                     |
| LegendSpec    | `title`, `entries: LegendEntry[]`                                                                                                                                                                                                                                         |
| LegendEntry   | `id`, `label`, `description`, `swatch: {shape?: Shape, tone: Tone, stroke: Stroke, arrow?: Arrow}`. Shape: `person`, `box`, `database`, `boundary`, `line`. Tone: `default`, `external`, `accent`, `muted`. Stroke: `solid`, `dashed`, `dotted`. Arrow: `none`, `forward` |

`Id` is a nonempty case-sensitive string matching `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`. IDs are unique within
their record collection; cross-reference fields identify the collection they target. `status` is
`existing | planned | mixed`. `mixed` requires nonempty `plannedNotes` on elements/relationships. A diagram
can be mixed because of its members. Existing entities with planned capabilities retain their identity; the
caption explicitly distinguishes current responsibility from proposed additions.

`Term` is `{id, text, definition, category}`, where category is `technicalNoun` or `technicalVerb`. Document
`termIds` reference the bundle terms. Content authors maintain these records in their dataset glossary; no
ts-db vocabulary ships in the framework.

`Element` is a discriminated union:

- `person`, `softwareSystem`: the base fields. Systems can carry the `external` tag.
- `container`: requires `parentId` of a software system and `technology`; optional `containerType` is
  `application | datastore` (default application).
- `component`: requires `parentId` of a container and `technology`.
- `code`: requires `parentId` of a component or code element, `symbolKind` from
  `class | interface | function | type | enum | table | module`, and optional `members` with name, signature
  and visibility. All members are text, not executable code.
- `deploymentNode`: requires `environment` and `technology`; optional parent is a deployment node in the same
  environment. `infrastructureNode` requires a deployment-node parent and technology.
- `instance`: requires `instanceOf` referencing a system or container, `parentId` referencing a deployment
  node, and `environment`. Two replicas are two instance IDs, not the same node repeated twice.

`Diagram` is a discriminated union with the base fields and these constraints:

| `kind`       | Additional fields and semantic checks                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `landscape`  | No required scope; person/system members                                                                                                                                                                                               |
| `context`    | `scopeId` references a system present in `nodes`; person/system members                                                                                                                                                                |
| `container`  | `scopeId` references a system; its containers plus external persons/systems/containers as supporting members                                                                                                                           |
| `component`  | `scopeId` references a container; its components plus supporting external elements                                                                                                                                                     |
| `code`       | `scopeId` references a component; code members within it plus explicitly tagged external symbols                                                                                                                                       |
| `dynamic`    | `scenario: Step`; optional `scopeId`; participating systems/containers/components/persons. Edges are static relations used by the scenario                                                                                             |
| `deployment` | `environment: string`; nodes are deployment/infrastructure nodes and instances in that environment. Edges have instance/infrastructure endpoints; optional `modelRelationshipId` on those relationships ties them to the logical model |

`Step` is recursive: `{kind:"sequence", id, children: Step[]}`, `{kind:"parallel", id, branches: Step[]}` or
`{kind:"interaction", id, relationshipId, direction:"forward"|"reverse", label}`. Step IDs are unique within
their diagram. Sequence array order is meaningful; parallel branches have no invented total order. Repeated
calls reuse a model relationship with distinct interaction IDs. An explicit reverse interaction represents a
response, not a permanently bidirectional relationship. A communication-style renderer with numbered
interactions satisfies v1; a UML sequence renderer can be added later through the same scene port.
[C4 dynamic diagrams](https://c4model.com/diagrams/dynamic).

Deployment nesting and instances are necessary semantics, not just boxes labelled “server”. Selecting an
instance can link to the logical container's component diagram while retaining the instance breadcrumb.
Infrastructure edges do not have to invent corresponding logical dependencies.
[C4 deployment diagrams](https://c4model.com/diagrams/deployment).

### 3.2 Validation pipeline and evolution

1. Load a catalog-selected resource or a caller-provided object. Bound bytes before parsing when fetching;
   initial defaults: 5 MiB/bundle, 5,000 model elements, 10,000 relationships, 200 diagrams, nesting depth 32.
   These are proposed guardrails, not benchmarked limits. Allow host configuration with explicit ceilings.
2. Validate strict Zod shape: supported version, enum fields, finite numbers, bounded strings/arrays, URL
   schemes and required fields. Reject unknown core keys; reserve a JSON-only `extensions` namespace only if
   an actual extension requires it in a later schema revision.
3. Pure semantic validation builds indexes and checks missing/duplicate references, parent cycles, legal
   containment, diagram scopes, visible edge endpoints, group membership, instance environment, step
   references and navigation targets. `detail` targets must identify the corresponding next scope, not an
   unrelated diagram. Canonical diagram parents form a forest. Cyclic related links are legal.
4. Return structured diagnostics `{code, path, severity, message}`. Structural/reference errors reject the
   bundle; C4 clarity warnings (missing protocol, incomplete legend, overly large view) remain visible. The
   milestone gate treats its configured C4 warnings as failures. Never silently drop invalid nodes.
5. Build immutable indexes and scene inputs only after success. An invalid replacement leaves the last valid
   dataset visible with a clear error, never a partially mixed model.

Container/component scope checks allow external supporting elements but do not treat all arbitrary level
mixing as valid. The conversion review must label intentional external abstractions. Every rendered edge must
have both endpoints in the view; v1 does not automatically invent ancestor-to-ancestor edges.

Group members occur in at most one direct group per diagram. Parent groups contain child groups and form a
tree; they do not create duplicate model nodes. Manual layout requires positions for every member; auto mode
initially rejects partial fixed-position constraints instead of silently ignoring them.

Zod shape validation and semantic validation are separate. Exported JSON Schema helps editors validate shape,
but cannot replace cross-reference checks. Unknown major versions are rejected with an upgrade message; later
versions need explicit pure migrations and fixture tests, never a best-effort cast.
[Zod JSON Schema support](https://zod.dev/json-schema).

### 3.3 Worked JSON: FFI context with a valid detail destination

This is a complete illustrative bundle under the proposed schema, not generated product code. It maps the
seven elements and six numbered relationships from the FFI context source and adds a deliberately small
container detail view so the drill-down target resolves. The milestone conversion must include the complete
source container/component views, not stop at this example. Statuses make source descriptions of future
additions explicit. The STE text is a draft, not a compliance certification.

```json
{
  "schemaVersion": 1,
  "id": "tsdb-ffi-proposal",
  "title": "Document DB: proposed FFI execution",
  "revision": "ffi-context-bc1a1b5-example-1",
  "defaultDiagramId": "ffi-context",
  "sources": [
    {
      "id": "ffi-context-source",
      "title": "FFI System Context proposal",
      "url": "https://github.com/nickstrad/ts-db/blob/bc1a1b55e368a730fc1d8300e14cae566d246a31/docs/plans/ffi/c4-context-ffi.github.md",
      "revision": "bc1a1b55e368a730fc1d8300e14cae566d246a31"
    }
  ],
  "documents": [
    {
      "id": "context-explanation",
      "title": "What this proposal changes",
      "plain": "The existing API and registry remain. The proposal adds isolated statement lanes and placement metadata. WAL shipping is a later phase.",
      "ste": {
        "text": "The API receives a request. The registry identifies the tenant. The proposed lane executes the statement. This design is not installed.",
        "issue": "ASD-STE100 Issue 9",
        "reviewStatus": "draft"
      },
      "sourceIds": ["ffi-context-source"]
    },
    {
      "id": "platform-explanation",
      "title": "Statement execution",
      "plain": "The proposed Deno child processes load libsqlite3 through FFI. Long statements use nonblocking calls and an interrupt path. The existing DuckDB child continues to serve event-log analysis.",
      "ste": {
        "text": "The proposed lane loads the SQLite library. A separate thread executes a long statement. The deadline monitor can stop the statement.",
        "issue": "ASD-STE100 Issue 9",
        "reviewStatus": "draft"
      }
    }
  ],
  "model": {
    "elements": [
      {
        "id": "developer",
        "kind": "person",
        "name": "App developer",
        "description": "Defines schemas and named handlers.",
        "status": "existing"
      },
      {
        "id": "caller",
        "kind": "person",
        "name": "Application caller",
        "description": "Calls the authenticated document API.",
        "status": "existing"
      },
      {
        "id": "operator",
        "kind": "person",
        "name": "Platform operator",
        "description": "Manages tenants and backups.",
        "status": "existing"
      },
      {
        "id": "platform",
        "kind": "softwareSystem",
        "name": "Document DB platform",
        "description": "Serves document requests and event-log analysis.",
        "status": "mixed",
        "plannedNotes": ["Statement lanes use Deno FFI to libsqlite3."],
        "docIds": ["platform-explanation"]
      },
      {
        "id": "registry",
        "kind": "softwareSystem",
        "name": "Central registry and placement",
        "description": "Stores tenants, credentials and sessions.",
        "status": "mixed",
        "technology": "Postgres",
        "plannedNotes": ["Add tenant placement, leases and epochs."]
      },
      {
        "id": "objects",
        "kind": "softwareSystem",
        "name": "Object storage",
        "description": "Stores immutable snapshots and manifests.",
        "status": "mixed",
        "tags": ["external"],
        "plannedNotes": ["Store WAL frames in phase two."]
      },
      {
        "id": "analytics",
        "kind": "softwareSystem",
        "name": "Analytics consumer",
        "description": "Reads named results or derived event-log data.",
        "status": "existing",
        "tags": ["external"]
      },
      {
        "id": "api",
        "kind": "container",
        "parentId": "platform",
        "name": "API process",
        "description": "Authenticates and routes requests.",
        "technology": "Deno",
        "status": "mixed",
        "plannedNotes": ["Route to statement lanes and supervise them."]
      },
      {
        "id": "lanes",
        "kind": "container",
        "parentId": "platform",
        "name": "Statement lane",
        "description": "Executes SQLite statements with resource limits.",
        "technology": "Deno child process and FFI",
        "status": "planned"
      },
      {
        "id": "reader",
        "kind": "container",
        "parentId": "platform",
        "name": "Reader process",
        "description": "Ingests and queries the event log.",
        "technology": "Deno and DuckDB",
        "status": "existing"
      }
    ],
    "relationships": [
      {
        "id": "r1",
        "sourceId": "developer",
        "targetId": "platform",
        "label": "Provides schemas and named handlers",
        "technology": "TypeScript",
        "status": "existing"
      },
      {
        "id": "r2",
        "sourceId": "caller",
        "targetId": "platform",
        "label": "Sends authenticated document requests",
        "technology": "HTTP JSON; bearer; X-Trace-Id",
        "status": "mixed",
        "plannedNotes": ["The receiving node can forward to the owner."]
      },
      {
        "id": "r3",
        "sourceId": "operator",
        "targetId": "platform",
        "label": "Manages tenants and backups",
        "technology": "Admin HTTP / CLI",
        "status": "mixed",
        "plannedNotes": ["Add placement-move operations."]
      },
      {
        "id": "r4",
        "sourceId": "platform",
        "targetId": "registry",
        "label": "Reads tenant and authentication data",
        "technology": "Postgres protocol",
        "status": "mixed",
        "plannedNotes": ["Look up placement and renew leases."]
      },
      {
        "id": "r5",
        "sourceId": "platform",
        "targetId": "objects",
        "label": "Publishes snapshots and manifests",
        "technology": "S3 HTTPS or local files",
        "status": "mixed",
        "plannedNotes": ["Publish WAL frames in phase two."]
      },
      {
        "id": "r6",
        "sourceId": "platform",
        "targetId": "analytics",
        "label": "Provides query results and derived event-log rows",
        "status": "existing"
      },
      {
        "id": "lane-ipc",
        "sourceId": "api",
        "targetId": "lanes",
        "label": "Dispatches statements and cancellation",
        "technology": "JSON-lines IPC",
        "status": "planned"
      },
      {
        "id": "reader-ipc",
        "sourceId": "api",
        "targetId": "reader",
        "label": "Requests ingest and named analysis",
        "technology": "JSON-lines IPC",
        "status": "existing"
      }
    ]
  },
  "diagrams": [
    {
      "id": "ffi-context",
      "kind": "context",
      "title": "System Context: proposed FFI execution",
      "status": "mixed",
      "scopeId": "platform",
      "nodes": [
        { "elementId": "developer" },
        { "elementId": "caller" },
        { "elementId": "operator" },
        { "elementId": "platform", "detail": { "diagramId": "ffi-containers" } },
        { "elementId": "registry" },
        { "elementId": "objects" },
        { "elementId": "analytics" }
      ],
      "edges": [
        { "relationshipId": "r1", "displayNumber": 1 },
        { "relationshipId": "r2", "displayNumber": 2 },
        { "relationshipId": "r3", "displayNumber": 3 },
        { "relationshipId": "r4", "displayNumber": 4 },
        { "relationshipId": "r5", "displayNumber": 5 },
        { "relationshipId": "r6", "displayNumber": 6 }
      ],
      "groups": [
        {
          "id": "platform-boundary",
          "label": "Document DB platform organisation",
          "memberIds": ["platform", "registry"],
          "status": "existing"
        }
      ],
      "docIds": ["context-explanation"],
      "sourceIds": ["ffi-context-source"],
      "layout": { "mode": "auto", "direction": "TB" },
      "legend": {
        "title": "Diagram key",
        "entries": [
          {
            "id": "people",
            "label": "Person",
            "description": "A user or operator role.",
            "swatch": { "shape": "person", "tone": "default", "stroke": "solid" }
          },
          {
            "id": "systems",
            "label": "System",
            "description": "A software system.",
            "swatch": { "shape": "box", "tone": "default", "stroke": "solid" }
          },
          {
            "id": "external",
            "label": "External system",
            "description": "A system outside the platform boundary.",
            "swatch": { "shape": "box", "tone": "external", "stroke": "solid" }
          },
          {
            "id": "boundary",
            "label": "Organisation boundary",
            "description": "Groups systems managed together.",
            "swatch": { "shape": "boundary", "tone": "muted", "stroke": "solid" }
          },
          {
            "id": "mixed",
            "label": "Existing with planned changes",
            "description": "Solid element plus an explicit planned-change note.",
            "swatch": { "shape": "box", "tone": "accent", "stroke": "solid" }
          },
          {
            "id": "relationship",
            "label": "Directed relationship",
            "description": "The label states the operation and protocol; mixed links include a planned-change note.",
            "swatch": { "shape": "line", "tone": "default", "stroke": "solid", "arrow": "forward" }
          }
        ]
      }
    },
    {
      "id": "ffi-containers",
      "kind": "container",
      "title": "Container: abbreviated FFI detail example",
      "status": "mixed",
      "scopeId": "platform",
      "parent": { "diagramId": "ffi-context", "elementId": "platform" },
      "nodes": [{ "elementId": "api" }, { "elementId": "lanes" }, { "elementId": "reader" }],
      "edges": [{ "relationshipId": "lane-ipc" }, { "relationshipId": "reader-ipc" }],
      "docIds": ["platform-explanation"],
      "legend": {
        "title": "Status and notation",
        "entries": [
          {
            "id": "container",
            "label": "Container",
            "description": "A running application or data store.",
            "swatch": { "shape": "box", "tone": "default", "stroke": "solid" }
          },
          {
            "id": "mixed",
            "label": "Existing with planned changes",
            "description": "Current process with explicitly listed additions.",
            "swatch": { "shape": "box", "tone": "accent", "stroke": "solid" }
          },
          {
            "id": "planned",
            "label": "Planned container",
            "description": "Not implemented; dashed outline and planned label.",
            "swatch": { "shape": "box", "tone": "default", "stroke": "dashed" }
          },
          {
            "id": "link",
            "label": "Existing relationship",
            "description": "Directed, labelled communication.",
            "swatch": { "shape": "line", "tone": "default", "stroke": "solid", "arrow": "forward" }
          },
          {
            "id": "planned-link",
            "label": "Planned relationship",
            "description": "Proposed communication; dashed line and planned label.",
            "swatch": { "shape": "line", "tone": "default", "stroke": "dashed", "arrow": "forward" }
          }
        ]
      }
    }
  ]
}
```

This example intentionally treats the registry and Document DB as two systems inside an organisation boundary,
following the source context's abstraction. It does not claim that a runtime Postgres process is a second
logical system in every other view. The full conversion records such abstraction choices.

## 4. Mandatory view, hook and container architecture

Views receive complete presentation props and callbacks. They contain no fetching, context access,
state/effect hooks, route parsing, graph traversal, validation, layout, selection decisions or status
classification. Declarative iteration and displaying supplied values are presentation, not domain logic. Do
not hide event semantics in a node's `onClick`; pass the final callback from its hook/adapter.

Hooks bind pure functions to React, effects and injected ports. Containers only call their hook and compose
views. Dependency rules enforce that `views/` cannot import `hooks/`, `model/navigation`, app code or router
APIs. Third-party React Flow internals are isolated behind an adapter container; they do not justify stateful
first-party views.

| Area           | Props-only views                                                                                | Containers and hooks                                                                                   | Pure functions                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Diagram        | `DiagramView`, `NodeView`, `BoundaryView`, `RelationshipView`, `CodeSymbolView`, `InstanceView` | `DiagramContainer`, seven typed wrappers; `useDiagramRenderer`, `useMeasuredNodes`, `useDiagramLayout` | `projectDiagram`, `buildScene`, `toLayoutGraph`, `applyLayout`, `resolvePresentation`  |
| Canvas adapter | Views above supplied as node/edge slots                                                         | `FlowCanvasContainer`, `FlowNodeContainer`; `useFlowCanvas`, `useFlowNodeProps`                        | `toFlowNodes`, `toFlowEdges`, coordinate conversion                                    |
| Navigation     | `NavigationView`, `BreadcrumbView`, `DetailLinkView`                                            | `NavigationContainer`; `useViewerController`, `useNavigation`, `useRouteSync`                          | `parseRoute`, `formatRoute`, `navigationReducer`, `resolveTarget`, `selectBreadcrumbs` |
| Documentation  | `DocumentationView`, `SourceListView`, `StatusView`                                             | `DocumentationContainer`; `useDocumentation`                                                           | `selectDocuments`, `resolveTerms`, safe text/Markdown preparation                      |
| Legend         | `Legend`, `LegendEntryView`, `LegendSwatchView`                                                 | Optional `LegendContainer`; `useLegend`                                                                | `resolveLegend`, `validateLegendCoverage`                                              |
| Dynamic        | `StepListView`, `StepControlsView`                                                              | `DynamicControlsContainer`; `useDynamicSteps`                                                          | `flattenScenario`, `selectActiveInteractions`, step-transition reducer                 |
| Loading/errors | `LoadingView`, `DiagnosticView`, `EmptyView`                                                    | Viewer provider/app loader; `useArchitectureBundle`                                                    | normalisation, indexes, validation and diagnostics                                     |

Concrete composition (API sketch in the plan, not a code scaffold):

```tsx
function DiagramContainer() {
  const { viewProps, canvasProps } = useDiagramRenderer();
  return <DiagramView {...viewProps} canvas={<FlowCanvasContainer {...canvasProps} />} />;
}

function DiagramView({ title, statusText, canvas, descriptionSlot }: DiagramViewProps) {
  return (
    <section aria-label={title}>
      <h1>{title}</h1>
      <p>{statusText}</p>
      {canvas}
      {descriptionSlot}
    </section>
  );
}

function NavigationContainer() {
  const props = useNavigation();
  return <NavigationView {...props} />;
}

function NavigationView({ crumbs, onBack, onUp, canBack, canUp }: NavigationViewProps) {
  return (
    <nav aria-label="Diagram navigation">
      <button onClick={onBack} disabled={!canBack}>Back</button>
      <button onClick={onUp} disabled={!canUp}>Up one diagram</button>
      <BreadcrumbView items={crumbs} />
    </nav>
  );
}
```

One `ArchitectureProvider` calls `useViewerController` once. Both hooks above consume that same controller;
they must not independently create navigation state. `useDiagramRenderer` selects the validated view, requests
layout, derives status labels and supplies callbacks through the canvas adapter. `useNavigation` derives
breadcrumbs and Back/Up actions from the same route and model indexes. Reducers/selectors contain the
navigation rules; hooks handle subscriptions, focus and effect cleanup.

The public API supports `<ArchitectureViewer bundle={validatedBundle} ... />` and lower-level composition with
a provider, diagram, legend, docs and navigation containers. Each named diagram wrapper verifies its expected
`kind` and shares the projection pipeline. Users can replace presentational slots without reimplementing
validation or navigation. They can instantiate `Legend` independently with their own props.

## 5. Navigation and drill-down

Use route state as the authority for the selected dataset, diagram, element and step. Avoid a private
navigation stack that disagrees with browser Back. The model library accepts an injected route port; the
reference app uses React Router. Hash routing is the initial static-host default:

```text
/pages/#/architectures/tsdb-current/diagrams/context
/pages/#/architectures/tsdb-ffi-proposal/diagrams/ffi-context/elements/platform
/pages/#/architectures/tsdb-ffi-proposal/diagrams/ffi-cancel?step=interrupt
```

IDs are encoded and decoded through one pure route codec. Hosts can select browser-path routing with the same
logical paths if they provide SPA rewrites. Respect Vite's configured base URL. Reloading a deep link loads
the bundle before resolving IDs; a missing diagram shows Not Found, and an element not in that diagram shows a
diagnostic with a link to the diagram, never silently selecting an unrelated node.

Interaction rules:

- Clicking a node with a single `detail` target follows that target. Clicking a node without one selects it
  and opens its explanation. Every node also has an explicit Inspect action, so linked elements still expose
  their own documentation without forcing drill-down. All actions work by keyboard.
- A detail link normally follows context → container → component → code. Supporting views use labelled Related
  links. A system can have several container views; only one is the default detail, the rest are named
  choices. The framework never guesses a child by display name.
- Canonical breadcrumbs come from `parent`, so they work on a direct URL. `Up` navigates to that parent and
  selects its `elementId`. `Back` follows actual browser history within the viewer; if there is no viewer
  history entry, fall back to Up, then the dataset root. Do not send a new visitor off-site.
- Cross-links may produce a different Back path from the canonical breadcrumb trail. This is intentional.
  Nested deployment nodes expand/collapse inside a view; that gesture is not a level change.
- A click on the empty canvas clears selection; an explicit Up button leaves the diagram. Panning and zooming
  the viewport never change the architecture level. Escape closes a transient panel first.
- Preserve viewport/focus per dataset revision and diagram in session state. Do not put every pan event in
  browser history. Restore focus to the drilled-from element on Up and announce the new diagram title.
- A dynamic-step selection is deep-linkable. Playback, if later added, uses `replace`, not hundreds of history
  entries. Parallel interactions can be active together. Reduced-motion mode disables transitions.

Load/layout races use request generations and abort signals. Navigation to B while A is loading must not allow
A's late response or layout to overwrite B. Unmount cancels subscriptions and releases workers.
[React Router route composition](https://reactrouter.com/start/declarative/routing).

## 6. Rendering, layout and accessibility

Choose React Flow for viewport controls, interactive nodes/edges and keyboard foundations; custom views render
the C4-specific content. Disable editing, connection creation and persistence of drag positions in v1. The
internal scene is framework-independent so React Flow is an adapter, not the JSON schema.
[Custom nodes](https://reactflow.dev/learn/customization/custom-nodes),
[accessibility facilities](https://reactflow.dev/learn/advanced-use/accessibility).

Use ELK layered layout in a Web Worker for compound boundaries, directed edges and labels. React Flow is not
itself an automatic layout engine. Sort inputs by stable IDs, pin engine/options, pass measured node sizes,
and cache by bundle revision, diagram ID, sizes and layout settings. Determinism is a tested property for
pinned versions, not a promise across all ELK releases.
[React Flow layout choices](https://reactflow.dev/learn/layouting/layouting),
[ELK JavaScript implementation](https://github.com/kieler/elkjs).

Measurement runs in a hook using a bounded two-pass strategy: provisional sizes, then one stable relayout
after fonts and node dimensions settle. Prevent resize/layout feedback loops. The worker adapter owns
timeouts/restarts; discarding stale results alone does not stop worker CPU consumption. Validate finite
geometry and group containment before publication. On failure, preserve the last valid scene or show an error
with an accessible element/relationship list; do not fabricate an apparently correct arrangement.

C4 boundaries are compound layout groups, separate from diagram navigation. React Flow parent-relative
coordinates must be translated by pure adapter functions and tested for nested groups and cross-boundary
edges. Dynamic diagrams use the same spatial graph with numbered interaction overlays and an ordered text
panel. Code symbols show selected member compartments. Deployment nodes contain instance cards and
infrastructure nodes. [React Flow nesting](https://reactflow.dev/learn/layouting/sub-flows).

Initial supported-view target: 200 visible nodes and 400 edges, with larger models split into views. Proposed
performance gate on a recorded reference machine: layout completes within 2 seconds for that fixture and
selection does not cause a relayout. Measure production builds; tune the gate after the layout spike instead
of making untested claims. Show progress and retain cancellation when loading large data.

Every view has a title, explicit element types, relationship labels and visible status text. Planned
elements/edges are dashed and labelled “planned”; mixed elements show planned-change notes. Colour alone never
communicates status. Supply a tabular/text alternative that exposes the same links and descriptions, visible
focus, generous hit targets and diagram-title announcements. On narrow screens, docs use a shadcn Sheet rather
than crushing the canvas. Verify desktop and mobile layouts, 200% zoom, keyboard-only use, screen-reader
names, high contrast and reduced motion. Automated accessibility checks supplement manual keyboard and
screenshot review.

## 7. Legend and documentation primitives

### Legend

`Legend` takes `{title, entries, compact?}` and renders provided swatches, labels and explanations. It does
not inspect a global store or infer a project's meaning from colours. `useLegend` can resolve a diagram's JSON
into those props. Hosts can render it beside the canvas or in a panel; it remains available without selecting
a node.

A default preset covers C4 shapes, relationship arrows and lifecycle status. Each diagram explicitly
instantiates its key and can add project-specific entries such as “read-only connection” or “FFI call”. Use
the same swatch renderer and theme tokens as nodes/edges so a legend cannot drift from the canvas. V1 limits
swatches to the enumerated safe shapes/tokens; arbitrary SVG/HTML strings are not accepted. Semantic
validation checks that every used non-default notation is explained. The milestone must resolve coverage
warnings. C4 is notation-independent but explicitly recommends a key for each diagram; its open choice of
notation is precisely why this is a primitive.
[C4 notation and legends](https://c4model.com/diagrams/notation).

### STE100 and plain explanations

Each diagram and each element can reference multiple documents. Display diagram documentation initially;
inspection selects element-specific documentation while retaining the diagram's title and context. Tabs select
Plain explanation or STE100 text. An element without documentation displays an honest empty state and its
short description, not generated prose. The generic library permits missing docs; the milestone requires both
forms for every converted diagram and element, including planned ones.

STE is controlled vocabulary plus writing rules, not just short sentences. Store the issue and human review
status with each text; for `reviewed`, require reviewer and date. Maintain a project glossary of technical
nouns/verbs under `content/`, including C4, lane, FFI, tenant, WAL and interrupt. Schema validation checks
metadata and references; it cannot certify language compliance. Add authoring checks for sentence length and
terminology as advisory diagnostics, followed by human review against the chosen standard. Never label a draft
as certified. Use the current official Issue 9 material as the authoring reference, and preserve its licensing
instead of bundling the whole dictionary into the library.
[ASD explanation of STE](https://www.asd-ste100.org/about_STE.html),
[official standard downloads](https://www.asd-ste100.org/STE_downloads.html).

Document bodies are Markdown strings stored inside JSON, with a small supported subset: paragraphs, headings,
lists, inline code and safe links. No MDX, raw HTML, embedded scripts or remote images in v1. Choose a
Markdown renderer with HTML disabled and explicit link-scheme filtering; loading architecture JSON must never
execute content. Inline prose in the JSON keeps the runtime bundle self-contained; authors may use a later
build-time content packer without changing the runtime contract.

## 8. Library decisions

| Choice                                      | Decision and reason                                                                                 | Limits / alternative                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| React + TypeScript                          | Required; typed props and composable views                                                          | Types alone cannot validate fetched JSON                                                                                                                                                   |
| Vite                                        | Required; reference app, worker bundling and package builds                                         | Verify worker/CSS output through a real external consumer                                                                                                                                  |
| Tailwind CSS + shadcn/ui                    | Required; app styling and accessible shell primitives                                               | Keep app aliases and global CSS out of published library contracts                                                                                                                         |
| Zod                                         | Adopt in the model package for runtime shape validation and inferred types                          | Cross-reference/C4 rules stay in pure semantic validators; generated JSON Schema is shape-only                                                                                             |
| React Flow (`@xyflow/react`)                | Adopt behind an adapter; avoids implementing pan/zoom, handles and basic accessibility from scratch | Its editor features are disabled; no React Flow types in public JSON                                                                                                                       |
| ELK (`elkjs`)                               | Adopt behind `LayoutEngine`; compound directed layouts are important for C4 boundaries              | Larger worker payload and geometry complexity; spike nested edges before commitment to the adapter                                                                                         |
| React Router                                | Adopt only in the reference app; routes and browser history                                         | Library receives a route port and supports embedding without a router                                                                                                                      |
| Effect                                      | Do not add to the initial browser library                                                           | Fetch + AbortController, a worker port and pure reducers are sufficient. Reconsider for several coordinated remote resources or complex retries; never add it merely because ts-db uses it |
| fast-check                                  | Adopt for graph, route, hierarchy and state-transition properties                                   | Pair with concrete regressions and readable shrunk counterexamples; no random screenshot assertions                                                                                        |
| Vitest + Testing Library                    | Adopt for pure logic, hooks and props-only view contracts                                           | Mock the ports, not the entire navigation algorithm                                                                                                                                        |
| Playwright + axe-core                       | Adopt for deep links, real worker integration, keyboard flows and accessibility checks              | Screenshot review remains human; axe is not complete accessibility proof                                                                                                                   |
| `react-markdown` or equivalent              | Select a small renderer at bootstrap with HTML disabled                                             | No MDX; explicit safe-link policy; no content-driven component imports                                                                                                                     |
| Redux/Zustand, D3, Dagre, animation library | Not initially needed                                                                                | One provider/reducer suffices; D3 duplicates scene work; ELK better matches nesting needs; CSS handles optional transitions                                                                |

Resolve and lock compatible stable versions in C4R-00, rather than copying ts-db's dependency pins. Record
licenses, package sizes and the reason for each direct dependency. Required-stack integration references:
[shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite),
[Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite). Property-testing method:
[fast-check introduction](https://fast-check.dev/docs/introduction/).

## 9. Milestone content and source fidelity

Pin content to these inspected source snapshots; branches are not interchangeable with landed behavior:

| Dataset/source | Revision                                                                  | Conversion scope                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current ts-db  | `e808983cefcabe9ba1fe28ce7ea54fb6725a7e0c` (`main`)                       | Four diagram pairs: context, platform containers, observability containers, server components; root usage docs and relevant implementation files |
| FFI diagrams   | `bc1a1b55e368a730fc1d8300e14cae566d246a31` (`docs/ffi-c4`)                | Three pairs under `docs/plans/ffi/`: context, containers, lane components; README's four flows                                                   |
| FFI rationale  | `d97bcf8f145e94279b882665c70412eabdaba775` (`research/fable-lang-switch`) | `docs/architecture/lang-switch-fable.md`; explanation of nonblocking FFI, cancellation, process lanes and the limits of its measurements         |

Do not merge these branches merely to read their content. Use commit-pinned source links and a conversion
inventory with source node/edge number → JSON ID → documentation IDs. Compare Mermaid and terminal versions
and their prose; discrepancies become explicit review notes. For current architecture, verify against the
pinned implementation, particularly document reads bypassing the DuckDB child. For proposed architecture, keep
“planned” on lanes, placement, FFI and WAL shipping; retain phase-two distinctions.

The FFI source combines abstraction levels in places. A shared library is not an independently running C4
container: represent libsqlite3 as an implementation dependency/component detail of a lane, or an explicitly
labelled supporting element, with a conversion note. Its existing logger implementation does not imply an
existing deployed lane logger. Record planned instantiation separately from code reuse. Preserve all
relationships through the mapping inventory, even if they move to a more appropriate detail view.

Source timing claims are historical observations, not guarantees. Put measured numbers and host/version
context in documentation with provenance, not permanent node labels. The source's synchronous “bounded
statement” classification must be presented as a proposal; a point lookup does not by itself prove a hard
wall-clock limit under I/O stalls. Neither a diagram nor an STE rewrite should strengthen those claims.

Beyond the seven existing source diagrams, create the missing type examples deliberately:

- A landscape view of the modelled people/systems, without inventing new running systems.
- A code view of current `platform/document_reader.ts` functions under its owning component, source-linked.
- Dynamic views for the FFI point read, deadline/interrupt, forwarded mutation, and kill/restart flows.
  Branching failure paths are separate named scenarios or explicitly parallel/sequence steps, not fake
  measurements or a claim that both outcomes occur.
- One illustrative FFI deployment with two data nodes and lane instances, marked proposed/illustrative; it is
  not a claim about the actual droplet topology.

Add an unrelated generic example to prove portability. The milestone is complete when all seven types render,
current and proposed datasets have complete mapping inventories and both documentation modes,
context-to-detail navigation works through available levels, and links to alternate views are discoverable. Do
not fabricate code-level FFI classes to manufacture a fourth drill-down level for unbuilt code.

## 10. Implementation sequence and ownership

This table is a future build plan, not authorisation to start implementation in this session. Use the repo's
item worktree/branch protocol when it is approved, with identifiers such as `item/c4r-01-schema`. One logical
item per commit; `<area>: <imperative summary>`. Every item receives an independent top-tier review against
its acceptance criteria before landing. NITS/FAIL return to the owning builder. Landings also get the required
docs/C4 follow-up; this plan does not waive that protocol.

Model correspondence: top tier **Opus 5.5 / Astra (`gpt-6-astra`)**; middle tier **Sonnet / Sol
(`gpt-6.1-sol`)**; experiment tier **Haiku ≥5.5 / Luna (`gpt-6-luna`, high)**. Builders and reviewers must be
different agents. Top-tier review is mandatory even for mechanical items. No Haiku/Luna production item is
assigned below; an optional scratch investigation can use that tier under the experiment board protocol and
its explicit human landing approval requirement.

All paths below are under `pages/`. An item's Owns set includes tests adjacent to its owned modules unless
separately assigned. Read dependencies are named; do not edit their files to make integration easier. Public
contracts change through the original owner and re-review. Each item adds meaningful tests of its behavior,
not tests that merely mirror code.

| Item / tier                                          | Dependencies and Reads                 | Owns                                                                                                                                                   | Deliverable and acceptance gate                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C4R-00 — workspace, Sol/Sonnet                       | This plan; root conventions            | Workspace/package manifests, lockfile, TS/Vite/test/lint configs, app HTML/main bootstrap, app UI primitives/styles, library style/build configuration | Isolated npm workspace; required stack; scripts for typecheck/lint/test/build/content/e2e; no root dependency/config edits; empty consumer build works                                                 |
| C4R-01 — model contract, Astra/Opus                  | 00                                     | `packages/model/src/schema/`, `validate/`, `index.ts`, generated schema; schema/validation fixtures                                                    | All seven discriminated variants; worked JSON validates; duplicate/dangling refs, cycles and invalid deployment instances rejected; JSON Schema export documented                                      |
| C4R-02 — scene and layout port, Astra/Opus           | 01                                     | `packages/model/src/scene/`, `packages/react/src/contracts/`, `packages/layout-elk/src/` and its tests                                                 | Nested boundaries, labels and cross-boundary edges; seven-type scene projection; worker timeout/stale-result handling; manual mode; finite, contained geometry and pinned-layout reproducibility tests |
| C4R-03 — navigation core, Astra/Opus                 | 01                                     | `packages/model/src/navigation/`                                                                                                                       | Route round trips, detail/related distinction, canonical Up, breadcrumb forest, direct element/step links; property tests for valid/invalid transitions                                                |
| C4R-04 — views, legend and documentation, Sol/Sonnet | 01 and 02 frozen scene props           | `packages/react/src/views/`, library CSS sources, view tests                                                                                           | Props-only views for every scene shape, legend swatches and two doc modes; no stateful imports; keyboard semantics and safe Markdown links; planned status visible without colour                      |
| C4R-05 — controllers and hooks, Astra/Opus           | 01–03; reads 04 prop contracts         | `packages/react/src/hooks/`, hook tests                                                                                                                | One shared controller; abortable loading, measurement lifecycle, layout races, focus/selection and dynamic-step state; unmount/StrictMode cleanup tested                                               |
| C4R-06 — renderer integration, Astra/Opus            | 04–05; reads layout port               | `packages/react/src/containers/`, `adapters/flow/`, `index.ts`, integration fixtures/tests                                                             | Seven named components plus generic viewer; React Flow adapter; inspect vs drill; nested groups; no domain content in JSX; legends/docs controlled by shared state                                     |
| C4R-07 — reference app, Sol/Sonnet                   | 06                                     | `apps/viewer/src/{containers,views,hooks,routing}/`, `public/catalog.json`, generic-example JSON                                                       | Dataset loading, hash routes/base paths, diagnostics, responsive shell, back/forward/reload and static hosting behavior; displays unrelated model unchanged                                            |
| C4R-08 — current dataset, Astra/Opus                 | 01; reads pinned current docs/code     | `apps/viewer/public/architectures/tsdb-current.json`, `content/current/`                                                                               | Four source pairs converted, landscape/code views added; node/edge inventory complete; explanations faithful to code, STE review recorded                                                              |
| C4R-09 — FFI dataset, Astra/Opus                     | 01; reads pinned FFI diagrams/research | `apps/viewer/public/architectures/tsdb-ffi-proposal.json`, `content/ffi/`                                                                              | Three source pairs, four dynamic scenarios and illustrative deployment; planned/mixed statuses preserved; source discrepancies and timings qualified; STE review recorded                              |
| C4R-10 — end-to-end and extraction gate, Astra/Opus  | 07–09                                  | `tests/e2e/`, `tests/consumer/`, remaining conformance fixtures and test reports                                                                       | Seven-type browser matrix, fast-check regressions, safe-content failures, keyboard/axe checks, desktop/mobile screenshots inspected; packed-library consumer succeeds without ts-db imports            |
| C4R-11 — guides and release readiness, Sol/Sonnet    | 10                                     | `README.md`, `CONTRIBUTING.md`, `docs/`, content review index                                                                                          | Schema/authoring/embedding/navigation/STE guides; source/version inventory; verified extraction recipe; report limitations and dependency licenses; no publication                                     |

C4R-00 establishes shared configs once; later items add modules/tests discovered by configured globs. A
required dependency/config amendment goes through its owner, not concurrent lockfile edits. C4R-01's public
schema and C4R-02's scene/port contracts are SYNC gates before their consumers begin.

Safe batches: 00 → 01 → (02 + 03 + 08 + 09) → (04 + 05) → 06 → 07 → 10 → 11. Within each batch, Owns sets are
disjoint. Content authors may validate against the frozen schema while rendering is built; their final
acceptance also waits for the visual gate in 10. C4R-04 and 05 share frozen prop contracts from 02, not a file
edited by either concurrently. The coordinator reports landed/in-review/next items and stops at the approved
milestone; do not treat this table as permission to run all items indefinitely.

## 11. Acceptance and risks

### Verification matrix

| Area               | Required evidence                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model              | Positive/negative fixtures for all seven kinds; exact diagnostic paths; maximum-depth/size rejection; immutable validation                                                                                  |
| Properties         | Route format/parse identity; breadcrumb termination; Up restores parent selection; related cycles do not break navigation; geometry remains finite and nested; node/edge membership conserved by projection |
| Concurrency        | Out-of-order fetch and layout completion cannot replace newer state; timeout releases worker; remount does not leak subscriptions                                                                           |
| UI                 | All seven components rendered in browser; real text wrapping, boundary nesting and edge labels inspected at desktop and narrow width; no clipped controls                                                   |
| Navigation         | Click/keyboard drill; Inspect for a linked node; browser Back/Forward; Up from deep link; invalid route; alternate diagram; deployment instance and dynamic step links                                      |
| Documents/legend   | Diagram and element attachments; Plain/STE tabs; review status; no HTML execution or unsafe links; displayed key matches notation                                                                           |
| Portability        | Generic data works; packages build and install in isolated consumer; no outside imports; base URL, CSS, fonts and worker resolve after packing                                                              |
| Milestone fidelity | Complete source-ID mapping, explicit corrections, current/proposed separation, no unsupported deployment claims or upgraded timing guarantees                                                               |

Record `fast-check` seeds and replay paths on failure. Do not assert a unique visual layout for every random
graph: test invariants on generated graphs and use a small curated screenshot suite for presentation. The
final acceptance report distinguishes tests run, screenshots inspected and STE review completed from checks
still pending. The build must have a green `pages/` verification command. Report any pre-existing root ts-db
CI failure separately rather than modifying platform code as part of this project.

### Decisions to validate, with defaults

| Risk / open question                        | Proposed default and decision point                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compound layout quality                     | ELK worker and React Flow adapter; C4R-02 must prove nested external edges and long labels before UI integration                                                           |
| Literal “dumb views”                        | No stateful first-party view code; adapter containers own third-party mechanics. Enforce import boundaries in C4R-00/04                                                    |
| Click-to-drill hides documentation          | Node click follows detail; explicit Inspect and keyboard action always available. Verify with milestone navigation tasks                                                   |
| Formal STE review ownership                 | Draft content can be developed, but milestone cannot claim reviewed STE until an identified reviewer checks it against Issue 9; author plus independent review is required |
| Source diagrams mix abstractions and status | Keep a conversion ledger; correct representation transparently and preserve source links instead of copying misleading labels                                              |
| Schema becomes a drawing-tool format        | Keep model identities and view projections distinct; reject arbitrary style/code payloads; defer visual editing                                                            |
| Library styling leaks into host             | Scoped stylesheet, no reset and peer React; isolated-consumer gate includes a host with unrelated styles                                                                   |
| Scale beyond initial view target            | Encourage multiple focused diagrams; resource limits and worker cancellation; benchmark before claiming thousands of visible elements                                      |
| Future repository/package identity          | Keep package names provisional and imports internal to workspace; confirm namespace/license before publishing, not before planning/building                                |
| New content revisions break links           | Stable IDs plus dataset revisions and source provenance; schema migrations explicit; do not recycle IDs for different concepts                                             |

## 12. Planning-task verification

Only this plan document is in scope for this commit. No `pages/` files, runtime dependencies, model code, new
diagrams or tests are scaffolded. The worked JSON is checked for syntactic validity and internal references as
a planning aid; the proposed Zod validator does not exist yet. The example parses and its 10 elements, 8
relationships and 2 diagrams have resolvable model, document, source and drill-down references; the context
retains 7 nodes and 6 numbered edges. `deno fmt --check docs/plans/c4-react.md` and `git diff --check` pass.
No product test suite was run for this plan-only change. Application behavior, layout quality and screenshots
remain future build acceptance work, not results of this planning task.

The shared task-start event could not be written because the Git inbox is read-only in the sandbox; event
logging is skipped under the user's existing instruction. This does not block the authorised plan commit and
push to `plan/c4-react`.
