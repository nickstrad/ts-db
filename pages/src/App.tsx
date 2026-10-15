import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
  ArchitectureProvider,
  ArchitectureViewer,
  browserRoutePort,
  createMemoryRoutePort,
  DiagramDocumentation,
  DiagramNavigation,
  DiagramView,
  layoutPort,
  loadArchitectures,
} from "./sdk.ts";
import type { Diagnostic, LoadedArchitecture, ValidatedArchitecture } from "./sdk.ts";
import {
  compareHash,
  counterpart,
  CURRENT_ID,
  levelNames,
  parseSiteRoute,
  PROPOSED_ID,
  sharedLevels,
  singleHash,
} from "./routes.ts";
import type { SiteRoute } from "./routes.ts";

const REPO = "https://github.com/nickstrad/ts-db";
const CATALOG_URL = `${import.meta.env.BASE_URL}catalog.json`;

// The site reads the URL hash for its own mode. The SDK hash port reports its pushState writes and
// browser navigation; `replaceSiteHash` reports the side-by-side view's own rewrites.
const siteListeners = new Set<() => void>();
function subscribeHash(listener: () => void): () => void {
  const unsubscribe = browserRoutePort().subscribe(listener);
  siteListeners.add(listener);
  return () => {
    unsubscribe();
    siteListeners.delete(listener);
  };
}
function replaceSiteHash(hash: string) {
  if (location.hash === hash) return;
  history.replaceState(history.state, "", hash);
  siteListeners.forEach((listener) => listener());
}
function useHash(): string {
  return useSyncExternalStore(subscribeHash, () => location.hash, () => "");
}

type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | {
    readonly state: "ready";
    readonly current: ValidatedArchitecture;
    readonly proposed: ValidatedArchitecture;
  };

function useArchitectures(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    loadArchitectures(CATALOG_URL, abort.signal).then(
      (entries) => {
        if (!abort.signal.aborted) setLoaded(settle(entries));
      },
      (error: unknown) => {
        if (!abort.signal.aborted) {
          setLoaded({
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => abort.abort();
  }, []);
  return loaded;
}

function settle(entries: readonly LoadedArchitecture[]): Loaded {
  const problems: string[] = [];
  const pick = (id: string) => {
    const loaded = entries.find((entry) => entry.entry.id === id);
    if (!loaded) problems.push(`The catalog has no "${id}" entry.`);
    else if (!loaded.result.ok) {
      problems.push(`${id}: ${describe(loaded.result.diagnostics)}`);
    }
    return loaded?.result.ok ? loaded.result.value : undefined;
  };
  const current = pick(CURRENT_ID);
  const proposed = pick(PROPOSED_ID);
  return current && proposed
    ? { state: "ready", current, proposed }
    : { state: "failed", message: problems.join(" ") };
}

function describe(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} at ${d.path}: ${d.message}`)
    .join("; ");
}

export function App() {
  const hash = useHash();
  const loaded = useArchitectures();
  const route = parseSiteRoute(hash);
  return (
    <>
      <a className="skip-link" href="#site-main" onClick={skipToMain}>
        Skip to the diagrams
      </a>
      <header className="site-header">
        <div className="site-heading">
          <p className="site-eyebrow">C4 model · current and proposed</p>
          <p className="site-title">ts-db architecture</p>
          <p className="site-purpose">
            Use these diagrams when you design a feature: compare what runs on <code>main</code>{" "}
            today with a proposed design, level by level and side by side, then drill from the system context
            down to components. Every element traces to a commit-pinned source.
          </p>
          <p className="site-links">
            <a href={`${REPO}/tree/main/docs/architecture`}>
              Markdown diagrams in docs/architecture/
            </a>
            <span aria-hidden="true">·</span>
            <a href={`${REPO}/tree/main/pages/content`}>
              Conversion inventories
            </a>
          </p>
        </div>
        {loaded.state === "ready" && <ModeNavigation route={route} {...loaded} />}
      </header>
      <main id="site-main" tabIndex={-1} className="site-main">
        {loaded.state === "loading" && <p role="status">Loading the architecture catalog…</p>}
        {loaded.state === "failed" && (
          <section role="alert" className="site-panel">
            <h2>The diagrams could not be loaded</h2>
            <p>{loaded.message}</p>
          </section>
        )}
        {loaded.state === "ready" && <Content route={route} {...loaded} />}
      </main>
    </>
  );
}

function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  // Hash links drive routing here, so move focus without changing the URL.
  event.preventDefault();
  document.getElementById("site-main")?.focus();
}

interface ReadyProps {
  readonly route: SiteRoute;
  readonly current: ValidatedArchitecture;
  readonly proposed: ValidatedArchitecture;
}

function routedKind(props: ReadyProps) {
  const { route, current, proposed } = props;
  if (route.kind === "compare") {
    return current.index.diagrams[route.currentDiagramId]?.kind;
  }
  if (route.kind !== "single") return undefined;
  const bundle = route.architectureId === CURRENT_ID
    ? current
    : route.architectureId === PROPOSED_ID
    ? proposed
    : undefined;
  return bundle?.index.diagrams[route.diagramId]?.kind;
}

function ModeNavigation(props: ReadyProps) {
  const { route, current, proposed } = props;
  const kind = routedKind(props);
  const pair = sharedLevels(current, proposed).find((level) => level.kind === kind) ??
    sharedLevels(current, proposed)[0];
  const active = route.kind === "compare"
    ? "compare"
    : route.kind === "single"
    ? route.architectureId
    : route.kind === "home"
    ? CURRENT_ID
    : undefined;
  const tabs = [
    {
      id: CURRENT_ID,
      label: "Current",
      href: singleHash(CURRENT_ID, counterpart(current, kind)),
    },
    {
      id: PROPOSED_ID,
      label: "Proposed",
      href: singleHash(PROPOSED_ID, counterpart(proposed, kind)),
    },
    {
      id: "compare",
      label: "Side by side",
      href: compareHash(
        pair?.currentId ?? current.bundle.defaultDiagramId,
        pair?.proposedId ?? proposed.bundle.defaultDiagramId,
      ),
    },
  ];
  return (
    <nav aria-label="View mode" className="mode-nav">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

function Content(props: ReadyProps) {
  const { route, current, proposed } = props;
  if (route.kind === "not-found") {
    return <NotFound message={route.message} {...props} />;
  }
  if (route.kind === "compare") {
    const missing = [
      current.index.diagrams[route.currentDiagramId]
        ? undefined
        : `current diagram "${route.currentDiagramId}"`,
      proposed.index.diagrams[route.proposedDiagramId]
        ? undefined
        : `proposed diagram "${route.proposedDiagramId}"`,
    ].filter(Boolean);
    if (missing.length) {
      return <NotFound message={`Unknown ${missing.join(" and ")}.`} {...props} />;
    }
    return <Compare current={current} proposed={proposed} route={route} />;
  }
  const architectureId = route.kind === "single" ? route.architectureId : CURRENT_ID;
  const bundle = architectureId === CURRENT_ID
    ? current
    : architectureId === PROPOSED_ID
    ? proposed
    : undefined;
  if (!bundle) {
    return (
      <NotFound
        message={`Unknown architecture "${architectureId}".`}
        {...props}
      />
    );
  }
  return (
    <section aria-label={bundle.bundle.title}>
      <DatasetNote architecture={bundle} />
      <ArchitectureViewer
        key={bundle.bundle.id}
        validatedBundle={bundle}
        routePort={browserRoutePort()}
        layoutPort={layoutPort}
      />
    </section>
  );
}

function DatasetNote(
  { architecture }: { architecture: ValidatedArchitecture },
) {
  const proposedSet = architecture.bundle.id === PROPOSED_ID;
  return (
    <p
      className={proposedSet ? "dataset-note dataset-note-proposed" : "dataset-note"}
    >
      <strong>{architecture.bundle.title}.</strong> {proposedSet
        ? "Dashed boxes and lines are planned or existing with planned changes. This set proposes only statement lanes and tenant placement; the FFI execution layer (FFI-01 to FFI-08) has landed and is part of the current set."
        : "Every box and line exists on main; the diagrams mirror the audited docs/architecture/ set."}
    </p>
  );
}

function NotFound(
  { message, current, proposed }: ReadyProps & { readonly message: string },
) {
  return (
    <section role="alert" className="site-panel">
      <h2>Not Found</h2>
      <p>{message}</p>
      <ul>
        <li>
          <a href={singleHash(CURRENT_ID, current.bundle.defaultDiagramId)}>
            Open the current system context
          </a>
        </li>
        <li>
          <a href={singleHash(PROPOSED_ID, proposed.bundle.defaultDiagramId)}>
            Open the proposed system context
          </a>
        </li>
      </ul>
    </section>
  );
}

function Compare(
  { current, proposed, route }: {
    readonly current: ValidatedArchitecture;
    readonly proposed: ValidatedArchitecture;
    readonly route: Extract<SiteRoute, { kind: "compare" }>;
  },
) {
  const levels = sharedLevels(current, proposed);
  // Each pane navigates in memory; the URL records both panes' diagrams so a reload or a shared link
  // reopens the same pair. Element selection and pane history stay in memory.
  const [left, setLeft] = useState(route.currentDiagramId);
  const [right, setRight] = useState(route.proposedDiagramId);
  useEffect(() => {
    setLeft(route.currentDiagramId);
    setRight(route.proposedDiagramId);
  }, [route.currentDiagramId, route.proposedDiagramId]);
  useEffect(() => replaceSiteHash(compareHash(left, right)), [left, right]);
  return (
    <section aria-labelledby="compare-heading">
      <div className="compare-toolbar">
        <h2 id="compare-heading">Side by side</h2>
        <nav aria-label="C4 level" className="level-nav">
          {levels.map((level) => (
            <a
              key={level.kind}
              href={compareHash(level.currentId, level.proposedId)}
              aria-current={level.currentId === route.currentDiagramId &&
                  level.proposedId === route.proposedDiagramId
                ? "page"
                : undefined}
            >
              {levelNames[level.kind]}
            </a>
          ))}
        </nav>
      </div>
      <div className="compare-grid">
        <ComparePane
          label="Current"
          architecture={current}
          diagramId={route.currentDiagramId}
          onDiagram={setLeft}
        />
        <ComparePane
          label="Proposed"
          architecture={proposed}
          diagramId={route.proposedDiagramId}
          onDiagram={setRight}
        />
      </div>
    </section>
  );
}

function ComparePane(
  { label, architecture, diagramId, onDiagram }: {
    readonly label: string;
    readonly architecture: ValidatedArchitecture;
    readonly diagramId: string;
    readonly onDiagram: (diagramId: string) => void;
  },
) {
  const architectureId = architecture.bundle.id;
  // One in-memory port per pane for the life of the view; URL changes are applied to it below.
  const port = useMemo(
    () => createMemoryRoutePort({ architectureId, diagramId }),
    [architectureId],
  );
  useEffect(() => {
    if (port.route().diagramId !== diagramId) {
      port.replace({ architectureId, diagramId });
    }
  }, [port, architectureId, diagramId]);
  useEffect(() => port.subscribe(() => onDiagram(port.route().diagramId)), [
    port,
    onDiagram,
  ]);
  return (
    <Pane label={label} architecture={architecture}>
      <ArchitectureProvider
        validatedBundle={architecture}
        routePort={port}
        layoutPort={layoutPort}
      >
        <DiagramNavigation />
        <DiagramView />
        <DiagramDocumentation />
      </ArchitectureProvider>
    </Pane>
  );
}

function Pane(
  { label, architecture, children }: {
    readonly label: string;
    readonly architecture: ValidatedArchitecture;
    readonly children: ReactNode;
  },
) {
  const id = `pane-${architecture.bundle.id}`;
  return (
    <section className="compare-pane" aria-labelledby={id}>
      <p className="pane-label" id={id}>
        <strong>{label}</strong> · {architecture.bundle.title}
      </p>
      {children}
    </section>
  );
}
