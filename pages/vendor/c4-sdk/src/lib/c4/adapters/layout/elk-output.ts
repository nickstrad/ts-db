import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { Bounds, EdgeSection, Scene, SceneEdge } from "../../domain/geometry";
import type { SceneInput } from "../../domain/scene";
import type { Result } from "../../domain/model";
import { validateLayout } from "../../domain/layout";
import { edgeId, groupId, nodeId } from "./elk-input";
export interface LayoutGeometry {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly (Bounds & { id: string; labelBounds?: Bounds })[];
  readonly edges: readonly { id: string; sections: readonly EdgeSection[]; labelBounds?: Bounds }[];
}
/** ELK children and edge containers are local; publish absolute scene coordinates exactly once. */
export function elkOutput(root: ElkNode): LayoutGeometry {
  const nodes: LayoutGeometry["nodes"][number][] = [];
  const pending: { edge: ElkExtendedEdge; x: number; y: number }[] = [];
  const containers = new Map<string, { x: number; y: number }>([[root.id, { x: 0, y: 0 }]]);
  const visit = (graph: ElkNode, x: number, y: number) => {
    for (const child of graph.children ?? []) {
      const cx = x + (child.x ?? NaN);
      const cy = y + (child.y ?? NaN);
      containers.set(child.id, { x: cx, y: cy });
      const label = child.labels?.[0];
      nodes.push({
        id: child.id,
        x: cx,
        y: cy,
        width: child.width ?? NaN,
        height: child.height ?? NaN,
        ...(label
          ? {
            labelBounds: {
              x: cx + (label.x ?? 16),
              y: cy + (label.y ?? 16),
              width: label.width ?? NaN,
              height: label.height ?? NaN,
            },
          }
          : {}),
      });
      visit(child, cx, cy);
    }
    for (const edge of graph.edges ?? []) pending.push({ edge, x, y });
  };
  visit(root, 0, 0);
  const edges = pending.map(({ edge, x, y }) => {
    // ELK may retain edges in the root array while reporting their common ancestor
    // in `container`. Route and label coordinates belong to that container.
    const origin = edge.container ? containers.get(edge.container) : { x, y };
    if (!origin) throw new Error("Layout edge names an unknown coordinate container.");
    const label = edge.labels?.[0];
    const translate = (p: { x: number; y: number }) => ({ x: origin.x + p.x, y: origin.y + p.y });
    return {
      id: edge.id,
      sections: (edge.sections ?? []).map((section) => ({
        startPoint: translate(section.startPoint),
        endPoint: translate(section.endPoint),
        bendPoints: section.bendPoints?.map(translate),
      })),
      ...(label
        ? {
          labelBounds: {
            x: origin.x + (label.x ?? NaN),
            y: origin.y + (label.y ?? NaN),
            width: label.width ?? NaN,
            height: label.height ?? NaN,
          },
        }
        : {}),
    };
  });
  return { width: root.width ?? NaN, height: root.height ?? NaN, nodes, edges };
}
export function attachGeometry(input: SceneInput, geometry: LayoutGeometry): Result<Scene> {
  try {
    const count = input.nodes.length + input.groups.length;
    if (
      !geometry || !Array.isArray(geometry.nodes) || !Array.isArray(geometry.edges) ||
      geometry.nodes.length !== count || geometry.edges.length !== input.edges.length
    ) throw new Error("count");
    const expectedNodes = new Set([
      ...input.nodes.map((node) => nodeId(node.element.id)),
      ...input.groups.map((group) => groupId(group.id)),
    ]);
    const expectedEdges = new Set(input.edges.map((edge) => edgeId(edge.relationship.id)));
    for (const node of geometry.nodes) {
      if (!node || !expectedNodes.delete(node.id)) throw new Error("node identity");
    }
    let routePoints = 0;
    for (const edge of geometry.edges) {
      if (!edge || !expectedEdges.delete(edge.id) || !validSections(edge.sections, count)) {
        throw new Error("edge identity or routing budget");
      }
    }
    for (const edge of geometry.edges) {
      routePoints += edge.sections.reduce(
        (total: number, section: EdgeSection) => total + 2 + (section.bendPoints?.length ?? 0),
        0,
      );
      if (routePoints > 100_000) throw new Error("total routing budget");
    }
    const positions = new Map(geometry.nodes.map((node) => [node.id, node]));
    const nodes = input.nodes.map((node) => ({ ...node, ...positions.get(nodeId(node.element.id))! }));
    const groups = input.groups.map((group) => ({
      group,
      parentGroupId: group.parentGroupId,
      ...positions.get(groupId(group.id))!,
    }));
    const routes = new Map(geometry.edges.map((edge) => [edge.id, edge]));
    const edges: SceneEdge[] = input.edges.map((edge) => {
      const route = routes.get(edgeId(edge.relationship.id))!;
      const first = route.sections[0].startPoint;
      const last = route.sections.at(-1)!.endPoint;
      return {
        ...edge,
        source: nodes.find((n) => n.element.id === edge.relationship.sourceId)!,
        target: nodes.find((n) => n.element.id === edge.relationship.targetId)!,
        sections: route.sections,
        labelBounds: route.labelBounds,
        x1: first.x,
        y1: first.y,
        x2: last.x,
        y2: last.y,
        labelX: route.labelBounds
          ? route.labelBounds.x + route.labelBounds.width / 2
          : (first.x + last.x) / 2,
        labelY: route.labelBounds?.y ?? (first.y + last.y) / 2,
      };
    });
    return validateLayout(input, {
      ok: true,
      value: {
        architectureId: input.architectureId,
        revision: input.revision,
        diagram: input.diagram,
        kindLabel: input.kindLabel,
        statusText: input.statusText,
        nodes,
        groups,
        edges,
        width: geometry.width,
        height: geometry.height,
      },
      diagnostics: [],
    });
  } catch {
    return {
      ok: false,
      diagnostics: [{
        code: "layout",
        severity: "error",
        path: "$.layout",
        message: "Layout worker returned incomplete geometry.",
      }],
    };
  }
}
/** React Flow requires ancestors first and parent-relative positions, while the SDK stays absolute. */
export function relativeGeometry(scene: Scene) {
  const groups = new Map((scene.groups ?? []).map((group) => [group.group.id, group]));
  const position = (item: Bounds & { parentGroupId?: string }) => {
    const parent = item.parentGroupId ? groups.get(item.parentGroupId) : undefined;
    return { x: item.x - (parent?.x ?? 0), y: item.y - (parent?.y ?? 0) };
  };
  const ordered: NonNullable<Scene["groups"]>[number][] = [];
  const seen = new Set<string>();
  const add = (group: NonNullable<Scene["groups"]>[number]) => {
    if (seen.has(group.group.id)) return;
    if (group.parentGroupId) add(groups.get(group.parentGroupId)!);
    seen.add(group.group.id);
    ordered.push(group);
  };
  for (const group of groups.values()) add(group);
  return {
    groups: ordered.map((group) => ({
      id: groupId(group.group.id),
      parentId: group.parentGroupId ? groupId(group.parentGroupId) : undefined,
      position: position(group),
      group,
    })),
    nodes: scene.nodes.map((node) => ({
      id: nodeId(node.element.id),
      parentId: node.parentGroupId ? groupId(node.parentGroupId) : undefined,
      position: position(node),
      node,
    })),
  };
}

/** Bound the raw engine tree before traversing it or retaining any output in the cache. */
export function checkedElkOutput(input: SceneInput, raw: unknown): LayoutGeometry {
  const count = input.nodes.length + input.groups.length;
  const expectedNodes = new Set([
    ...input.nodes.map((node) => nodeId(node.element.id)),
    ...input.groups.map((group) => groupId(group.id)),
  ]);
  const expectedEdges = new Set(input.edges.map((edge) => edgeId(edge.relationship.id)));
  let routePoints = 0;
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const invalid = () => {
    throw new Error("Layout worker returned unexpected, duplicate or excessive geometry.");
  };
  const stack: { graph: unknown; depth: number; root: boolean }[] = [{ graph: raw, depth: 0, root: true }];
  while (stack.length) {
    const { graph, depth, root } = stack.pop()!;
    if (!graph || typeof graph !== "object" || depth > 33) invalid();
    const node = graph as ElkNode;
    if (!root) {
      if (!expectedNodes.has(node.id) || seenNodes.has(node.id)) invalid();
      seenNodes.add(node.id);
    }
    if (node.labels && (!Array.isArray(node.labels) || node.labels.length > 1)) invalid();
    if (node.children && (!Array.isArray(node.children) || node.children.length > count)) invalid();
    for (const child of node.children ?? []) stack.push({ graph: child, depth: depth + 1, root: false });
    if (stack.length + seenNodes.size > count + 1) invalid();
    if (node.edges && (!Array.isArray(node.edges) || node.edges.length > expectedEdges.size)) invalid();
    for (const edge of node.edges ?? []) {
      if (!expectedEdges.has(edge.id) || seenEdges.has(edge.id)) invalid();
      seenEdges.add(edge.id);
      if (edge.labels && (!Array.isArray(edge.labels) || edge.labels.length > 1)) invalid();
      if (!validSections(edge.sections, count)) invalid();
      routePoints += edge.sections!.reduce(
        (total: number, section: EdgeSection) => total + 2 + (section.bendPoints?.length ?? 0),
        0,
      );
      if (routePoints > 100_000) invalid();
    }
  }
  if (seenNodes.size !== expectedNodes.size || seenEdges.size !== expectedEdges.size) invalid();
  return elkOutput(raw as ElkNode);
}
function validSections(value: unknown, count: number): value is readonly EdgeSection[] {
  const max = Math.max(16, 2 * count + 8);
  const point = (value: unknown) =>
    !!value && typeof value === "object" && Number.isFinite((value as { x: number }).x) &&
    Number.isFinite((value as { y: number }).y);
  let points = 0;
  return Array.isArray(value) && value.length > 0 && value.length <= max &&
    value.every((section) =>
      section && (points += 2 + (section.bendPoints?.length ?? 0)) <= 100_000 && point(section.startPoint) &&
      point(section.endPoint) &&
      (section.bendPoints === undefined ||
        Array.isArray(section.bendPoints) && section.bendPoints.length <= max &&
          section.bendPoints.every(point))
    );
}
