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
    anchorMode: "visibleStart", // "visibleStart" | "barIndex" | "sessionStart"
    anchorIndex: 0,             // used when anchorMode === "barIndex"
    source: "hlc3",            // "hlc3" | "close" | "ohlc4"
    showBands: true,
    bandStd1: 1,
    bandStd2: 2
  },

  onSeries(ctx) {
    const candles = ctx.candles;
    if (!candles || candles.length === 0) return;
    const inp = ctx.inputs;

    // ---- resolve the anchor candle index ----
    let start = 0;
    if (inp.anchorMode === "barIndex") {
      const idx = Math.floor(Number(inp.anchorIndex));
      start = Math.max(0, Math.min(candles.length - 1, Number.isFinite(idx) ? idx : 0));
    } else if (inp.anchorMode === "sessionStart") {
      // anchor at the first candle of the latest calendar day in the loaded data:
      // walk back from the last candle until the day changes.
      const last = new Date(candles[candles.length - 1].startTime);
      const y = last.getFullYear(), m = last.getMonth(), d = last.getDate();
      for (let i = candles.length - 1; i >= 0; i--) {
        const di = new Date(candles[i].startTime);
        if (di.getFullYear() !== y || di.getMonth() !== m || di.getDate() !== d) {
          start = i + 1;
          break;
        }
      }
    }
    // "visibleStart" (default): first loaded candle -> start stays 0. NOTE: true
    // viewport-left anchoring is not possible yet (the runtime does not expose the
    // chart's visible range), so this anchors from the first LOADED candle.

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
      ctx.plotLine("AVWAP +1σ", up1, { color: "#d9a441", width: 1, opacity: 0.75, pane: "price" });
      ctx.plotLine("AVWAP -1σ", dn1, { color: "#d9a441", width: 1, opacity: 0.75, pane: "price" });
      ctx.plotLine("AVWAP +2σ", up2, { color: "#9a6a1f", width: 1, opacity: 0.55, pane: "price" });
      ctx.plotLine("AVWAP -2σ", dn2, { color: "#9a6a1f", width: 1, opacity: 0.55, pane: "price" });
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
