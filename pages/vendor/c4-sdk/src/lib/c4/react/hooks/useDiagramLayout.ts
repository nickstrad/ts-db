import { useEffect, useRef, useState } from "react";
import { fixedLayout, validateLayout } from "../../domain/layout";
import type { Scene, SceneInput } from "../../domain/scene";
import type { Result } from "../../domain/model";
import type { LayoutMeasurements, LayoutPort } from "../../ports/layout";
export function useDiagramLayout(
  input: SceneInput,
  port?: LayoutPort,
  measurements?: LayoutMeasurements,
): Result<Scene> {
  const generation = useRef(0);
  const [published, publish] = useState<
    { input: SceneInput; measures?: LayoutMeasurements; result: Result<Scene> }
  >();
  useEffect(() => {
    if (!port) return;
    const controller = new AbortController();
    const current = ++generation.current;
    port.layout({ scene: input, generation: current, signal: controller.signal, measurements }).then(
      (response) => {
        if (
          !controller.signal.aborted && response.generation === current && generation.current === current &&
          response.measurementRevision === measurements?.revision
        ) publish({ input, measures: measurements, result: validateLayout(input, response.result) });
      },
    ).catch((error: unknown) => {
      if (!controller.signal.aborted && generation.current === current) {
        publish({
          input,
          measures: measurements,
          result: {
            ok: false,
            diagnostics: [{
              code: "layout",
              severity: "error",
              path: "$.layout",
              message: error instanceof Error ? error.message : "Layout failed.",
            }],
          },
        });
      }
    });
    return () => {
      controller.abort();
    };
  }, [input, port, measurements]);
  if (!port) return fixedLayout(input);
  if (published?.input === input && published.measures === measurements) return published.result;
  const diagnostics = [{
    code: "layout-pending",
    severity: "warning" as const,
    path: "$.layout",
    message: "Arranging diagram…",
  }];
  if (published?.input === input && published.result.ok) return { ...published.result, diagnostics };
  return { ok: false, diagnostics };
}
