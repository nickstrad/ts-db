import type { Result } from "./model";
import type { SceneInput } from "./scene";
import type { Bounds, Point, Scene, SceneEdge, SceneNode } from "./geometry";
export function fixedLayout(input: SceneInput): Result<Scene> {
  const { diagram } = input;
  const failure = (path: string, message: string): Result<Scene> => ({
    ok: false,
    diagnostics: [{ code: "projection", severity: "error", path, message }],
  });
  if (input.groups.length) {
    return {
      ok: false,
      diagnostics: [{
        code: "unsupported-groups",
        path: "$.groups",
        severity: "error",
        message:
          "Fixed layout cannot render groups. Use a compound layout/canvas adapter after C4-04; groups will not be discarded.",
      }],
    };
  }
  const nodes: SceneNode[] = [];
  const columnWidth = Math.max(220, ...diagram.nodes.map((member) => member.size?.width ?? 220));
  const rowHeight = Math.max(166, ...diagram.nodes.map((member) => member.size?.height ?? 166));
  for (const [i, member] of diagram.nodes.entries()) {
    const element = input.nodes[i].element;
    if (!element) return failure(`$.nodes[${i}]`, "Cannot project an unknown element.");
    const horizontal = diagram.layout?.direction === "LR";
    const spacing = diagram.layout?.spacing ?? 100;
    const x = member.position?.x ?? (horizontal ? i % 3 * (columnWidth + spacing) + 40 : 280);
    const y = member.position?.y ??
      (horizontal ? Math.floor(i / 3) * (rowHeight + spacing + 80) + 130 : i * (rowHeight + spacing) + 100);
    nodes.push({
      element,
      x,
      y,
      width: member.size?.width ?? 220,
      height: member.size?.height ?? 166,
      tone: input.nodes[i].tone,
      stroke: input.nodes[i].stroke,
      statusText: input.nodes[i].statusText,
      kindLabel: input.nodes[i].kindLabel,
    });
  }
  const shiftX = diagram.layout?.mode === "manual"
    ? 0
    : Math.max(0, 40 - Math.min(...nodes.map((node) => node.x)));
  const shiftY = diagram.layout?.mode === "manual"
    ? 0
    : Math.max(0, 100 - Math.min(...nodes.map((node) => node.y)));
  nodes.forEach((node, i) => {
    nodes[i] = { ...node, x: node.x + shiftX, y: node.y + shiftY };
  });
  if (nodes.some((node) => !Number.isFinite(node.x + node.width) || !Number.isFinite(node.y + node.height))) {
    return failure(
      "$.nodes",
      "Positions exceed the finite canvas geometry range. Reduce the distance between members.",
    );
  }
  const tinyNode = nodes.findIndex((node) => node.width / 2 === 0 || node.height / 2 === 0);
  if (tinyNode !== -1) {
    return failure(
      `$.nodes[${tinyNode}].size`,
      "Size is too small to represent canvas geometry. Increase the member width and height.",
    );
  }
  const edges: SceneEdge[] = [];
  for (const i of diagram.edges.keys()) {
    const relationship = input.edges[i].relationship;
    const source = nodes.find((node) => node.element.id === relationship?.sourceId);
    const target = nodes.find((node) => node.element.id === relationship?.targetId);
    if (!relationship || !source || !target) {
      return failure(`$.edges[${i}]`, "Cannot project a relationship with absent endpoints.");
    }
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height / 2;
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height / 2;
    const dx = tx - sx;
    const dy = ty - sy;
    const sourceRatio = Math.max(Math.abs(dx) / (source.width / 2), Math.abs(dy) / (source.height / 2), 1);
    const targetRatio = Math.max(Math.abs(dx) / (target.width / 2), Math.abs(dy) / (target.height / 2), 1);
    const horizontalGap = Math.max(source.x, target.x) -
      Math.min(source.x + source.width, target.x + target.width);
    edges.push({
      relationship,
      source,
      target,
      number: input.edges[i].number,
      stroke: input.edges[i].stroke,
      x1: sx + dx / sourceRatio,
      y1: sy + dy / sourceRatio,
      x2: tx - dx / targetRatio,
      y2: ty - dy / targetRatio,
      labelX: sx / 2 + tx / 2,
      labelY: Math.abs(dx) >= Math.abs(dy)
        ? horizontalGap >= 310 ? sy / 2 + ty / 2 - 60 : Math.min(source.y, target.y) - 72
        : sy / 2 + ty / 2 - 20,
    });
  }
  const width = Math.max(960, ...nodes.map((node) => node.x + node.width + 40));
  const height = Math.max(350, ...nodes.map((node) => node.y + node.height + 40));
  const geometry = [
    width,
    height,
    ...nodes.flatMap((node) => [node.x, node.y, node.width, node.height]),
    ...edges.flatMap((edge) => [edge.x1, edge.y1, edge.x2, edge.y2, edge.labelX, edge.labelY]),
  ];
  if (!geometry.every(Number.isFinite)) {
    return failure(
      "$.layout",
      "Canvas geometry is not finite. Reduce the distance between members or increase very small member sizes.",
    );
  }
  return {
    ok: true,
    value: {
      architectureId: input.architectureId,
      revision: input.revision,
      diagram,
      kindLabel: input.kindLabel,
      groups: [],
      nodes,
      edges,
      width,
      height,
      statusText: input.statusText,
    },
    diagnostics: [],
  };
}

export interface GeometryLimits {
  readonly maxCoordinate?: number;
  readonly maxExtent?: number;
}
export const defaultGeometryLimits = { maxCoordinate: 10_000_000, maxExtent: 10_000_000 } as const;
/** A layout adapter changes geometry only; it cannot alter validated data or ancestry. */
export function validateLayout(
  input: SceneInput,
  result: Result<Scene>,
  limits: GeometryLimits = {},
): Result<Scene> {
  if (!result.ok) return result;
  const scene = result.value;
  const maximum = { ...defaultGeometryLimits, ...limits };
  for (const key of Object.keys(maximum) as (keyof GeometryLimits)[]) {
    if (!Number.isFinite(maximum[key]) || maximum[key] <= 0 || maximum[key] > defaultGeometryLimits[key]) {
      return {
        ok: false,
        diagnostics: [{
          code: "layout",
          path: "$.layout.limits",
          severity: "error",
          message: `${key} must be positive and no greater than ${defaultGeometryLimits[key]}.`,
        }],
      };
    }
  }
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  const point = (value: Point) =>
    Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) <= maximum.maxCoordinate &&
    Math.abs(value.y) <= maximum.maxCoordinate;
  const bounds = (value: Bounds) =>
    point(value) && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 &&
    value.height > 0 && value.width <= maximum.maxExtent && value.height <= maximum.maxExtent &&
    Number.isFinite(value.x + value.width) && Number.isFinite(value.y + value.height) &&
    Math.abs(value.x + value.width) <= maximum.maxCoordinate &&
    Math.abs(value.y + value.height) <= maximum.maxCoordinate;
  const nodes =
    same(input.nodes.map((node) => node.element.id), scene.nodes.map((node) => node.element.id)) &&
    scene.nodes.every((node, i) =>
      node.element === input.nodes[i]?.element && node.kindLabel === input.nodes[i]?.kindLabel &&
      node.tone === input.nodes[i]?.tone && node.stroke === input.nodes[i]?.stroke &&
      node.statusText === input.nodes[i]?.statusText &&
      node.parentGroupId === input.nodes[i]?.parentGroupId && bounds(node) &&
      (!node.labelBounds || bounds(node.labelBounds))
    );
  const groups = scene.groups ?? [];
  const groupIdentity = same(input.groups.map((group) => group.id), groups.map((group) => group.group.id)) &&
    groups.every((group, i) =>
      group.group === input.groups[i] && group.parentGroupId === input.groups[i]?.parentGroupId &&
      bounds(group) && (!group.labelBounds || bounds(group.labelBounds))
    );
  const contains = (outer: Bounds, inner: Bounds) =>
    inner.x >= outer.x - 0.001 && inner.y >= outer.y - 0.001 &&
    inner.x + inner.width <= outer.x + outer.width + 0.001 &&
    inner.y + inner.height <= outer.y + outer.height + 0.001;
  const containment = [...scene.nodes, ...groups].every((item) => {
    const parent = item.parentGroupId
      ? groups.find((group) => group.group.id === item.parentGroupId)
      : undefined;
    return !item.parentGroupId || !!parent && contains(parent, item);
  }) && groups.every((group) => !group.labelBounds || contains(group, group.labelBounds));
  let routePoints = 0;
  const maxSections = Math.max(16, 2 * (scene.nodes.length + groups.length) + 8);
  const edges =
    same(input.edges.map((edge) => edge.relationship.id), scene.edges.map((edge) => edge.relationship.id)) &&
    scene.edges.every((edge, i) => {
      const relationship = input.edges[i]?.relationship;
      const endpoints = edge.relationship === relationship && edge.source === scene.nodes.find((node) =>
            node.element.id === relationship?.sourceId
          ) &&
        edge.target === scene.nodes.find((node) => node.element.id === relationship?.targetId);
      const scalars = [edge.x1, edge.y1, edge.x2, edge.y2, edge.labelX, edge.labelY].every((value) =>
        Number.isFinite(value) && Math.abs(value) <= maximum.maxCoordinate
      );
      const sections = !edge.sections ||
        edge.sections.length > 0 && edge.sections.length <= maxSections && edge.sections.every((section) =>
            (routePoints += 2 + (section.bendPoints?.length ?? 0)) <= 100_000 &&
            (section.bendPoints?.length ?? 0) <= maxSections && point(section.startPoint) &&
            point(section.endPoint) && (section.bendPoints ?? []).every(point)
          ) &&
          edge.sections[0].startPoint.x === edge.x1 && edge.sections[0].startPoint.y === edge.y1 &&
          edge.sections.at(-1)!.endPoint.x === edge.x2 && edge.sections.at(-1)!.endPoint.y === edge.y2;
      return edge.number === input.edges[i]?.number && edge.stroke === input.edges[i]?.stroke && endpoints &&
        scalars && sections && (!edge.labelBounds || bounds(edge.labelBounds));
    });
  if (
    scene.diagram !== input.diagram || scene.statusText !== input.statusText ||
    (scene.kindLabel !== undefined && scene.kindLabel !== input.kindLabel) || !nodes || !groupIdentity ||
    !containment || !edges || !Number.isFinite(scene.width) || !Number.isFinite(scene.height) ||
    scene.width <= 0 || scene.height <= 0 || scene.width > maximum.maxExtent ||
    scene.height > maximum.maxExtent
  ) {
    return {
      ok: false,
      diagnostics: [{
        code: "layout",
        path: "$.layout",
        severity: "error",
        message:
          "Layout must preserve validated data, member/edge/group order, endpoints and ancestry with finite positive bounds and routed points within coordinate/extent limits.",
      }],
    };
  }
  return result;
}

/** ID dictionaries can be ordinary objects; valid IDs never resolve inherited keys. */
export function lookupMeasuredSize(
  values: Readonly<Partial<Record<string, import("./geometry").Size>>>,
  id: string,
): import("./geometry").Size | undefined {
  if (!Object.hasOwn(values, id)) return undefined;
  const size = values[id];
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 &&
      size.height > 0
    ? size
    : undefined;
}

/** Manual positions remain authored; boundaries are derived around their descendants. */
export function manualLayout(
  input: SceneInput,
  measures?: {
    readonly nodeSizes: Readonly<Partial<Record<string, import("./geometry").Size>>>;
    readonly edgeLabelSizes?: Readonly<Partial<Record<string, import("./geometry").Size>>>;
    readonly groupLabelSizes?: Readonly<Partial<Record<string, import("./geometry").Size>>>;
  },
): Result<Scene> {
  const diagram = {
    ...input.diagram,
    nodes: input.diagram.nodes.map((member) => ({
      ...member,
      size: lookupMeasuredSize(measures?.nodeSizes ?? {}, member.elementId) ?? member.size,
    })),
  };
  const placed = fixedLayout({ ...input, diagram, groups: [] });
  if (!placed.ok) return placed;
  const nodes = placed.value.nodes.map((node, i) => ({
    ...node,
    parentGroupId: input.nodes[i].parentGroupId,
  }));
  const byId = new Map<string, import("./geometry").SceneGroup>();
  const place = (id: string): import("./geometry").SceneGroup => {
    const saved = byId.get(id);
    if (saved) return saved;
    const group = input.groups.find((g) => g.id === id)!;
    const children: Bounds[] = [
      ...nodes.filter((node) => node.parentGroupId === id),
      ...input.groups.filter((child) => child.parentGroupId === id).map((child) => place(child.id)),
    ];
    const label = lookupMeasuredSize(measures?.groupLabelSizes ?? {}, id) ?? { width: 260, height: 52 };
    const x =
      (children.length
        ? Math.min(...children.map((child) => child.x))
        : input.groups.indexOf(group) * 400 + 40) - 32;
    const y = (children.length ? Math.min(...children.map((child) => child.y)) : 100) - label.height - 32;
    const width = Math.max(x + label.width + 64, ...children.map((child) => child.x + child.width + 32)) - x;
    const height = Math.max(y + label.height + 96, ...children.map((child) => child.y + child.height + 32)) -
      y;
    const result = {
      group,
      parentGroupId: group.parentGroupId,
      x,
      y,
      width,
      height,
      labelBounds: { x: x + 16, y: y + 16, ...label },
    };
    byId.set(id, result);
    return result;
  };
  const groups = input.groups.map((group) => place(group.id));
  const occupied: Bounds[] = [...nodes, ...groups.map((group) => group.labelBounds!)];
  const edges = placed.value.edges.map((edge) => {
    const size = lookupMeasuredSize(measures?.edgeLabelSizes ?? {}, edge.relationship.id) ??
      { width: 240, height: 76 };
    const labelBounds = {
      x: edge.labelX - size.width / 2,
      y: Math.min(edge.source.y, edge.target.y) - size.height - 16,
      ...size,
    };
    // Keep authored nodes fixed. Lift labels above any node, boundary title or
    // earlier label they intersect; each step passes at least one obstacle.
    let collisions = occupied.filter((box) => overlaps(labelBounds, box));
    while (collisions.length) {
      labelBounds.y = Math.min(...collisions.map((box) => box.y)) - size.height - 16;
      collisions = occupied.filter((box) => overlaps(labelBounds, box));
    }
    occupied.push(labelBounds);
    return {
      ...edge,
      labelBounds,
      labelY: labelBounds.y,
      source: nodes.find((node) => node.element.id === edge.relationship.sourceId)!,
      target: nodes.find((node) => node.element.id === edge.relationship.targetId)!,
    };
  });
  return validateLayout(input, {
    ok: true,
    diagnostics: [],
    value: {
      ...placed.value,
      diagram: input.diagram,
      nodes,
      groups,
      edges,
      width: Math.max(placed.value.width, ...groups.map((group) => group.x + group.width + 40)),
      height: Math.max(placed.value.height, ...groups.map((group) => group.y + group.height + 40)),
    },
  });
}
function overlaps(a: Bounds, b: Bounds) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
