// Imperative input controller for the chart drawing layer.
//
// subscribeClick (used by the AVWAP anchor flow) only fires on a click and cannot
// drive create-by-drag / move / resize, so this attaches native pointer listeners to
// the chart host. While a drawing tool is active OR a gesture is in progress we
// disable lightweight-charts pan/zoom (handleScroll/handleScale) so the chart doesn't
// fight the gesture, and restore it after. All reads use useStore.getState() so the
// once-attached listeners never hold stale state (same discipline as FootprintChart's
// onChartClick). Geometry is stored in DATA coords (time ms + price); the transient
// draft (create / move / resize preview) lives here and is merged into the primitive's
// render state via the provider.
import type { IChartApi, UTCTimestamp } from "lightweight-charts";
import { useStore } from "../store/useStore";
import type { FootprintSeriesApi } from "../charts/footprintSeries";
import { DrawingPrimitive, type AvwapSelection, type DrawingRenderState } from "./DrawingPrimitive";
import { hitTestDrawing, hitTestHandle, dist, distToSegment, HIT_TOLERANCE, type Px } from "./geometry";
import {
  DEFAULT_DRAWING_STYLE,
  drawingDisplayName,
  makeDrawingId,
  pointsForTool,
  type ChartPoint,
  type DrawingObject,
  type DrawingTool,
  type SnapMode,
} from "./types";
import type { FootprintCandle } from "../types/orderflow";

// Magnet/snap: pull a free price onto the nearest candle feature for the snap mode.
function snapPrice(mode: SnapMode, candle: FootprintCandle, target: number): number {
  if (mode === "vwap") return candle.vwap ?? target;
  if (mode === "poc") return candle.poc ?? target;
  if (mode === "ohlc") {
    const cands = [candle.open, candle.high, candle.low, candle.close];
    let best = cands[0];
    let bd = Math.abs(target - best);
    for (const v of cands) {
      const d = Math.abs(target - v);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }
  return target;
}

type Interaction =
  | { kind: "creating"; tool: DrawingTool; pointerId: number; lastPx: Px }
  | { kind: "moving"; pointerId: number; target: DrawingObject; startPx: Px; origPoints: ChartPoint[]; origPath?: ChartPoint[] }
  | { kind: "resizing"; pointerId: number; target: DrawingObject; handleIndex: number };

export function createDrawingController(opts: {
  host: HTMLDivElement;
  chart: IChartApi;
  series: FootprintSeriesApi;
}): { dispose: () => void } {
  const { host, chart, series } = opts;

  let draft: DrawingObject | null = null;
  let interaction: Interaction | null = null;

  // the main "Anchored VWAP" line output for a given indicator id (price pane), if any
  const avwapLineFor = (indicatorId: string) => {
    const st = useStore.getState();
    return st.indicatorOutputs.find(
      (o) => o.type === "line" && o.indicatorId === indicatorId && (o.pane ?? "price") === "price",
    );
  };

  // ---- the render-state provider the primitive reads every paint ----
  const provider = (): DrawingRenderState => {
    const st = useStore.getState();
    const sym = st.symbol;
    const committed = st.drawings.filter((d) => d.symbol === sym && d.visible);
    let list = committed;
    if (draft) {
      list = committed.some((d) => d.id === draft!.id)
        ? committed.map((d) => (d.id === draft!.id ? draft! : d))
        : [...committed, draft];
    }
    // highlight a selected Anchored VWAP by tracing its plotted line
    let avwapSelection: AvwapSelection | null = null;
    if (st.selectedIndicatorId) {
      const ind = st.indicators.find((i) => i.id === st.selectedIndicatorId && i.kind === "anchored-vwap");
      const line = ind ? avwapLineFor(ind.id) : undefined;
      if (line && line.type === "line" && line.points.length) {
        avwapSelection = { points: line.points, color: line.color };
      }
    }
    return { drawings: list, selectedId: st.selectedDrawingId, theme: st.theme, avwapSelection };
  };

  const primitive = new DrawingPrimitive(provider);
  series.attachPrimitive(primitive);
  const requestUpdate = () => primitive.requestUpdate();

  // ---- coordinate helpers ----
  const toLocal = (e: PointerEvent): Px => {
    const r = host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const snap = (ms: number): number => {
    const cs = useStore.getState().candles;
    if (!cs.length) return ms;
    let best = cs[0].startTime;
    let bd = Math.abs(cs[0].startTime - ms);
    for (let i = 1; i < cs.length; i++) {
      const d = Math.abs(cs[i].startTime - ms);
      if (d < bd) {
        bd = d;
        best = cs[i].startTime;
      }
    }
    return best;
  };
  const pxToData = (px: Px): ChartPoint | null => {
    const price = series.coordinateToPrice(px.y);
    if (price == null) return null;
    const t = chart.timeScale().coordinateToTime(px.x);
    let ms: number;
    if (typeof t === "number") {
      ms = (t as number) * 1000;
    } else {
      const cs = useStore.getState().candles;
      if (!cs.length) return null;
      ms = px.x < 0 ? cs[0].startTime : cs[cs.length - 1].startTime;
    }
    const time = snap(ms);
    // magnet/snap: pull the free price onto the snapped candle's OHLC / POC / VWAP
    let outPrice = price as number;
    const st = useStore.getState();
    if (st.snapMode !== "off") {
      const c = st.candles.find((cc) => cc.startTime === time);
      if (c) outPrice = snapPrice(st.snapMode, c, outPrice);
    }
    return { time, price: outPrice };
  };
  const dataToPx = (pt: ChartPoint): Px | null => {
    const y = series.priceToCoordinate(pt.price);
    if (y == null) return null;
    const x = chart.timeScale().timeToCoordinate(Math.floor(pt.time / 1000) as UTCTimestamp);
    if (x == null) return null;
    return { x: x as number, y: y as number };
  };
  const dims = () => ({ width: host.clientWidth, height: host.clientHeight });

  // ---- pan + cursor reflect the current tool / gesture ----
  const drawingActive = () => useStore.getState().activeTool !== "select" || interaction != null;
  const syncPanAndCursor = () => {
    const enabled = !drawingActive();
    chart.applyOptions({ handleScroll: enabled, handleScale: enabled });
    host.style.cursor = useStore.getState().activeTool !== "select" ? "crosshair" : "default";
  };

  const pickAt = (local: Px): DrawingObject | null => {
    const st = useStore.getState();
    const list = st.drawings.filter((d) => d.symbol === st.symbol && d.visible);
    const box = dims();
    for (let i = list.length - 1; i >= 0; i--) {
      if (hitTestDrawing(list[i], dataToPx, local, box)) return list[i];
    }
    return null;
  };

  // pick an enabled Anchored VWAP whose plotted line passes near `local` (returns the
  // indicator id). Tests every AVWAP line segment (incl. SD bands) on the price pane.
  const pickAvwapAt = (local: Px): string | null => {
    const st = useStore.getState();
    const avwapIds = new Set(
      st.indicators.filter((i) => i.kind === "anchored-vwap" && i.enabled).map((i) => i.id),
    );
    if (!avwapIds.size) return null;
    const lines = st.indicatorOutputs.filter(
      (o) => o.type === "line" && avwapIds.has(o.indicatorId) && (o.pane ?? "price") === "price",
    );
    for (let li = lines.length - 1; li >= 0; li--) {
      const o = lines[li];
      if (o.type !== "line") continue;
      const pts = o.points;
      for (let i = 1; i < pts.length; i++) {
        const a = dataToPx({ time: pts[i - 1].time, price: pts[i - 1].value });
        const b = dataToPx({ time: pts[i].time, price: pts[i].value });
        if (a && b && distToSegment(local, a, b) <= HIT_TOLERANCE) return o.indicatorId;
      }
    }
    return null;
  };

  // ---- gesture starters ----
  const startCreate = (e: PointerEvent, tool: DrawingTool, local: Px) => {
    const p = pxToData(local);
    if (!p) return;
    const st = useStore.getState();
    const base: DrawingObject = {
      id: makeDrawingId(),
      type: tool,
      name: drawingDisplayName(tool, st.drawings),
      symbol: st.symbol,
      timeframe: st.timeframe,
      points: [],
      visible: true,
      locked: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      style: { ...DEFAULT_DRAWING_STYLE },
    };
    if (tool === "brush") base.path = [p];
    else if (pointsForTool(tool) === 1) base.points = [p];
    else base.points = [p, p];
    draft = base;
    interaction = { kind: "creating", tool, pointerId: e.pointerId, lastPx: local };
    try {
      host.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may not be capturable (e.g. synthetic) */
    }
    syncPanAndCursor();
    requestUpdate();
  };

  const startMove = (e: PointerEvent, target: DrawingObject, local: Px) => {
    interaction = {
      kind: "moving",
      pointerId: e.pointerId,
      target,
      startPx: local,
      origPoints: target.points.map((p) => ({ ...p })),
      origPath: target.path?.map((p) => ({ ...p })),
    };
    try {
      host.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may not be capturable (e.g. synthetic) */
    }
    syncPanAndCursor();
  };

  const startResize = (e: PointerEvent, target: DrawingObject, handleIndex: number) => {
    interaction = { kind: "resizing", pointerId: e.pointerId, target, handleIndex };
    try {
      host.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may not be capturable (e.g. synthetic) */
    }
    syncPanAndCursor();
  };

  // ---- pointer handlers ----
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const st = useStore.getState();
    const tool = st.activeTool;
    const local = toLocal(e);

    if (tool === "select") {
      const sel = st.drawings.find(
        (d) => d.id === st.selectedDrawingId && d.symbol === st.symbol && d.visible,
      );
      if (sel && !sel.locked && sel.type !== "brush") {
        const hi = hitTestHandle(sel, dataToPx, local);
        if (hi >= 0) {
          startResize(e, sel, hi);
          return;
        }
      }
      const hit = pickAt(local);
      if (hit) {
        useStore.getState().selectDrawing(hit.id);
        if (!hit.locked) startMove(e, hit, local);
        return;
      }
      // nothing drawn hit -> try an Anchored VWAP line (select-only; re-anchor/delete
      // happen via its selection toolbar). Don't start a move gesture for it.
      const avwapId = pickAvwapAt(local);
      if (avwapId) {
        useStore.getState().selectIndicator(avwapId);
        requestUpdate();
        return;
      }
      if (st.selectedDrawingId || st.selectedIndicatorId) {
        useStore.getState().selectDrawing(null);
        useStore.getState().selectIndicator(null);
        requestUpdate();
      }
      return; // empty space -> let the chart pan
    }

    startCreate(e, tool, local);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!interaction) return;
    const local = toLocal(e);
    if (interaction.kind === "creating") {
      if (!draft) return;
      const p = pxToData(local);
      if (!p) return;
      if (interaction.tool === "brush") {
        if (dist(local, interaction.lastPx) >= 2) {
          interaction.lastPx = local;
          draft = { ...draft, path: [...(draft.path ?? []), p] };
          requestUpdate();
        }
      } else if (pointsForTool(interaction.tool) === 1) {
        draft = { ...draft, points: [p] };
        requestUpdate();
      } else {
        draft = { ...draft, points: [draft.points[0], p] };
        requestUpdate();
      }
    } else if (interaction.kind === "moving") {
      const dx = local.x - interaction.startPx.x;
      const dy = local.y - interaction.startPx.y;
      const shift = (op: ChartPoint): ChartPoint => {
        const px = dataToPx(op);
        if (!px) return op;
        return pxToData({ x: px.x + dx, y: px.y + dy }) ?? op;
      };
      draft = {
        ...interaction.target,
        points: interaction.origPoints.map(shift),
        path: interaction.origPath?.map(shift),
      };
      requestUpdate();
    } else if (interaction.kind === "resizing") {
      const p = pxToData(local);
      if (!p) return;
      const pts = interaction.target.points.slice();
      pts[interaction.handleIndex] = p;
      draft = { ...interaction.target, points: pts };
      requestUpdate();
    }
  };

  const commitCreate = (d: DrawingObject, tool: DrawingTool): void => {
    const add = useStore.getState().addDrawing;
    if (tool === "brush") {
      if ((d.path?.length ?? 0) >= 2) add(d);
      return;
    }
    if (pointsForTool(tool) === 1) {
      if (tool === "text") {
        const txt = window.prompt("Text label:", "");
        if (txt == null || txt.trim() === "") return;
        add({ ...d, text: txt.trim() });
        return;
      }
      add(d);
      return;
    }
    // 2-point: require a real drag so a stray click doesn't drop a zero-size object
    const a = d.points[0] ? dataToPx(d.points[0]) : null;
    const b = d.points[1] ? dataToPx(d.points[1]) : null;
    if (a && b && dist(a, b) >= 4) add(d);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!interaction) return;
    const inter = interaction;
    try {
      host.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
    interaction = null;
    const d = draft;
    draft = null;
    if (inter.kind === "creating") {
      if (d) commitCreate(d, inter.tool);
    } else if (d && (inter.kind === "moving" || inter.kind === "resizing")) {
      useStore.getState().updateDrawing(d.id, { points: d.points, path: d.path });
    }
    syncPanAndCursor();
    requestUpdate();
  };

  // ---- keyboard: undo/redo, Esc cancels tool/selection, Delete removes selection ----
  const onKeyDown = (e: KeyboardEvent) => {
    const el = document.activeElement as HTMLElement | null;
    const editing =
      el != null &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    if (editing) return;

    // undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y). Skips while a gesture
    // is mid-flight so we don't restore underneath an active drag.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (!interaction) (e.shiftKey ? useStore.getState().redo : useStore.getState().undo)();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      if (!interaction) useStore.getState().redo();
      return;
    }

    const st = useStore.getState();
    if (e.key === "Escape") {
      if (interaction) {
        interaction = null;
        draft = null;
      }
      if (st.activeTool !== "select") useStore.getState().setActiveTool("select");
      else if (st.selectedDrawingId) useStore.getState().selectDrawing(null);
      else if (st.selectedIndicatorId) useStore.getState().selectIndicator(null);
      syncPanAndCursor();
      requestUpdate();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (st.selectedDrawingId) {
        e.preventDefault();
        useStore.getState().removeDrawing(st.selectedDrawingId);
      } else if (st.selectedIndicatorId) {
        e.preventDefault();
        useStore.getState().removeIndicator(st.selectedIndicatorId);
      }
    }
  };

  // ---- repaint + pan-sync when relevant store slices change ----
  const unsub = useStore.subscribe((s, prev) => {
    if (s.activeTool !== prev.activeTool || s.symbol !== prev.symbol) syncPanAndCursor();
    if (
      s.drawings !== prev.drawings ||
      s.selectedDrawingId !== prev.selectedDrawingId ||
      s.selectedIndicatorId !== prev.selectedIndicatorId ||
      s.indicatorOutputs !== prev.indicatorOutputs ||
      s.theme !== prev.theme ||
      s.activeTool !== prev.activeTool ||
      s.symbol !== prev.symbol
    ) {
      requestUpdate();
    }
  });

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  syncPanAndCursor();
  requestUpdate();

  return {
    dispose() {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      unsub();
      try {
        series.detachPrimitive(primitive);
      } catch {
        /* series/chart may already be disposed */
      }
      chart.applyOptions({ handleScroll: true, handleScale: true });
    },
  };
}
