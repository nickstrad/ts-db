// Compatibility entry; domain projection, documents and geometry have separate owners.
import type { Diagnostic, ModelIndex, Result } from "./model";
import type { Scene } from "./scene";
import { buildScene } from "./scene";
import { fixedLayout } from "./layout";
export { resolveLegend, selectDocumentation } from "./documentation";
export { statusLabel } from "./scene";
export type { Scene, SceneEdge, SceneNode } from "./scene";
export type { DocumentSelection } from "./documentation";
export function projectDiagram(index: ModelIndex, diagramId: string): Result<Scene> {
  const input = buildScene(index, diagramId);
  return input.ok ? fixedLayout(input.value) : input;
}
export function loadingFailure(message: string): readonly Diagnostic[] {
  return [{ code: "load", path: "$", severity: "error", message }];
}

export function resourceStatus(
  pending: boolean,
  architecture: { readonly bundle: { readonly title: string; readonly revision: string } } | undefined,
  diagnostics: readonly Diagnostic[],
): string {
  if (pending) return "Loading architecture…";
  if (architecture && diagnostics.some((item) => item.severity === "error")) {
    return "Resource rejected. The last valid architecture remains visible.";
  }
  return architecture
    ? `${architecture.bundle.title} · Revision ${architecture.bundle.revision}`
    : "No valid architecture loaded.";
}
