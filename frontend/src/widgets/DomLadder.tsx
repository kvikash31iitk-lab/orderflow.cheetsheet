import { useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Crosshair, Loader2 } from "lucide-react";
import { api } from "../api/rest";
import { consolidatedRowSize } from "../lib/rowsize";
import { useStore } from "../store/useStore";

const ROWS = 14; // price rows above/below mid
const SMOOTH_WIN = 4; // moving-average window over pulses (graceful depth transitions)

// deterministic pseudo-random in [0,1) so synthetic depth is stable per (row,tick)
function rnd(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Moving-average of the synthetic random factor across the last SMOOTH_WIN
// pulses. Consecutive pulses share SMOOTH_WIN-1 terms, so the size numbers and
// depth bars ease between values instead of flashing on every 700ms refresh.
function smoothFactor(row: number, pulse: number): number {
  let sum = 0;
  // distinct row/pulse frequencies so neighbouring rows differ and equal-sum
  // (row,pulse) pairs don't alias; averaged over `pulse - j` for temporal easing
  for (let j = 0; j < SMOOTH_WIN; j++) sum += 0.4 + 0.9 * rnd(row * 101.7 + (pulse - j) * 0.37);
  return sum / SMOOTH_WIN;
}

export default function DomLadder() {
  const symbol = useStore((s) => s.symbol);
  const consolidation = useStore((s) => s.consolidation);
  const candles = useStore((s) => s.candles);
  const positions = useStore((s) => s.positions);
  const orders = useStore((s) => s.orders);
  const [qty, setQty] = useState(1);
  const [pulse, setPulse] = useState(0); // drives the synthetic depth refresh
  const scrollRef = useRef<HTMLDivElement>(null);
  const replayActive = useStore((s) => s.replayActive);

  // seed positions/orders once on mount; live updates arrive over the WS
  useEffect(() => {
    api.tradeState().then((s) => useStore.setState({ positions: s.positions, orders: s.orders, fills: s.fills })).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setPulse((p) => p + 1), 700);
    return () => clearInterval(t);
  }, []);

  const rowSize = consolidatedRowSize(symbol, consolidation);
  const last = candles[candles.length - 1];
  const price = last?.close ?? null;
  const pos = positions.find((p) => p.symbol === symbol);

  const [ladderMid, setLadderMid] = useState<number | null>(null);

  // Initialize/re-center ladderMid when symbol, rowSize, or initial price changes
  useEffect(() => {
    if (price != null) {
      setLadderMid(Math.round(price / rowSize) * rowSize);
    }
  }, [symbol, rowSize, price == null]);

  // dynamically calculate decimal places from rowSize to prevent duplicates
  const dp = useMemo(() => {
    const s = String(rowSize);
    const dot = s.indexOf(".");
    if (dot === -1) return 0;
    return s.length - dot - 1;
  }, [rowSize]);

  const rows = useMemo(() => {
    if (ladderMid == null) return [];
    const out: { price: number; isAsk: boolean; bidSize: number; askSize: number }[] = [];
    for (let i = ROWS; i >= -ROWS; i--) {
      // quantise to the row's own decimal count (dp), not a hardcoded 4: a 0.00005
      // grid (6E) needs 5 dp, else adjacent rows collapse to duplicate prices ->
      // duplicate React keys, dead mid-highlight, and wrong limit-order prices.
      const p = +(ladderMid + i * rowSize).toFixed(dp);
      const dist = Math.abs(i);
      const size = Math.round((10 + 240 * Math.exp(-dist * 0.22)) * smoothFactor(i, pulse));
      out.push({ price: p, isAsk: i > 0, bidSize: i <= 0 ? size : 0, askSize: i >= 0 ? size : 0 });
    }
    return out;
  }, [ladderMid, rowSize, pulse, dp]);

  const maxBidSize = useMemo(() => Math.max(...rows.map((r) => r.bidSize), 1), [rows]);
  const maxAskSize = useMemo(() => Math.max(...rows.map((r) => r.askSize), 1), [rows]);

  // center the ladder on mid once we have rows
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [symbol, rowSize, ladderMid]);

  const placeLimit = (p: number, isAsk: boolean) =>
    api.tradeOrder({ symbol, side: isAsk ? "sell" : "buy", type: "limit", qty, price: p }).catch(() => {});
  const market = (side: "buy" | "sell") =>
    api.tradeOrder({ symbol, side, type: "market", qty }).catch(() => {});
  const cancel = (id: number) => api.tradeCancel(id).catch(() => {});

  const ordersAt = (p: number) =>
    orders.filter((o) => o.symbol === symbol && o.price != null && Math.abs(o.price - p) < rowSize / 2);

  const pnlColor = (v: number) => (v > 0 ? "text-flow-buyHi" : v < 0 ? "text-flow-sellHi" : "text-terminal-muted");
  const pnlBg = (v: number) => (v > 0 ? "bg-flow-buy/10 border-flow-buy/30" : v < 0 ? "bg-flow-sell/10 border-flow-sell/30" : "bg-terminal-bg/50 border-terminal-border/60");

  if (replayActive) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-terminal-border bg-terminal-bg p-6 text-center text-terminal-muted">
        <Clapperboard size={28} className="text-terminal-muted" />
        <span className="font-semibold text-xs text-terminal-text uppercase tracking-wider">DOM Inactive in Replay Mode</span>
        <p className="text-[10px] max-w-[200px] leading-normal font-sans">
          Simulated trading is locked while viewing historical replays. Exit Replay Mode to enable live DOM execution.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-terminal-bg text-xs">
      {/* Account Info Panel */}
      <div className="grid grid-cols-3 gap-1.5 p-2 border-b border-terminal-border bg-terminal-panel/30">
        <div className="bg-terminal-bg/40 border border-terminal-border/50 rounded p-1.5 flex flex-col items-center justify-center min-w-0">
          <span className="text-[9px] uppercase tracking-wider text-terminal-muted">Position</span>
          <span className={`text-xs font-bold truncate ${pos && pos.qty !== 0 ? (pos.qty > 0 ? "text-flow-buyHi" : "text-flow-sellHi") : "text-terminal-muted"}`}>
            {pos && pos.qty !== 0 ? (
              <span className="flex flex-col items-center">
                <span>{pos.qty > 0 ? "LONG" : "SHORT"} {Math.abs(pos.qty)}</span>
                <span className="text-[8px] text-terminal-muted font-mono">@ {pos.entryPrice?.toFixed(1)}</span>
              </span>
            ) : (
              "FLAT"
            )}
          </span>
        </div>

        <div className={`border rounded p-1.5 flex flex-col items-center justify-center min-w-0 transition-colors ${pnlBg(pos?.unrealisedPnl ?? 0)}`}>
          <span className="text-[9px] uppercase tracking-wider text-terminal-muted">Open PnL</span>
          <span className={`text-xs font-bold truncate ${pnlColor(pos?.unrealisedPnl ?? 0)}`}>
            {pos?.unrealisedPnl != null && pos.unrealisedPnl !== 0 ? (
              `${pos.unrealisedPnl > 0 ? "+" : ""}${pos.unrealisedPnl.toFixed(0)}`
            ) : (
              "0"
            )}
          </span>
        </div>

        <div className={`border rounded p-1.5 flex flex-col items-center justify-center min-w-0 transition-colors ${pnlBg(pos?.realisedPnl ?? 0)}`}>
          <span className="text-[9px] uppercase tracking-wider text-terminal-muted font-medium">Realised</span>
          <span className={`text-xs font-bold truncate ${pnlColor(pos?.realisedPnl ?? 0)}`}>
            {pos?.realisedPnl != null && pos.realisedPnl !== 0 ? (
              `${pos.realisedPnl > 0 ? "+" : ""}${pos.realisedPnl.toFixed(0)}`
            ) : (
              "0"
            )}
          </span>
        </div>
      </div>

      {/* Trading Controls Panel */}
      <div className="flex flex-col gap-2.5 p-2 border-b border-terminal-border bg-terminal-panel/20">
        {/* Quantity Controller & Center Button */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-terminal-muted font-bold">Qty</span>
            <button 
              onClick={() => {
                if (price != null) {
                  setLadderMid(Math.round(price / rowSize) * rowSize);
                }
                const el = scrollRef.current;
                if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
              }}
              className="flex items-center gap-0.5 rounded-md border border-terminal-border bg-terminal-panel px-1.5 py-0.5 text-[9px] font-bold uppercase text-terminal-text transition-colors hover:border-terminal-border-strong hover:bg-terminal-border/40"
              title="Recenter Ladder on Last Price"
            >
              <Crosshair size={11} /> Center
            </button>
          </div>
          
          <div className="flex items-center gap-1 flex-1 justify-end max-w-[170px]">
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              className="w-11 rounded border border-terminal-border/80 bg-terminal-bg px-1 py-0.5 text-center font-mono font-bold text-white focus:outline-none focus:border-flow-delta text-xs shadow-inner"
            />
            {/* Quick buttons */}
            <div className="flex gap-0.5">
              {[1, 5, 10, 50].map((q) => (
                <button
                  key={q}
                  onClick={() => setQty((prev) => prev + q)}
                  className="rounded border border-terminal-border/60 hover:border-terminal-muted bg-terminal-panel hover:bg-terminal-border text-[9px] font-semibold text-terminal-text px-1 py-0.5 transition-all active:scale-95"
                >
                  +{q}
                </button>
              ))}
              <button
                onClick={() => setQty(1)}
                className="rounded border border-terminal-border/60 hover:border-flow-sell bg-terminal-panel hover:bg-flow-sell/20 text-[9px] font-bold text-flow-sellHi px-1.5 py-0.5 transition-all active:scale-95"
                title="Reset Qty to 1"
              >
                C
              </button>
            </div>
          </div>
        </div>

        {/* Market Actions Grid */}
        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => market("buy")} className="btn-buy-mkt flex flex-col items-center py-1 rounded">
            <span className="text-[10px] font-bold tracking-wide">BUY MKT</span>
            <span className="text-[8px] opacity-75 font-normal uppercase">Join Ask</span>
          </button>
          <button onClick={() => market("sell")} className="btn-sell-mkt flex flex-col items-center py-1 rounded">
            <span className="text-[10px] font-bold tracking-wide">SELL MKT</span>
            <span className="text-[8px] opacity-75 font-normal uppercase">Join Bid</span>
          </button>
          <button 
            onClick={() => api.tradeFlatten(symbol).catch(() => {})} 
            className="btn-flatten flex flex-col items-center justify-center py-1 rounded"
          >
            <span className="text-[10px] font-bold tracking-wide">FLATTEN</span>
            <span className="text-[8px] opacity-75 font-normal uppercase">Close All</span>
          </button>
        </div>
      </div>

      {/* Ladder Container */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {price == null ? (
          <div className="p-4 text-center text-terminal-muted font-sans flex flex-col items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin text-terminal-muted" />
            <span>Waiting for market ticks...</span>
          </div>
        ) : (
          <table className="w-full border-collapse text-right font-mono table-fixed">
            <thead className="sticky top-0 bg-terminal-panel/90 backdrop-blur-sm z-30 text-[9px] uppercase tracking-wider text-terminal-muted border-b border-terminal-border">
              <tr>
                <th className="px-2.5 py-1.5 text-right font-semibold w-[30%] border-r border-terminal-border/20">Bid Depth</th>
                <th className="px-1.5 py-1.5 text-center font-semibold w-[28%] bg-terminal-bg/20">Price</th>
                <th className="px-2.5 py-1.5 text-left font-semibold w-[30%] border-l border-terminal-border/20">Ask Depth</th>
                <th className="px-1.5 py-1.5 text-left font-semibold w-[12%]">Orders</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const atMid = Math.abs(r.price - Math.round((price ?? 0) / rowSize) * rowSize) < 1e-6;
                const myOrders = ordersAt(r.price);
                const isEntryPrice = pos && pos.qty !== 0 && pos.entryPrice != null && Math.abs(r.price - pos.entryPrice) < rowSize / 2;

                return (
                  <tr 
                    key={r.price} 
                    className={`border-t border-terminal-border/10 transition-colors duration-100 group ${
                      atMid 
                        ? "bg-flow-delta/5 hover:bg-flow-delta/10" 
                        : isEntryPrice 
                          ? (pos.qty > 0 ? "bg-flow-buy/5 hover:bg-flow-buy/10" : "bg-flow-sell/5 hover:bg-flow-sell/10")
                          : "hover:bg-terminal-border/20"
                    }`}
                  >
                    {/* Bid Depth Column */}
                    <td 
                      onClick={() => placeLimit(r.price, false)}
                      className="dom-cell-bid px-2.5 py-1 text-right select-none relative group/cell border-r border-terminal-border/10 overflow-hidden"
                      title={`Place Buy Limit ${qty} @ ${r.price}`}
                    >
                      {/* Depth Bar Background */}
                      {r.bidSize > 0 && (
                        <div 
                          className="absolute right-0 top-0 bottom-0 bg-flow-buy/15 border-r border-flow-buy/30 transition-all duration-300 pointer-events-none"
                          style={{ width: `${(r.bidSize / maxBidSize) * 100}%` }}
                        />
                      )}
                      <span className="relative z-10 font-bold text-flow-buyHi text-[11px]">
                        {r.bidSize || ""}
                      </span>
                      {/* Hover action indicator */}
                      <span className="absolute left-1.5 top-1 z-20 text-[7px] font-bold text-flow-buyHi opacity-0 group-hover/cell:opacity-100 transition-opacity bg-flow-buy/20 px-1 rounded uppercase tracking-tighter">
                        Buy Limit
                      </span>
                    </td>

                    {/* Price Column */}
                    <td 
                      className={`px-1.5 py-1 text-center relative font-bold text-[11px] ${
                        atMid 
                          ? "text-white bg-flow-delta/20 border-y border-flow-delta/40" 
                          : isEntryPrice 
                            ? (pos.qty > 0 ? "text-flow-buyHi font-black" : "text-flow-sellHi font-black") 
                            : "text-terminal-text"
                      }`}
                    >
                      {r.price.toFixed(dp)}
                      
                      {/* Midprice indicator dot */}
                      {atMid && (
                        <span className="absolute right-1 top-[7px] w-1.5 h-1.5 rounded-full bg-flow-buyHi shadow shadow-flow-buyHi animate-ping" />
                      )}

                      {/* Position average entry badge */}
                      {isEntryPrice && (
                        <span 
                          className={`absolute left-0.5 top-1 z-20 text-[7px] font-bold uppercase px-0.5 rounded leading-none ${
                            pos.qty > 0 ? "bg-flow-buy text-white border border-flow-buyHi/30" : "bg-flow-sell text-white border border-flow-sellHi/30"
                          }`}
                          title={`Average Entry Price: ${pos.entryPrice}`}
                        >
                          {pos.qty > 0 ? "L" : "S"}
                        </span>
                      )}
                    </td>

                    {/* Ask Depth Column */}
                    <td 
                      onClick={() => placeLimit(r.price, true)}
                      className="dom-cell-ask px-2.5 py-1 text-left select-none relative group/cell border-l border-terminal-border/10 overflow-hidden"
                      title={`Place Sell Limit ${qty} @ ${r.price}`}
                    >
                      {/* Depth Bar Background */}
                      {r.askSize > 0 && (
                        <div 
                          className="absolute left-0 top-0 bottom-0 bg-flow-sell/15 border-l border-flow-sell/30 transition-all duration-300 pointer-events-none"
                          style={{ width: `${(r.askSize / maxAskSize) * 100}%` }}
                        />
                      )}
                      <span className="relative z-10 font-bold text-flow-sellHi text-[11px]">
                        {r.askSize || ""}
                      </span>
                      {/* Hover action indicator */}
                      <span className="absolute right-1.5 top-1 z-20 text-[7px] font-bold text-flow-sellHi opacity-0 group-hover/cell:opacity-100 transition-opacity bg-flow-sell/20 px-1 rounded uppercase tracking-tighter">
                        Sell Limit
                      </span>
                    </td>

                    {/* Working Orders Column */}
                    <td className="px-1.5 py-1 text-left relative overflow-visible">
                      {myOrders.map((o) => (
                        <span 
                          key={o.id} 
                          className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] font-bold shadow-sm border ${
                            o.side === "buy" 
                              ? "bg-flow-buy/20 border-flow-buy/40 text-flow-buyHi" 
                              : "bg-flow-sell/20 border-flow-sell/40 text-flow-sellHi"
                          }`}
                        >
                          <span>{o.side === "buy" ? "B" : "S"}{o.qty}</span>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              cancel(o.id);
                            }} 
                            className="hover:text-white text-terminal-muted hover:bg-white/10 rounded transition-colors font-bold px-0.5 text-[9px] leading-none" 
                            title="Cancel Order"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="border-t border-terminal-border bg-terminal-panel/20 px-2.5 py-1.5 text-[9px] text-terminal-muted flex items-center justify-between font-sans">
        <span>Simulated (paper) trading mode</span>
        <span>No real risk</span>
      </div>
    </div>
  );
}
