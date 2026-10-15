// deno-lint-ignore-file no-window no-window-prefix
import { useEffect, useRef, useState } from "react";
import type { SceneInput } from "../../domain/scene";
import type { LayoutMeasurements } from "../../ports/layout";
import type { Size } from "../../domain/geometry";
/** Natural-content probes are independent of layout output: resize cannot feed back into ELK. */
export function useDiagramMeasurements(input: SceneInput) {
  const ref = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<{ input: SceneInput; measurements: LayoutMeasurements }>();
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let fontsReady = false;
    const measure = () => {
      frame = 0;
      if (disposed || !ref.current) return;
      const sizes: Record<string, Record<string, Size>> = {
        node: Object.create(null),
        edge: Object.create(null),
        group: Object.create(null),
      };
      for (const element of ref.current.querySelectorAll<HTMLElement>("[data-measure-id]")) {
        const kind = element.dataset.measureKind!;
        const id = element.dataset.measureId!;
        const width = Math.ceil(element.offsetWidth);
        const height = Math.ceil(element.scrollHeight);
        if (width > 0 && height > 0) sizes[kind][id] = { width, height };
      }
      const revision = JSON.stringify(sizes);
      setSnapshot((previous) =>
        previous?.input === input && previous.measurements.revision === revision ? previous : {
          input,
          measurements: {
            revision,
            nodeSizes: sizes.node,
            edgeLabelSizes: sizes.edge,
            groupLabelSizes: sizes.group,
          },
        }
      );
    };
    const schedule = () => {
      if (!disposed && fontsReady && !frame) frame = requestAnimationFrame(measure);
    };
    Promise.resolve(document.fonts?.ready).then(() => {
      fontsReady = true;
      schedule();
    });
    // A host font/style change is new input. Repeated unchanged observations are ignored;
    // each changed natural-size snapshot starts one replacement layout, not another probe pass.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    ref.current?.querySelectorAll("[data-measure-id]").forEach((element) => observer?.observe(element));
    document.fonts?.addEventListener("loadingdone", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [input]);
  return { ref, measurements: snapshot?.input === input ? snapshot.measurements : undefined };
}
