// Pure 2D geometry + hit-testing for chart drawings. NO lightweight-charts import:
// callers pass a `toPx` converter (data point -> pixel) so these stay unit-testable
// and reusable by both the renderer (selection handles) and the input controller
// (hover / pick). All inputs/outputs are in media (CSS) pixels.
import type { ChartPoint, DrawingObject } from "./types";
import { FIB_LEVELS } from "./types";

export interface Px {
  x: number;
  y: number;
}

export type ToPx = (pt: ChartPoint) => Px | null;

export const HIT_TOLERANCE = 6; // px
export const HANDLE_SIZE = 7; // px (square side)

export function dist(a: Px, b: Px): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// shortest distance from p to the finite segment a-b
export function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// distance from p to the ray a->b (extends past b but not before a)
export function distToRay(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, t);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Pixel positions of a drawing's draggable anchor handles (empty if off-screen).
export function drawingHandles(d: DrawingObject, toPx: ToPx): Px[] {
  if (d.type === "brush") {
    const path = d.path ?? [];
    const ends = [path[0], path[path.length - 1]].filter(Boolean) as ChartPoint[];
    return ends.map(toPx).filter((p): p is Px => p != null);
  }
  return (d.points ?? []).map(toPx).filter((p): p is Px => p != null);
}

// True if `test` is within `tol` px of the drawing's geometry. `dims` = chart media size.
export function hitTestDrawing(
  d: DrawingObject,
  toPx: ToPx,
  test: Px,
  _dims: { width: number; height: number },
  tol = HIT_TOLERANCE,
): boolean {
  const pts = (d.points ?? []).map(toPx);
  switch (d.type) {
    case "horizontal-line": {
      const a = pts[0];
      return a != null && Math.abs(test.y - a.y) <= tol;
    }
    case "vertical-line": {
      const a = pts[0];
      return a != null && Math.abs(test.x - a.x) <= tol;
    }
    case "text": {
      const a = pts[0];
      if (a == null) return false;
      const fs = d.style.fontSize ?? 12;
      const w = Math.max(24, (d.text?.length ?? 4) * fs * 0.62) + 8;
      const h = fs + 8;
      return test.x >= a.x - 4 && test.x <= a.x - 4 + w && test.y >= a.y - h / 2 && test.y <= a.y + h / 2;
    }
    case "trendline": {
      const a = pts[0];
      const b = pts[1];
      return a != null && b != null && distToSegment(test, a, b) <= tol;
    }
    case "ray": {
      const a = pts[0];
      const b = pts[1];
      return a != null && b != null && distToRay(test, a, b) <= tol;
    }
    case "rectangle": {
      const a = pts[0];
      const b = pts[1];
      if (a == null || b == null) return false;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      const nearBorder =
        ((Math.abs(test.x - x0) <= tol || Math.abs(test.x - x1) <= tol) && test.y >= y0 - tol && test.y <= y1 + tol) ||
        ((Math.abs(test.y - y0) <= tol || Math.abs(test.y - y1) <= tol) && test.x >= x0 - tol && test.x <= x1 + tol);
      const inside = test.x >= x0 && test.x <= x1 && test.y >= y0 && test.y <= y1;
      return nearBorder || inside;
    }
    case "fib-retracement": {
      const a = pts[0];
      const b = pts[1];
      if (a == null || b == null) return false;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      if (test.x < x0 - tol || test.x > x1 + tol) return false;
      // hit if near any level's horizontal line
      for (const lvl of FIB_LEVELS) {
        const y = a.y + (b.y - a.y) * lvl;
        if (Math.abs(test.y - y) <= tol) return true;
      }
      return false;
    }
    case "brush": {
      const path = (d.path ?? []).map(toPx);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        if (a != null && b != null && distToSegment(test, a, b) <= tol) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// index of the handle within `tol` px of `test` (-1 = none). Used for endpoint resize.
export function hitTestHandle(d: DrawingObject, toPx: ToPx, test: Px, tol = HANDLE_SIZE): number {
  const handles = (d.points ?? []).map(toPx);
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i];
    if (h != null && Math.abs(test.x - h.x) <= tol && Math.abs(test.y - h.y) <= tol) return i;
  }
  return -1;
}
