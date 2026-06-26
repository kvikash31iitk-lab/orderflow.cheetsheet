import { useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Crosshair, FlaskConical, Loader2, X } from "lucide-react";
import { api } from "../api/rest";
import { consolidatedRowSize } from "../lib/rowsize";
import { useStore } from "../store/useStore";
import { useContextMenu } from "../components/TerminalContextMenu";
import DomRowMenu from "./DomRowMenu";
import { DEFAULT_DRAWING_STYLE, drawingDisplayName, makeDrawingId } from "../drawings/types";

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
  const addDrawing = useStore((s) => s.addDrawing);
  const drawings = useStore((s) => s.drawings);
  const { menu, open, close } = useContextMenu<{ row: { price: number; bidSize: number; askSize: number } }>();

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

  const recenter = () => {
    if (price != null) setLadderMid(Math.round(price / rowSize) * rowSize);
    const el = scrollRef.current;
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  };
  // drop a horizontal line at a DOM price (reuses the standard drawing model — renders on the chart)
  const addHLine = (p: number) => {
    const now = Date.now();
    addDrawing({
      id: makeDrawingId(),
      type: "horizontal-line",
      name: drawingDisplayName("horizontal-line", drawings),
      symbol,
      points: [{ time: last?.startTime ?? now, price: p }],
      visible: true,
      locked: false,
      createdAt: now,
      updatedAt: now,
      style: { ...DEFAULT_DRAWING_STYLE },
    });
  };

  const ordersAt = (p: number) =>
    orders.filter((o) => o.symbol === symbol && o.price != null && Math.abs(o.price - p) < rowSize / 2);

  const pnlColor = (v: number) => (v > 0 ? "text-flow-buyHi" : v < 0 ? "text-flow-sellHi" : "text-terminal-muted");
  const pnlBg = (v: number) => (v > 0 ? "border-flow-buy/30 bg-flow-buy/10" : v < 0 ? "border-flow-sell/30 bg-flow-sell/10" : "border-terminal-border/60 bg-terminal-bg/40");
  // signed PnL string; 0 collapses to a plain "0" (matches the previous inline logic)
  const fmtPnl = (v: number) => (v === 0 ? "0" : `${v > 0 ? "+" : ""}${v.toFixed(0)}`);

  if (replayActive) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-terminal-border bg-terminal-bg p-6 text-center text-terminal-muted">
        <Clapperboard size={28} className="text-terminal-muted" />
        <span className="text-xs font-semibold uppercase tracking-wider text-terminal-text">DOM Inactive in Replay Mode</span>
        <p className="max-w-[200px] font-sans text-[10px] leading-normal">
          Simulated trading is locked while viewing historical replays. Exit Replay Mode to enable live DOM execution.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-terminal-bg text-xs">
      {/* Instrument + last price */}
      <div className="flex shrink-0 items-center justify-between border-b border-terminal-border bg-terminal-panel/40 px-2.5 py-1">
        <span className="truncate text-[11px] font-semibold tracking-wide text-terminal-text">{symbol}</span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-terminal-text">{price != null ? price.toFixed(dp) : "—"}</span>
      </div>

      {/* Position / PnL strip */}
      <div className="grid shrink-0 grid-cols-3 gap-1 border-b border-terminal-border bg-terminal-panel/20 p-1.5">
        <div
          className={`dom-stat ${
            pos && pos.qty !== 0
              ? pos.qty > 0
                ? "border-flow-buy/30 bg-flow-buy/10"
                : "border-flow-sell/30 bg-flow-sell/10"
              : "border-terminal-border/60 bg-terminal-bg/40"
          }`}
        >
          <span className="dom-stat-label">Position</span>
          <span
            className={`dom-stat-value ${
              pos && pos.qty !== 0 ? (pos.qty > 0 ? "text-flow-buyHi" : "text-flow-sellHi") : "text-terminal-muted"
            }`}
          >
            {pos && pos.qty !== 0 ? `${pos.qty > 0 ? "LONG" : "SHORT"} ${Math.abs(pos.qty)}` : "FLAT"}
          </span>
          <span className="text-[8px] leading-none tabular-nums text-terminal-muted">
            {pos && pos.qty !== 0 && pos.entryPrice != null ? `@ ${pos.entryPrice.toFixed(dp)}` : " "}
          </span>
        </div>

        <div className={`dom-stat ${pnlBg(pos?.unrealisedPnl ?? 0)}`}>
          <span className="dom-stat-label">Open PnL</span>
          <span className={`dom-stat-value ${pnlColor(pos?.unrealisedPnl ?? 0)}`}>{fmtPnl(pos?.unrealisedPnl ?? 0)}</span>
        </div>

        <div className={`dom-stat ${pnlBg(pos?.realisedPnl ?? 0)}`}>
          <span className="dom-stat-label">Realised</span>
          <span className={`dom-stat-value ${pnlColor(pos?.realisedPnl ?? 0)}`}>{fmtPnl(pos?.realisedPnl ?? 0)}</span>
        </div>
      </div>

      {/* Qty + market actions */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-terminal-border bg-terminal-panel/20 p-2">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold uppercase tracking-wider text-terminal-muted">Qty</span>
            <button
              onClick={recenter}
              className="dom-qty-btn flex items-center gap-1 uppercase"
              title="Recenter ladder on last price"
            >
              <Crosshair size={11} /> Center
            </button>
          </div>

          <div className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              className="tinput w-12 px-1 !text-center font-bold"
            />
            <div className="flex gap-0.5">
              {[1, 5, 10, 50].map((q) => (
                <button key={q} onClick={() => setQty((prev) => prev + q)} className="dom-qty-btn">
                  +{q}
                </button>
              ))}
              <button
                onClick={() => setQty(1)}
                className="dom-qty-btn !text-flow-sellHi hover:!border-flow-sell/50 hover:!bg-flow-sell/15"
                title="Reset qty to 1"
              >
                C
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => market("buy")} className="trade-btn trade-btn-buy">
            <span className="text-[10px] font-bold tracking-wide">BUY MKT</span>
            <span className="text-[8px] font-normal uppercase opacity-80">Join Ask</span>
          </button>
          <button onClick={() => market("sell")} className="trade-btn trade-btn-sell">
            <span className="text-[10px] font-bold tracking-wide">SELL MKT</span>
            <span className="text-[8px] font-normal uppercase opacity-80">Join Bid</span>
          </button>
          <button onClick={() => api.tradeFlatten(symbol).catch(() => {})} className="trade-btn trade-btn-flat">
            <span className="text-[10px] font-bold tracking-wide">FLATTEN</span>
            <span className="text-[8px] font-normal uppercase opacity-70">Close All</span>
          </button>
        </div>
      </div>

      {/* Ladder */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {price == null ? (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-center font-sans text-terminal-muted">
            <Loader2 size={16} className="animate-spin text-terminal-muted" />
            <span>Waiting for market ticks…</span>
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-right font-mono">
            <thead className="sticky top-0 z-30 border-b border-terminal-border bg-terminal-panel/95 text-[9px] uppercase tracking-wider text-terminal-muted backdrop-blur-sm">
              <tr>
                <th className="w-[30%] px-2 py-1.5 text-right font-semibold">Bid</th>
                <th className="w-[28%] px-1.5 py-1.5 text-center font-semibold">Price</th>
                <th className="w-[30%] px-2 py-1.5 text-left font-semibold">Ask</th>
                <th className="w-[12%] px-1.5 py-1.5 text-left font-semibold">Ord</th>
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
                    onContextMenu={(e) => open(e, { row: { price: r.price, bidSize: r.bidSize, askSize: r.askSize } })}
                    className={`border-t border-terminal-border/10 transition-colors duration-100 ${
                      atMid
                        ? "bg-accent/[0.07]"
                        : isEntryPrice
                          ? pos.qty > 0
                            ? "bg-flow-buy/[0.06]"
                            : "bg-flow-sell/[0.06]"
                          : "hover:bg-terminal-border/20"
                    }`}
                  >
                    {/* Bid depth (click = buy limit) */}
                    <td
                      onClick={() => placeLimit(r.price, false)}
                      className="dom-cell dom-cell-bid group/cell text-right"
                      title={`Place Buy Limit ${qty} @ ${r.price}`}
                    >
                      {r.bidSize > 0 && (
                        <div
                          className="dom-depth-bar right-0 border-l border-flow-buy/30 bg-flow-buy/15"
                          style={{ width: `${(r.bidSize / maxBidSize) * 100}%` }}
                        />
                      )}
                      <span className="relative z-10 font-semibold text-flow-buyHi">{r.bidSize || ""}</span>
                      <span className="absolute left-1 top-1/2 z-20 hidden -translate-y-1/2 rounded bg-flow-buy/20 px-1 text-[7px] font-bold uppercase tracking-tight text-flow-buyHi group-hover/cell:block">
                        Buy
                      </span>
                    </td>

                    {/* Price (anchor) */}
                    <td
                      className={`dom-price-cell ${
                        atMid
                          ? "border-y border-accent/40 bg-accent/15 text-terminal-text"
                          : isEntryPrice
                            ? pos.qty > 0
                              ? "text-flow-buyHi"
                              : "text-flow-sellHi"
                            : "text-terminal-text"
                      }`}
                    >
                      {r.price.toFixed(dp)}
                      {atMid && <span className="absolute right-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent" />}
                      {isEntryPrice && (
                        <span
                          className={`absolute left-0.5 top-1/2 z-20 -translate-y-1/2 rounded px-0.5 text-[7px] font-bold uppercase leading-none text-white ${
                            pos.qty > 0 ? "bg-flow-buy" : "bg-flow-sell"
                          }`}
                          title={`Average entry price: ${pos.entryPrice}`}
                        >
                          {pos.qty > 0 ? "L" : "S"}
                        </span>
                      )}
                    </td>

                    {/* Ask depth (click = sell limit) */}
                    <td
                      onClick={() => placeLimit(r.price, true)}
                      className="dom-cell dom-cell-ask group/cell text-left"
                      title={`Place Sell Limit ${qty} @ ${r.price}`}
                    >
                      {r.askSize > 0 && (
                        <div
                          className="dom-depth-bar left-0 border-r border-flow-sell/30 bg-flow-sell/15"
                          style={{ width: `${(r.askSize / maxAskSize) * 100}%` }}
                        />
                      )}
                      <span className="relative z-10 font-semibold text-flow-sellHi">{r.askSize || ""}</span>
                      <span className="absolute right-1 top-1/2 z-20 hidden -translate-y-1/2 rounded bg-flow-sell/20 px-1 text-[7px] font-bold uppercase tracking-tight text-flow-sellHi group-hover/cell:block">
                        Sell
                      </span>
                    </td>

                    {/* Working orders */}
                    <td className="px-1 py-1 text-left align-middle">
                      <div className="flex flex-wrap gap-0.5">
                        {myOrders.map((o) => (
                          <span
                            key={o.id}
                            className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[8px] font-bold tabular-nums ${
                              o.side === "buy"
                                ? "border-flow-buy/40 bg-flow-buy/15 text-flow-buyHi"
                                : "border-flow-sell/40 bg-flow-sell/15 text-flow-sellHi"
                            }`}
                          >
                            {o.side === "buy" ? "B" : "S"}
                            {o.qty}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cancel(o.id);
                              }}
                              className="row-icon-btn !h-3.5 !w-3.5"
                              title="Cancel order"
                            >
                              <X size={9} strokeWidth={2.5} />
                            </button>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer / status */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-terminal-border bg-terminal-panel/20 px-2.5 py-1 text-[9px] text-terminal-muted">
        <span className="flex items-center gap-1">
          <FlaskConical size={10} /> Simulated · paper trading
        </span>
        <span>No real risk</span>
      </div>

      {menu && (
        <DomRowMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          dp={dp}
          symbol={symbol}
          onRecenter={recenter}
          onAddHLine={addHLine}
          onClose={close}
        />
      )}
    </div>
  );
}
