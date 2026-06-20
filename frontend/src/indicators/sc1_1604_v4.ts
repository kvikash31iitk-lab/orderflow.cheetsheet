// SC1 1604 V4 5S Orderflow — V3's faithful Pine math + visuals, but the lower-timeframe
// orderflow comes from EXPLICIT 5-second child bars instead of the parent bar's scalars.
//
// V3 read each parent bar's tick-derived totalAskVolume/totalBidVolume/delta/maxDelta/
// minDelta directly. V4 instead requests 5-second footprint children
// (ctx.requestFootprint("5S"), served on demand by the backend from stored ticks) and
// aggregates them into each parent bar exactly like the Pine source:
//   tvta.requestUpAndDownVolume("5S")  -> buyVol = Σ child.totalAskVolume,
//                                         sellVol = Σ child.totalBidVolume
//   tvta.requestVolumeDelta("5S", tf)  -> delta = Σ child.delta, and maxDelta/minDelta =
//                                         the max/min of the running CVD PATH stepping
//                                         through the 5s children within the parent bar.
//
// Built by patching the verified SC1 V3 script (formulas/visuals byte-identical) and
// injecting `applyLowerOrderflow()` right after the base series is built, which OVERRIDES
// BUY/SELL/D/MAXD/MIND. `volume` (VOL) stays the chart volume and the 1D-anchored CVD
// (I3) stays the parent session cumDelta, exactly as Pine uses them.
//
// Fallback: for parent bars OLDER than the fetched 5s window (the 5s endpoint is bounded
// to the most-recent ~25k buckets ≈ 34.7h) or below `min5sCoverage`, V4 keeps the parent
// bar's tick-derived scalars (the V3 path). We deliberately do NOT add a 1-minute fallback
// level: the parent scalar is tick-resolution and therefore a STRICTLY BETTER fallback than
// re-aggregating 1m bars (whose maxDelta/minDelta would be coarser), and it avoids a second
// always-on prefetch. The per-bar source is tracked in `lowerStatus` (debug-visible).
import { SC1_1604_V3_SCRIPT } from "./sc1_1604_v3";

function replaceOnce(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) {
    throw new Error(`SC1 V4 template anchor not found: ${search.slice(0, 60)}`);
  }
  return source.replace(search, replacement);
}

let script = SC1_1604_V3_SCRIPT;

// 1) rename the indicator
script = replaceOnce(script, 'indicator("SC1 1604 V3 Pine Parity", {', 'indicator("SC1 1604 V4 5S Orderflow", {');

// 2) V4 inputs (after the last super-signal input)
script = replaceOnce(
  script,
  "showSuperSignals: false,",
  `showSuperSignals: false,
    // ----- V4: 5-second lower-timeframe orderflow -----
    use5sOrderflow: true,            // aggregate ctx.requestFootprint("5S") children
    min5sCoverage: 0.70,             // min child coverage of a parent bar to use 5s
    fallbackToParentOrderflow: true, // older/low-coverage bars use parent scalars (V3)
    showLowerSourceDebug: false,     // plot a 5s-vs-parent source tally on the last bar`,
);

// 3) call the override right after the base series + VWAP are built
script = replaceOnce(
  script,
  "fillVwap(VWAPv, H, L, C, VOL, T);",
  `fillVwap(VWAPv, H, L, C, VOL, T);
    // V4: swap parent-bar orderflow for explicit 5-second child aggregation
    let lowerStatus = null;
    applyLowerOrderflow();`,
);

// 4) inject the aggregation helper (function declaration -> hoisted within onSeries)
script = replaceOnce(
  script,
  "    function fillVwap(vw, h, l, c, vol, t) {",
  `    // V4: aggregate 5-second footprint children into each parent bar and override the
    // order-flow arrays. literal ctx.requestFootprint("5S") so the host prefetches it.
    function applyLowerOrderflow() {
      if (input.use5sOrderflow === false) return;
      const minCov = numIn("min5sCoverage", 0.70);
      const allowParent = input.fallbackToParentOrderflow !== false;
      const five = ctx.requestFootprint("5S");
      if (!Array.isArray(five) || five.length === 0) { lowerStatus = { five: 0, parent: n, note: "no-5s-data" }; return; }
      const parentMs = (num(candles[0].endTime) - num(candles[0].startTime)) || (n > 1 ? T[1] - T[0] : 60000);
      const firstStart = num(five[0].startTime);
      let used5s = 0, usedParent = 0, j = 0;
      for (let i = 0; i < n; i++) {
        const start = T[i];
        const end = num(candles[i].endTime) || (start + parentMs);
        while (j < five.length && num(five[j].startTime) < start) j++;
        let k = j, buy = 0, sell = 0, delta = 0, run = 0, maxD = 0, minD = 0, bars = 0;
        while (k < five.length) {
          const c = five[k];
          const cs = num(c.startTime);
          if (cs >= end) break;
          buy += positive(c.totalAskVolume);
          sell += positive(c.totalBidVolume);
          const cd = num(c.delta);
          delta += cd;
          run += cd;
          if (run > maxD) maxD = run;
          if (run < minD) minD = run;
          bars += 1;
          k += 1;
        }
        const expected = Math.max(1, Math.round((end - start) / 5000));
        const covered = start >= firstStart && (bars / expected) >= minCov;
        if (covered) {
          BUY[i] = buy; SELL[i] = sell; D[i] = delta; MAXD[i] = maxD; MIND[i] = minD;
          used5s += 1;
        } else {
          // keep the parent bar's tick-derived scalars (already in the arrays)
          if (!allowParent && start >= firstStart) { BUY[i] = buy; SELL[i] = sell; D[i] = delta; MAXD[i] = maxD; MIND[i] = minD; }
          usedParent += 1;
        }
      }
      lowerStatus = { five: used5s, parent: usedParent, note: used5s > 0 ? "5s+parent-fallback" : "parent" };
      if (input.showLowerSourceDebug && endIndex >= 0) {
        ctx.shape({ time: candles[endIndex].startTime, price: H[endIndex] + range(endIndex), text: "5s " + used5s + " / parent " + usedParent, color: "#eab308", position: "above" });
      }
    }

    function fillVwap(vw, h, l, c, vol, t) {`,
);

export const SC1_1604_V4_SCRIPT = script;
