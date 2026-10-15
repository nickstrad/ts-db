import type { Result } from "../domain/model";
import type { SceneInput } from "../domain/scene";
import type { Scene, Size } from "../domain/geometry";
export interface LayoutMeasurements {
  readonly revision: string;
  readonly nodeSizes: Readonly<Partial<Record<string, Size>>>;
  readonly edgeLabelSizes: Readonly<Partial<Record<string, Size>>>;
  readonly groupLabelSizes?: Readonly<Partial<Record<string, Size>>>;
}
export interface LayoutRequest {
  readonly scene: SceneInput;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly measurements?: LayoutMeasurements;
  readonly timeoutMs?: number;
}
export interface LayoutResponse {
  readonly generation: number;
  readonly result: Result<Scene>;
  readonly measurementRevision?: string;
}
/** Return absolute finite geometry or diagnostics. Never publish aborted/stale generations. */
export interface LayoutPort {
  readonly layout: (request: LayoutRequest) => Promise<LayoutResponse>;
}
