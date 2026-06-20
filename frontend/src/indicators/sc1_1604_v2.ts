import { SC1_1604_SCRIPT } from "./sc1_1604";

function replaceOnce(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) {
    throw new Error(`SC1 V2 template anchor not found: ${search.slice(0, 60)}`);
  }
  return source.replace(search, replacement);
}

let script = SC1_1604_SCRIPT;

script = replaceOnce(script, 'indicator("SC1 1604 Replica", {', 'indicator("SC1 1604 V2", {');

script = replaceOnce(
  script,
  '    showDebugStrength: false,',
  `    showDebugStrength: false,
    // V2: pull lower-timeframe footprint candles through ctx.requestFootprint().
    // The host prefetches this before the sandbox run. If unavailable, V2 falls back
    // to the current chart candle's order-flow fields exactly like V1.
    useLowerFootprint: true,
    lowerTimeframe: "1m",
    lowerDataMinCoverage: 0.25,`,
);

script = replaceOnce(
  script,
  `    const n = candles.length;
    if (n < 80) return;`,
  `    const n = candles.length;
    if (n < 80) return;

    const lowerTimeframe = String(input.lowerTimeframe || "1m");
    const lowerFootprints = input.useLowerFootprint === false
      ? []
      : (lowerTimeframe === "1m" ? ctx.requestFootprint("1m") : ctx.requestFootprint(lowerTimeframe));`,
);

script = replaceOnce(
  script,
  `      POC[i] = finite(x.poc) ? Number(x.poc) : NaN;
    }

    fillMissingCvd(CVD, D);`,
  `      POC[i] = finite(x.poc) ? Number(x.poc) : NaN;
    }

    const LOWER = buildLowerFootprintStats(candles, lowerFootprints, lowerTimeframe);
    applyLowerFootprintStats(LOWER);

    fillMissingCvd(CVD, D);`,
);

script = replaceOnce(
  script,
  `    function footprintStats(i) {`,
  `    function buildLowerFootprintStats(parents, lower, lowerTf) {
      const out = new Array(parents.length);
      if (!Array.isArray(lower) || lower.length === 0) return out;
      const lowerMs = timeframeMs(lowerTf) || inferLowerMs(lower) || 60 * 1000;
      let j = 0;
      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i] || {};
        const start = Number(parent.startTime);
        const end = Number(parent.endTime) || start + timeframeMs(ctx.timeframe) || start;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        while (j < lower.length && Number(lower[j].endTime || lower[j].startTime) <= start) j++;
        let k = j;
        let ask = 0, bid = 0, volume = 0, runningDelta = 0, maxDelta = 0, minDelta = 0;
        let bars = 0, buyImb = 0, sellImb = 0, bullAbs = 0, bearAbs = 0, pocLow = 0, pocHigh = 0;
        while (k < lower.length) {
          const c = lower[k] || {};
          const cs = Number(c.startTime);
          if (!Number.isFinite(cs) || cs >= end) break;
          const ce = Number(c.endTime) || cs + lowerMs;
          if (ce > start) {
            bars++;
            const a = positive(c.totalAskVolume);
            const b = positive(c.totalBidVolume);
            ask += a;
            bid += b;
            volume += positive(c.totalVolume) || a + b;
            runningDelta += num(c.delta);
            maxDelta = Math.max(maxDelta, runningDelta, num(c.maxDelta));
            minDelta = Math.min(minDelta, runningDelta, num(c.minDelta));
            const sig = c.signals || {};
            const cells = Array.isArray(c.cells) ? c.cells : [];
            const cpoc = finite(c.poc) ? Number(c.poc) : NaN;
            for (let x = 0; x < cells.length; x++) {
              const cell = cells[x] || {};
              if (cell.buyImbalance) buyImb++;
              if (cell.sellImbalance) sellImb++;
              if (Number.isFinite(cpoc) && Math.abs(num(cell.price) - cpoc) <= Math.max(num(c.rowSize), tickSize(i)) / 2) {
                if (cpoc <= num(c.low) + Math.max(num(c.high) - num(c.low), tickSize(i)) * 0.33 && num(cell.delta) >= 0) pocLow++;
                if (cpoc >= num(c.high) - Math.max(num(c.high) - num(c.low), tickSize(i)) * 0.33 && num(cell.delta) <= 0) pocHigh++;
              }
            }
            const zones = Array.isArray(sig.stackedImbalances) ? sig.stackedImbalances : [];
            for (let z = 0; z < zones.length; z++) {
              if (zones[z] && zones[z].direction === "bullish") buyImb += Math.max(1, num(zones[z].count));
              if (zones[z] && zones[z].direction === "bearish") sellImb += Math.max(1, num(zones[z].count));
            }
            if (sig.absorption && sig.absorptionSide === "bid") bullAbs++;
            if (sig.absorption && sig.absorptionSide === "ask") bearAbs++;
          }
          k++;
        }
        if (bars > 0 && volume > 0) {
          const expected = Math.max(1, Math.round((end - start) / lowerMs));
          out[i] = { ask, bid, volume, delta: ask - bid, maxDelta, minDelta, bars, coverage: Math.min(1, bars / expected), buyImb, sellImb, bullAbs, bearAbs, pocLow, pocHigh };
        }
      }
      return out;
    }

    function applyLowerFootprintStats(lowerStats) {
      if (input.useLowerFootprint === false) return;
      const minCoverage = numberInput("lowerDataMinCoverage", 0.25);
      for (let i = 0; i < lowerStats.length; i++) {
        const s = lowerStats[i];
        if (!s || s.volume <= 0 || s.coverage < minCoverage) continue;
        ASK[i] = s.ask;
        BID[i] = s.bid;
        V[i] = s.volume;
        D[i] = s.delta;
        MAXD[i] = s.maxDelta;
        MIND[i] = s.minDelta;
      }
    }

    function timeframeMs(tf) {
      if (tf === "tick") return 0;
      if (tf === "1m") return 60 * 1000;
      if (tf === "2m") return 2 * 60 * 1000;
      if (tf === "3m") return 3 * 60 * 1000;
      if (tf === "5m") return 5 * 60 * 1000;
      if (tf === "15m") return 15 * 60 * 1000;
      if (tf === "30m") return 30 * 60 * 1000;
      if (tf === "1h") return 60 * 60 * 1000;
      if (tf === "4h") return 4 * 60 * 60 * 1000;
      if (tf === "1D") return 24 * 60 * 60 * 1000;
      return 0;
    }

    function inferLowerMs(rows) {
      for (let i = 1; i < rows.length; i++) {
        const a = Number(rows[i - 1] && rows[i - 1].startTime);
        const b = Number(rows[i] && rows[i].startTime);
        const d = b - a;
        if (Number.isFinite(d) && d > 0) return d;
      }
      return 0;
    }

    function footprintStats(i) {
      const lower = LOWER[i];
      if (input.useLowerFootprint !== false && lower && lower.volume > 0 && lower.coverage >= numberInput("lowerDataMinCoverage", 0.25)) {
        return {
          bullImbalance: lower.buyImb >= 2,
          bearImbalance: lower.sellImb >= 2,
          bullAbsorption: lower.bullAbs > 0,
          bearAbsorption: lower.bearAbs > 0,
          pocLow: lower.pocLow > 0,
          pocHigh: lower.pocHigh > 0
        };
      }`,
);

export const SC1_1604_V2_SCRIPT = script;
