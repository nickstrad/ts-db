import type { Diagram, Element, Group, ModelIndex, Relationship, Result, Status } from "./model";
export type { Bounds, EdgeSection, Point, Scene, SceneEdge, SceneGroup, SceneNode, Size } from "./geometry";
import { directGroupMembership, validateGroups } from "./groups";
export const statusLabel = (status: Status) =>
  status === "mixed"
    ? "Existing system with planned changes"
    : status === "planned"
    ? "Planned architecture"
    : "Existing architecture";
export interface SceneInput {
  readonly architectureId: string;
  readonly revision: string;
  readonly diagram: Diagram;
  readonly kindLabel: string;
  readonly statusText: string;
  readonly groups: readonly Group[];
  readonly nodes: readonly {
    readonly element: Element;
    readonly kindLabel: string;
    readonly parentGroupId?: string;
    readonly tone: "accent" | "external" | "default";
    readonly stroke: "solid" | "dashed";
    readonly statusText: string;
  }[];
  readonly edges: readonly {
    readonly relationship: Relationship;
    readonly number?: number;
    readonly stroke: "solid" | "dashed";
  }[];
}
export function buildScene(index: ModelIndex, diagramId: string): Result<SceneInput> {
  const diagram = index.diagrams[diagramId];
  const fail = (path: string, message: string): Result<SceneInput> => ({
    ok: false,
    diagnostics: [{ code: "projection", severity: "error", path, message }],
  });
  if (!diagram) return fail("$.diagramId", `Unknown diagram "${diagramId}".`);
  const groups = Object.freeze([...(diagram.groups ?? [])]);
  const groupDiagnostics = validateGroups(groups, diagram.nodes.map((node) => node.elementId));
  if (groupDiagnostics.length) return { ok: false, diagnostics: groupDiagnostics };
  const membership = directGroupMembership(groups);
  const nodes: SceneInput["nodes"][number][] = [];
  for (const [i, member] of diagram.nodes.entries()) {
    const element = index.elements[member.elementId];
    if (!element) return fail(`$.nodes[${i}]`, "Cannot project an unknown element.");
    const kindLabel = element.kind === "deploymentNode"
      ? `Deployment node · ${element.technology} · ${element.environment}`
      : element.kind === "infrastructureNode"
      ? `Infrastructure · ${element.technology}`
      : element.kind === "instance"
      ? `Instance of ${index.elements[element.instanceOf]?.name} · ${element.environment}`
      : element.kind === "code"
      ? `Code · ${element.symbolKind}${element.technology ? ` · ${element.technology}` : ""}`
      : element.kind === "component"
      ? `Component${element.technology ? ` · ${element.technology}` : ""}`
      : element.kind === "person"
      ? "Person"
      : element.kind === "container"
      ? `${element.containerType === "datastore" ? "Data store" : "Application"} · ${element.technology}`
      : element.tags.includes("external")
      ? "External software system"
      : "Software system";
    nodes.push(Object.freeze({
      element,
      kindLabel,
      tone: element.id === diagram.scopeId
        ? "accent"
        : element.tags.includes("external")
        ? "external"
        : "default",
      stroke: element.status === "existing" ? "solid" : "dashed",
      statusText: element.status === "mixed" ? "Existing + planned changes" : element.status,
      ...(membership.has(element.id) ? { parentGroupId: membership.get(element.id) } : {}),
    }));
  }
  const edges: SceneInput["edges"][number][] = [];
  for (const [i, edge] of diagram.edges.entries()) {
    const relationship = index.relationships[edge.relationshipId];
    if (
      !relationship || !nodes.some((node) => node.element.id === relationship.sourceId) ||
      !nodes.some((node) => node.element.id === relationship.targetId)
    ) return fail(`$.edges[${i}]`, "Cannot project a relationship with absent endpoints.");
    edges.push(
      Object.freeze({
        relationship,
        number: edge.displayNumber,
        stroke: relationship.status === "existing" ? "solid" : "dashed",
      }),
    );
  }
  return {
    ok: true,
    value: Object.freeze({
      architectureId: index.bundle.id,
      revision: index.bundle.revision,
      diagram,
      kindLabel: diagramKindLabel(diagram.kind),
      statusText: statusLabel(diagram.status),
      groups,
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
    }),
    diagnostics: [],
  };
}

/** Presentation names are selected before geometry; canvas modules never dispatch model kinds. */
export function diagramKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    landscape: "System landscape",
    context: "System context",
    container: "Containers",
    component: "Components",
    code: "Code",
    dynamic: "Dynamic",
    deployment: "Deployment",
  };
  return Object.hasOwn(labels, kind) ? labels[kind] : "Diagram";
}
