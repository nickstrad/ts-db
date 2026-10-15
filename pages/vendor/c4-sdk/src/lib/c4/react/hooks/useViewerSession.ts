import { useCallback, useEffect, useRef } from "react";
import type { FocusEvent } from "react";
import type { Viewport } from "@xyflow/react";
import type { Route } from "../../domain/navigation";
interface Session {
  focus: Map<string, string>;
  viewport: Map<string, Viewport>;
  previous?: string;
  requested?: string;
}
// A persistent host DOM node outlives CatalogViewer's keyed dataset child. Weak keys release
// its memory on host removal and isolate two catalogs even when they share the same route port.
const MAX_SAVED_VIEWS = 256;
function remember<T>(memory: Map<string, T>, key: string, value: T) {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > MAX_SAVED_VIEWS) memory.delete(memory.keys().next().value!);
}
const hosts = new WeakMap<HTMLElement, Map<number, Session>>();
export interface CanvasSession {
  readonly getFocusedElement: () => HTMLElement | undefined;
  readonly getViewport: () => Viewport | undefined;
  readonly onViewport: (viewport: Viewport) => void;
  readonly onReady: () => void;
}
export function useViewerSession(route: Route, revision: string) {
  const root = useRef<HTMLDivElement>(null);
  const viewKey = JSON.stringify([route.architectureId, revision, route.diagramId]);
  const key = JSON.stringify([viewKey, route.elementId ?? ""]);
  const initialRoute = useRef(key);
  const session = useCallback(() => {
    const parent = root.current?.parentElement;
    const host = parent?.classList.contains("c4-shell") ? parent : root.current;
    if (!host) return undefined;
    const slot = host === root.current
      ? 0
      : [...host.children].filter((child) => child.hasAttribute("data-c4-viewer-host")).indexOf(
        root.current!,
      );
    let slots = hosts.get(host);
    if (!slots) {
      slots = new Map();
      hosts.set(host, slots);
    }
    let value = slots.get(slot);
    if (!value) {
      value = { focus: new Map(), viewport: new Map() };
      slots.set(slot, value);
    }
    return value;
  }, []);
  const restore = useCallback(() => {
    const memory = session();
    if (!memory) return;
    // Arrival and completed restoration differ: a user can go Back before the
    // intervening asynchronous diagram ever becomes ready. Revisit must restore
    // focus even when its key equals the last successfully restored route.
    if (memory.requested !== key) {
      memory.requested = key;
      if (memory.previous === key) memory.previous = "pending-return";
    }
    if (memory.previous === key) return;
    // Wait for the asynchronous canvas; the temporary text list must not consume restoration.
    if (!root.current?.querySelector("[data-layout-ready]")) return;
    const id = route.elementId ?? memory.focus.get(viewKey);
    const selected = [...root.current.querySelectorAll<HTMLElement>("[data-element-id]")].find((node) =>
      node.dataset.elementId === id && (!node.closest("details") || node.closest("details")!.open)
    );
    if (
      id && (!selected || selected.closest<HTMLElement>(".react-flow__node")?.style.visibility === "hidden")
    ) return;
    if (memory.previous || id || initialRoute.current !== key) {
      (selected ?? root.current.querySelector<HTMLElement>("[data-diagram-heading]"))?.focus({
        preventScroll: true,
      });
    }
    memory.previous = key;
  }, [key, route.elementId, session, viewKey]);
  useEffect(() => {
    restore();
    if (!root.current) return;
    const observer = new MutationObserver(restore);
    observer.observe(root.current, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-layout-ready", "style"],
    });
    return () => observer.disconnect();
  }, [restore]);
  return {
    rootProps: {
      ref: root,
      "data-c4-viewer-host": true,
      onFocusCapture: (event: FocusEvent<HTMLDivElement>) => {
        const id = (event.target as HTMLElement).dataset.elementId;
        const memory = session();
        if (id && memory) remember(memory.focus, viewKey, id);
      },
    },
    canvasSession: {
      getFocusedElement: () => {
        const active = document.activeElement;
        return active instanceof HTMLElement && root.current?.contains(active) ? active : undefined;
      },
      getViewport: () => session()?.viewport.get(viewKey),
      onViewport: (viewport: Viewport) => {
        const memory = session();
        if (memory) remember(memory.viewport, viewKey, viewport);
      },
      onReady: restore,
    } satisfies CanvasSession,
  };
}
