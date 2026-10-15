import ELK from "elkjs/lib/elk-api";
import type { LayoutPort, LayoutResponse } from "../../ports/layout";
import { manualLayout, validateLayout } from "../../domain/layout";
import { elkInput, layoutCacheKey } from "./elk-input";
import { attachGeometry, checkedElkOutput } from "./elk-output";
import type { LayoutGeometry } from "./elk-output";
export interface LayoutWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export const createLayoutWorker = (): LayoutWorker =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
export interface ElkLayoutLimits {
  readonly geometry?: import("../../domain/layout").GeometryLimits;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly cacheEntries?: number;
  readonly timeoutMs?: number;
}
/** Cache geometry only; a hit still reattaches this caller's original model references. */
export function createElkLayoutPort(
  factory: () => LayoutWorker = createLayoutWorker,
  limits: ElkLayoutLimits = {},
): LayoutPort {
  const maximumNodes = limits.maxNodes ?? 5000;
  const maximumEdges = limits.maxEdges ?? 10000;
  const cacheEntries = limits.cacheEntries ?? 24;
  const defaultTimeout = limits.timeoutMs ?? 10000;
  for (
    const [key, value, maximum] of [["maxNodes", maximumNodes, 5000], ["maxEdges", maximumEdges, 10000], [
      "cacheEntries",
      cacheEntries,
      24,
    ], ["timeoutMs", defaultTimeout, 2147483647]] as const
  ) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    }
  }
  const cache = new Map<string, LayoutGeometry>();
  return {
    layout(request) {
      const response = (result: LayoutResponse["result"]): LayoutResponse => ({
        generation: request.generation,
        measurementRevision: request.measurements?.revision,
        result,
      });
      const failure = (message: string) =>
        response({
          ok: false,
          diagnostics: [{ code: "layout", path: "$.layout", severity: "error", message }],
        });
      const timeout = request.timeoutMs ?? defaultTimeout;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) {
        return Promise.resolve(
          failure("Layout timeout must be finite, positive and no greater than 2147483647 ms."),
        );
      }
      if (request.signal.aborted) return Promise.resolve(failure("Layout cancelled."));
      if (request.scene.nodes.length > maximumNodes || request.scene.edges.length > maximumEdges) {
        return Promise.resolve(
          failure(
            `Layout exceeds the host limit of ${maximumNodes} nodes or ${maximumEdges} edges. Use a smaller view.`,
          ),
        );
      }
      if (request.scene.diagram.layout?.mode === "manual") {
        return Promise.resolve(
          response(
            validateLayout(request.scene, manualLayout(request.scene, request.measurements), limits.geometry),
          ),
        );
      }
      const key = layoutCacheKey(request.scene, request.measurements);
      const cached = cache.get(key);
      if (cached) {
        return Promise.resolve(
          response(validateLayout(request.scene, attachGeometry(request.scene, cached), limits.geometry)),
        );
      }
      return new Promise((resolve) => {
        let worker: LayoutWorker | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (value: LayoutResponse) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
          }
          resolve(value);
        };
        const abort = () => finish(failure("Layout cancelled."));
        try {
          worker = factory();
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) {
            abort();
            return;
          }
          worker.onerror = (event) =>
            finish(
              failure(
                `Layout worker failed to load or execute: ${event.message || "unknown error"}${
                  event.filename ? ` (${event.filename}:${event.lineno})` : ""
                }`,
              ),
            );
          worker.onmessageerror = () => finish(failure("Layout worker returned an unreadable message."));
          const engine = new ELK({ workerFactory: () => worker as Worker, algorithms: ["layered"] });
          timer = setTimeout(
            () => finish(failure(`Layout exceeded ${timeout} ms. Use a smaller view or retry.`)),
            timeout,
          );
          engine.layout(elkInput(request.scene, request.measurements)).then((graph) => {
            if (settled) return;
            try {
              const geometry = checkedElkOutput(request.scene, graph);
              const result = validateLayout(
                request.scene,
                attachGeometry(request.scene, geometry),
                limits.geometry,
              );
              if (result.ok) {
                cache.set(key, geometry);
                if (cache.size > cacheEntries) cache.delete(cache.keys().next().value!);
              }
              finish(response(result));
            } catch (error) {
              finish(
                failure(error instanceof Error ? error.message : "Layout worker returned invalid geometry."),
              );
            }
          }, (error) => finish(failure(error instanceof Error ? error.message : "ELK layout failed.")));
        } catch (error) {
          finish(failure(error instanceof Error ? error.message : "Layout worker unavailable."));
        }
      });
    },
  };
}
