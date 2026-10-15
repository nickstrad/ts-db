import type { Bounds, Scene } from "./geometry";
export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}
/** Logical canvas dimensions, independent of browser CSS zoom and native focus scrolling. */
export function frameBounds(bounds: Bounds, width: number, height: number, maxZoom = 1): CanvasViewport {
  const zoom = Math.max(
    0.02,
    Math.min(
      maxZoom,
      Math.max(1, width - 32) / Math.max(1, bounds.width),
      Math.max(1, height - 32) / Math.max(1, bounds.height),
    ),
  );
  return {
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}
/** Fit includes routed edges and labels, which can extend beyond node bounds. */
export function sceneBounds(scene: Scene): Bounds {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (bounds: Bounds) => {
    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  };
  for (const node of scene.nodes) include(node);
  for (const group of scene.groups ?? []) {
    include(group);
    if (group.labelBounds) include(group.labelBounds);
  }
  for (const edge of scene.edges) {
    include(edge.labelBounds ?? { x: edge.labelX - 120, y: edge.labelY, width: 240, height: 76 });
    include({ x: edge.x1, y: edge.y1, width: 0, height: 0 });
    include({ x: edge.x2, y: edge.y2, width: 0, height: 0 });
    for (const section of edge.sections ?? []) {
      include({ ...section.startPoint, width: 0, height: 0 });
      include({ ...section.endPoint, width: 0, height: 0 });
      for (const point of section.bendPoints ?? []) include({ ...point, width: 0, height: 0 });
    }
  }
  return x === Infinity
    ? { x: 0, y: 0, width: scene.width, height: scene.height }
    : { x, y, width: right - x, height: bottom - y };
}
export function initialViewport(scene: Scene, width: number, height: number): CanvasViewport {
  const fit = frameBounds(sceneBounds(scene), width, height);
  // Keep a readable entry point for wide diagrams; Fit and the complete text list remain available.
  return fit.zoom >= 0.75 || !scene.nodes.length ? fit : frameBounds(scene.nodes[0], width, height);
}
