import type { ElkNode } from "elkjs/lib/elk-api";
import type { SceneInput } from "../../domain/scene";
import { lookupMeasuredSize } from "../../domain/layout";
import type { LayoutMeasurements } from "../../ports/layout";
export const ENGINE = "elkjs@0.12.0/layered-v1";
export const nodeId = (id: string) => `node:${id}`;
export const groupId = (id: string) => `group:${id}`;
export const edgeId = (id: string) => `edge:${id}`;
const sorted = <T extends { id: string }>(items: T[]) =>
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Stable geometry-only input. The worker never receives model objects or callbacks. */
export function elkInput(input: SceneInput, measures?: LayoutMeasurements): ElkNode {
  const spacing = input.diagram.layout?.spacing ?? 64;
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.diagram.layout?.direction === "LR" ? "RIGHT" : "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(spacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing),
      "elk.spacing.edgeLabel": "16",
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      "elk.randomSeed": "1",
    },
    children: [],
    edges: [],
  };
  const groups = new Map(input.groups.map((group) => {
    const label = lookupMeasuredSize(measures?.groupLabelSizes ?? {}, group.id) ?? { width: 260, height: 52 };
    return [group.id, {
      id: groupId(group.id),
      children: [],
      width: label.width + 48,
      height: label.height + 64,
      layoutOptions: {
        "elk.padding": `[top=${label.height + 32},left=32,bottom=32,right=32]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${label.width + 64},${label.height + 64})`,
      },
      labels: [{
        text: group.label,
        ...label,
        layoutOptions: { "elk.nodeLabels.placement": "INSIDE H_LEFT V_TOP" },
      }],
    } as ElkNode] as const;
  }));
  for (const group of input.groups) {
    (group.parentGroupId ? groups.get(group.parentGroupId)! : root).children!.push(groups.get(group.id)!);
  }
  for (const node of input.nodes) {
    const member = input.diagram.nodes.find((item) => item.elementId === node.element.id)!;
    const size = lookupMeasuredSize(measures?.nodeSizes ?? {}, node.element.id) ?? member.size ??
      { width: 260, height: 220 };
    (node.parentGroupId ? groups.get(node.parentGroupId)! : root).children!.push({
      id: nodeId(node.element.id),
      ...size,
    });
  }
  for (const graph of [root, ...groups.values()]) graph.children = sorted(graph.children!);
  root.edges = sorted(input.edges.map((edge) => ({
    id: edgeId(edge.relationship.id),
    sources: [nodeId(edge.relationship.sourceId)],
    targets: [nodeId(edge.relationship.targetId)],
    labels: [{
      text: edge.relationship.label,
      ...(lookupMeasuredSize(measures?.edgeLabelSizes ?? {}, edge.relationship.id) ??
        { width: 240, height: 76 }),
    }],
  })));
  return root;
}
export function layoutCacheKey(input: SceneInput, measures?: LayoutMeasurements): string {
  return JSON.stringify([
    ENGINE,
    input.architectureId,
    input.revision,
    input.diagram.id,
    input.diagram.layout?.mode ?? "auto",
    measures?.revision ?? null,
    elkInput(input, measures),
    input.nodes.map(
      (n) => [
        n.element.id,
        n.element.name,
        n.element.description,
        n.kindLabel,
        n.statusText,
        n.stroke,
        n.tone,
      ],
    ).sort(),
    input.edges.map(
      (e) => [
        e.relationship.id,
        e.relationship.label,
        e.relationship.technology,
        e.relationship.status,
        e.number,
        e.stroke,
      ],
    ).sort(),
    input.groups.map((g) => [g.id, g.label, g.status, g.parentGroupId, [...g.memberIds].sort()]).sort(),
  ]);
}
