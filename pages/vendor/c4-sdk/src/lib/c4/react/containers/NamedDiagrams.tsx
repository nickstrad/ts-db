import { ArchitectureViewer } from "./ArchitectureViewer";
import type { NamedDiagramProps } from "./ArchitectureViewer";
// Every named wrapper shares the one viewer pipeline; only the checked routed kind differs.
export function SystemLandscape(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="landscape" />;
}
export function SystemContext(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="context" />;
}
export function ContainerDiagram(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="container" />;
}
export function ComponentDiagram(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="component" />;
}
export function CodeDiagram(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="code" />;
}
export function DynamicDiagram(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="dynamic" />;
}
export function DeploymentDiagram(props: NamedDiagramProps) {
  return <ArchitectureViewer {...props} expectedKind="deployment" />;
}
