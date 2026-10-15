import type { MouseEventHandler, ReactNode } from "react";
import type { Diagnostic, Document, LegendSpec, Source } from "../../domain/model";
import type { DocumentSelection, Scene, SceneNode } from "../../domain/presentation";
export interface DestinationLinkProps {
  readonly href: string;
  readonly onClick: MouseEventHandler<HTMLAnchorElement>;
}
export interface DiagramCanvasProps {
  readonly overlays?: readonly import("../../domain/scenario").InteractionOverlay[];
  readonly markerId: string;
  readonly scene: Scene;
  readonly nodes: readonly (SceneNode & {
    readonly selected: boolean;
    readonly onSelect: () => void;
    readonly onInspect: () => void;
    readonly detail?: DestinationLinkProps;
  })[];
  readonly onDiagramSelect: () => void;
}
export interface ContextViewProps {
  readonly scene: Scene;
  readonly canvasSlot: ReactNode;
  readonly onDiagramSelect: () => void;
}
export type NavigationSlot = (props: import("../views/NavigationView").NavigationViewProps) => ReactNode;
export type LegendSlot = (props: LegendProps) => ReactNode;
export type DocumentationSlot = (props: DocumentationViewProps) => ReactNode;
export interface DocumentationViewProps {
  readonly selection: DocumentSelection;
  readonly mode: "plain" | "ste";
  readonly onPlain: () => void;
  readonly onSte: () => void;
  readonly document?: Document;
  readonly documentId?: string;
  readonly onDocument?: (id: string) => void;
}
export interface LegendProps extends LegendSpec {
  readonly compact?: boolean;
}
export interface DiagnosticViewProps {
  readonly diagnostics: readonly Diagnostic[];
}
export interface SourceListProps {
  readonly sources: readonly Source[];
}
