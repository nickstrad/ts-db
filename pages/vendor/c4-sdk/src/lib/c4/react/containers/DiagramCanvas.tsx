import { Background, ControlButton, Controls, ReactFlow } from "@xyflow/react";
import { useCanvasViewport } from "../hooks/useDiagramRenderer";
import type { DiagramCanvasProps } from "../contracts/views";
import type { SceneInput } from "../../domain/scene";
import type { RefObject } from "react";
import type { CanvasSession } from "../hooks/useViewerSession";
import { relativeGeometry } from "../../adapters/layout/elk-output";
import { nodeId } from "../../adapters/layout/elk-input";
import { CodeMembers } from "../views/CodeMembers";
import { CanvasNode } from "../views/CanvasNode";
import type { FlowNode } from "../views/CanvasNode";
import { CanvasGroup } from "../views/CanvasGroup";
import type { FlowGroup } from "../views/CanvasGroup";
import { CanvasEdge } from "../views/CanvasEdge";
import type { FlowEdge } from "../views/CanvasEdge";
import "@xyflow/react/dist/style.css";
import "../../styles/canvas.css";
const nodeTypes = { c4Node: CanvasNode, c4Group: CanvasGroup };
const edgeTypes = { c4Edge: CanvasEdge };
export function DiagramCanvas(
  { markerId, scene, nodes, onDiagramSelect, session, overlays }: DiagramCanvasProps & {
    session: CanvasSession;
  },
) {
  const geometry = relativeGeometry(scene);
  const flowNodes: (FlowNode | FlowGroup)[] = [
    ...geometry.groups.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      position: item.position,
      type: "c4Group" as const,
      data: { group: item.group },
      width: item.group.width,
      height: item.group.height,
      style: { width: item.group.width, height: item.group.height },
      selectable: false,
      focusable: false,
      zIndex: -1,
    })),
    ...geometry.nodes.map((item, i) => ({
      id: item.id,
      parentId: item.parentId,
      position: item.position,
      type: "c4Node" as const,
      data: { node: nodes[i] },
      width: item.node.width,
      height: item.node.height,
      style: { width: item.node.width, height: item.node.height },
      focusable: false,
    })),
  ];
  const edges: FlowEdge[] = scene.edges.map((edge) => ({
    id: `edge:${edge.relationship.id}`,
    source: nodeId(edge.relationship.sourceId),
    target: nodeId(edge.relationship.targetId),
    type: "c4Edge",
    data: {
      edge,
      markerId,
      overlays: overlays?.filter((item) => item.relationshipId === edge.relationship.id),
    },
    focusable: false,
    selectable: false,
    zIndex: 1,
  }));
  const { canvasRef, ...viewport } = useCanvasViewport(session, scene);
  return (
    <div
      ref={canvasRef}
      className="c4-flow-canvas c4-canvas-scroll"
      role="region"
      aria-label={`${
        scene.diagram.kind.charAt(0).toUpperCase() + scene.diagram.kind.slice(1)
      } diagram canvas`}
      data-layout-ready="true"
      tabIndex={0}
      onFocusCapture={viewport.onFocusCapture}
      onPointerDownCapture={viewport.onPointerDownCapture}
      onPointerUpCapture={viewport.onPointerUpCapture}
      onPointerCancel={viewport.onPointerCancel}
      onKeyDownCapture={viewport.onKeyDownCapture}
      onKeyDown={viewport.onKeyDown}
    >
      <ReactFlow<FlowNode | FlowGroup, FlowEdge>
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        panOnScroll
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        minZoom={0.02}
        maxZoom={2}
        onInit={viewport.onInit}
        onMoveEnd={(_, viewport) => session.onViewport(viewport)}
        onPaneClick={onDiagramSelect}
        proOptions={{ hideAttribution: true }}
      >
        <svg className="c4-marker-defs" aria-hidden="true">
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
        </svg>
        <Controls showInteractive={false} showFitView={false}>
          <ControlButton onClick={viewport.onFit} aria-label="Fit View">Fit</ControlButton>
          <ControlButton onClick={viewport.onActualSize} aria-label="Actual size">1:1</ControlButton>
        </Controls>
        <Background />
      </ReactFlow>
    </div>
  );
}
/** Props-only natural-size replicas. No canvas dimensions or transforms enter measurement. */
export function MeasurementRack(
  { input, measurementRef }: { input: SceneInput; measurementRef: RefObject<HTMLDivElement | null> },
) {
  return (
    <div ref={measurementRef} className="c4-measurements" aria-hidden="true">
      {input.nodes.map((node) => {
        const detail = input.diagram.nodes.find((member) => member.elementId === node.element.id)?.detail;
        return (
          <div
            key={node.element.id}
            data-measure-kind="node"
            data-measure-id={node.element.id}
            className="c4-measure-node"
            style={{
              width: input.diagram.nodes.find((member) =>
                member.elementId === node.element.id
              )?.size?.width ?? 260,
            }}
          >
            <div className="c4-node-probe">
              <span className="c4-node-kind">{node.kindLabel}</span>
              <strong>{node.element.name}</strong>
              <span>{node.element.description}</span>
              <small>{node.statusText}{detail ? " · Open detail →" : ""}</small>
              <CodeMembers element={node.element} />
            </div>
            {detail && <div className="c4-measure-inspect">Inspect</div>}
          </div>
        );
      })}
      {input.edges.map((edge) => (
        <div
          key={edge.relationship.id}
          data-measure-kind="edge"
          data-measure-id={edge.relationship.id}
          className="c4-edge-label"
        >
          {edge.number ? `${edge.number}. ` : ""}
          {edge.relationship.label}
          <small>
            {edge.relationship.kind !== "dependency" ? `${edge.relationship.kind} · ` : ""}
            {edge.relationship.technology}
            {edge.relationship.technology ? " · " : ""}
            {edge.relationship.status}
          </small>
        </div>
      ))}
      {input.groups.map((group) => (
        <div key={group.id} data-measure-kind="group" data-measure-id={group.id} className="c4-group-label">
          <strong>{group.label}</strong>
          <small>{group.status === "mixed" ? "Existing + planned changes" : group.status} boundary</small>
        </div>
      ))}
    </div>
  );
}
