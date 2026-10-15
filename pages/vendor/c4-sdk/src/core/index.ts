/** Deliberate browser-free data facade. Keep schema engines and renderer helpers private. */
export { decodeArchitecture } from "../lib/c4/schema/decode";
export { architectureJsonSchema } from "./public/editor-schema";
export { buildScene } from "../lib/c4/domain/scene";
export { resolveLegend, selectDocumentation } from "../lib/c4/domain/documentation";
export { breadcrumbs, formatRoute, parseRoute, transition, validateRoute } from "../lib/c4/domain/navigation";
export type { DecodeLimits } from "../lib/c4/schema/decode";
export type {
  ArchitectureBundle,
  CodeDiagram,
  CodeMember,
  ComponentDiagram,
  ContainerDiagram,
  ContextDiagram,
  DeploymentDiagram,
  Diagnostic,
  Diagram,
  Document,
  DynamicDiagram,
  EdgeRef,
  Element,
  Group,
  Id,
  InteractionStep,
  LandscapeDiagram,
  LegendEntry,
  LegendSpec,
  Link,
  Member,
  ModelIndex,
  References,
  Relationship,
  RelationshipKind,
  Result,
  Source,
  Status,
  Step,
  Swatch,
  SymbolKind,
  Target,
  Term,
  ValidatedArchitecture,
  Visibility,
} from "../lib/c4/domain/model";
export type { SceneInput } from "../lib/c4/domain/scene";
export type {
  Bounds,
  EdgeSection,
  Point,
  Scene,
  SceneEdge,
  SceneGroup,
  SceneNode,
  Size,
} from "../lib/c4/domain/geometry";
export type { DocumentSelection } from "../lib/c4/domain/documentation";
export type { NavigationAction, NavigationEffect, Route } from "../lib/c4/domain/navigation";
export type { RoutePort, RouteSnapshot } from "../lib/c4/ports/route";
export type { LayoutMeasurements, LayoutPort, LayoutRequest, LayoutResponse } from "../lib/c4/ports/layout";
export type { GeometryLimits } from "../lib/c4/domain/layout";
export type { ArchitectureLoader, Catalog, CatalogEntry } from "../lib/c4/ports/loader";
