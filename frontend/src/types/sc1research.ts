// SC1 V4 research-lab wire contract — mirrors backend app/research/sc1 dicts.
// This is the OFFLINE analysis surface for the live SC1 V4 indicator; it never changes
// the indicator itself.

export type Sc1Side = "long" | "short";
export type Sc1Class = "baseline" | "blocked_by_candle" | "near_miss";

export interface Sc1CoverageTf {
  timeframe: string;
  count: number;
  minStart: number;
  maxStart: number;
}
export interface Sc1Coverage {
  symbol: string;
  ticks: { minTs: number; maxTs: number; spanHours: number } | null;
  timeframes: Sc1CoverageTf[];
  notes: string[];
}

export type Sc1ComponentKey =
  | "swing" | "exhaust" | "absorption" | "trap" | "cvd"
  | "reversal" | "reject" | "strongClose" | "lowVol" | "liqSweep";

export interface Sc1Candidate {
  id: string;
  barIndex: number;
  startTime: number;
  endTime: number;
  side: Sc1Side;
  klass: Sc1Class;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  atr: number;
  bullStrength: number;
  bearStrength: number;
  netEdge: number;
  doji: boolean;
  hammer: boolean;
  invHammer: boolean;
  shootingStar: boolean;
  // attribution
  components: Record<Sc1ComponentKey, number>;
  weights: Record<Sc1ComponentKey, number>;
  penalty: number;
  bonus: number;
  rawStrength: number;
  trend: { bullHtf: boolean; bearHtf: boolean; bullAdx: boolean; bearAdx: boolean; adx: number | null };
}

export interface Sc1Inventory {
  baseline: { long: number; short: number };
  blocked_by_candle: { long: number; short: number };
  near_miss: { long: number; short: number };
  [k: string]: { long: number; short: number };
}

export interface Sc1RunReport {
  ok: boolean;
  error?: string;
  runId?: string;
  symbol?: string;
  timeframe?: string;
  configHash?: string;
  config?: Record<string, number | boolean | string>;
  range?: { minStart: number; maxStart: number; bars: number };
  orderflow?: { used5s: number; totalBars: number; source5sActive: boolean };
  inventory?: Sc1Inventory;
  byDay?: Record<string, { baseline: number; blocked_by_candle: number; near_miss: number }>;
  candidates: Sc1Candidate[];
}

export interface Sc1Summary {
  n: number;
  expectancyR: number;
  winRate: number;
  profitFactor: number | null;
  avgMae: number;
  avgMfe: number;
  medMae: number;
  medMfe: number;
  maxDrawdownR: number;
  long: number;
  short: number;
}

export interface Sc1ExitMatrixRow {
  class: Sc1Class;
  cells: Record<string, Sc1Summary>; // exitModel -> summary
}

export interface Sc1Trade {
  candidate_id: string;
  candidate_class: Sc1Class;
  side: Sc1Side;
  signal_time: number;
  entry_time: number;
  entry_price: number;
  entry_source: "tick" | "next_open" | "signal_close";
  exit_model: string;
  exit_time: number;
  exit_price: number;
  gross_points: number;
  net_points: number;
  r_multiple: number;
  mae: number;
  mfe: number;
  bars_held: number;
  win: boolean;
  reason: string;
  cost_points: number;
  slippage_points: number;
}

export interface Sc1ExitReport {
  ok: boolean;
  error?: string;
  runId?: string;
  models?: string[];
  matrix?: Sc1ExitMatrixRow[];
  overall?: Record<string, Sc1Summary>;
  exitConfig?: Record<string, number | number[]>;
  trades?: Sc1Trade[];
}

export interface Sc1LeaderRow extends Sc1Summary {
  changed: Record<string, number>;
  configHash: string;
  isBaseline: boolean;
  objective: number;
  warnings: string[];
}
export interface Sc1SweepReport {
  ok: boolean;
  error?: string;
  symbol?: string;
  timeframe?: string;
  exitModel?: string;
  baselineHash?: string;
  leaderboard?: Sc1LeaderRow[];
  note?: string;
}
