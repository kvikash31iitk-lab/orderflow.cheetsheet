// Shared indicator script runtime. Imported by BOTH the direct runner (main thread)
// and the worker (sandbox). It builds the approved script API + ctx, runs the user
// script, and normalizes everything into IndicatorOutput[]. Has no DOM/React deps so
// it bundles cleanly into the worker.
//
// SANDBOXING NOTE: the script body is run via `new Function`, with dangerous host
// globals shadowed (passed as `undefined` params) so a script can't trivially reach
// fetch/window/document/worker APIs. This is a ROBUSTNESS sandbox, not a hardened
// security boundary — a determined script could still escape via constructor tricks
// (`[].constructor.constructor`). Real isolation comes from running in the Web Worker
// (no DOM) plus the client-side timeout. Direct mode is "trusted" (no isolation).
import type {
  IndicatorOutput,
  IndicatorPane,
  IndicatorRunRequest,
  IndicatorRunResult,
  LinePoint,
} from "./types";
import { MAX_CANDLES, MAX_OUTPUTS, MAX_SCRIPT_LENGTH } from "./types";
import { sma, ema, highest, lowest, sum, change, crossOver, crossUnder } from "./helpers";
import type { FootprintCandle } from "../types/orderflow";

// Host capabilities shadowed within the script body (resolve to `undefined`).
const SHADOWED = [
  "window", "document", "globalThis", "self", "top", "parent", "frames",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker",
  "importScripts", "postMessage", "localStorage", "sessionStorage", "indexedDB",
  "navigator", "location", "history", "require", "module", "exports", "process",
];

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function normalizePane(p: unknown): IndicatorPane {
  return p === "delta" || p === "cumDelta" || p === "custom" || p === "price" ? p : "price";
}

function makeSafeConsole() {
  const c = typeof console !== "undefined" ? console : undefined;
  const fwd = (fn?: (...a: unknown[]) => void) => (...args: unknown[]) => {
    try {
      fn?.("[indicator]", ...args);
    } catch {
      /* ignore */
    }
  };
  return {
    log: fwd(c?.log?.bind(c)),
    warn: fwd(c?.warn?.bind(c)),
    error: fwd(c?.error?.bind(c)),
    info: fwd(c?.info?.bind(c)),
  };
}

interface LineAccum {
  points: LinePoint[];
  color: string;
  width: number;
  opacity: number;
  pane: IndicatorPane;
}

export interface IndicatorMeta {
  name: string;
  inputs: Record<string, number | string | boolean>;
  overlay: boolean;
  error?: string;
  kind?: string;
}

// Read an indicator's DISPLAY metadata (name + overlay flag) by STATIC inspection —
// deliberately WITHOUT executing the script. Executing it here would run on the main
// thread with no timeout (this is called by the store on every add/edit), so a
// top-level `while (true) {}` could freeze the whole tab even in sandbox mode. Static
// parsing keeps the add/edit path off the `new Function` path entirely; the script is
// actually executed (and validated) later by executeIndicatorScript inside the
// sandboxed worker during recompute, where any error/timeout surfaces per-indicator.
// The name/overlay are only used for the panel label, so a best-effort regex suffices.
// Default inputs are intentionally NOT parsed here — executeIndicatorScript already
// merges the definition's inputs at run time.
export function parseIndicatorMeta(script: string): IndicatorMeta {
  const meta: IndicatorMeta = { name: "Indicator", inputs: {}, overlay: true };
  if (typeof script !== "string" || script.length > MAX_SCRIPT_LENGTH) {
    meta.error = "Invalid or oversized script";
    return meta;
  }
  const nameMatch = script.match(/indicator\s*\(\s*(["'`])([^"'`]+)\1/);
  if (nameMatch && nameMatch[2].trim()) meta.name = nameMatch[2].trim().slice(0, 64);
  // overlay defaults to true; only an explicit `overlay: false` turns it off
  if (/\boverlay\s*:\s*false\b/.test(script)) meta.overlay = false;
  // Mark the Anchored-VWAP tool so the panel offers click-to-anchor UI. Require BOTH
  // an `anchorTime` token AND the quoted "Anchored VWAP" label so an unrelated custom
  // indicator that merely mentions `anchorTime` (e.g. in a comment) isn't misclassified.
  if (/\banchorTime\b/.test(script) && /["']Anchored VWAP["']/.test(script)) {
    meta.kind = "anchored-vwap";
  }
  if (!/\bindicator\s*\(/.test(script)) {
    meta.error = "Script did not call indicator(name, definition)";
  }
  return meta;
}

export function executeIndicatorScript(request: IndicatorRunRequest): IndicatorRunResult {
  const start = nowMs();
  const instance = request.indicator;
  const script = typeof instance?.script === "string" ? instance.script : "";

  if (script.length > MAX_SCRIPT_LENGTH) {
    return { ok: false, outputs: [], error: `Script too long (> ${MAX_SCRIPT_LENGTH} chars)`, runtimeMs: 0 };
  }

  const maxOutputs = Math.min(request.maxOutputs ?? MAX_OUTPUTS, MAX_OUTPUTS);
  let candles = Array.isArray(request.candles) ? request.candles : [];
  if (candles.length > MAX_CANDLES) candles = candles.slice(-MAX_CANDLES);

  const id = instance.id;
  const outputs: IndicatorOutput[] = [];
  const lines = new Map<string, LineAccum>();
  let outId = 0;

  const push = (o: IndicatorOutput): void => {
    if (outputs.length < maxOutputs) outputs.push(o);
  };

  // --- registered definition (set by the script calling indicator(name, def)).
  // held in an object so TS doesn't narrow it to `null` (assigned in a closure) ---
  const reg: { def: Record<string, unknown> | null } = { def: null };
  function indicatorFn(_name: unknown, definition: unknown): void {
    if (definition && typeof definition === "object") reg.def = definition as Record<string, unknown>;
  }

  function makeCtx(candle: FootprintCandle | null, index: number, inputs: Record<string, unknown>) {
    const ctx = {
      candle,
      index,
      candles,
      inputs,
      symbol: request.symbol,
      timeframe: request.timeframe,

      // O(1) look-back to a previous candle (offset back from the current index),
      // so scripts can peek backwards without slicing the whole history.
      prev(offset: unknown = 1): FootprintCandle | null {
        const o = Math.trunc(Number(offset));
        const back = Number.isFinite(o) && o >= 1 ? o : 1;
        const j = index - back;
        return j >= 0 && j < candles.length ? candles[j] : null;
      },

      // The last `length` candles up to and including the current one (cheap tail
      // slice) — rolling-window math without copying the full history each candle.
      window(length: unknown): FootprintCandle[] {
        const len = Math.trunc(Number(length));
        if (!Number.isFinite(len) || len <= 0) return [];
        const end = index >= 0 ? index + 1 : candles.length;
        const start = Math.max(0, end - len);
        return candles.slice(start, end);
      },

      shape(opts: Record<string, unknown>) {
        if (!opts || typeof opts !== "object") return;
        const time = Number(opts.time);
        const price = Number(opts.price);
        if (!isNum(time) || !isNum(price)) return;
        const position =
          opts.position === "above" || opts.position === "below" || opts.position === "price"
            ? (opts.position as "above" | "below" | "price")
            : "price";
        push({
          type: "shape",
          indicatorId: id,
          id: `${id}:s${outId++}`,
          time,
          price,
          text: typeof opts.text === "string" ? opts.text.slice(0, 24) : undefined,
          color: typeof opts.color === "string" ? opts.color : "#888888",
          position,
        });
      },

      zone(opts: Record<string, unknown>) {
        if (!opts || typeof opts !== "object") return;
        const fromTime = Number(opts.fromTime);
        const toTime = Number(opts.toTime);
        const low = Number(opts.low);
        const high = Number(opts.high);
        if (![fromTime, toTime, low, high].every(isNum)) return;
        push({
          type: "zone",
          indicatorId: id,
          id: `${id}:z${outId++}`,
          fromTime,
          toTime,
          low: Math.min(low, high),
          high: Math.max(low, high),
          color: typeof opts.color === "string" ? opts.color : "#3b82f6",
          opacity: isNum(Number(opts.opacity)) ? clamp01(Number(opts.opacity)) : 0.15,
        });
      },

      plotLine(name: unknown, pointsOrValue: unknown, opts?: Record<string, unknown>) {
        const key = typeof name === "string" && name ? name : `line${outId++}`;
        let acc = lines.get(key);
        if (!acc) {
          acc = {
            points: [],
            color: opts && typeof opts.color === "string" ? opts.color : "#14b8a6",
            width: opts && isNum(Number(opts.width)) ? Number(opts.width) : 2,
            opacity: opts && isNum(Number(opts.opacity)) ? clamp01(Number(opts.opacity)) : 1,
            pane: normalizePane(opts?.pane),
          };
          lines.set(key, acc);
        } else if (opts) {
          if (typeof opts.color === "string") acc.color = opts.color;
          if (isNum(Number(opts.width))) acc.width = Number(opts.width);
          if (opts.pane !== undefined) acc.pane = normalizePane(opts.pane);
        }
        if (Array.isArray(pointsOrValue)) {
          acc.points = [];
          for (const p of pointsOrValue as Array<{ time?: unknown; value?: unknown }>) {
            const t = Number(p?.time);
            const v = Number(p?.value);
            if (isNum(t) && isNum(v)) acc.points.push({ time: t, value: v });
          }
        } else {
          const v = Number(pointsOrValue);
          if (isNum(v) && candle) acc.points.push({ time: candle.startTime, value: v });
        }
      },

      // NOTE: histogram outputs are normalized and stored, but NOT yet rendered by any
      // pane (a histogram sub-pane was a documented phase-1 non-goal). The output is
      // inert until a renderer consumes type:"histogram"; not advertised in the panel.
      histogram(_name: unknown, points: unknown, opts?: Record<string, unknown>) {
        const pane = normalizePane(opts?.pane);
        const pts: { time: number; value: number; color?: string }[] = [];
        if (Array.isArray(points)) {
          for (const p of points as Array<{ time?: unknown; value?: unknown; color?: unknown }>) {
            const t = Number(p?.time);
            const v = Number(p?.value);
            if (isNum(t) && isNum(v)) {
              pts.push({ time: t, value: v, color: typeof p?.color === "string" ? p.color : undefined });
            }
          }
        }
        push({
          type: "histogram",
          indicatorId: id,
          id: `${id}:h${outId++}`,
          points: pts,
          pane: pane === "price" ? "custom" : pane,
        });
      },

      // Stubbed for phase 1 — real alert wiring is intentionally deferred.
      alert(_condition: unknown, _message: unknown) {
        /* no-op */
      },
    };

    // `history` is kept for backward-compat but computed LAZILY via a getter.
    // Eagerly building candles.slice(0, index+1) for EVERY candle is O(n^2) and was
    // tripping the sandbox timeout even for scripts (e.g. Delta Spike) that never read
    // it. With the getter, the slice only happens if a script actually accesses it.
    Object.defineProperty(ctx, "history", {
      enumerable: true,
      configurable: true,
      get(): FootprintCandle[] {
        return candle ? candles.slice(0, index + 1) : candles;
      },
    });

    return ctx;
  }

  try {
    const apiNames = [
      "indicator", "sma", "ema", "highest", "lowest", "sum", "change", "crossOver", "crossUnder", "console",
    ];
    const apiImpls = [indicatorFn, sma, ema, highest, lowest, sum, change, crossOver, crossUnder, makeSafeConsole()];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...apiNames, ...SHADOWED, `"use strict";\n${script}\n`);
    fn(...apiImpls, ...SHADOWED.map(() => undefined));

    const def = reg.def;
    if (!def) {
      return { ok: false, outputs: [], error: "Script did not call indicator(name, definition)", runtimeMs: nowMs() - start };
    }

    const defInputs = def.inputs && typeof def.inputs === "object" ? (def.inputs as Record<string, unknown>) : {};
    const inputs: Record<string, unknown> = { ...defInputs, ...(instance.inputs || {}) };
    const onSeries = typeof def.onSeries === "function" ? (def.onSeries as (ctx: unknown) => void) : null;
    const onCandle = typeof def.onCandle === "function" ? (def.onCandle as (ctx: unknown) => void) : null;

    if (!onSeries && !onCandle) {
      return { ok: false, outputs: [], error: "Indicator has no onCandle or onSeries handler", runtimeMs: nowMs() - start };
    }

    if (onSeries) {
      const last = candles.length ? candles[candles.length - 1] : null;
      onSeries(makeCtx(last, candles.length - 1, inputs));
    }
    if (onCandle) {
      for (let i = 0; i < candles.length; i++) {
        if (outputs.length >= maxOutputs) break;
        onCandle(makeCtx(candles[i], i, inputs));
      }
    }

    // finalize accumulated lines (sorted ascending unique-ish time for renderers)
    for (const acc of lines.values()) {
      if (outputs.length >= maxOutputs) break;
      if (!acc.points.length) continue;
      acc.points.sort((a, b) => a.time - b.time);
      push({
        type: "line",
        indicatorId: id,
        id: `${id}:l${outId++}`,
        points: acc.points,
        color: acc.color,
        width: acc.width,
        opacity: acc.opacity,
        pane: acc.pane,
      });
    }

    return { ok: true, outputs, runtimeMs: nowMs() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message || String(err) : String(err);
    return { ok: false, outputs: [], error: msg, runtimeMs: nowMs() - start };
  }
}
