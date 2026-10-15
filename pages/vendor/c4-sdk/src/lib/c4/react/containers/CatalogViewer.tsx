import type { RoutePort } from "../../ports/route";
import type { ArchitectureLoader } from "../../ports/loader";
import { useCatalogViewer } from "../hooks/useCatalogViewer";
import { ArchitectureViewer } from "./ArchitectureViewer";
import { DiagnosticView } from "../views/DiagnosticView";
import { CatalogView } from "../views/CatalogView";
export interface CatalogViewerProps {
  readonly catalogUrl: string;
  readonly loader?: ArchitectureLoader;
  readonly title?: string;
  readonly routePort?: RoutePort;
}
export function CatalogViewer(
  { catalogUrl, loader, title = "Architecture explorer", routePort }: CatalogViewerProps,
) {
  const state = useCatalogViewer(catalogUrl, loader, routePort);
  return (
    <CatalogView
      title={title}
      catalog={state.catalog}
      resourceUrl={state.resourceUrl}
      onResourceSelect={state.onResourceSelect}
      statusText={state.statusText}
      diagnosticsSlot={<DiagnosticView diagnostics={state.diagnostics} />}
      viewerSlot={state.viewerArchitecture && (
        <ArchitectureViewer
          key={state.viewerKey}
          validatedBundle={state.viewerArchitecture}
          routePort={state.port}
        />
      )}
    />
  );
}
