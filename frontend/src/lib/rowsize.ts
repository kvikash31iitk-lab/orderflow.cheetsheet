// Base footprint row size per instrument — mirrors backend SYMBOL_ROW_SIZE
// (app/market_data/aggregator.py). The consolidated row size sent to the backend
// is baseRowSize(symbol) * consolidation multiplier.
const BASE_ROW_SIZE: Record<string, number> = {
  "NIFTY-I": 0.1,
  "BANKNIFTY-I": 0.2,
  "FINNIFTY-I": 5,
  "MIDCPNIFTY-I": 5,
  "SENSEX-I": 10,
  // DataBento CME/COMEX futures (must mirror backend SYMBOL_CONFIG row_size, else
  // the WS subscribe rowSize mismatches and the chart drops every candle).
  "6E.V.0": 0.00005,
  "GC.V.0": 0.1,
};
const DEFAULT_BASE = 1;

export function baseRowSize(symbol: string): number {
  return BASE_ROW_SIZE[symbol.toUpperCase()] ?? DEFAULT_BASE;
}

export function consolidatedRowSize(symbol: string, consolidation: number): number {
  return baseRowSize(symbol) * (consolidation || 1);
}
