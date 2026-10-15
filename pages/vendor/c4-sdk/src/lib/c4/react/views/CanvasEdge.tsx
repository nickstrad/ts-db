import type { Edge, EdgeProps } from "@xyflow/react";
import type { SceneEdge } from "../../domain/geometry";
export type FlowEdge = Edge<
  {
    edge: SceneEdge;
    markerId: string;
    overlays?: readonly import("../../domain/scenario").InteractionOverlay[];
  },
  "c4Edge"
>;
export function EdgeLabel({ edge }: { edge: SceneEdge }) {
  return (
    <div className="c4-edge-label">
      {edge.number ? `${edge.number}. ` : ""}
      {edge.relationship.label}
      <small>
        {edge.relationship.kind !== "dependency" ? `${edge.relationship.kind} · ` : ""}
        {edge.relationship.technology}
        {edge.relationship.technology ? " · " : ""}
        {edge.relationship.status}
      </small>
    </div>
  );
}
export function CanvasEdge({ data }: EdgeProps<FlowEdge>) {
  if (!data) return null;
  const { edge, markerId, overlays } = data;
  const sections = edge.sections ??
    [{ startPoint: { x: edge.x1, y: edge.y1 }, endPoint: { x: edge.x2, y: edge.y2 } }];
  const path = sections.map((section) =>
    [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p, i) =>
      `${i ? "L" : "M"} ${p.x} ${p.y}`
    ).join(" ")
  ).join(" ");
  const label = edge.labelBounds ?? { x: edge.labelX - 120, y: edge.labelY, width: 240, height: 76 };
  return (
    <g aria-hidden="true" data-relationship-id={edge.relationship.id}>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray={edge.stroke === "dashed" ? "7 5" : undefined}
        markerEnd={overlays?.length ? undefined : `url(#${markerId})`}
      />
      <foreignObject {...label}>
        <EdgeLabel edge={edge} />
      </foreignObject>
      {overlays?.map((interaction, i) => (
        <g
          key={interaction.id}
          className="c4-interaction-overlay"
          data-overlay-id={interaction.id}
          data-direction={interaction.direction}
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            markerEnd={interaction.direction === "forward" ? `url(#${markerId})` : undefined}
            markerStart={interaction.direction === "reverse" ? `url(#${markerId})` : undefined}
          />
          <text x={label.x} y={label.y - 10 - i * 20}>
            {interaction.number} · {interaction.direction === "reverse" ? "←" : "→"}
          </text>
        </g>
      ))}
    </g>
  );
}
