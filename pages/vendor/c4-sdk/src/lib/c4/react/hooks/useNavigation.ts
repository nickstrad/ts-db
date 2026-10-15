import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import type { Target, ValidatedArchitecture } from "../../domain/model";
import {
  breadcrumbs,
  detailTarget,
  formatRoute,
  isOrdinaryLinkActivation,
  parseRoute,
  recoveryTarget,
  relatedTargets,
  transition,
  validateRoute,
} from "../../domain/navigation";
import type { NavigationAction, Route } from "../../domain/navigation";
import type { RoutePort } from "../../ports/route";
import { createHashRoutePort } from "../../adapters/router/hash";
export function useRoutePort(provided?: RoutePort) {
  return useMemo(() => provided ?? createHashRoutePort(), [provided]);
}
export function useRouteSnapshot(port: RoutePort) {
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot);
}
export function useNavigation(
  architecture: ValidatedArchitecture,
  port: RoutePort,
  initialDiagramId?: string,
) {
  const snapshot = useRouteSnapshot(port);
  const parsed = parseRoute(snapshot.hash);
  const root: Route = useMemo(
    () => ({
      architectureId: architecture.bundle.id,
      diagramId: initialDiagramId ?? architecture.bundle.defaultDiagramId,
    }),
    [architecture, initialDiagramId],
  );
  // A rejected resource preserves its last valid viewer. Its route remains isolated to that architecture.
  const route = parsed.ok && parsed.value?.architectureId === architecture.bundle.id ? parsed.value : root;
  const diagnostics = !parsed.ok ? parsed.diagnostics : validateRoute(architecture.index, route);
  useEffect(() => {
    if (!snapshot.hash) port.replace(root);
  }, [port, snapshot.hash, root]);
  const navigate = (action: NavigationAction) => {
    const result = transition(architecture.index, route, action, snapshot.canGoBack);
    if (result.ok) {
      if (result.value.type === "back") port.back();
      else port.push(result.value.route);
    }
  };
  const destination = (target: Target) => ({
    href: formatRoute({ architectureId: architecture.bundle.id, ...target }),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (isOrdinaryLinkActivation(event)) {
        event.preventDefault();
        navigate({ type: "target", target });
      }
    },
  });
  const diagram = architecture.index.diagrams[route.diagramId];
  const trail = breadcrumbs(architecture.index, route);
  return {
    route,
    diagnostics,
    navigate,
    diagramTitle: diagram?.title,
    recovery: destination(recoveryTarget(architecture.index, route)),
    detail: (elementId: string) => {
      const target = detailTarget(architecture.index, route, elementId);
      return target ? destination(target) : undefined;
    },
    viewProps: {
      breadcrumbs: trail.map((target, i) => ({
        id: target.diagramId,
        title: architecture.index.diagrams[target.diagramId].title,
        current: i === trail.length - 1,
        ...destination(target),
      })),
      onBack: () => navigate({ type: "back" }),
      up: diagram?.parent ? destination(diagram.parent) : undefined,
      related: relatedTargets(architecture.index, route).map((target) => ({
        label: target.label,
        ...destination(target),
      })),
    },
  };
}
