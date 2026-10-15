import { useMemo, useRef } from "react";
import type { SceneInput } from "../../domain/scene";
import type { Scene } from "../../domain/geometry";
import type { LayoutPort } from "../../ports/layout";
import type { useContext } from "./useContext";
import { createElkLayoutPort } from "../../adapters/layout/client";
import { useDiagramLayout } from "./useDiagramLayout";
import { useDiagramMeasurements } from "./useDiagramMeasurements";
import { frameBounds, initialViewport, sceneBounds } from "../../domain/viewport";
export function useDiagramRenderer(
  input: SceneInput,
  context: ReturnType<typeof useContext>,
  layoutPort?: LayoutPort,
) {
  const port = useMemo(() => layoutPort ?? createElkLayoutPort(), [layoutPort]);
  const measurement = useDiagramMeasurements(input);
  // Legacy custom ports need not implement measured requests. The built-in engine always does.
  const projected = useDiagramLayout(input, port, layoutPort ? undefined : measurement.measurements);
  return {
    projected,
    measurementRef: measurement.ref,
    canvasProps: projected.ok
      ? {
        markerId: context.markerId,
        overlays: context.dynamic?.overlays,
        scene: projected.value,
        onDiagramSelect: context.canvasActions.onDiagramSelect,
        nodes: projected.value.nodes.map((node) => ({
          ...node,
          ...context.canvasActions.nodeActions(node.element.id),
        })),
      }
      : undefined,
  };
}

/** Browser viewport effects stay outside the props-only node/edge/group views. */
export function useCanvasViewport(session: import("./useViewerSession").CanvasSession, scene: Scene) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const instance = useRef<
    import("@xyflow/react").ReactFlowInstance<
      import("../views/CanvasNode").FlowNode | import("../views/CanvasGroup").FlowGroup,
      import("../views/CanvasEdge").FlowEdge
    > | undefined
  >(undefined);
  const pointerDown = useRef(false);
  const revealFocused = (target: HTMLElement, canvas: HTMLElement) => {
    if (!instance.current) return;
    const id = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const node = scene.nodes.find((node) => node.element.id === id);
    if (!node) return;
    const viewport = instance.current.getViewport();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const left = viewport.x + node.x * viewport.zoom;
    const top = viewport.y + node.y * viewport.zoom;
    if (
      viewport.zoom < 0.75 || left < 0 || left + node.width * viewport.zoom > width || top < 0 ||
      top + node.height * viewport.zoom > height
    ) {
      void instance.current.setViewport(frameBounds(node, width, height, Math.max(viewport.zoom, 0.75)));
    }
  };
  return {
    canvasRef,
    onPointerDownCapture: () => {
      pointerDown.current = true;
    },
    onPointerUpCapture: () => {
      pointerDown.current = false;
    },
    onPointerCancel: () => {
      pointerDown.current = false;
    },
    // Capture before React Flow handles keyboard events on its descendants.
    onKeyDownCapture: () => {
      pointerDown.current = false;
    },
    onInit: (value: NonNullable<typeof instance.current>) => {
      instance.current = value;
      const canvas = canvasRef.current;
      void value.setViewport(
        session.getViewport() ??
          initialViewport(scene, canvas?.clientWidth ?? 300, canvas?.clientHeight ?? 520),
      ).then(() => {
        session.onReady();
        // Initial viewport application can finish after MutationObserver restored
        // focus. Reconcile the focused card after that application, too.
        const target = session.getFocusedElement();
        const canvas = target?.closest<HTMLElement>(".c4-flow-canvas");
        if (target && canvas) revealFocused(target, canvas);
      });
    },
    onFit: () => {
      const canvas = canvasRef.current;
      if (canvas) {
        void instance.current?.setViewport(
          frameBounds(sceneBounds(scene), canvas.clientWidth, canvas.clientHeight),
        );
      }
    },
    onActualSize: () => {
      void instance.current?.zoomTo(1);
    },
    onFocusCapture: (event: import("react").FocusEvent<HTMLDivElement>) => {
      // A mouse/touch focus must not move its target between pointerdown and click.
      if (pointerDown.current || !instance.current) return;
      revealFocused(event.target as HTMLElement, event.currentTarget);
    },
    onKeyDown: (event: import("react").KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || !instance.current) return;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [80, 0],
        ArrowRight: [-80, 0],
        ArrowUp: [0, 80],
        ArrowDown: [0, -80],
      };
      const move = delta[event.key];
      if (!move) return;
      event.preventDefault();
      const viewport = instance.current.getViewport();
      void instance.current.setViewport({ ...viewport, x: viewport.x + move[0], y: viewport.y + move[1] });
    },
  };
}
