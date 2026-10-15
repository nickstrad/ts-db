import { useMemo, useState } from "react";
import { deploymentAncestors, effectiveCollapsed, projectDeployment } from "../../domain/deployment";
import type { ModelIndex } from "../../domain/model";
import type { Route } from "../../domain/navigation";
import type { DestinationLinkProps } from "../contracts/views";
export function useDeployment(
  index: ModelIndex,
  route: Route,
  inspect: (id: string) => void,
  detail: (id: string) => DestinationLinkProps | undefined,
) {
  const [states, setStates] = useState<Readonly<Record<string, readonly string[]>>>({});
  const diagram = index.diagrams[route.diagramId];
  const key = JSON.stringify([index.bundle.id, index.bundle.revision, route.diagramId]);
  const stored = states[key];
  const collapsed = useMemo(
    () =>
      diagram?.kind === "deployment" ? effectiveCollapsed(index, diagram, stored ?? [], route.elementId) : [],
    [index, diagram, stored, route.elementId],
  );
  const collapsedKey = JSON.stringify(collapsed);
  // Geometry changes only with the derived visible set, not ordinary inspection.
  const projection = useMemo(
    () =>
      diagram?.kind === "deployment"
        ? projectDeployment(index, diagram, JSON.parse(collapsedKey) as string[])
        : undefined,
    [index, diagram, collapsedKey],
  );
  if (diagram?.kind !== "deployment" || !projection) return undefined;
  const toggle = (id: string) => {
    // When collapsing an ancestor of selection, select that physical node first.
    if (
      !collapsed.includes(id) && route.elementId && deploymentAncestors(index, route.elementId).includes(id)
    ) inspect(id);
    setStates((previous) => ({
      ...previous,
      [key]: collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id],
    }));
  };
  return {
    projection,
    environment: diagram.environment,
    hiddenCount: diagram.nodes.length - projection.nodes.length,
    relationships: diagram.edges.map((ref) => {
      const edge = index.relationships[ref.relationshipId];
      return {
        id: edge.id,
        source: index.elements[edge.sourceId].name,
        target: index.elements[edge.targetId].name,
        label: edge.label,
        status: edge.status,
      };
    }),
    rows: diagram.nodes.map((member) => {
      const element = index.elements[member.elementId];
      return {
        id: element.id,
        name: element.name,
        description: element.description,
        status: element.status,
        depth: deploymentAncestors(index, element.id).length,
        parent: "parentId" in element && element.parentId
          ? index.elements[element.parentId]?.name
          : undefined,
        logical: element.kind === "instance" ? index.elements[element.instanceOf]?.name : undefined,
        kind: element.kind,
        selected: route.elementId === element.id,
        collapsed: collapsed.includes(element.id),
        onToggle: () => toggle(element.id),
        onInspect: () => inspect(element.id),
        detail: detail(element.id),
      };
    }),
  };
}
