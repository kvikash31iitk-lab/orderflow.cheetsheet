// Dashboard-native port of the supplied TradingView Pine indicator:
// "SC1 1604_ New".
//
// The script is intentionally stored as editable custom-indicator text. Users can
// add it from the fx panel, inspect it, tune the inputs, and later promote pieces
// into first-class UI controls if desired.

export const SC1_1604_SCRIPT = `indicator("SC1 1604 Replica", {
  overlay: true,
  inputs: {
    // Pine-compatible mode keeps the final Super Signal driven by Indicator 1 only,
    // matching the supplied script. Composite mode votes I1/I2/I3 together.
    superMode: "pine", // "pine" | "composite"
    triggerRule: "one", // "one" | "two" | "all"
    confirmOnClose: true,
    skipConflictingBars: true,
    cooldownBars: 4,
    showComponentMarkers: true,
    showI1Markers: true,
    showI2Markers: false,
    showI3Markers: false,
    showSuperSignals: false,
    showTrendLines: false,
    showDebugStrength: false,

    // Indicator 1: swing/sweep/exhaustion/absorption/trap reversal engine.
    i1Enabled: true,
    i1SwingLookback: 24,
    i1VolLen: 20,
    i1RsiLen: 14,
    i1AtrLen: 14,
    i1FastEma: 9,
    i1SlowEma: 21,
    i1TrendEma: 55,
    i1AdxLen: 14,
    i1StrengthThreshold: 0.62,
    i1SetupThreshold: 0.42,
    i1HighVolMult: 1.35,
    i1LowVolMult: 0.78,
    i1SweepAtr: 0.10,
    i1ProximityAtr: 0.45,
    i1MinBodyPct: 0.18,
    i1MinRejectPct: 0.34,
    i1DeltaPct: 0.18,

    // Indicator 2: upgraded reversal model with order-flow, structure and trend gates.
    i2Enabled: true,
    i2StrengthThreshold: 0.66,
    i2SetupThreshold: 0.48,
    i2StructureLookback: 18,
    i2CounterTrendAdx: 26,
    i2RequireMicroTrigger: true,
    i2FlowWeight: 0.14,
    i2PullbackBoost: 0.08,
    i2ContinuationBoost: 0.08,

    // Indicator 3: trend-continuation/pullback engine with FVG + footprint proxy.
    i3Enabled: true,
    i3FastEma: 13,
    i3SlowEma: 34,
    i3TrendEma: 89,
    i3AdxLen: 14,
    i3MinAdx: 16,
    i3StrengthThreshold: 0.62,
    i3PullbackAtr: 0.75,
    i3QuietVolMult: 0.92,
    i3FvgLookback: 40,
    i3UseFootprint: true,
    i3UseFvg: true
  },

  onSeries(ctx) {
    const candles = ctx.candles || [];
    const input = ctx.inputs || {};
    const n = candles.length;
    if (n < 80) return;

    const endIndex = input.confirmOnClose && candles[n - 1] && candles[n - 1].closed === false ? n - 2 : n - 1;
    if (endIndex < 80) return;

    const O = new Array(n), H = new Array(n), L = new Array(n), C = new Array(n);
    const V = new Array(n), D = new Array(n), CVD = new Array(n), MAXD = new Array(n), MIND = new Array(n);
    const ASK = new Array(n), BID = new Array(n), SRC = new Array(n), VWAP = new Array(n), POC = new Array(n);

    for (let i = 0; i < n; i++) {
      const x = candles[i] || {};
      O[i] = num(x.open);
      H[i] = num(x.high);
      L[i] = num(x.low);
      C[i] = num(x.close);
      ASK[i] = positive(x.totalAskVolume);
      BID[i] = positive(x.totalBidVolume);
      V[i] = positive(x.totalVolume) || ASK[i] + BID[i] || Math.abs(num(x.delta)) || 1;
      D[i] = num(x.delta);
      CVD[i] = num(x.cumDelta);
      MAXD[i] = num(x.maxDelta);
      MIND[i] = num(x.minDelta);
      SRC[i] = (H[i] + L[i] + C[i]) / 3;
      VWAP[i] = finite(x.vwap) ? Number(x.vwap) : NaN;
      POC[i] = finite(x.poc) ? Number(x.poc) : NaN;
    }

    fillMissingCvd(CVD, D);
    const sessionVwap = buildSessionVwap(candles, SRC, V, VWAP);
    const i1 = runI1();
    const i2 = runI2(i1);
    const i3 = runI3();
    drawOutputs(i1, i2, i3);

    function runI1() {
      const out = blankState();
      const swingLen = intInput("i1SwingLookback", 24);
      const volLen = intInput("i1VolLen", 20);
      const atrLen = intInput("i1AtrLen", 14);
      const rsiLen = intInput("i1RsiLen", 14);
      const fastLen = intInput("i1FastEma", 9);
      const slowLen = intInput("i1SlowEma", 21);
      const trendLen = intInput("i1TrendEma", 55);
      const adxLen = intInput("i1AdxLen", 14);
      const threshold = numberInput("i1StrengthThreshold", 0.62);
      const setupThreshold = numberInput("i1SetupThreshold", 0.42);
      const highVolMult = numberInput("i1HighVolMult", 1.35);
      const lowVolMult = numberInput("i1LowVolMult", 0.78);
      const sweepAtr = numberInput("i1SweepAtr", 0.10);
      const proxAtr = numberInput("i1ProximityAtr", 0.45);
      const minBody = numberInput("i1MinBodyPct", 0.18);
      const minReject = numberInput("i1MinRejectPct", 0.34);
      const deltaNeed = numberInput("i1DeltaPct", 0.18);

      const volMa = smaLocal(V, volLen);
      const atrA = atrLocal(H, L, C, atrLen);
      const rsiA = rsiLocal(C, rsiLen);
      const emaFast = emaLocal(C, fastLen);
      const emaSlow = emaLocal(C, slowLen);
      const emaTrend = emaLocal(C, trendLen);
      const dmi = dmiLocal(H, L, C, adxLen);
      const cvdEma = emaLocal(CVD, 8);
      let lastBull = -9999;
      let lastBear = -9999;

      for (let i = Math.max(swingLen + 2, trendLen); i <= endIndex; i++) {
        const atr = safe(atrA[i], range(i));
        const priorLow = lowestBefore(L, swingLen, i);
        const priorHigh = highestBefore(H, swingLen, i);
        const r = Math.max(range(i), tickSize(i));
        const bodyPct = Math.abs(C[i] - O[i]) / r;
        const lowerWickPct = (Math.min(O[i], C[i]) - L[i]) / r;
        const upperWickPct = (H[i] - Math.max(O[i], C[i])) / r;
        const closePosition = closePos(i);
        const vma = safe(volMa[i], V[i]);
        const highVolume = V[i] >= vma * highVolMult;
        const lowVolume = V[i] <= vma * lowVolMult;
        const dPct = deltaPct(i);
        const cvdDiff = CVD[i] - safe(CVD[Math.max(0, i - 5)], CVD[i]);
        const cvdSlope = safe(cvdEma[i] - cvdEma[i - 3], 0);
        const trendDown = C[i] < emaTrend[i] && emaFast[i] < emaSlow[i];
        const trendUp = C[i] > emaTrend[i] && emaFast[i] > emaSlow[i];

        const bullNearSwing = clamp01(1 - Math.max(0, L[i] - priorLow) / Math.max(atr * proxAtr, tickSize(i)));
        const bearNearSwing = clamp01(1 - Math.max(0, priorHigh - H[i]) / Math.max(atr * proxAtr, tickSize(i)));
        const bullSweep = L[i] < priorLow - atr * sweepAtr && C[i] > priorLow;
        const bearSweep = H[i] > priorHigh + atr * sweepAtr && C[i] < priorHigh;
        const bullReject = lowerWickPct >= minReject && closePosition >= 0.55;
        const bearReject = upperWickPct >= minReject && closePosition <= 0.45;
        const bullStrongClose = closePosition >= 0.67 && bodyPct >= minBody;
        const bearStrongClose = closePosition <= 0.33 && bodyPct >= minBody;
        const bullExhaustion = lowVolume && bullNearSwing > 0.5 && lowerWickPct > 0.25;
        const bearExhaustion = lowVolume && bearNearSwing > 0.5 && upperWickPct > 0.25;
        const bullAbsorption = highVolume && D[i] <= -V[i] * deltaNeed && C[i] >= O[i] && closePosition >= 0.50;
        const bearAbsorption = highVolume && D[i] >= V[i] * deltaNeed && C[i] <= O[i] && closePosition <= 0.50;
        const bullTrap = bullSweep && (D[i] < 0 || MIND[i] < -V[i] * 0.12) && C[i] > O[i];
        const bearTrap = bearSweep && (D[i] > 0 || MAXD[i] > V[i] * 0.12) && C[i] < O[i];
        const bullCvd = clamp01((cvdDiff > 0 ? 0.55 : 0) + (cvdSlope > 0 ? 0.35 : 0) + (dPct > 0 ? 0.25 : 0));
        const bearCvd = clamp01((cvdDiff < 0 ? 0.55 : 0) + (cvdSlope < 0 ? 0.35 : 0) + (dPct < 0 ? 0.25 : 0));
        const bullConfirm = (crossedOver(C, emaFast, i) || (C[i] > emaFast[i] && rsiA[i] > rsiA[i - 1] && rsiA[i] > 43)) ? 1 : 0;
        const bearConfirm = (crossedUnder(C, emaFast, i) || (C[i] < emaFast[i] && rsiA[i] < rsiA[i - 1] && rsiA[i] < 57)) ? 1 : 0;
        const bullTrendPenalty = trendDown && dmi.adx[i] > 28 ? 0.08 : 0;
        const bearTrendPenalty = trendUp && dmi.adx[i] > 28 ? 0.08 : 0;

        const bullSetup =
          0.28 * bullNearSwing +
          0.18 * boolScore(bullReject) +
          0.16 * boolScore(bullSweep) +
          0.14 * boolScore(bullAbsorption) +
          0.12 * boolScore(bullTrap) +
          0.12 * boolScore(bullExhaustion);
        const bearSetup =
          0.28 * bearNearSwing +
          0.18 * boolScore(bearReject) +
          0.16 * boolScore(bearSweep) +
          0.14 * boolScore(bearAbsorption) +
          0.12 * boolScore(bearTrap) +
          0.12 * boolScore(bearExhaustion);

        const bullStrength = clamp01(
          0.14 * bullNearSwing +
          0.12 * boolScore(bullReject) +
          0.08 * boolScore(bullExhaustion) +
          0.10 * boolScore(bullStrongClose) +
          0.15 * boolScore(bullSweep) +
          0.15 * boolScore(bullAbsorption) +
          0.14 * boolScore(bullTrap) +
          0.06 * bullCvd +
          0.08 * bullConfirm -
          bullTrendPenalty
        );
        const bearStrength = clamp01(
          0.14 * bearNearSwing +
          0.12 * boolScore(bearReject) +
          0.08 * boolScore(bearExhaustion) +
          0.10 * boolScore(bearStrongClose) +
          0.15 * boolScore(bearSweep) +
          0.15 * boolScore(bearAbsorption) +
          0.14 * boolScore(bearTrap) +
          0.06 * bearCvd +
          0.08 * bearConfirm -
          bearTrendPenalty
        );

        let bullSignal = bullStrength >= threshold && bullSetup >= setupThreshold;
        let bearSignal = bearStrength >= threshold && bearSetup >= setupThreshold;
        if (input.skipConflictingBars && bullSignal && bearSignal) {
          if (bullStrength > bearStrength) bearSignal = false;
          else if (bearStrength > bullStrength) bullSignal = false;
          else bullSignal = bearSignal = false;
        }
        if (bullSignal && i - lastBull <= input.cooldownBars) bullSignal = false;
        if (bearSignal && i - lastBear <= input.cooldownBars) bearSignal = false;
        if (bullSignal) lastBull = i;
        if (bearSignal) lastBear = i;

        out[i] = {
          bull: bullSignal,
          bear: bearSignal,
          bullStrength,
          bearStrength,
          bullSetup,
          bearSetup,
          bullSweep,
          bearSweep,
          bullAbsorption,
          bearAbsorption,
          bullTrap,
          bearTrap
        };
      }
      return out;
    }

    function runI2(i1) {
      const out = blankState();
      const threshold = numberInput("i2StrengthThreshold", 0.66);
      const setupThreshold = numberInput("i2SetupThreshold", 0.48);
      const structureLen = intInput("i2StructureLookback", 18);
      const counterAdx = numberInput("i2CounterTrendAdx", 26);
      const requireMicro = !!input.i2RequireMicroTrigger;
      const flowWeight = numberInput("i2FlowWeight", 0.14);
      const pullbackBoostInput = numberInput("i2PullbackBoost", 0.08);
      const continuationBoostInput = numberInput("i2ContinuationBoost", 0.08);
      const fast = emaLocal(C, intInput("i1FastEma", 9));
      const slow = emaLocal(C, intInput("i1SlowEma", 21));
      const trend = emaLocal(C, intInput("i1TrendEma", 55));
      const atrA = atrLocal(H, L, C, intInput("i1AtrLen", 14));
      const dmi = dmiLocal(H, L, C, intInput("i1AdxLen", 14));
      let lastBull = -9999;
      let lastBear = -9999;

      for (let i = Math.max(structureLen + 3, 60); i <= endIndex; i++) {
        const base = i1[i] || emptySignal();
        const atr = safe(atrA[i], range(i));
        const dPct = deltaPct(i);
        const buyDominance = ASK[i] > BID[i] * 1.18 || dPct > 0.16;
        const sellDominance = BID[i] > ASK[i] * 1.18 || dPct < -0.16;
        const bullBos = C[i] > highestBefore(H, structureLen, i);
        const bearBos = C[i] < lowestBefore(L, structureLen, i);
        const bullMicro =
          (C[i] > O[i] && C[i] > C[i - 1] && L[i] >= Math.min(L[i - 1], L[i - 2])) ||
          (D[i] > 0 && D[i - 1] > 0 && C[i] >= C[i - 1]);
        const bearMicro =
          (C[i] < O[i] && C[i] < C[i - 1] && H[i] <= Math.max(H[i - 1], H[i - 2])) ||
          (D[i] < 0 && D[i - 1] < 0 && C[i] <= C[i - 1]);
        const trendUp = C[i] > trend[i] && fast[i] > slow[i];
        const trendDown = C[i] < trend[i] && fast[i] < slow[i];
        const pullbackBull = trendUp && L[i] <= Math.max(fast[i], sessionVwap[i]) + atr * 0.25 && C[i] > O[i];
        const pullbackBear = trendDown && H[i] >= Math.min(fast[i], sessionVwap[i]) - atr * 0.25 && C[i] < O[i];
        const continuationBull = trendUp && C[i] > C[i - 1] && H[i] >= highestBefore(H, 6, i) && buyDominance;
        const continuationBear = trendDown && C[i] < C[i - 1] && L[i] <= lowestBefore(L, 6, i) && sellDominance;
        const counterBlockBull = trendDown && dmi.adx[i] >= counterAdx && !bullBos && !base.bullTrap;
        const counterBlockBear = trendUp && dmi.adx[i] >= counterAdx && !bearBos && !base.bearTrap;

        const bullFlow = buyDominance ? 1 : D[i] > 0 ? 0.55 : 0;
        const bearFlow = sellDominance ? 1 : D[i] < 0 ? 0.55 : 0;
        const bullStructure = bullBos ? 1 : base.bullSweep || base.bullTrap ? 0.65 : 0;
        const bearStructure = bearBos ? 1 : base.bearSweep || base.bearTrap ? 0.65 : 0;
        const bullBoost = (pullbackBull ? pullbackBoostInput : 0) + (continuationBull ? continuationBoostInput : 0);
        const bearBoost = (pullbackBear ? pullbackBoostInput : 0) + (continuationBear ? continuationBoostInput : 0);
        const bullStrength = clamp01(base.bullStrength * 0.72 + flowWeight * bullFlow + 0.09 * boolScore(bullMicro) + 0.10 * bullStructure + bullBoost - (counterBlockBull ? 0.18 : 0));
        const bearStrength = clamp01(base.bearStrength * 0.72 + flowWeight * bearFlow + 0.09 * boolScore(bearMicro) + 0.10 * bearStructure + bearBoost - (counterBlockBear ? 0.18 : 0));
        const bullSetup = clamp01(base.bullSetup * 0.70 + 0.15 * bullStructure + 0.15 * boolScore(bullMicro || pullbackBull));
        const bearSetup = clamp01(base.bearSetup * 0.70 + 0.15 * bearStructure + 0.15 * boolScore(bearMicro || pullbackBear));

        let bullSignal = bullStrength >= threshold && bullSetup >= setupThreshold && !counterBlockBull && (!requireMicro || bullMicro || bullBos || pullbackBull);
        let bearSignal = bearStrength >= threshold && bearSetup >= setupThreshold && !counterBlockBear && (!requireMicro || bearMicro || bearBos || pullbackBear);
        if (input.skipConflictingBars && bullSignal && bearSignal) {
          if (bullStrength > bearStrength) bearSignal = false;
          else if (bearStrength > bullStrength) bullSignal = false;
          else bullSignal = bearSignal = false;
        }
        if (bullSignal && i - lastBull <= input.cooldownBars) bullSignal = false;
        if (bearSignal && i - lastBear <= input.cooldownBars) bearSignal = false;
        if (bullSignal) lastBull = i;
        if (bearSignal) lastBear = i;
        out[i] = { bull: bullSignal, bear: bearSignal, bullStrength, bearStrength, bullSetup, bearSetup, bullBos, bearBos, bullMicro, bearMicro };
      }
      return out;
    }

    function runI3() {
      const out = blankState();
      const fast = emaLocal(C, intInput("i3FastEma", 13));
      const slow = emaLocal(C, intInput("i3SlowEma", 34));
      const trend = emaLocal(C, intInput("i3TrendEma", 89));
      const atrA = atrLocal(H, L, C, intInput("i1AtrLen", 14));
      const volMa = smaLocal(V, intInput("i1VolLen", 20));
      const dmi = dmiLocal(H, L, C, intInput("i3AdxLen", 14));
      const threshold = numberInput("i3StrengthThreshold", 0.62);
      const minAdx = numberInput("i3MinAdx", 16);
      const pullbackAtr = numberInput("i3PullbackAtr", 0.75);
      const quietVolMult = numberInput("i3QuietVolMult", 0.92);
      const fvgLookback = intInput("i3FvgLookback", 40);
      let lastBull = -9999;
      let lastBear = -9999;

      for (let i = Math.max(90, fvgLookback + 3); i <= endIndex; i++) {
        const atr = safe(atrA[i], range(i));
        const upTrend = fast[i] > slow[i] && C[i] > trend[i] && dmi.plus[i] >= dmi.minus[i] && dmi.adx[i] >= minAdx;
        const downTrend = fast[i] < slow[i] && C[i] < trend[i] && dmi.minus[i] >= dmi.plus[i] && dmi.adx[i] >= minAdx;
        const quietPullback = V[i] <= safe(volMa[i], V[i]) * quietVolMult;
        const bullPullback = upTrend && L[i] <= Math.max(fast[i], sessionVwap[i]) + atr * pullbackAtr && C[i] > O[i] && closePos(i) > 0.55;
        const bearPullback = downTrend && H[i] >= Math.min(fast[i], sessionVwap[i]) - atr * pullbackAtr && C[i] < O[i] && closePos(i) < 0.45;
        const cvdBull = CVD[i] >= CVD[i - 1] || CVD[i] - CVD[i - 5] > 0;
        const cvdBear = CVD[i] <= CVD[i - 1] || CVD[i] - CVD[i - 5] < 0;
        const deltaBull = D[i] > 0 || deltaPct(i) > 0.12;
        const deltaBear = D[i] < 0 || deltaPct(i) < -0.12;
        const fp = footprintStats(i);
        const bullFootprint = fp.bullImbalance || fp.bullAbsorption || fp.pocLow || !input.i3UseFootprint;
        const bearFootprint = fp.bearImbalance || fp.bearAbsorption || fp.pocHigh || !input.i3UseFootprint;
        const bullFvg = !input.i3UseFvg || fvgScore(i, "bull", fvgLookback) > 0;
        const bearFvg = !input.i3UseFvg || fvgScore(i, "bear", fvgLookback) > 0;
        const bullTrigger = C[i] > H[i - 1] || crossedOver(C, fast, i) || (bullPullback && deltaBull);
        const bearTrigger = C[i] < L[i - 1] || crossedUnder(C, fast, i) || (bearPullback && deltaBear);

        const bullStrength = clamp01(
          0.22 * boolScore(upTrend) +
          0.18 * boolScore(bullPullback) +
          0.10 * boolScore(quietPullback) +
          0.13 * boolScore(deltaBull) +
          0.12 * boolScore(cvdBull) +
          0.10 * boolScore(bullFootprint) +
          0.08 * fvgScore(i, "bull", fvgLookback) +
          0.07 * boolScore(bullTrigger)
        );
        const bearStrength = clamp01(
          0.22 * boolScore(downTrend) +
          0.18 * boolScore(bearPullback) +
          0.10 * boolScore(quietPullback) +
          0.13 * boolScore(deltaBear) +
          0.12 * boolScore(cvdBear) +
          0.10 * boolScore(bearFootprint) +
          0.08 * fvgScore(i, "bear", fvgLookback) +
          0.07 * boolScore(bearTrigger)
        );

        let bullSignal = bullStrength >= threshold && bullTrigger && bullFvg;
        let bearSignal = bearStrength >= threshold && bearTrigger && bearFvg;
        if (input.skipConflictingBars && bullSignal && bearSignal) {
          if (bullStrength > bearStrength) bearSignal = false;
          else if (bearStrength > bullStrength) bullSignal = false;
          else bullSignal = bearSignal = false;
        }
        if (bullSignal && i - lastBull <= input.cooldownBars) bullSignal = false;
        if (bearSignal && i - lastBear <= input.cooldownBars) bearSignal = false;
        if (bullSignal) lastBull = i;
        if (bearSignal) lastBear = i;
        out[i] = { bull: bullSignal, bear: bearSignal, bullStrength, bearStrength, bullSetup: bullStrength, bearSetup: bearStrength, upTrend, downTrend };
      }
      return out;
    }

    function drawOutputs(i1, i2, i3) {
      let lastSuperBull = -9999;
      let lastSuperBear = -9999;
      const useI1 = !!input.i1Enabled;
      const useI2 = !!input.i2Enabled;
      const useI3 = !!input.i3Enabled;
      const enabledCount = (useI1 ? 1 : 0) + (useI2 ? 1 : 0) + (useI3 ? 1 : 0);
      if (enabledCount === 0) return;

      for (let i = 0; i <= endIndex; i++) {
        const a = i1[i] || emptySignal();
        const b = i2[i] || emptySignal();
        const c3 = i3[i] || emptySignal();
        if (input.showComponentMarkers) {
          if (useI1 && input.showI1Markers !== false && a.bull) mark(i, strengthLabel(a), "#16a34a", "bull");
          if (useI1 && input.showI1Markers !== false && a.bear) mark(i, strengthLabel(a), "#dc2626", "bear");
          if (useI2 && input.showI2Markers === true && b.bull) mark(i, strengthLabel(b), "#22c55e", "bull");
          if (useI2 && input.showI2Markers === true && b.bear) mark(i, strengthLabel(b), "#f43f5e", "bear");
          if (useI3 && input.showI3Markers === true && c3.bull) mark(i, strengthLabel(c3), "#84cc16", "bull");
          if (useI3 && input.showI3Markers === true && c3.bear) mark(i, strengthLabel(c3), "#fb923c", "bear");
        }

        let buyVotes = 0;
        let sellVotes = 0;
        let required = 1;
        if (input.superMode === "composite") {
          if (useI1 && a.bull) buyVotes++;
          if (useI2 && b.bull) buyVotes++;
          if (useI3 && c3.bull) buyVotes++;
          if (useI1 && a.bear) sellVotes++;
          if (useI2 && b.bear) sellVotes++;
          if (useI3 && c3.bear) sellVotes++;
          required = input.triggerRule === "all" ? enabledCount : input.triggerRule === "two" ? Math.min(2, enabledCount) : 1;
        } else {
          // Exact supplied Pine behavior: final Super Signal uses only Indicator 1.
          buyVotes = useI1 && a.bull ? 1 : 0;
          sellVotes = useI1 && a.bear ? 1 : 0;
          required = 1;
        }

        let superBull = buyVotes >= required;
        let superBear = sellVotes >= required;
        if (input.skipConflictingBars && superBull && superBear) {
          const bullPower = safe(a.bullStrength, 0) + safe(b.bullStrength, 0) + safe(c3.bullStrength, 0);
          const bearPower = safe(a.bearStrength, 0) + safe(b.bearStrength, 0) + safe(c3.bearStrength, 0);
          if (bullPower > bearPower) superBear = false;
          else if (bearPower > bullPower) superBull = false;
          else superBull = superBear = false;
        }
        if (superBull && i - lastSuperBull <= input.cooldownBars) superBull = false;
        if (superBear && i - lastSuperBear <= input.cooldownBars) superBear = false;
        if (superBull) lastSuperBull = i;
        if (superBear) lastSuperBear = i;

        if (input.showSuperSignals && superBull) mark(i, "SC1 BUY", "#00d084", "bull");
        if (input.showSuperSignals && superBear) mark(i, "SC1 SELL", "#ff2f70", "bear");
      }

      if (input.showTrendLines) {
        const fastLine = emaLocal(C, intInput("i1FastEma", 9)).map((value, i) => ({ time: candles[i].startTime, value }));
        const slowLine = emaLocal(C, intInput("i1SlowEma", 21)).map((value, i) => ({ time: candles[i].startTime, value }));
        ctx.plotLine("SC1 Fast EMA", fastLine, { color: "#38bdf8", width: 1, opacity: 0.75, pane: "price" });
        ctx.plotLine("SC1 Slow EMA", slowLine, { color: "#f97316", width: 1, opacity: 0.75, pane: "price" });
      }

      if (input.showDebugStrength) {
        const bull = [], bear = [];
        for (let i = 0; i <= endIndex; i++) {
          const a = i1[i] || emptySignal();
          const b = i2[i] || emptySignal();
          const c3 = i3[i] || emptySignal();
          bull.push({ time: candles[i].startTime, value: Math.max(safe(a.bullStrength, 0), safe(b.bullStrength, 0), safe(c3.bullStrength, 0)) });
          bear.push({ time: candles[i].startTime, value: -Math.max(safe(a.bearStrength, 0), safe(b.bearStrength, 0), safe(c3.bearStrength, 0)) });
        }
        ctx.plotLine("SC1 Bull Strength", bull, { color: "#22c55e", width: 1, pane: "custom" });
        ctx.plotLine("SC1 Bear Strength", bear, { color: "#f43f5e", width: 1, pane: "custom" });
      }
    }

    function strengthLabel(sig) {
      return "(" + pctStrength(sig.bullStrength) + "," + pctStrength(sig.bearStrength) + ")";
    }

    function pctStrength(v) {
      return String(Math.round(clamp01(safe(v, 0)) * 100));
    }
    function mark(i, text, color, side) {
      const atr = Math.max(range(i), tickSize(i));
      ctx.shape({
        time: candles[i].startTime,
        price: side === "bull" ? L[i] - atr * 0.15 : H[i] + atr * 0.15,
        text,
        color,
        position: side === "bull" ? "below" : "above"
      });
    }

    function footprintStats(i) {
      const c = candles[i] || {};
      const sig = c.signals || {};
      const cells = Array.isArray(c.cells) ? c.cells : [];
      let buyImb = 0, sellImb = 0, pocDelta = 0;
      for (let k = 0; k < cells.length; k++) {
        const cell = cells[k] || {};
        if (cell.buyImbalance) buyImb++;
        if (cell.sellImbalance) sellImb++;
        if (finite(POC[i]) && Math.abs(num(cell.price) - POC[i]) <= tickSize(i) / 2) pocDelta += num(cell.delta);
      }
      const zones = Array.isArray(sig.stackedImbalances) ? sig.stackedImbalances : [];
      for (let z = 0; z < zones.length; z++) {
        if (zones[z] && zones[z].direction === "bullish") buyImb += Math.max(1, num(zones[z].count));
        if (zones[z] && zones[z].direction === "bearish") sellImb += Math.max(1, num(zones[z].count));
      }
      const pocLow = finite(POC[i]) && POC[i] <= L[i] + range(i) * 0.33 && pocDelta >= 0;
      const pocHigh = finite(POC[i]) && POC[i] >= H[i] - range(i) * 0.33 && pocDelta <= 0;
      const absorptionSide = sig.absorptionSide || "";
      return {
        bullImbalance: buyImb >= 2,
        bearImbalance: sellImb >= 2,
        bullAbsorption: !!sig.absorption && (absorptionSide === "bid" || closePos(i) >= 0.5),
        bearAbsorption: !!sig.absorption && (absorptionSide === "ask" || closePos(i) <= 0.5),
        pocLow,
        pocHigh
      };
    }

    function fvgScore(i, side, lookback) {
      let score = 0;
      const start = Math.max(2, i - lookback);
      for (let j = start; j <= i; j++) {
        if (side === "bull" && L[j] > H[j - 2]) {
          const low = H[j - 2];
          const high = L[j];
          const touched = L[i] <= high && H[i] >= low;
          const unfilled = L[i] > low;
          if (touched || unfilled) score = Math.max(score, touched ? 1 : 0.55);
        }
        if (side === "bear" && H[j] < L[j - 2]) {
          const low = H[j];
          const high = L[j - 2];
          const touched = H[i] >= low && L[i] <= high;
          const unfilled = H[i] < high;
          if (touched || unfilled) score = Math.max(score, touched ? 1 : 0.55);
        }
      }
      return score;
    }

    function blankState() {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = emptySignal();
      return out;
    }

    function emptySignal() {
      return { bull: false, bear: false, bullStrength: 0, bearStrength: 0, bullSetup: 0, bearSetup: 0 };
    }

    function fillMissingCvd(cvd, delta) {
      let running = 0;
      for (let i = 0; i < cvd.length; i++) {
        if (Number.isFinite(cvd[i])) running = cvd[i];
        else {
          running += safe(delta[i], 0);
          cvd[i] = running;
        }
      }
    }

    function buildSessionVwap(candles, price, volume, existing) {
      const out = new Array(candles.length);
      let lastKey = "", pv = 0, vv = 0;
      for (let i = 0; i < candles.length; i++) {
        if (Number.isFinite(existing[i])) {
          out[i] = existing[i];
          continue;
        }
        const key = sessionKey(candles[i].startTime);
        if (key !== lastKey) {
          lastKey = key;
          pv = 0;
          vv = 0;
        }
        pv += price[i] * Math.max(1, volume[i]);
        vv += Math.max(1, volume[i]);
        out[i] = vv > 0 ? pv / vv : price[i];
      }
      return out;
    }

    function sessionKey(t) {
      // CME-style trading day starts near 17:00 Chicago. Without a timezone DB inside
      // the sandbox, shift UTC by 23h so evening Globex bars roll into the next key.
      const d = new Date(Number(t) + 23 * 60 * 60 * 1000);
      return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate();
    }

    function smaLocal(values, len) {
      const out = new Array(values.length).fill(NaN);
      const L = Math.max(1, Math.floor(len));
      let s = 0;
      for (let i = 0; i < values.length; i++) {
        s += safe(values[i], 0);
        if (i >= L) s -= safe(values[i - L], 0);
        if (i >= L - 1) out[i] = s / L;
      }
      return out;
    }

    function emaLocal(values, len) {
      const out = new Array(values.length).fill(NaN);
      const L = Math.max(1, Math.floor(len));
      const a = 2 / (L + 1);
      let prev = NaN;
      for (let i = 0; i < values.length; i++) {
        const v = safe(values[i], NaN);
        if (!Number.isFinite(v)) {
          out[i] = prev;
          continue;
        }
        prev = Number.isFinite(prev) ? a * v + (1 - a) * prev : v;
        out[i] = prev;
      }
      return out;
    }

    function rmaLocal(values, len) {
      const out = new Array(values.length).fill(NaN);
      const L = Math.max(1, Math.floor(len));
      let prev = NaN, seed = 0, seen = 0;
      for (let i = 0; i < values.length; i++) {
        const v = safe(values[i], 0);
        if (seen < L) {
          seed += v;
          seen++;
          if (seen === L) prev = seed / L;
        } else {
          prev = (prev * (L - 1) + v) / L;
        }
        out[i] = prev;
      }
      return out;
    }

    function atrLocal(h, l, c, len) {
      const tr = new Array(h.length).fill(0);
      for (let i = 0; i < h.length; i++) {
        tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      }
      return rmaLocal(tr, len);
    }

    function rsiLocal(values, len) {
      const gains = new Array(values.length).fill(0);
      const losses = new Array(values.length).fill(0);
      for (let i = 1; i < values.length; i++) {
        const ch = values[i] - values[i - 1];
        gains[i] = Math.max(0, ch);
        losses[i] = Math.max(0, -ch);
      }
      const avgGain = rmaLocal(gains, len);
      const avgLoss = rmaLocal(losses, len);
      const out = new Array(values.length).fill(50);
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(avgLoss[i]) || avgLoss[i] === 0) out[i] = 100;
        else {
          const rs = avgGain[i] / avgLoss[i];
          out[i] = 100 - 100 / (1 + rs);
        }
      }
      return out;
    }

    function dmiLocal(h, l, c, len) {
      const plusDM = new Array(h.length).fill(0);
      const minusDM = new Array(h.length).fill(0);
      const tr = new Array(h.length).fill(0);
      for (let i = 1; i < h.length; i++) {
        const up = h[i] - h[i - 1];
        const down = l[i - 1] - l[i];
        plusDM[i] = up > down && up > 0 ? up : 0;
        minusDM[i] = down > up && down > 0 ? down : 0;
        tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      }
      const trR = rmaLocal(tr, len);
      const pR = rmaLocal(plusDM, len);
      const mR = rmaLocal(minusDM, len);
      const plus = new Array(h.length).fill(0);
      const minus = new Array(h.length).fill(0);
      const dx = new Array(h.length).fill(0);
      for (let i = 0; i < h.length; i++) {
        plus[i] = trR[i] ? 100 * pR[i] / trR[i] : 0;
        minus[i] = trR[i] ? 100 * mR[i] / trR[i] : 0;
        dx[i] = plus[i] + minus[i] ? 100 * Math.abs(plus[i] - minus[i]) / (plus[i] + minus[i]) : 0;
      }
      return { plus, minus, adx: rmaLocal(dx, len) };
    }

    function highestBefore(values, len, i) {
      let m = -Infinity;
      const start = Math.max(0, i - len);
      for (let j = start; j < i; j++) if (Number.isFinite(values[j]) && values[j] > m) m = values[j];
      return Number.isFinite(m) ? m : values[i];
    }

    function lowestBefore(values, len, i) {
      let m = Infinity;
      const start = Math.max(0, i - len);
      for (let j = start; j < i; j++) if (Number.isFinite(values[j]) && values[j] < m) m = values[j];
      return Number.isFinite(m) ? m : values[i];
    }

    function crossedOver(a, b, i) {
      return i > 0 && Number.isFinite(a[i - 1]) && Number.isFinite(b[i - 1]) && Number.isFinite(a[i]) && Number.isFinite(b[i]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
    }

    function crossedUnder(a, b, i) {
      return i > 0 && Number.isFinite(a[i - 1]) && Number.isFinite(b[i - 1]) && Number.isFinite(a[i]) && Number.isFinite(b[i]) && a[i - 1] >= b[i - 1] && a[i] < b[i];
    }

    function range(i) {
      return Math.max(tickSize(i), H[i] - L[i]);
    }

    function closePos(i) {
      return clamp01((C[i] - L[i]) / Math.max(range(i), tickSize(i)));
    }

    function deltaPct(i) {
      return V[i] > 0 ? clamp(D[i] / V[i], -1, 1) : 0;
    }

    function tickSize(i) {
      const row = candles[i] && Number(candles[i].rowSize);
      if (Number.isFinite(row) && row > 0) return row;
      return Math.max(0.000001, Math.abs(C[i]) * 0.00001);
    }

    function intInput(name, fallback) {
      const v = Number(input[name]);
      return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fallback;
    }

    function numberInput(name, fallback) {
      const v = Number(input[name]);
      return Number.isFinite(v) ? v : fallback;
    }

    function positive(v) {
      const x = Number(v);
      return Number.isFinite(x) && x > 0 ? x : 0;
    }

    function num(v) {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    }

    function finite(v) {
      return Number.isFinite(Number(v));
    }

    function safe(v, fallback) {
      return Number.isFinite(Number(v)) ? Number(v) : fallback;
    }

    function boolScore(v) {
      return v ? 1 : 0;
    }

    function clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    }

    function clamp01(v) {
      return clamp(v, 0, 1);
    }
  }
});
`;
