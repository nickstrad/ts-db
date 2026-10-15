import { createContext, useContext as useReactContext } from "react";
import type { Diagram, ValidatedArchitecture } from "../../domain/model";
import type { LayoutPort } from "../../ports/layout";
import type { useContext } from "./useContext";
import type { useNavigation } from "./useNavigation";
import type { useViewerSession } from "./useViewerSession";
export interface ViewerController {
  readonly architecture: ValidatedArchitecture;
  readonly navigation: ReturnType<typeof useNavigation>;
  readonly context: ReturnType<typeof useContext>;
  readonly session: ReturnType<typeof useViewerSession>;
  readonly layoutPort?: LayoutPort;
  readonly expectedKind?: Diagram["kind"];
}
export const ControllerContext = createContext<ViewerController | undefined>(undefined);
export function useController(): ViewerController {
  const controller = useReactContext(ControllerContext);
  if (!controller) throw new Error("Diagram parts must be rendered inside an ArchitectureProvider.");
  return controller;
}
/** Read-only view of the shared controller for custom parts. It cannot start a second route. */
export function useViewerController(): {
  readonly route: ViewerController["navigation"]["route"];
  readonly diagram: Diagram | undefined;
  readonly validatedBundle: ValidatedArchitecture;
  readonly navigate: ViewerController["navigation"]["navigate"];
} {
  const { navigation, architecture } = useController();
  return {
    route: navigation.route,
    diagram: architecture.index.diagrams[navigation.route.diagramId],
    validatedBundle: architecture,
    navigate: navigation.navigate,
  };
}
