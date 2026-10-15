import { useDeployment } from "./useDeployment";
import { useId, useMemo } from "react";
import type { ValidatedArchitecture } from "../../domain/model";
import { buildScene } from "../../domain/scene";
import { useDynamicSteps } from "./useDynamicSteps";
import { useDocumentation } from "./useDocumentation";
import { selectDocumentation } from "../../domain/documentation";
import type { DestinationLinkProps } from "../contracts/views";
import type { NavigationAction, Route } from "../../domain/navigation";
export function useContext(
  architecture: ValidatedArchitecture,
  route: Route,
  navigate: (action: NavigationAction) => void,
  detail: (elementId: string) => DestinationLinkProps | undefined,
) {
  const markerId = useId();
  const deployment = useDeployment(
    architecture.index,
    route,
    (elementId) => navigate({ type: "inspect", elementId }),
    detail,
  );
  const projection = deployment?.projection;
  const input = useMemo(
    () =>
      buildScene(
        projection
          ? {
            ...architecture.index,
            diagrams: { ...architecture.index.diagrams, [route.diagramId]: projection },
          }
          : architecture.index,
        route.diagramId,
      ),
    [architecture, route.diagramId, projection],
  );
  const documentation = selectDocumentation(architecture.index, route.diagramId, route.elementId);
  const documentationProps = useDocumentation(
    documentation,
    JSON.stringify([architecture.bundle.id, architecture.bundle.revision, route.diagramId, route.elementId]),
  );
  const dynamic = useDynamicSteps(architecture.index, route, navigate);
  return {
    input,
    markerId,
    documentationProps,
    dynamic,
    deployment,
    canvasActions: {
      onDiagramSelect: () => navigate({ type: "diagram" }),
      nodeActions: (elementId: string) => ({
        selected: route.elementId === elementId,
        detail: detail(elementId),
        onSelect: () => navigate({ type: "activate", elementId }),
        onInspect: () => navigate({ type: "inspect", elementId }),
      }),
    },
  };
}
