export type Id = string;
export type Status = "existing" | "planned" | "mixed";
export interface Diagnostic {
  readonly code: string;
  readonly path: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}
export interface References {
  readonly docIds: readonly Id[];
  readonly sourceIds: readonly Id[];
}
interface ElementBase extends References {
  readonly id: Id;
  readonly name: string;
  readonly description: string;
  readonly status: Status;
  readonly technology?: string;
  readonly tags: readonly string[];
  readonly plannedNotes: readonly string[];
}
export type SymbolKind = "class" | "interface" | "function" | "type" | "enum" | "table" | "module";
export type Visibility = "public" | "protected" | "private" | "package";
/** Text-only declaration shown in a symbol compartment; never executed, parsed or fetched. */
export interface CodeMember {
  readonly name: string;
  readonly signature?: string;
  readonly visibility: Visibility;
}
export type RelationshipKind =
  | "dependency"
  | "association"
  | "inheritance"
  | "implementation"
  | "composition";
export type Element =
  | (ElementBase & { readonly kind: "person" | "softwareSystem" })
  | (ElementBase & {
    readonly kind: "container";
    readonly parentId: Id;
    readonly technology: string;
    readonly containerType: "application" | "datastore";
  })
  | (ElementBase & { readonly kind: "component"; readonly parentId: Id; readonly technology: string })
  | (ElementBase & {
    readonly kind: "code";
    readonly parentId: Id;
    readonly symbolKind: SymbolKind;
    readonly members: readonly CodeMember[];
  })
  | (ElementBase & {
    readonly kind: "deploymentNode";
    readonly environment: string;
    readonly technology: string;
    readonly parentId?: Id;
  })
  | (ElementBase & {
    readonly kind: "infrastructureNode";
    readonly parentId: Id;
    readonly technology: string;
  })
  | (ElementBase & {
    readonly kind: "instance";
    readonly instanceOf: Id;
    readonly parentId: Id;
    readonly environment: string;
  });
export interface Target {
  readonly diagramId: Id;
  readonly elementId?: Id;
}
export interface Link extends Target {
  readonly label: string;
}
export interface Relationship extends References {
  readonly id: Id;
  readonly sourceId: Id;
  readonly targetId: Id;
  readonly label: string;
  readonly modelRelationshipId?: Id;
  readonly status: Status;
  readonly technology?: string;
  readonly kind: RelationshipKind;
  readonly plannedNotes: readonly string[];
}
export interface Member {
  readonly elementId: Id;
  readonly detail?: Target;
  readonly related: readonly Link[];
  readonly position?: { readonly x: number; readonly y: number };
  readonly size?: { readonly width: number; readonly height: number };
}
export interface Group {
  readonly id: Id;
  readonly label: string;
  readonly memberIds: readonly Id[];
  readonly status: Status;
  readonly parentGroupId?: Id;
}
export interface EdgeRef {
  readonly relationshipId: Id;
  readonly displayNumber?: number;
}
export interface Swatch {
  readonly shape?: "person" | "box" | "database" | "boundary" | "line";
  readonly tone: "default" | "external" | "accent" | "muted";
  readonly stroke: "solid" | "dashed" | "dotted";
  readonly arrow?: "none" | "forward";
}
export interface LegendEntry {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly swatch: Swatch;
}
export interface LegendSpec {
  readonly title: string;
  readonly entries: readonly LegendEntry[];
}
interface DiagramBase extends References {
  readonly id: Id;
  readonly parent?: Target;
  readonly related: readonly Link[];
  readonly title: string;
  readonly status: Status;
  readonly groups?: readonly Group[];
  readonly scopeId: Id;
  readonly nodes: readonly Member[];
  readonly edges: readonly EdgeRef[];
  readonly legend: LegendSpec;
  readonly layout?: {
    readonly mode: "manual" | "auto";
    readonly direction: "TB" | "LR";
    readonly spacing?: number;
  };
}
export interface LandscapeDiagram extends Omit<DiagramBase, "scopeId"> {
  readonly kind: "landscape";
  readonly scopeId?: Id;
}
export interface ContextDiagram extends DiagramBase {
  readonly kind: "context";
}
export interface ContainerDiagram extends DiagramBase {
  readonly kind: "container";
}
export interface ComponentDiagram extends DiagramBase {
  readonly kind: "component";
}
export interface CodeDiagram extends DiagramBase {
  readonly kind: "code";
}
export interface InteractionStep {
  readonly kind: "interaction";
  readonly id: Id;
  readonly relationshipId: Id;
  readonly direction: "forward" | "reverse";
  readonly label: string;
}
export type Step = InteractionStep | {
  readonly kind: "sequence";
  readonly id: Id;
  readonly children: readonly Step[];
} | { readonly kind: "parallel"; readonly id: Id; readonly branches: readonly Step[] };
export interface DynamicDiagram extends Omit<DiagramBase, "scopeId"> {
  readonly kind: "dynamic";
  readonly scopeId?: Id;
  readonly scenario: Step;
}
export interface DeploymentDiagram extends Omit<DiagramBase, "scopeId"> {
  readonly kind: "deployment";
  readonly scopeId?: Id;
  readonly environment: string;
}
export type Diagram =
  | LandscapeDiagram
  | ContextDiagram
  | ContainerDiagram
  | ComponentDiagram
  | CodeDiagram
  | DynamicDiagram
  | DeploymentDiagram;
export interface Document {
  readonly sourceIds: readonly Id[];
  readonly id: Id;
  readonly title: string;
  readonly plain: string;
  readonly ste: {
    readonly text: string;
    readonly issue: string;
    readonly reviewStatus: "draft" | "reviewed";
    readonly reviewer?: string;
    readonly reviewedAt?: string;
  };
  readonly termIds: readonly Id[];
}
export interface Source {
  readonly id: Id;
  readonly title: string;
  readonly url: string;
  readonly revision?: string;
  readonly path?: string;
  readonly notes?: string;
}
export interface Term {
  readonly id: Id;
  readonly text: string;
  readonly definition: string;
  readonly category: "technicalNoun" | "technicalVerb";
}
export interface ArchitectureBundle {
  readonly schemaVersion: 1;
  readonly id: Id;
  readonly title: string;
  readonly revision: string;
  readonly defaultDiagramId: Id;
  readonly model: { readonly elements: readonly Element[]; readonly relationships: readonly Relationship[] };
  readonly diagrams: readonly Diagram[];
  readonly documents: readonly Document[];
  readonly sources: readonly Source[];
  readonly terms: readonly Term[];
}
export interface ModelIndex {
  readonly bundle: ArchitectureBundle;
  readonly elements: Readonly<Record<Id, Element>>;
  readonly relationships: Readonly<Record<Id, Relationship>>;
  readonly diagrams: Readonly<Record<Id, Diagram>>;
  readonly documents: Readonly<Record<Id, Document>>;
  readonly sources: Readonly<Record<Id, Source>>;
  readonly terms: Readonly<Record<Id, Term>>;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
export interface ValidatedArchitecture {
  readonly bundle: ArchitectureBundle;
  readonly index: ModelIndex;
  readonly diagnostics: readonly Diagnostic[];
}
