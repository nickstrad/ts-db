// deno-lint-ignore-file jsx-button-has-type
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { DiagramCanvasProps } from "../contracts/views";
import { CodeMembers } from "./CodeMembers";
export type CanvasNodeData = DiagramCanvasProps["nodes"][number];
export type FlowNode = Node<{ node: CanvasNodeData }, "c4Node">;
export function NodeContent({ node }: { node: CanvasNodeData }) {
  return (
    <>
      <span className="c4-node-kind">{node.kindLabel}</span>
      <strong>{node.element.name}</strong>
      <span>{node.element.description}</span>
      <small>{node.statusText}{node.detail ? " · Open detail →" : ""}</small>
    </>
  );
}
export function CanvasNode({ data }: NodeProps<FlowNode>) {
  const node = data.node;
  return (
    <div
      className={`c4-flow-node nodrag nopan${node.element.kind === "code" ? " c4-code-node" : ""}`}
      data-node-id={node.element.id}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {node.detail
        ? (
          <a
            {...node.detail}
            data-element-id={node.element.id}
            className={`c4-node c4-tone-${node.tone} c4-stroke-${node.stroke}`}
            data-selected={node.selected}
            aria-label={`Open detail for ${node.element.name}`}
          >
            <NodeContent node={node} />
          </a>
        )
        : (
          <button
            data-element-id={node.element.id}
            className={`c4-node c4-tone-${node.tone} c4-stroke-${node.stroke}`}
            onClick={node.onSelect}
            aria-pressed={node.selected}
            aria-label={`Inspect ${node.element.name}`}
          >
            <NodeContent node={node} />
          </button>
        )}
      <CodeMembers element={node.element} />
      {node.detail && (
        <button className="c4-inspect" onClick={node.onInspect} aria-label={`Inspect ${node.element.name}`}>
          Inspect
        </button>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
