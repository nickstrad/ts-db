import type { Diagram, Element, Group, Id, Relationship } from "./model";
/** All geometry is absolute in the scene coordinate space, including nested children. */
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Bounds extends Point, Size {}
export interface EdgeSection {
  readonly startPoint: Point;
  readonly endPoint: Point;
  readonly bendPoints?: readonly Point[];
}
export interface SceneNode extends Bounds {
  readonly element: Element;
  readonly parentGroupId?: Id;
  readonly labelBounds?: Bounds;
  readonly tone: "accent" | "external" | "default";
  readonly stroke: "solid" | "dashed";
  readonly kindLabel: string;
  readonly statusText: string;
}
export interface SceneGroup extends Bounds {
  readonly group: Group;
  readonly parentGroupId?: Id;
  readonly labelBounds?: Bounds;
}
export interface SceneEdge {
  readonly relationship: Relationship;
  readonly source: SceneNode;
  readonly target: SceneNode;
  readonly number?: number;
  readonly stroke: "solid" | "dashed";
  // Legacy straight-edge anchors remain required for source compatibility.
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly labelX: number;
  readonly labelY: number;
  readonly sections?: readonly EdgeSection[];
  readonly labelBounds?: Bounds;
}
export interface Scene {
  readonly architectureId?: string;
  readonly revision?: string;
  readonly diagram: Diagram;
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly groups?: readonly SceneGroup[];
  readonly width: number;
  readonly height: number;
  readonly statusText: string;
  readonly kindLabel?: string;
}
