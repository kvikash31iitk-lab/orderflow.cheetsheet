// Built-in example indicator scripts. These are plain text the user can read/edit in
// the Indicators panel. They exercise both authoring styles: per-candle (onCandle +
// shape) and whole-series (onSeries + plotLine).

export const DELTA_SPIKE_SCRIPT = `indicator("Delta Spike", {
  overlay: true,
  inputs: {
    minDelta: 5000
  },

  onCandle(ctx) {
    const c = ctx.candle;
    if (Math.abs(c.delta) >= ctx.inputs.minDelta) {
      ctx.shape({
        time: c.startTime,
        price: c.delta > 0 ? c.low : c.high,
        text: c.delta > 0 ? "Buy Δ" : "Sell Δ",
        color: c.delta > 0 ? "#22c55e" : "#ef4444",
        position: c.delta > 0 ? "below" : "above"
      });
    }
  }
});
`;

export const CVD_MA_SCRIPT = `indicator("CVD MA", {
  overlay: false,
  inputs: { length: 20 },

  onSeries(ctx) {
    const values = ctx.candles.map(c => c.cumDelta);
    const ma = sma(values, ctx.inputs.length);
    ctx.plotLine("CVD MA", ma.map((value, i) => ({
      time: ctx.candles[i].startTime,
      value
    })), {
      color: "#14b8a6",
      pane: "cumDelta"
    });
  }
});
`;

export const ANCHORED_VWAP_SCRIPT = `indicator("Anchored VWAP", {
  overlay: true,
  inputs: {
    anchorTime: 0,       // epoch ms of the picked anchor candle (0 = not anchored yet)
    anchorSymbol: "",    // symbol the anchor was picked on (guards cross-symbol draw)
    source: "hlc3",     // "hlc3" | "close" | "ohlc4"
    showBands: false,   // bands off by default; set true to also plot +/- SD bands
    bandStd1: 1,
    bandStd2: 2
  },

  onSeries(ctx) {
    const candles = ctx.candles;
    if (!candles || candles.length === 0) return;
    const inp = ctx.inputs;

    // anchor belongs to a different symbol -> draw nothing (avoid a misleading line)
    const anchorSym = String(inp.anchorSymbol || "");
    if (anchorSym && anchorSym !== ctx.symbol) return;

    // need a picked anchor; without one, draw nothing so the panel can prompt the user
    const anchorTime = Number(inp.anchorTime);
    if (!Number.isFinite(anchorTime) || anchorTime <= 0) return;

    // map the anchor to the first candle at/after anchorTime in the CURRENT timeframe
    let start = -1;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].startTime >= anchorTime) { start = i; break; }
    }
    if (start < 0) return; // anchor is after every loaded candle -> nothing to plot

    // ---- price + volume helpers ----
    function priceOf(c) {
      if (inp.source === "close") return c.close;
      if (inp.source === "ohlc4") return (c.open + c.high + c.low + c.close) / 4;
      return (c.high + c.low + c.close) / 3; // hlc3 (default)
    }
    function volumeOf(c) {
      if (Number.isFinite(c.totalVolume) && c.totalVolume > 0) return c.totalVolume;
      if (Number.isFinite(c.volume) && c.volume > 0) return c.volume;
      return 1; // keep the line going even when volume is missing
    }

    const s1 = Number(inp.bandStd1) || 1;
    const s2 = Number(inp.bandStd2) || 2;

    // ---- accumulate VWAP + weighted stdev from the anchor forward ----
    const vwapPts = [], up1 = [], dn1 = [], up2 = [], dn2 = [];
    let sumPV = 0, sumV = 0, sumP2V = 0;

    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      const p = priceOf(c);
      if (!Number.isFinite(p)) continue;
      const v = volumeOf(c);
      sumPV += p * v;
      sumV += v;
      sumP2V += p * p * v;
      if (sumV <= 0) continue;
      const vwap = sumPV / sumV;
      const variance = sumP2V / sumV - vwap * vwap;
      const sd = Math.sqrt(Math.max(0, variance));
      const t = c.startTime;
      vwapPts.push({ time: t, value: vwap });
      if (inp.showBands) {
        up1.push({ time: t, value: vwap + s1 * sd });
        dn1.push({ time: t, value: vwap - s1 * sd });
        up2.push({ time: t, value: vwap + s2 * sd });
        dn2.push({ time: t, value: vwap - s2 * sd });
      }
    }

    // ---- plot everything on the price pane ----
    ctx.plotLine("Anchored VWAP", vwapPts, { color: "#f59e0b", width: 2, pane: "price" });
    if (inp.showBands) {
      ctx.plotLine("AVWAP +1 SD", up1, { color: "#d9a441", width: 1, opacity: 0.75, pane: "price" });
      ctx.plotLine("AVWAP -1 SD", dn1, { color: "#d9a441", width: 1, opacity: 0.75, pane: "price" });
      ctx.plotLine("AVWAP +2 SD", up2, { color: "#9a6a1f", width: 1, opacity: 0.55, pane: "price" });
      ctx.plotLine("AVWAP -2 SD", dn2, { color: "#9a6a1f", width: 1, opacity: 0.55, pane: "price" });
    }

    // anchor marker at the anchor candle
    const a = candles[start];
    ctx.shape({
      time: a.startTime,
      price: a.low,
      text: "AVWAP",
      color: "#f59e0b",
      position: "below"
    });
  }
});
`;

export interface IndicatorExample {
  name: string;
  script: string;
}

export const EXAMPLES: IndicatorExample[] = [
  { name: "Delta Spike", script: DELTA_SPIKE_SCRIPT },
  { name: "CVD MA", script: CVD_MA_SCRIPT },
  { name: "Anchored VWAP", script: ANCHORED_VWAP_SCRIPT },
];
