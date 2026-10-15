import type { Node, NodeProps } from "@xyflow/react";
import type { SceneGroup } from "../../domain/geometry";
export type FlowGroup = Node<{ group: SceneGroup }, "c4Group">;
export function CanvasGroup({ data }: NodeProps<FlowGroup>) {
  const group = data.group;
  const label = group.labelBounds;
  return (
    <div
      className={`c4-flow-group c4-stroke-${group.group.status === "existing" ? "solid" : "dashed"}`}
      data-group-id={group.group.id}
    >
      <div
        className="c4-group-label"
        style={{
          left: label ? label.x - group.x : 16,
          top: label ? label.y - group.y : 16,
          width: label?.width,
          height: label?.height,
        }}
      >
        <strong>{group.group.label}</strong>
        <small>
          {group.group.status === "mixed" ? "Existing + planned changes" : group.group.status} boundary
        </small>
      </div>
    </div>
  );
}
