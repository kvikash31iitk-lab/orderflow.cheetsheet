// Wire contract — mirrors backend app/orderflow/models.py to_dict() (camelCase).

// Footprint cell display modes (text shown inside each price row).
export type FootprintMode = "bidAsk" | "delta" | "volume" | "volumePercent";

// User-tunable footprint rendering settings (Settings modal -> store -> renderer).
export interface FootprintSettings {
  tickMultiplier: number;      // base tick-size grouping applied client-side (1,2,5,10)
  imbalanceRatio: number;      // ask/bid (or bid/ask) ratio to flag an imbalance (default 3.0)
  imbalanceMinVolume: number;  // minimum row volume required to flag an imbalance (default 50)
  showVwap: boolean;
  showSdBands: boolean;        // SD1 + SD2 bands
  showPoc: boolean;
  showImbalances: boolean;
  showBadges: boolean;         // LP / AD / Absorption / Exhaustion / DD tags
  showFills: boolean;          // execution triangles
  showThinCandle: boolean;     // thin candlestick drawn beside the footprint cells
  lockBlockSize: boolean;      // if true, ignores zoom-based consolidation k factor
}

// One backtested signal outcome (mirrors backend research.SignalOutcome).
export interface SignalOutcome {
  startTime: number; // epoch ms (candle start time)
  side: "long" | "short";
  entry: number;
  mae: number; // max adverse excursion
  mfe: number; // max favourable excursion
  ret: number; // signed return at the horizon
  win: boolean;
  endTime: number;      // epoch ms of exit candle
  exitPrice: number;    // close of exit candle
}

// Research / backtest report (mirrors backend research.ResearchReport.to_dict()).
export interface ResearchReport {
  label: string;
  n: number;
  winRate: number;
  expectancy: number;
  avgMae: number;
  avgMfe: number;
  outcomes?: SignalOutcome[];
}

export interface FootprintCell {
  price: number;
  bidVolume: number; // aggressive sell volume (executed at/below bid)
  askVolume: number; // aggressive buy volume (executed at/above ask)
  delta: number; // ask - bid
  total: number;
  buyImbalance: boolean;
  sellImbalance: boolean;
}

export interface ImbalanceZone {
  direction: "bullish" | "bearish";
  startPrice: number;
  endPrice: number;
  count: number;
}

export interface ActiveZone {
  direction: "bullish" | "bearish";
  startPrice: number;
  endPrice: number;
  startTime: number;
  mitigated: boolean;
  mitigationTime: number | null;
}

export interface Signals {
  absorption: boolean;
  absorptionPrice: number | null;
  absorptionSide: "bid" | "ask" | null;
  exhaustion: boolean;
  exhaustionType: "high" | "low" | null;
  lp: boolean;
  lpSide: "support" | "resistance" | null;
  lpPrice: number | null;
  ad: boolean;
  adValue: number;
  deltaSpike: boolean;
  volumeSpike: boolean;
  hvn: number[];
  lvn: number[];
  volumeCluster: boolean;
  deltaDivergence: boolean;
  deltaDivergenceSide: "bullish" | "bearish" | null;
  stackedImbalances: ImbalanceZone[];
  activeZones: ActiveZone[];
}

export interface FootprintCandle {
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  rowSize: number;
  open: number;
  high: number;
  low: number;
  close: number;
  cells: FootprintCell[];
  totalVolume: number;
  totalAskVolume: number;
  totalBidVolume: number;
  delta: number;
  cumDelta: number;
  vwap: number | null;
  vwapSd1Upper: number | null;
  vwapSd1Lower: number | null;
  vwapSd2Upper: number | null;
  vwapSd2Lower: number | null;
  maxDelta: number;
  minDelta: number;
  poc: number | null;
  marketStructure: string | null;
  signals: Signals;
  closed: boolean;
  tickCount: number;
  replay?: boolean;
}

export interface ConnStatus {
  state: string; // connected | reconnecting | disconnected
  source: string; // truedata | databento | simulator | none
  symbols: string[];
  liveSymbols?: string[]; // symbols on real data
  simSymbols?: string[];  // symbols on the synthetic fallback (e.g. no entitlement)
  lastTickMs: number;
  tickCount: number;
  connectedSinceMs: number;
  staleMs: number | null;
  message: string;
  clients?: number;
  pgEnabled?: boolean;
  redisEnabled?: boolean;
}

// Per-symbol order-flow tuning (mirrors backend SYMBOL_CONFIG via /api/symbol-config).
export interface SymbolConfig {
  row_size: number;
  imbalance_ratio: number;
  min_vol_for_highlight: number;
  stacked_imbalance_min: number;
  currency: string;
  tick_value: number;
}

export interface ScannerRow {
  symbol: string;
  timeframe: string;
  price: number;
  delta: number;
  cumDelta: number;
  absorption: boolean;
  exhaustion: boolean;
  lp: boolean;
  ad: boolean;
  imbalances: number;
  trend: string | null;
  signals: string[];
  updated: number;
}

export interface AlertMsg {
  ts: number;
  symbol: string;
  timeframe: string;
  type: string;
  severity: "info" | "warning" | "high" | string;
  message: string;
  payload: Record<string, unknown>;
}

// --- simulated trading ---
export interface Order {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  price: number | null;
  status: "working" | "filled" | "cancelled";
  timestamp: number;
}

export interface Position {
  symbol: string;
  qty: number;            // signed: + long, - short, 0 flat
  entryPrice: number | null;
  realisedPnl: number;
  unrealisedPnl: number;
}

export interface Fill {
  id: number;
  orderId: number;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  timestamp: number;
}

export type ServerMessage =
  | { type: "candle"; data: FootprintCandle }
  | { type: "snapshot"; data: { symbol: string; timeframe: string; candles: FootprintCandle[] } }
  | { type: "status"; data: ConnStatus }
  | { type: "alert"; data: AlertMsg }
  | { type: "replay"; data: ReplayState }
  | { type: "position"; data: Position[] }
  | { type: "orders"; data: Order[] }
  | { type: "fill"; data: Fill }
  | { type: "pong" };

export interface ReplayState {
  symbol: string;
  timeframe: string;
  index: number;
  total: number;
  progress: number;
  playing: boolean;
  speed: number;
  ts: number;
  exit?: boolean; // final frame when a replay ends -> client resyncs to live
}
