export { architectureJsonSchema, architectureSchema, decodeArchitecture } from "./schema/decode";
export type { DecodeLimits } from "./schema/decode";
export type { FetchLoaderLimits } from "./adapters/loaders/fetch";
export { buildIndex, validateArchitecture } from "./domain/architecture";
export { projectDiagram, resolveLegend, selectDocumentation } from "./domain/presentation";
export type {
  ArchitectureBundle,
  Diagnostic,
  LegendEntry,
  LegendSpec,
  ModelIndex,
  Result,
  ValidatedArchitecture,
} from "./domain/model";
export type { DocumentSelection, Scene } from "./domain/presentation";
export type { ArchitectureLoader, Catalog, CatalogEntry } from "./ports/loader";
export { createFetchLoader } from "./adapters/loaders/fetch";
export {
  ArchitectureProvider,
  ArchitectureViewer,
  DiagramDocumentation,
  DiagramLegend,
  DiagramNavigation,
  DiagramView,
} from "./react/containers/ArchitectureViewer";
export { useViewerController } from "./react/hooks/useViewerController";
export {
  CodeDiagram,
  ComponentDiagram,
  ContainerDiagram,
  DeploymentDiagram,
  DynamicDiagram,
  SystemContext,
  SystemLandscape,
} from "./react/containers/NamedDiagrams";
export { CatalogViewer } from "./react/containers/CatalogViewer";
export { Legend } from "./react/views/Legend";
export { DocumentationView, SourceListView } from "./react/views/DocumentationView";
export { DiagnosticView } from "./react/views/DiagnosticView";
export { buildScene } from "./domain/scene";
export { breadcrumbs, formatRoute, parseRoute, transition, validateRoute } from "./domain/navigation";
export { createHashRoutePort } from "./adapters/router/hash";
export type { NavigationAction, NavigationEffect, Route } from "./domain/navigation";
export type { RoutePort, RouteSnapshot } from "./ports/route";
export type { LayoutPort, LayoutRequest, LayoutResponse } from "./ports/layout";
export type { SceneInput } from "./domain/scene";
export type {
  ArchitectureProviderProps,
  ArchitectureViewerProps,
  NamedDiagramProps,
} from "./react/containers/ArchitectureViewer";
export type {
  DocumentationSlot,
  DocumentationViewProps,
  LegendSlot,
  NavigationSlot,
} from "./react/contracts/views";

export { precedence, scenarioItems, selectInteractions } from "./domain/scenario";
export type { InteractionStep, Step } from "./domain/model";

export { deploymentAncestors, deploymentEnvironment, projectDeployment } from "./domain/deployment";
export { codeAncestry, memberKey, symbolKey } from "./domain/codeview";
export type { CodeMember, Diagram, Element, RelationshipKind, SymbolKind, Visibility } from "./domain/model";
export { NavigationView } from "./react/views/NavigationView";
export type { NavigationViewProps } from "./react/views/NavigationView";

export type { GeometryLimits } from "./domain/layout";
