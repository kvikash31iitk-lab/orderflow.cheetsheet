// Per-indicator interval visibility (TradingView "Visibility" tab). Maps a chart
// timeframe to a category + numeric value, then checks the instance's allowed ranges.
// A missing visibility config => visible everywhere (back-compat). Pure module: shared
// by the engine (skip non-visible indicators) and the UI (dim the legend row).
import type { IndicatorInstance, IndicatorVisibility } from "./types";

export const DEFAULT_VISIBILITY: IndicatorVisibility = {
  ticks: { enabled: true, from: 1, to: 1 },
  minutes: { enabled: true, from: 1, to: 59 },
  hours: { enabled: true, from: 1, to: 24 },
  days: { enabled: true, from: 1, to: 366 },
};

export const VISIBILITY_CATEGORIES: { key: keyof IndicatorVisibility; label: string; max: number }[] = [
  { key: "ticks", label: "Ticks", max: 1 },
  { key: "minutes", label: "Minutes", max: 59 },
  { key: "hours", label: "Hours", max: 24 },
  { key: "days", label: "Days", max: 366 },
];

export function cloneVisibility(v?: IndicatorVisibility): IndicatorVisibility {
  const base = v ?? DEFAULT_VISIBILITY;
  return {
    ticks: { ...base.ticks },
    minutes: { ...base.minutes },
    hours: { ...base.hours },
    days: { ...base.days },
  };
}

// chart timeframe -> (category, numeric value). null for timeframes we don't gate.
export function timeframeBucket(tf: string): { cat: keyof IndicatorVisibility; value: number } | null {
  if (tf === "tick") return { cat: "ticks", value: 1 };
  const m = /^(\d+)m$/.exec(tf);
  if (m) return { cat: "minutes", value: Number(m[1]) };
  const h = /^(\d+)h$/.exec(tf);
  if (h) return { cat: "hours", value: Number(h[1]) };
  const d = /^(\d+)D$/i.exec(tf);
  if (d) return { cat: "days", value: Number(d[1]) };
  return null;
}

export function isIndicatorVisibleOnTimeframe(ind: Pick<IndicatorInstance, "visibility">, tf: string): boolean {
  const vis = ind.visibility;
  if (!vis) return true;
  const b = timeframeBucket(tf);
  if (!b) return true;
  const c = vis[b.cat];
  if (!c) return true;
  return c.enabled && b.value >= c.from && b.value <= c.to;
}
