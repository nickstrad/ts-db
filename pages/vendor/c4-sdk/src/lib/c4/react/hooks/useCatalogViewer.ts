import { useCallback, useMemo, useRef, useState } from "react";
import { createFetchLoader } from "../../adapters/loaders/fetch";
import { catalogRouteDiagnostics, parseRoute } from "../../domain/navigation";
import type { ValidatedArchitecture } from "../../domain/model";
import type { ArchitectureLoader } from "../../ports/loader";
import type { RoutePort, RouteSnapshot } from "../../ports/route";
import { useArchitectureBundle } from "./useArchitectureBundle";
import { useRoutePort, useRouteSnapshot } from "./useNavigation";
interface ResourceRequest {
  readonly catalogUrl: string;
  readonly url: string;
  readonly fromSnapshot: RouteSnapshot;
}
export function useCatalogViewer(catalogUrl: string, loader?: ArchitectureLoader, providedPort?: RoutePort) {
  const resourceLoader = useMemo(() => loader ?? createFetchLoader(), [loader]);
  const port = useRoutePort(providedPort);
  const snapshot = useRouteSnapshot(port);
  const parsed = parseRoute(snapshot.hash);
  const architectureId = parsed.ok ? parsed.value?.architectureId : undefined;
  const [requested, setRequested] = useState<ResourceRequest>();
  const requestedRef = useRef<ResourceRequest | undefined>(undefined);
  const override = requested?.catalogUrl === catalogUrl && requested.fromSnapshot === snapshot
    ? requested.url
    : undefined;
  const onAccepted = useCallback((architecture: ValidatedArchitecture, url: string) => {
    const request = requestedRef.current;
    if (
      !request || request.catalogUrl !== catalogUrl || request.url !== url ||
      request.fromSnapshot !== port.getSnapshot()
    ) return;
    requestedRef.current = undefined;
    setRequested(undefined);
    const route = { architectureId: architecture.bundle.id, diagramId: architecture.bundle.defaultDiagramId };
    // Only now is a destination known. Failure/delay never creates a guessed history entry.
    if (request.fromSnapshot.hash) port.push(route);
    else port.replace(route);
  }, [catalogUrl, port, setRequested]);
  const state = useArchitectureBundle(resourceLoader, catalogUrl, {
    architectureId,
    resourceUrl: override,
    onAccepted,
    requireCatalogIdentity: true,
  });
  const routeDiagnostics = catalogRouteDiagnostics(state.catalog, architectureId);
  return {
    ...state,
    port,
    diagnostics: [...state.diagnostics, ...routeDiagnostics],
    viewerArchitecture: routeDiagnostics.length ? undefined : state.architecture,
    viewerKey: state.architecture
      ? `${state.architecture.bundle.id}:${state.architecture.bundle.revision}`
      : undefined,
    onResourceSelect: (url: string) => {
      if (!state.catalog?.entries.some((entry) => entry.url === url)) return;
      const request = { catalogUrl, url, fromSnapshot: port.getSnapshot() };
      requestedRef.current = request;
      setRequested(request);
    },
  };
}
