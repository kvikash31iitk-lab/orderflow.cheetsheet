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

export interface IndicatorExample {
  name: string;
  script: string;
}

export const EXAMPLES: IndicatorExample[] = [
  { name: "Delta Spike", script: DELTA_SPIKE_SCRIPT },
  { name: "CVD MA", script: CVD_MA_SCRIPT },
];
