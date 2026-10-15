import type { ReactNode } from "react";
import { ControllerContext, useController } from "../hooks/useViewerController";
import type { ViewerController } from "../hooks/useViewerController";
import { DeploymentTreeView } from "../views/DeploymentTreeView";
import type { Diagram, ValidatedArchitecture } from "../../domain/model";
import { diagramKindDiagnostics } from "../../domain/architecture";
import type { LayoutPort } from "../../ports/layout";
import type { RoutePort } from "../../ports/route";
import type { DocumentationSlot, LegendSlot, NavigationSlot } from "../contracts/views";
import { useContext } from "../hooks/useContext";
import { useNavigation, useRoutePort } from "../hooks/useNavigation";
import { useDiagramRenderer } from "../hooks/useDiagramRenderer";
import { useViewerSession } from "../hooks/useViewerSession";
import { DiagramCanvas, MeasurementRack } from "./DiagramCanvas";
import { DiagramFallback } from "../views/DiagramFallback";
import type { CanvasSession } from "../hooks/useViewerSession";
import { ContextView } from "../views/ContextView";
import { NavigationView } from "../views/NavigationView";
import { DocumentationView } from "../views/DocumentationView";
import { DiagnosticView } from "../views/DiagnosticView";
import { StepControlsView } from "../views/StepControlsView";
import { StepListView } from "../views/StepListView";
import { Legend } from "../views/Legend";
import type { SceneInput } from "../../domain/scene";
export interface ArchitectureViewerProps {
  readonly validatedBundle: ValidatedArchitecture;
  readonly diagramId?: string;
  readonly routePort?: RoutePort;
  readonly layoutPort?: LayoutPort;
  /** Reject any routed diagram of another kind. Named wrappers set this; the check follows the actual route. */
  readonly expectedKind?: Diagram["kind"];
  readonly navigationSlot?: NavigationSlot;
  readonly legendSlot?: LegendSlot;
  readonly documentationSlot?: DocumentationSlot;
}
/** Wrappers hide `expectedKind`; they cannot be configured for another kind. */
export type NamedDiagramProps = Omit<ArchitectureViewerProps, "expectedKind">;
function RenderDiagram(
  { input, context, layoutPort, session, legendSlot }: {
    input: SceneInput;
    context: ReturnType<typeof useContext>;
    layoutPort?: LayoutPort;
    session: CanvasSession;
    legendSlot: LegendSlot;
  },
) {
  const { projected, canvasProps, measurementRef } = useDiagramRenderer(input, context, layoutPort);
  const pending = projected.diagnostics.some((diagnostic) => diagnostic.code === "layout-pending");
  return (
    <>
      {context.dynamic && <StepControlsView {...context.dynamic} />}
      <MeasurementRack input={input} measurementRef={measurementRef} />
      {pending && projected.ok && <p role="status">Updating diagram layout…</p>}
      {projected.ok && canvasProps
        ? (
          <>
            <ContextView
              scene={projected.value}
              onDiagramSelect={context.canvasActions.onDiagramSelect}
              canvasSlot={
                <DiagramCanvas
                  key={JSON.stringify([input.architectureId, input.revision, input.diagram.id])}
                  {...canvasProps}
                  session={session}
                />
              }
            />
            <details className="c4-text-alternative">
              <summary>Element and relationship text alternative</summary>
              <DiagramFallback ready={false} input={input} nodeActions={context.canvasActions.nodeActions} />
            </details>
          </>
        )
        : (
          <>
            {pending
              ? <p role="status">Arranging diagram…</p>
              : <DiagnosticView diagnostics={projected.diagnostics} />}
            <DiagramFallback ready={!pending} input={input} nodeActions={context.canvasActions.nodeActions} />
          </>
        )}
      {context.deployment && <DeploymentTreeView {...context.deployment} />}
      {context.dynamic && <StepListView {...context.dynamic} />}
      {legendSlot(input.diagram.legend)}
    </>
  );
}

export interface ArchitectureProviderProps extends
  Pick<
    ArchitectureViewerProps,
    "validatedBundle" | "diagramId" | "routePort" | "layoutPort" | "expectedKind"
  > {
  readonly children?: ReactNode;
}
/**
 * One route/navigation/session controller for every composed part below it. Parts read it through
 * context, so a custom layout can never create a second controller for the same viewer.
 */
export function ArchitectureProvider(
  { validatedBundle, diagramId, routePort, layoutPort, expectedKind, children }: ArchitectureProviderProps,
) {
  const port = useRoutePort(routePort);
  const navigation = useNavigation(validatedBundle, port, diagramId);
  const context = useContext(validatedBundle, navigation.route, navigation.navigate, navigation.detail);
  const session = useViewerSession(navigation.route, validatedBundle.bundle.revision);
  return (
    <ControllerContext.Provider
      value={{ architecture: validatedBundle, navigation, context, session, layoutPort, expectedKind }}
    >
      <div {...session.rootProps} className="c4-sdk">{children}</div>
    </ControllerContext.Provider>
  );
}
/** Route diagnostics first, then the routed (not merely requested) diagram kind. */
function viewerDiagnostics({ navigation, architecture, expectedKind }: ViewerController) {
  if (navigation.diagnostics.length) return navigation.diagnostics;
  return expectedKind
    ? diagramKindDiagnostics(architecture.index, navigation.route.diagramId, expectedKind)
    : [];
}
export function DiagramNavigation({ slot }: { slot?: NavigationSlot }) {
  const { navigation } = useController();
  return (
    <>
      {slot ? slot(navigation.viewProps) : <NavigationView {...navigation.viewProps} />}
      <p className="c4-sr-only" aria-live="polite">{navigation.diagramTitle}</p>
    </>
  );
}
export function DiagramView({ legendSlot = (props) => <Legend {...props} /> }: { legendSlot?: LegendSlot }) {
  const controller = useController();
  const { navigation, context, layoutPort, session } = controller;
  const diagnostics = viewerDiagnostics(controller);
  if (diagnostics.length) {
    return (
      <>
        <DiagnosticView diagnostics={diagnostics} />
        {navigation.diagnostics.length ? <a {...navigation.recovery}>Open diagram</a> : null}
      </>
    );
  }
  return context.input.ok
    ? (
      <RenderDiagram
        input={context.input.value}
        context={context}
        layoutPort={layoutPort}
        session={session.canvasSession}
        legendSlot={legendSlot}
      />
    )
    : <DiagnosticView diagnostics={context.input.diagnostics} />;
}
/** The key for the routed diagram, for layouts that place it away from the canvas (pair with `legendSlot={() => null}`). */
export function DiagramLegend({ slot }: { slot?: LegendSlot }) {
  const controller = useController();
  if (viewerDiagnostics(controller).length || !controller.context.input.ok) return null;
  const legend = controller.context.input.value.diagram.legend;
  return <>{slot ? slot(legend) : <Legend {...legend} />}</>;
}
export function DiagramDocumentation({ slot }: { slot?: DocumentationSlot }) {
  const controller = useController();
  if (viewerDiagnostics(controller).length || !controller.context.input.ok) return null;
  const props = controller.context.documentationProps;
  return <>{slot ? slot(props) : <DocumentationView {...props} />}</>;
}
export function ArchitectureViewer(
  { navigationSlot, legendSlot, documentationSlot, ...provider }: ArchitectureViewerProps,
) {
  return (
    <ArchitectureProvider {...provider}>
      <DiagramNavigation slot={navigationSlot} />
      <div className="c4-viewer-grid">
        <div>
          <DiagramView legendSlot={legendSlot} />
        </div>
        <DiagramDocumentation slot={documentationSlot} />
      </div>
    </ArchitectureProvider>
  );
}
