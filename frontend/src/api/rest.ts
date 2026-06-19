import type { AlertMsg, Fill, FootprintCandle, Order, Position, ResearchReport, ScannerRow, SymbolConfig } from "../types/orderflow";

export interface TradeOrderBody {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  price?: number | null;
}

export interface ResearchValidateBody {
  symbol: string;
  timeframe?: string;
  kind: string;
  horizon: number;
  limit?: number;
  params?: Record<string, number>; // optional threshold overrides (re-run engine)
}
export interface ResearchSweepBody extends ResearchValidateBody {
  grid: Record<string, number[]>;
}

const API = import.meta.env.VITE_API_URL || `http://${location.hostname}:8000`;

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  symbols: () => j<{ symbols: string[] }>("/api/symbols"),
  timeframes: () => j<{ timeframes: string[]; default: string }>("/api/timeframes"),
  scanner: () => j<{ rows: ScannerRow[] }>("/api/scanner"),
  alerts: (limit = 100) => j<{ alerts: AlertMsg[] }>(`/api/alerts?limit=${limit}`),
  status: () => j<Record<string, unknown>>("/api/status"),
  symbolConfig: () => j<Record<string, SymbolConfig>>("/api/symbol-config"),
  footprints: (symbol: string, timeframe: string, rowSize?: number, limit?: number) =>
    j<{ symbol: string; timeframe: string; candles: FootprintCandle[] }>(
      `/api/footprints?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}` +
        (rowSize ? `&rowSize=${rowSize}` : "") +
        (limit ? `&limit=${limit}` : ""),
    ),

  // replay controls
  replayLoad: (body: { symbol: string; start: number; end: number; timeframe?: string }) =>
    j("/api/replay/load", { method: "POST", body: JSON.stringify(body) }),
  replayPlay: (speed: number) =>
    j("/api/replay/play", { method: "POST", body: JSON.stringify({ speed }) }),
  replayPause: () => j("/api/replay/pause", { method: "POST" }),
  replayStep: () => j("/api/replay/step", { method: "POST" }),
  replayStop: () => j("/api/replay/stop", { method: "POST" }),

  // research / backtest
  researchValidate: (body: ResearchValidateBody) =>
    j<ResearchReport>("/api/research/validate", { method: "POST", body: JSON.stringify(body) }),
  researchSweep: (body: ResearchSweepBody) =>
    j<{ reports: ResearchReport[] }>("/api/research/sweep", { method: "POST", body: JSON.stringify(body) }),
  researchSync: (horizon = 5) =>
    j<{ updated: number }>(`/api/research/sync?horizon=${horizon}`, { method: "POST" }),

  // simulated trading
  tradeOrder: (body: TradeOrderBody) =>
    j<Order>("/api/trade/order", { method: "POST", body: JSON.stringify(body) }),
  tradeCancel: (orderId: number) =>
    j<{ ok: boolean }>("/api/trade/cancel", { method: "POST", body: JSON.stringify({ order_id: orderId }) }),
  tradeFlatten: (symbol: string) =>
    j<{ ok: boolean }>("/api/trade/flatten", { method: "POST", body: JSON.stringify({ symbol }) }),
  tradeState: () =>
    j<{ positions: Position[]; orders: Order[]; fills: Fill[] }>("/api/trade/state"),
};

export const API_BASE = API;
