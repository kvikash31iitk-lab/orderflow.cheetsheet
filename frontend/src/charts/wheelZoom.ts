// Smooth, cursor-anchored wheel zoom for the footprint chart.
//
// Replaces lightweight-charts' built-in mouse-wheel zoom (disabled via
// handleScale.mouseWheel=false) so we can:
//   - normalize wheel / trackpad deltas across deltaMode + clamp spikes (no violent jumps),
//   - accumulate into a target bar-spacing and ease toward it with requestAnimationFrame,
//   - keep the logical index under the cursor anchored across the zoom (GoCharting feel),
//   - clamp to a sane bar-spacing range,
//   - stop the page from scrolling while the chart is hovered.
//
// Drag-pan, axis-drag scaling, pinch and touch are left to the native chart; only the
// vertical wheel gesture is taken over. Because the main chart's visible-range change is
// what chartSync mirrors to the sub-panes, the CVD / histogram panes follow automatically.
import type { IChartApi, Logical } from "lightweight-charts";

const MIN_BAR_SPACING = 2; // fully zoomed out -> renderer falls back to candlesticks
const MAX_BAR_SPACING = 240; // fully zoomed in -> large, very readable footprint cells
const SENSITIVITY = 0.0016; // normalized wheel delta -> zoom exponent
const EASE = 0.28; // per-frame approach to the target (0..1); higher = snappier
const MAX_STEP_DELTA = 60; // clamp one normalized wheel delta (tames trackpad spikes)

export interface WheelZoomController {
  dispose(): void;
}

export function createWheelZoom({ host, chart }: { host: HTMLElement; chart: IChartApi }): WheelZoomController {
  const ts = chart.timeScale();
  let target = ts.options().barSpacing || 110;
  let raf = 0;
  let running = false;
  let anchorX = 0;
  let anchorLogical: Logical | null = null;

  const clampBS = (v: number) => Math.min(MAX_BAR_SPACING, Math.max(MIN_BAR_SPACING, v));

  // bring every wheel source onto a common px-ish scale, then clamp burst magnitude
  const normalize = (e: WheelEvent): number => {
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16; // DOM_DELTA_LINE
    else if (e.deltaMode === 2) d *= host.clientHeight || 600; // DOM_DELTA_PAGE
    return Math.max(-MAX_STEP_DELTA, Math.min(MAX_STEP_DELTA, d));
  };

  const frame = () => {
    raf = 0;
    const cur = ts.options().barSpacing || target;
    let next = cur + (target - cur) * EASE;
    if (Math.abs(target - next) < 0.05) next = target;
    next = clampBS(next);
    ts.applyOptions({ barSpacing: next });

    // re-anchor: scroll so the logical index that was under the cursor lands back at the
    // same x. Increasing scrollPosition shifts content left (a logical's x decreases), so
    // the correction is (x2 - anchorX) / barSpacing bars.
    if (anchorLogical != null && next > 0) {
      const x2 = ts.logicalToCoordinate(anchorLogical);
      if (x2 != null) {
        ts.scrollToPosition(ts.scrollPosition() + (x2 - anchorX) / next, false);
      }
    }

    if (next !== target) raf = requestAnimationFrame(frame);
    else running = false;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault(); // chart owns the wheel -> never let the page scroll under it
    const rect = host.getBoundingClientRect();
    anchorX = e.clientX - rect.left;
    anchorLogical = ts.coordinateToLogical(anchorX);

    const cur = ts.options().barSpacing || target;
    if (!running) target = cur; // re-seed from the live value when starting fresh
    target = clampBS(target * Math.exp(-normalize(e) * SENSITIVITY));
    running = true;
    if (!raf) raf = requestAnimationFrame(frame);
  };

  host.addEventListener("wheel", onWheel, { passive: false });

  return {
    dispose() {
      host.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      running = false;
    },
  };
}
