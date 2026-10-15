import type { ArchitectureBundle, DeploymentDiagram, Diagnostic, Element, ModelIndex } from "./model";

export function isPhysical(element: Element): boolean {
  return element.kind === "deploymentNode" || element.kind === "infrastructureNode" ||
    element.kind === "instance";
}
/** Bounded and cycle-safe, including when called during validation of untrusted input. */
export function deploymentAncestors(index: ModelIndex, elementId: string): readonly string[] {
  const ancestors: string[] = [];
  const seen = new Set([elementId]);
  let element = index.elements[elementId];
  while (element && isPhysical(element) && "parentId" in element && element.parentId) {
    if (seen.has(element.parentId)) break;
    seen.add(element.parentId);
    ancestors.push(element.parentId);
    element = index.elements[element.parentId];
  }
  return ancestors;
}
export function deploymentEnvironment(index: ModelIndex, element: Element): string | undefined {
  if (element.kind === "deploymentNode" || element.kind === "instance") return element.environment;
  if (element.kind === "infrastructureNode") {
    const parent = index.elements[element.parentId];
    return parent?.kind === "deploymentNode" ? parent.environment : undefined;
  }
}
export function validateDeployment(bundle: ArchitectureBundle, index: ModelIndex): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (path: string, message: string) =>
    diagnostics.push({ code: "deployment", severity: "error", path, message });
  bundle.model.elements.forEach((element, i) => {
    if (!isPhysical(element)) return;
    const path = `$.model.elements[${i}]`;
    if ("parentId" in element && element.parentId) {
      const parent = index.elements[element.parentId];
      if (parent?.kind !== "deploymentNode") {
        error(path + ".parentId", "Physical parents must be deployment nodes.");
      } else if (deploymentEnvironment(index, element) !== parent.environment) {
        error(path + ".environment", "A physical child must share its parent environment.");
      }
    }
    if (
      element.kind === "instance" &&
      !["softwareSystem", "container"].includes(index.elements[element.instanceOf]?.kind)
    ) error(path + ".instanceOf", "An instance must reference a logical system or container.");
    const seen = new Set<string>();
    let current: Element | undefined = element;
    while (current && isPhysical(current)) {
      if (seen.has(current.id)) {
        error(path + ".parentId", "Deployment parents must form an acyclic forest.");
        break;
      }
      seen.add(current.id);
      if (seen.size > 32) {
        error(path + ".parentId", "Deployment nesting exceeds 32 levels.");
        break;
      }
      current = "parentId" in current && current.parentId ? index.elements[current.parentId] : undefined;
    }
  });
  bundle.model.relationships.forEach((edge, i) => {
    const source = index.elements[edge.sourceId];
    const target = index.elements[edge.targetId];
    const path = `$.model.relationships[${i}]`;
    if (source && target && (isPhysical(source) || isPhysical(target))) {
      if (
        !["instance", "infrastructureNode"].includes(source.kind) ||
        !["instance", "infrastructureNode"].includes(target.kind)
      ) {
        error(
          path,
          "Deployment edges connect instances or infrastructure services, never hosts or logical elements.",
        );
      }
      if (deploymentEnvironment(index, source) !== deploymentEnvironment(index, target)) {
        error(path, "Deployment edges cannot cross environments.");
      }
    }
    if (edge.modelRelationshipId) {
      const logical = index.relationships[edge.modelRelationshipId];
      if (
        !logical || source?.kind !== "instance" || target?.kind !== "instance" ||
        logical.sourceId !== source.instanceOf || logical.targetId !== target.instanceOf
      ) {
        error(
          path + ".modelRelationshipId",
          "A model relationship must match the source and target logical identities of instance endpoints.",
        );
      }
    }
  });
  bundle.diagrams.forEach((diagram, i) => {
    const path = `$.diagrams[${i}]`;
    if (diagram.kind !== "deployment") {
      diagram.nodes.forEach((member, j) => {
        const element = index.elements[member.elementId];
        if (element && isPhysical(element)) {
          error(`${path}.nodes[${j}]`, "Physical deployment members belong only in deployment views.");
        }
      });
      return;
    }
    if (diagram.groups?.length) {
      error(
        path + ".groups",
        "Deployment boundaries derive from physical parents; authored visual groups are not supported in deployment views.",
      );
    }
    const visible = new Set(diagram.nodes.map((member) => member.elementId));
    diagram.nodes.forEach((member, j) => {
      const element = index.elements[member.elementId];
      if (!element) return;
      if (!isPhysical(element) || deploymentEnvironment(index, element) !== diagram.environment) {
        error(`${path}.nodes[${j}]`, "Deployment members must be physical elements in this environment.");
      }
      for (const ancestor of deploymentAncestors(index, element.id)) {
        if (!visible.has(ancestor)) {
          error(`${path}.nodes[${j}]`, "Declare every physical ancestor in the view to preserve nesting.");
        }
      }
    });
  });
  return diagnostics;
}
/** Selection wins over collapse: a deep link/history restoration must expose the exact replica. */
export function effectiveCollapsed(
  index: ModelIndex,
  diagram: DeploymentDiagram,
  collapsed: readonly string[],
  selectedId?: string,
): readonly string[] {
  const forcedOpen = new Set(selectedId ? deploymentAncestors(index, selectedId) : []);
  const physicalParents = new Set(
    diagram.nodes.filter((member) => index.elements[member.elementId]?.kind === "deploymentNode").map(
      (member) => member.elementId,
    ),
  );
  return [...new Set(collapsed)].filter((id) => physicalParents.has(id) && !forcedOpen.has(id));
}
/** Derived immutable view: hide incident edges, do not synthesize edges to collapsed ancestors. */
export function projectDeployment(
  index: ModelIndex,
  diagram: DeploymentDiagram,
  collapsed: readonly string[] = [],
  selectedId?: string,
): DeploymentDiagram {
  const closed = new Set(effectiveCollapsed(index, diagram, collapsed, selectedId));
  const nodes = diagram.nodes.filter((member) =>
    !deploymentAncestors(index, member.elementId).some((id) => closed.has(id))
  );
  const visible = new Set(nodes.map((member) => member.elementId));
  const groupId = (id: string) => `deployment-boundary:${id}`;
  const groups = nodes.flatMap((member) => {
    const element = index.elements[member.elementId];
    if (element.kind !== "deploymentNode") return [];
    return [{
      id: groupId(element.id),
      label: `${element.name} · ${element.environment}${closed.has(element.id) ? " · collapsed" : ""}`,
      status: element.status,
      ...(element.parentId ? { parentGroupId: groupId(element.parentId) } : {}),
      memberIds: nodes.filter((candidate) => {
        const child = index.elements[candidate.elementId];
        return child.id === element.id ||
          child.kind !== "deploymentNode" && "parentId" in child && child.parentId === element.id;
      }).map((candidate) => candidate.elementId),
    }];
  });
  return {
    ...diagram,
    nodes,
    groups,
    edges: diagram.edges.filter((ref) => {
      const edge = index.relationships[ref.relationshipId];
      return visible.has(edge.sourceId) && visible.has(edge.targetId);
    }),
  };
}
