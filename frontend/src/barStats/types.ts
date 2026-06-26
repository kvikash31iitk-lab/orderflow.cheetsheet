// Bar Statistics — types + the honest capability model. Every metric is sourced from a
// real field on FootprintCandle (see barStatsEngine). Metrics whose data the current
// footprint payload does NOT carry (per-trade counts, buy/sell VWAP, OI, COT) are present
// but flagged `available: false` so the settings UI can disable them — we never fabricate.

export type BarStatMetricId =
  // available (exact or honest derivation)
  | "volume"
  | "delta"
  | "cumDelta"
  | "maxDelta"
  | "minDelta"
  | "buyVolume"
  | "sellVolume"
  | "buyPct"
  | "sellPct"
  | "deltaPct"
  | "deltaPerVol"
  | "poc"
  | "vwap"
  | "maxVolAtPrice"
  | "minVolAtPrice"
  | "tickCount"
  // unavailable with the current data model (shown disabled in settings)
  | "trades"
  | "buyTrades"
  | "sellTrades"
  | "buyTradePct"
  | "sellTradePct"
  | "vwapBuy"
  | "vwapSell"
  | "openInterest"
  | "oiChange"
  | "cotHigh"
  | "cotLow";

// how a metric's cell is coloured
export type BarStatRole =
  | "neutral" // magnitude intensity in slate/blue
  | "signed" // green when >0, red when <0, intensity by |value|
  | "buy" // green intensity (always positive)
  | "sell" // red intensity (always positive)
  | "price"; // a price level (POC/VWAP) — quiet, no fill

// how a metric's value is formatted
export type BarStatFormatKind = "volume" | "delta" | "pct" | "ratio" | "price" | "count";

export interface BarStatMetricDef {
  id: BarStatMetricId;
  label: string; // full row label
  short: string; // compact label for narrow label gutters
  available: boolean; // false -> the data model can't supply it honestly
  role: BarStatRole;
  format: BarStatFormatKind;
  hint?: string; // why it is disabled (shown in settings)
}

// Single source of truth for every metric + its honesty flag.
export const BAR_STAT_METRICS: readonly BarStatMetricDef[] = [
  { id: "volume", label: "Volume", short: "Vol", available: true, role: "neutral", format: "volume" },
  { id: "delta", label: "Delta", short: "Δ", available: true, role: "signed", format: "delta" },
  { id: "cumDelta", label: "Cum Delta", short: "CumΔ", available: true, role: "signed", format: "delta" },
  { id: "maxDelta", label: "Max Delta", short: "maxΔ", available: true, role: "signed", format: "delta" },
  { id: "minDelta", label: "Min Delta", short: "minΔ", available: true, role: "signed", format: "delta" },
  { id: "buyVolume", label: "Buy Volume", short: "Buy", available: true, role: "buy", format: "volume" },
  { id: "sellVolume", label: "Sell Volume", short: "Sell", available: true, role: "sell", format: "volume" },
  { id: "buyPct", label: "Buy %", short: "Buy%", available: true, role: "buy", format: "pct" },
  { id: "sellPct", label: "Sell %", short: "Sell%", available: true, role: "sell", format: "pct" },
  { id: "deltaPct", label: "Delta %", short: "Δ%", available: true, role: "signed", format: "pct" },
  { id: "deltaPerVol", label: "Delta / Vol", short: "Δ/V", available: true, role: "signed", format: "ratio" },
  { id: "poc", label: "POC", short: "POC", available: true, role: "price", format: "price" },
  { id: "vwap", label: "VWAP", short: "VWAP", available: true, role: "price", format: "price" },
  { id: "maxVolAtPrice", label: "Max Vol @ Price", short: "maxV@", available: true, role: "neutral", format: "volume" },
  { id: "minVolAtPrice", label: "Min Vol @ Price", short: "minV@", available: true, role: "neutral", format: "volume" },
  { id: "tickCount", label: "Tick Count", short: "Ticks", available: true, role: "neutral", format: "count" },
  // ---- not available with the current footprint payload (cells carry volume, not trades) ----
  { id: "trades", label: "Trades", short: "Trd", available: false, role: "neutral", format: "count", hint: "requires per-trade data" },
  { id: "buyTrades", label: "Buy Trades", short: "BTrd", available: false, role: "buy", format: "count", hint: "requires per-trade data" },
  { id: "sellTrades", label: "Sell Trades", short: "STrd", available: false, role: "sell", format: "count", hint: "requires per-trade data" },
  { id: "buyTradePct", label: "Buy Trade %", short: "BTrd%", available: false, role: "buy", format: "pct", hint: "requires per-trade data" },
  { id: "sellTradePct", label: "Sell Trade %", short: "STrd%", available: false, role: "sell", format: "pct", hint: "requires per-trade data" },
  { id: "vwapBuy", label: "Buy VWAP", short: "bVWAP", available: false, role: "price", format: "price", hint: "requires buy/sell VWAP" },
  { id: "vwapSell", label: "Sell VWAP", short: "sVWAP", available: false, role: "price", format: "price", hint: "requires buy/sell VWAP" },
  { id: "openInterest", label: "Open Interest", short: "OI", available: false, role: "neutral", format: "volume", hint: "requires OI feed" },
  { id: "oiChange", label: "OI Change", short: "ΔOI", available: false, role: "signed", format: "delta", hint: "requires OI feed" },
  { id: "cotHigh", label: "COT High", short: "COTH", available: false, role: "neutral", format: "price", hint: "requires COT data" },
  { id: "cotLow", label: "COT Low", short: "COTL", available: false, role: "neutral", format: "price", hint: "requires COT data" },
];

export const BAR_STAT_METRIC_MAP: Record<BarStatMetricId, BarStatMetricDef> = Object.fromEntries(
  BAR_STAT_METRICS.map((m) => [m.id, m]),
) as Record<BarStatMetricId, BarStatMetricDef>;

export const AVAILABLE_BAR_STAT_IDS: BarStatMetricId[] = BAR_STAT_METRICS.filter((m) => m.available).map((m) => m.id);

export type BarStatNumberFormat = "compact" | "absolute";

export interface BarStatSettings {
  enabled: BarStatMetricId[]; // ordered enabled metrics -> one row each (available ids only)
  preset: string;
  numberFormat: BarStatNumberFormat; // compact (1.5K) vs absolute (1500)
  percentDecimals: number; // 0..2
  colorIntensity: number; // 0..1 — max cell-fill alpha
  // colour overrides ("" -> theme/flow default)
  buyColor: string;
  sellColor: string;
  neutralColor: string;
  pocColor: string;
}

export interface BarStatPreset {
  name: string;
  hint: string;
  settings: Partial<BarStatSettings>;
}

// Presets only ever touch `enabled` + format/intensity — never fabricate metrics.
export const BAR_STAT_PRESETS: BarStatPreset[] = [
  { name: "Clean", hint: "Volume · Delta · Cum Delta", settings: { enabled: ["volume", "delta", "cumDelta"] } },
  {
    name: "GoCharting Balanced",
    hint: "Volume, delta, buy/sell split + POC",
    settings: { enabled: ["volume", "delta", "cumDelta", "buyVolume", "sellVolume", "deltaPct", "poc"] },
  },
  {
    name: "Delta Focus",
    hint: "Everything delta",
    settings: { enabled: ["delta", "cumDelta", "maxDelta", "minDelta", "deltaPct", "deltaPerVol"] },
  },
  {
    name: "Volume Focus",
    hint: "Volume + buy/sell composition",
    settings: { enabled: ["volume", "buyVolume", "sellVolume", "buyPct", "sellPct", "maxVolAtPrice", "poc"] },
  },
  {
    name: "Institutional Minimal",
    hint: "Compact 5-row default",
    settings: { enabled: ["volume", "delta", "cumDelta", "maxDelta", "minDelta"] },
  },
  {
    name: "Scalping",
    hint: "Fast read: delta %, buy/sell %, ticks",
    settings: { enabled: ["delta", "deltaPct", "cumDelta", "buyPct", "sellPct", "tickCount"] },
  },
];

export const DEFAULT_BAR_STAT_SETTINGS: BarStatSettings = {
  enabled: ["volume", "delta", "cumDelta", "maxDelta", "minDelta"],
  preset: "Institutional Minimal",
  numberFormat: "compact",
  percentDecimals: 0,
  colorIntensity: 0.55,
  buyColor: "",
  sellColor: "",
  neutralColor: "",
  pocColor: "",
};

// Per-bar computed metric values (null = not computable for this bar, e.g. no cells / no POC).
export interface BarStatPoint {
  time: number; // candle startTime (epoch ms)
  values: Partial<Record<BarStatMetricId, number | null>>;
  dp: number; // price decimal places (from rowSize) for price-format metrics
}
