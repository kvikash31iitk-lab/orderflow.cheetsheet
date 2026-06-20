// SC1 1604 V3 — Pine-parity port of the supplied TradingView indicator
// "SC1 1604_ New" (file: "1604 databento version.txt").
//
// Unlike V1/V2 (dashboard-native approximations on a normalized 0-1 scale), V3 is a
// FAITHFUL line-by-line translation of the Pine source: the same helper functions
// (clamp01/avg2/avg3/avg4/rangeSafe/fitToBand/...), the same per-bar metrics, and the
// same 0-100 strength weights, penalties, reliefs, net-edge and signal logic for
// Indicator 1, Indicator 2 and Indicator 3, plus the super-signal stage.
//
// PINE -> DASHBOARD MAPPING (kept 1:1; input keys reuse Pine names):
//  * volume                          -> candle.totalVolume
//  * tvta.requestUpAndDownVolume(5S) -> parent bar buy/sell volume:
//        i1_buyVol  = candle.totalAskVolume   (aggressive buys)
//        i1_sellVol = candle.totalBidVolume   (aggressive sells)
//    Pine's 5S up/down volume SUMS the 5-second sub-bars inside the parent bar; that
//    sum equals the parent bar's tick-aggregated ask/bid volume (both reduce the same
//    DataBento ticks). So per parent bar the values are identical -- no 5s backend
//    query needed (and the backend has no 5s timeframe; see TIMEFRAME_MINUTES).
//  * tvta.requestVolumeDelta(5S,..)  -> candle.delta / candle.maxDelta / candle.minDelta
//    (maxDelta/minDelta are the tick-resolution intra-bar running-delta extremes, i.e.
//    finer than 5S, so this is parity-or-better).
//  * request.security(tickerid,"15", close[1]/ema[1]/ema[2], lookahead_on)
//        -> ctx.requestSecurity("15m") mapped to the parent bar's 15m bucket using the
//           prior completed 15m bar (the lookahead_on + [1] non-repaint convention).
//  * ta.vwap(hlc3)                   -> candle.vwap (backend session VWAP, CME-anchored)
//  * request.footprint / 1D CVD anchor -> parent candle signals + cumDelta (session CVD).
//
// VISUALS (user preference): Indicator 1 markers ON by default; Indicator 2 / 3 markers
// OFF by default (still fully computed). Super signal == Indicator 1 only (exactly as
// the supplied Pine wires enabledCount/buyCount/sellCount off enableIndicator1).
//   Bull I1 marker: green triangle below the bar, text "(bullStrength,bearStrength)".
//   Bear I1 marker: red triangle above the bar, text "(bearStrength,bullStrength)".
// Markers anchor to candle.startTime + bar low/high, so they never drift to the right
// edge on pan/scroll. No date filtering -> historical signals render wherever the
// formula triggers within the loaded window.

export const SC1_1604_V3_SCRIPT = `indicator("SC1 1604 V3 Pine Parity", {
  overlay: true,
  inputs: {
    // ----- Super Signal (Pine: Super Signal group) -----
    enableIndicator1: true,
    enableIndicator2: true,
    enableIndicator3: true,
    triggerRule: "any",            // "any" | "two" | "all" (super uses I1 only, per Pine)
    confirmOnClose: true,
    skipConflictingBars: true,
    cooldownBars: 0,
    showComponentMarkers: true,
    showI1Markers: true,           // user pref: I1 visible
    showI2Markers: false,          // user pref: I2 hidden (still computed)
    showI3Markers: false,          // user pref: I3 hidden (still computed)
    showSuperSignals: false,       // keep clean; I1 marker already carries the strengths

    // ----- Indicator 1 - Core -----
    i1_lookback: 8,
    i1_volLength: 12,
    i1_rsiLength: 7,
    i1_atrLength: 14,
    i1_swingAtrMult: 0.25,
    i1_weakVol: 0.90,
    i1_absorpDeltaPct: 8.0,
    i1_trapDeltaMult: 0.18,
    i1_minStrength: 45,
    i1_netEdgeSignalThreshold: 60.0,
    i1_useConfirm: false,
    // ----- Indicator 1 - Liquidity Sweep -----
    i1_useLiquiditySweep: true,
    i1_lsPivotLeft: 3,
    i1_lsPivotRight: 3,
    i1_lsMinSweepAtr: 0.10,
    i1_lsMaxAgeBars: 50,
    i1_lsRequireCloseBackIn: true,
    i1_lsVolumeMult: 0.80,
    i1_lsWeight: 15.0,
    // ----- Indicator 1 - Trend Filters -----
    i1_useTrendRegimeFilter: true,
    i1_htfEmaLength: 50,
    i1_adxLength: 14,
    i1_adxSmoothing: 14,
    i1_adxTrendThreshold: 28.0,
    i1_useReclaimFilter: true,
    i1_trendEmaLength: 20,
    i1_useStructureBreakFilter: true,
    i1_structureMaxAgeBars: 40,
    i1_trendPenaltyWeight: 16.0,
    i1_reclaimReliefWeight: 6.0,
    i1_structureReliefWeight: 8.0,
    i1_softMissingPenalty: 2.0,
    i1_trendAlignedBonusWeight: 3.0,
    // ----- Indicator 1 - Signal Candle Filter -----
    i1_useSignalCandleFilter: true,
    i1_dojiMaxBodyRange: 0.12,
    i1_hammerMinWickBody: 1.8,
    i1_hammerMaxOppositeWickBody: 0.8,

    // ----- Indicator 2 - Core (Pine defaults) -----
    i2_lookback: 8,
    i2_volLength: 12,
    i2_rsiLength: 7,
    i2_atrLength: 14,
    i2_swingAtrMult: 0.25,
    i2_weakVol: 0.90,
    i2_absorpDeltaPct: 8.0,
    i2_trapDeltaMult: 0.18,
    i2_minStrength: 45,
    i2_netEdgeSignalThreshold: 60.0,
    i2_useConfirm: false,
    i2_useLiquiditySweep: true,
    i2_lsPivotLeft: 3,
    i2_lsPivotRight: 3,
    i2_lsMinSweepAtr: 0.10,
    i2_lsMaxAgeBars: 50,
    i2_lsRequireCloseBackIn: true,
    i2_lsVolumeMult: 0.80,
    i2_lsWeight: 15.0,
    i2_useTrendRegimeFilter: true,
    i2_htfEmaLength: 50,
    i2_adxLength: 14,
    i2_adxSmoothing: 14,
    i2_adxTrendThreshold: 28.0,
    i2_useReclaimFilter: true,
    i2_trendEmaLength: 20,
    i2_useStructureBreakFilter: true,
    i2_structureMaxAgeBars: 40,
    i2_trendPenaltyWeight: 16.0,
    i2_reclaimReliefWeight: 6.0,
    i2_structureReliefWeight: 8.0,
    i2_softMissingPenalty: 2.0,
    i2_trendAlignedBonusWeight: 3.0,
    i2_useCounterTrendSignalBlock: true,
    i2_counterTrendBlockMode: "3m or 5m",
    i2_counterTrendBlockEmaLength: 34,
    i2_counterTrendBlockAdxThreshold: 24.0,
    i2_counterTrendBlockPersistenceBars: 2,
    i2_useTrendPullbackBoost: true,
    i2_trendPullbackLookback: 4,
    i2_trendPullbackAtrBuffer: 0.35,
    i2_trendPullbackBonusWeight: 18.0,
    i2_trendPullbackThresholdRelief: 8.0,
    i2_useTrendContinuationBoost: true,
    i2_trendContinuationBonusWeight: 10.0,
    i2_trendContinuationThresholdRelief: 4.0,
    i2_useStructureBiasLock: true,
    i2_structureBiasCooldownBars: 6,
    i2_useMicroStructureTrigger: true,
    i2_microTriggerPivotLeft: 2,
    i2_microTriggerPivotRight: 2,
    i2_trendPullbackFlowThreshold: 0.25,
    i2_useSignalCandleFilter: true,
    i2_dojiMaxBodyRange: 0.12,
    i2_hammerMinWickBody: 1.8,
    i2_hammerMaxOppositeWickBody: 0.8,

    // ----- Indicator 3 (Pine defaults) -----
    i3_emaFastLength: 20,
    i3_emaSlowLength: 50,
    i3_adxLength: 14,
    i3_adxSmoothing: 14,
    i3_minTrendAdx: 14.0,
    i3_useHtfBias: true,
    i3_htfFastLength: 20,
    i3_htfSlowLength: 50,
    i3_atrLength: 14,
    i3_rsiLength: 7,
    i3_volLength: 20,
    i3_pullbackLookback: 10,
    i3_pullbackZoneAtr: 0.55,
    i3_maxTrendBreakAtr: 0.90,
    i3_minPullbackAtr: 0.05,
    i3_maxPullbackAtr: 2.40,
    i3_bullPullbackRsiFloor: 34.0,
    i3_bullPullbackRsiCeiling: 66.0,
    i3_bearPullbackRsiFloor: 34.0,
    i3_bearPullbackRsiCeiling: 66.0,
    i3_useQuietPullbackVolume: true,
    i3_pullbackVolumeMult: 1.80,
    i3_deltaEmaLength: 8,
    i3_cvdEmaLength: 21,
    i3_usePullbackDeltaFilter: true,
    i3_maxPullbackCounterDeltaPct: 30.0,
    i3_useCvdBias: true,
    i3_useOrderflowTrigger: true,
    i3_minTriggerDeltaPct: 3.0,
    i3_triggerPressureRatio: 1.00,
    i3_maxSetupBars: 14,
    i3_triggerBreakoutLookback: 1,
    i3_triggerBodyAtr: 0.01,
    i3_useTriggerVolume: false,
    i3_triggerVolumeMult: 1.00,
    i3_useVwapAlignment: true,
    i3_useFootprintConfirm: true,
    i3_minFootprintDeltaPct: 2.0,
    i3_minStackedImbalances: 1,
    i3_requireFootprintPocLocation: false,
    i3_useFvgBoost: true,
    i3_fvgMitigationMode: "Close",
    i3_fvgMaxAgeBars: 120,
    i3_fvgMitigatedKeepBars: 400,
    i3_minFvgAtr: 0.08,
    i3_minFvgImpulseBodyAtr: 0.20,
    i3_fvgProximityBufferAtr: 0.45,
    i3_fvgStrengthBoostPct: 10.0,
    i3_minBarsBetweenSignals: 2,
    i3_useSignalCandleFilter: true,
    i3_dojiMaxBodyRange: 0.12,
    i3_hammerMinWickBody: 1.8,
    i3_hammerMaxOppositeWickBody: 0.8
  },

  onSeries(ctx) {
    const candles = ctx.candles || [];
    const input = ctx.inputs || {};
    const n = candles.length;
    if (n < 60) return;

    // confirm-on-close: ignore the still-forming last bar (Pine barstate.isconfirmed)
    const lastForming = candles[n - 1] && candles[n - 1].closed === false;
    const endIndex = (input.confirmOnClose !== false && lastForming) ? n - 2 : n - 1;
    if (endIndex < 50) return;

    // ---------- base series ----------
    const O = new Array(n), H = new Array(n), L = new Array(n), C = new Array(n), T = new Array(n);
    const VOL = new Array(n), BUY = new Array(n), SELL = new Array(n), D = new Array(n);
    const MAXD = new Array(n), MIND = new Array(n), CVD = new Array(n), VWAPv = new Array(n), POC = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = candles[i] || {};
      O[i] = num(x.open); H[i] = num(x.high); L[i] = num(x.low); C[i] = num(x.close);
      T[i] = num(x.startTime);
      BUY[i] = positive(x.totalAskVolume);
      SELL[i] = positive(x.totalBidVolume);
      VOL[i] = positive(x.totalVolume) || (BUY[i] + SELL[i]) || Math.abs(num(x.delta)) || 1;
      D[i] = num(x.delta);
      MAXD[i] = finite(x.maxDelta) ? Number(x.maxDelta) : D[i];
      MIND[i] = finite(x.minDelta) ? Number(x.minDelta) : D[i];
      CVD[i] = num(x.cumDelta);
      VWAPv[i] = finite(x.vwap) ? Number(x.vwap) : NaN;
      POC[i] = finite(x.poc) ? Number(x.poc) : NaN;
    }
    fillVwap(VWAPv, H, L, C, VOL, T);

    // ---------- derived per-bar primitives ----------
    const RANGE = new Array(n), BODY = new Array(n), UWICK = new Array(n), LWICK = new Array(n);
    const CLOSEPOS = new Array(n), DPCT = new Array(n);
    for (let i = 0; i < n; i++) {
      RANGE[i] = H[i] - L[i];
      BODY[i] = Math.abs(C[i] - O[i]);
      const ub = Math.max(C[i], O[i]), lb = Math.min(C[i], O[i]);
      UWICK[i] = H[i] - ub; LWICK[i] = lb - L[i];
      CLOSEPOS[i] = RANGE[i] > 0 ? (C[i] - L[i]) / RANGE[i] : 0.5;
      DPCT[i] = VOL[i] > 0 ? (D[i] / VOL[i]) * 100 : 0;
    }

    // ---------- shared TA ----------
    const sessVwap = VWAPv;
    const I = {
      volMA1: sma(VOL, intIn("i1_volLength", 12)),
      rsi1: rsi(C, intIn("i1_rsiLength", 7)),
      atr1: atr(H, L, C, intIn("i1_atrLength", 14)),
      trendEma1: ema(C, intIn("i1_trendEmaLength", 20)),
      dmi1: dmi(H, L, C, intIn("i1_adxLength", 14), intIn("i1_adxSmoothing", 14)),
    };
    // 15m HTF mapping (literal requestSecurity("15m") so the host prefetches it).
    const htf15 = mapHtfEma2(ctx.requestSecurity("15m"), intIn("i1_htfEmaLength", 50));

    const out1 = runIndicator1();
    const out2 = runIndicator2();
    const out3 = runIndicator3();
    draw(out1, out2, out3);

    // ============================ INDICATOR 1 ============================
    function runIndicator1() {
      const lookback = intIn("i1_lookback", 8);
      const weakVol = numIn("i1_weakVol", 0.90);
      const swingAtrMult = numIn("i1_swingAtrMult", 0.25);
      const absorp = numIn("i1_absorpDeltaPct", 8.0);
      const trapMult = numIn("i1_trapDeltaMult", 0.18);
      const minStrength = numIn("i1_minStrength", 45);
      const netEdgeThr = numIn("i1_netEdgeSignalThreshold", 60.0);
      const useConfirm = input.i1_useConfirm === true;
      const lsWeight = numIn("i1_lsWeight", 15.0);
      const useLS = input.i1_useLiquiditySweep !== false;
      const lsMinSweepAtr = numIn("i1_lsMinSweepAtr", 0.10);
      const lsMaxAge = intIn("i1_lsMaxAgeBars", 50);
      const lsRequireBackIn = input.i1_lsRequireCloseBackIn !== false;
      const lsVolMult = numIn("i1_lsVolumeMult", 0.80);
      const useTrend = input.i1_useTrendRegimeFilter !== false;
      const adxThr = numIn("i1_adxTrendThreshold", 28.0);
      const useReclaim = input.i1_useReclaimFilter !== false;
      const useStructBreak = input.i1_useStructureBreakFilter !== false;
      const structMaxAge = intIn("i1_structureMaxAgeBars", 40);
      const trendPenW = numIn("i1_trendPenaltyWeight", 16.0);
      const reclaimReliefW = numIn("i1_reclaimReliefWeight", 6.0);
      const structReliefW = numIn("i1_structureReliefWeight", 8.0);
      const softPen = numIn("i1_softMissingPenalty", 2.0);
      const trendBonusW = numIn("i1_trendAlignedBonusWeight", 3.0);
      const useCandle = input.i1_useSignalCandleFilter !== false;
      const dojiMax = numIn("i1_dojiMaxBodyRange", 0.12);
      const hammerWick = numIn("i1_hammerMinWickBody", 1.8);
      const hammerOpp = numIn("i1_hammerMaxOppositeWickBody", 0.8);

      const volMA = I.volMA1, rsiA = I.rsi1, atrA = I.atr1, trendEma = I.trendEma1, dmiA = I.dmi1;
      const piv = pivots(L, H, intIn("i1_lsPivotLeft", 3), intIn("i1_lsPivotRight", 3));
      const cvd3 = new Array(n);
      for (let i = 0; i < n; i++) cvd3[i] = D[i] + nzv(D[i - 1]) + nzv(D[i - 2]);

      const bullStr = new Array(n).fill(0), bearStr = new Array(n).fill(0);
      const bullSetup = new Array(n).fill(false), bearSetup = new Array(n).fill(false);
      const bullCandle = new Array(n).fill(false), bearCandle = new Array(n).fill(false);

      for (let i = 1; i <= endIndex; i++) {
        const atrV = safe(atrA[i], range(i));
        const buy = BUY[i], sell = SELL[i];
        const prevBuy = nzf(BUY[i - 1], buy), prevSell = nzf(SELL[i - 1], sell);
        const prevDp = nzv(DPCT[i - 1]);
        const closePos = CLOSEPOS[i], dPct = DPCT[i];
        const swingLow = loBefore(L, lookback, i), swingHigh = hiBefore(H, lookback, i);
        const swingWin = rsafe(atrV * swingAtrMult, i);
        const lowVol = clamp01((volMA[i] * weakVol - VOL[i]) / rsafe(volMA[i] * weakVol, i));
        const strongCloseBull = clamp01((closePos - 0.65) / 0.35);
        const strongCloseBear = clamp01((0.35 - closePos) / 0.35);
        const bullSwing = clamp01((swingLow + swingWin - L[i]) / swingWin);
        const bearSwing = clamp01((H[i] - (swingHigh - swingWin)) / swingWin);
        const bullReject = avg2(clamp01((closePos - 0.52) / 0.48), clamp01((LWICK[i] / rsafe(BODY[i], i) - 0.80) / 1.20));
        const bearReject = avg2(clamp01((0.48 - closePos) / 0.48), clamp01((UWICK[i] / rsafe(BODY[i], i) - 0.80) / 1.20));

        // liquidity sweep
        const lsMinDist = atrV * lsMinSweepAtr;
        const lsVolThr = volMA[i] * lsVolMult;
        const plVal = piv.plVal[i], plBar = piv.plBar[i], phVal = piv.phVal[i], phBar = piv.phBar[i];
        const bullLsValid = isFin(plVal) && isFin(plBar) && i > plBar && (i - plBar) <= lsMaxAge;
        const bearLsValid = isFin(phVal) && isFin(phBar) && i > phBar && (i - phBar) <= lsMaxAge;
        const bullSweepDist = bullLsValid ? Math.max(plVal - L[i], 0) : 0;
        const bearSweepDist = bearLsValid ? Math.max(H[i] - phVal, 0) : 0;
        const bullSwept = bullLsValid && L[i] < plVal - lsMinDist;
        const bearSwept = bearLsValid && H[i] > phVal + lsMinDist;
        const bullBackIn = bullLsValid && C[i] > plVal;
        const bearBackIn = bearLsValid && C[i] < phVal;
        const lsVolOk = lsVolMult <= 0 || VOL[i] >= lsVolThr;
        const bullLsActive = useLS && bullSwept && lsVolOk && (!lsRequireBackIn || bullBackIn);
        const bearLsActive = useLS && bearSwept && lsVolOk && (!lsRequireBackIn || bearBackIn);
        const bullLs = bullLsActive ? avg4(
          clamp01((bullSweepDist - lsMinDist) / rsafe(Math.max(lsMinDist, atrV * 0.5), i)),
          bullBackIn ? 1 : 0, strongCloseBull,
          Math.max(clamp01((dPct - prevDp) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)))) : 0;
        const bearLs = bearLsActive ? avg4(
          clamp01((bearSweepDist - lsMinDist) / rsafe(Math.max(lsMinDist, atrV * 0.5), i)),
          bearBackIn ? 1 : 0, strongCloseBear,
          Math.max(clamp01((prevDp - dPct) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)))) : 0;

        const bullExhaust = avg4(bullSwing, bullReject, clamp01((45.0 - rsiA[i]) / 45.0),
          Math.max(lowVol, Math.max(clamp01((dPct - prevDp) / 25.0), clamp01((prevSell - sell) / rsafe(prevSell, i)))));
        const bearExhaust = avg4(bearSwing, bearReject, clamp01((rsiA[i] - 55.0) / 45.0),
          Math.max(lowVol, Math.max(clamp01((prevDp - dPct) / 25.0), clamp01((prevBuy - buy) / rsafe(prevBuy, i)))));
        const bullAbsorp = avg3(bullSwing, clamp01(((-dPct) - absorp) / rsafe(absorp, i)), clamp01((closePos - 0.58) / 0.42));
        const bearAbsorp = avg3(bearSwing, clamp01((dPct - absorp) / rsafe(absorp, i)), clamp01((0.42 - closePos) / 0.42));
        const bullTrap = avg4(bullSwing, clamp01(((-MIND[i]) - (VOL[i] * trapMult)) / rsafe(VOL[i] * trapMult, i)),
          clamp01((dPct + absorp) / rsafe(absorp * 2.0, i)), clamp01((closePos - 0.55) / 0.45));
        const bearTrap = avg4(bearSwing, clamp01((MAXD[i] - (VOL[i] * trapMult)) / rsafe(VOL[i] * trapMult, i)),
          clamp01((absorp - dPct) / rsafe(absorp * 2.0, i)), clamp01((0.45 - closePos) / 0.45));
        const c3 = cvd3[i], c3p = nzv(cvd3[i - 1]);
        const bullCvd = avg2(bullSwing, clamp01((c3 - c3p) / rsafe(Math.abs(c3p) + VOL[i] * 0.1, i)));
        const bearCvd = avg2(bearSwing, clamp01((c3p - c3) / rsafe(Math.abs(c3p) + VOL[i] * 0.1, i)));
        const prevCp = nzf(CLOSEPOS[i - 1], closePos);
        const bullRev = avg4(bullAbsorp, clamp01((dPct - prevDp) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)), clamp01((closePos - prevCp) / 0.35));
        const bearRev = avg4(bearAbsorp, clamp01((prevDp - dPct) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)), clamp01((prevCp - closePos) / 0.35));

        let rawBull = clampN(15 * bullSwing + 20 * bullExhaust + 25 * bullAbsorp + 20 * bullTrap + 20 * bullCvd + 15 * bullRev + 10 * bullReject + 10 * strongCloseBull + 5 * lowVol + lsWeight * bullLs);
        let rawBear = clampN(15 * bearSwing + 20 * bearExhaust + 25 * bearAbsorp + 20 * bearTrap + 20 * bearCvd + 15 * bearRev + 10 * bearReject + 10 * strongCloseBear + 5 * lowVol + lsWeight * bearLs);

        const hc = htf15.close[i], he = htf15.ema[i], hep = htf15.emaPrev[i];
        const bearHtf = isFin(hc) && isFin(he) && isFin(hep) && hc < he && he < hep;
        const bullHtf = isFin(hc) && isFin(he) && isFin(hep) && hc > he && he > hep;
        const bearAdx = isFin(dmiA.adx[i]) && dmiA.adx[i] > adxThr && dmiA.minus[i] > dmiA.plus[i];
        const bullAdx = isFin(dmiA.adx[i]) && dmiA.adx[i] > adxThr && dmiA.plus[i] > dmiA.minus[i];
        const strongBear = useTrend && bearHtf && bearAdx;
        const strongBull = useTrend && bullHtf && bullAdx;
        const bullReclaim = !useReclaim || C[i] > sessVwap[i] || C[i] > trendEma[i];
        const bearReclaim = !useReclaim || C[i] < sessVwap[i] || C[i] < trendEma[i];
        const bullStruct = isFin(phVal) && isFin(phBar) && i > phBar && (i - phBar) <= structMaxAge && C[i] > phVal;
        const bearStruct = isFin(plVal) && isFin(plBar) && i > plBar && (i - plBar) <= structMaxAge && C[i] < plVal;
        const bullCtPen = useTrend && strongBear ? trendPenW : 0;
        const bearCtPen = useTrend && strongBull ? trendPenW : 0;
        const bullRelief = (useReclaim && bullReclaim ? reclaimReliefW : 0) + (useStructBreak && bullStruct ? structReliefW : 0);
        const bearRelief = (useReclaim && bearReclaim ? reclaimReliefW : 0) + (useStructBreak && bearStruct ? structReliefW : 0);
        const bullSoft = (useReclaim && !bullReclaim ? softPen : 0) + (useStructBreak && !bullStruct ? softPen : 0);
        const bearSoft = (useReclaim && !bearReclaim ? softPen : 0) + (useStructBreak && !bearStruct ? softPen : 0);
        const bullBonus = useTrend && bullHtf && dmiA.plus[i] >= dmiA.minus[i] ? trendBonusW : 0;
        const bearBonus = useTrend && bearHtf && dmiA.minus[i] >= dmiA.plus[i] ? trendBonusW : 0;
        const bullPen = Math.max(0, bullCtPen - bullRelief) + bullSoft;
        const bearPen = Math.max(0, bearCtPen - bearRelief) + bearSoft;

        const bs = clampN(rawBull - bullPen + bullBonus);
        const br = clampN(rawBear - bearPen + bearBonus);
        bullStr[i] = bs; bearStr[i] = br;
        const netBuy = bs - br, netSell = br - bs;
        bullSetup[i] = bs >= minStrength && netBuy >= netEdgeThr;
        bearSetup[i] = br >= minStrength && netSell >= netEdgeThr;
        const doji = isDoji(BODY[i], RANGE[i], dojiMax, i);
        bullCandle[i] = !useCandle || doji || isHammer(i, hammerWick, hammerOpp) || isInvHammer(i, hammerWick, hammerOpp);
        bearCandle[i] = !useCandle || doji || isShootingStar(i, hammerWick, hammerOpp);
      }

      const bull = new Array(n).fill(false), bear = new Array(n).fill(false);
      for (let i = 1; i <= endIndex; i++) {
        const base = useConfirm ? (bullSetup[i - 1] && C[i] > H[i - 1]) : (bullSetup[i] && !bullSetup[i - 1]);
        const baseS = useConfirm ? (bearSetup[i - 1] && C[i] < L[i - 1]) : (bearSetup[i] && !bearSetup[i - 1]);
        bull[i] = input.enableIndicator1 !== false && base && bullCandle[i];
        bear[i] = input.enableIndicator1 !== false && baseS && bearCandle[i];
      }
      return { bull, bear, bullStr, bearStr };
    }

    // ============================ INDICATOR 2 ============================
    function runIndicator2() {
      const lookback = intIn("i2_lookback", 8);
      const weakVol = numIn("i2_weakVol", 0.90);
      const swingAtrMult = numIn("i2_swingAtrMult", 0.25);
      const absorp = numIn("i2_absorpDeltaPct", 8.0);
      const trapMult = numIn("i2_trapDeltaMult", 0.18);
      const minStrength = numIn("i2_minStrength", 45);
      const netEdgeThr = numIn("i2_netEdgeSignalThreshold", 60.0);
      const useConfirm = input.i2_useConfirm === true;
      const lsWeight = numIn("i2_lsWeight", 15.0);
      const useLS = input.i2_useLiquiditySweep !== false;
      const lsMinSweepAtr = numIn("i2_lsMinSweepAtr", 0.10);
      const lsMaxAge = intIn("i2_lsMaxAgeBars", 50);
      const lsRequireBackIn = input.i2_lsRequireCloseBackIn !== false;
      const lsVolMult = numIn("i2_lsVolumeMult", 0.80);
      const useTrend = input.i2_useTrendRegimeFilter !== false;
      const adxThr = numIn("i2_adxTrendThreshold", 28.0);
      const useReclaim = input.i2_useReclaimFilter !== false;
      const useStructBreak = input.i2_useStructureBreakFilter !== false;
      const structMaxAge = intIn("i2_structureMaxAgeBars", 40);
      const trendPenW = numIn("i2_trendPenaltyWeight", 16.0);
      const reclaimReliefW = numIn("i2_reclaimReliefWeight", 6.0);
      const structReliefW = numIn("i2_structureReliefWeight", 8.0);
      const softPen = numIn("i2_softMissingPenalty", 2.0);
      const trendBonusW = numIn("i2_trendAlignedBonusWeight", 3.0);
      const useCtBlock = input.i2_useCounterTrendSignalBlock !== false;
      const ctMode = String(input.i2_counterTrendBlockMode || "3m or 5m");
      const ctEmaLen = intIn("i2_counterTrendBlockEmaLength", 34);
      const ctAdxThr = numIn("i2_counterTrendBlockAdxThreshold", 24.0);
      const ctPersist = intIn("i2_counterTrendBlockPersistenceBars", 2);
      const usePullback = input.i2_useTrendPullbackBoost !== false;
      const pullbackLook = intIn("i2_trendPullbackLookback", 4);
      const pullbackBuf = numIn("i2_trendPullbackAtrBuffer", 0.35);
      const pullbackBonusW = numIn("i2_trendPullbackBonusWeight", 18.0);
      const pullbackReliefW = numIn("i2_trendPullbackThresholdRelief", 8.0);
      const useCont = input.i2_useTrendContinuationBoost !== false;
      const contBonusW = numIn("i2_trendContinuationBonusWeight", 10.0);
      const contReliefW = numIn("i2_trendContinuationThresholdRelief", 4.0);
      const useBiasLock = input.i2_useStructureBiasLock !== false;
      const biasCooldown = intIn("i2_structureBiasCooldownBars", 6);
      const useMicro = input.i2_useMicroStructureTrigger !== false;
      const flowThr = numIn("i2_trendPullbackFlowThreshold", 0.25);
      const useCandle = input.i2_useSignalCandleFilter !== false;
      const dojiMax = numIn("i2_dojiMaxBodyRange", 0.12);
      const hammerWick = numIn("i2_hammerMinWickBody", 1.8);
      const hammerOpp = numIn("i2_hammerMaxOppositeWickBody", 0.8);

      const volMA = sma(VOL, intIn("i2_volLength", 12));
      const rsiA = rsi(C, intIn("i2_rsiLength", 7));
      const atrA = atr(H, L, C, intIn("i2_atrLength", 14));
      const trendEma = ema(C, intIn("i2_trendEmaLength", 20));
      const dmiA = dmi(H, L, C, intIn("i2_adxLength", 14), intIn("i2_adxSmoothing", 14));
      const piv = pivots(L, H, intIn("i2_lsPivotLeft", 3), intIn("i2_lsPivotRight", 3));
      const micro = pivots(L, H, intIn("i2_microTriggerPivotLeft", 2), intIn("i2_microTriggerPivotRight", 2));
      // counter-trend state on this TF ("3m"/chart) and 5m security
      const ctSelf = counterTrendState(C, ctEmaLen, dmiA, ctAdxThr, ctPersist);
      const ct5 = counterTrendState5m(ctEmaLen, ctAdxThr, ctPersist);
      const cvd3 = new Array(n);
      for (let i = 0; i < n; i++) cvd3[i] = D[i] + nzv(D[i - 1]) + nzv(D[i - 2]);

      const bullStr = new Array(n).fill(0), bearStr = new Array(n).fill(0);
      const bullSetup = new Array(n).fill(false), bearSetup = new Array(n).fill(false);
      const bullCandle = new Array(n).fill(false), bearCandle = new Array(n).fill(false);
      const bullBlocked = new Array(n).fill(false), bearBlocked = new Array(n).fill(false);
      let bias = 0, lastBullStructBar = NaN, lastBearStructBar = NaN;

      for (let i = 1; i <= endIndex; i++) {
        const atrV = safe(atrA[i], range(i));
        const buy = BUY[i], sell = SELL[i];
        const prevBuy = nzf(BUY[i - 1], buy), prevSell = nzf(SELL[i - 1], sell);
        const prevDp = nzv(DPCT[i - 1]);
        const closePos = CLOSEPOS[i], dPct = DPCT[i];
        const swingLow = loBefore(L, lookback, i), swingHigh = hiBefore(H, lookback, i);
        const swingWin = rsafe(atrV * swingAtrMult, i);
        const lowVol = clamp01((volMA[i] * weakVol - VOL[i]) / rsafe(volMA[i] * weakVol, i));
        const strongCloseBull = clamp01((closePos - 0.65) / 0.35);
        const strongCloseBear = clamp01((0.35 - closePos) / 0.35);
        const bullSwing = clamp01((swingLow + swingWin - L[i]) / swingWin);
        const bearSwing = clamp01((H[i] - (swingHigh - swingWin)) / swingWin);
        const bullReject = avg2(clamp01((closePos - 0.52) / 0.48), clamp01((LWICK[i] / rsafe(BODY[i], i) - 0.80) / 1.20));
        const bearReject = avg2(clamp01((0.48 - closePos) / 0.48), clamp01((UWICK[i] / rsafe(BODY[i], i) - 0.80) / 1.20));

        const lsMinDist = atrV * lsMinSweepAtr;
        const lsVolThr = volMA[i] * lsVolMult;
        const plVal = piv.plVal[i], plBar = piv.plBar[i], phVal = piv.phVal[i], phBar = piv.phBar[i];
        const bullLsValid = isFin(plVal) && isFin(plBar) && i > plBar && (i - plBar) <= lsMaxAge;
        const bearLsValid = isFin(phVal) && isFin(phBar) && i > phBar && (i - phBar) <= lsMaxAge;
        const bullSweepDist = bullLsValid ? Math.max(plVal - L[i], 0) : 0;
        const bearSweepDist = bearLsValid ? Math.max(H[i] - phVal, 0) : 0;
        const bullSwept = bullLsValid && L[i] < plVal - lsMinDist;
        const bearSwept = bearLsValid && H[i] > phVal + lsMinDist;
        const bullBackIn = bullLsValid && C[i] > plVal;
        const bearBackIn = bearLsValid && C[i] < phVal;
        const lsVolOk = lsVolMult <= 0 || VOL[i] >= lsVolThr;
        const bullLsActive = useLS && bullSwept && lsVolOk && (!lsRequireBackIn || bullBackIn);
        const bearLsActive = useLS && bearSwept && lsVolOk && (!lsRequireBackIn || bearBackIn);
        const bullLs = bullLsActive ? avg4(clamp01((bullSweepDist - lsMinDist) / rsafe(Math.max(lsMinDist, atrV * 0.5), i)), bullBackIn ? 1 : 0, strongCloseBull, Math.max(clamp01((dPct - prevDp) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)))) : 0;
        const bearLs = bearLsActive ? avg4(clamp01((bearSweepDist - lsMinDist) / rsafe(Math.max(lsMinDist, atrV * 0.5), i)), bearBackIn ? 1 : 0, strongCloseBear, Math.max(clamp01((prevDp - dPct) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)))) : 0;
        const bullExhaust = avg4(bullSwing, bullReject, clamp01((45.0 - rsiA[i]) / 45.0), Math.max(lowVol, Math.max(clamp01((dPct - prevDp) / 25.0), clamp01((prevSell - sell) / rsafe(prevSell, i)))));
        const bearExhaust = avg4(bearSwing, bearReject, clamp01((rsiA[i] - 55.0) / 45.0), Math.max(lowVol, Math.max(clamp01((prevDp - dPct) / 25.0), clamp01((prevBuy - buy) / rsafe(prevBuy, i)))));
        const bullAbsorp = avg3(bullSwing, clamp01(((-dPct) - absorp) / rsafe(absorp, i)), clamp01((closePos - 0.58) / 0.42));
        const bearAbsorp = avg3(bearSwing, clamp01((dPct - absorp) / rsafe(absorp, i)), clamp01((0.42 - closePos) / 0.42));
        const bullTrap = avg4(bullSwing, clamp01(((-MIND[i]) - (VOL[i] * trapMult)) / rsafe(VOL[i] * trapMult, i)), clamp01((dPct + absorp) / rsafe(absorp * 2.0, i)), clamp01((closePos - 0.55) / 0.45));
        const bearTrap = avg4(bearSwing, clamp01((MAXD[i] - (VOL[i] * trapMult)) / rsafe(VOL[i] * trapMult, i)), clamp01((absorp - dPct) / rsafe(absorp * 2.0, i)), clamp01((0.45 - closePos) / 0.45));
        const c3 = cvd3[i], c3p = nzv(cvd3[i - 1]);
        const bullCvd = avg2(bullSwing, clamp01((c3 - c3p) / rsafe(Math.abs(c3p) + VOL[i] * 0.1, i)));
        const bearCvd = avg2(bearSwing, clamp01((c3p - c3) / rsafe(Math.abs(c3p) + VOL[i] * 0.1, i)));
        const prevCp = nzf(CLOSEPOS[i - 1], closePos);
        const bullRev = avg4(bullAbsorp, clamp01((dPct - prevDp) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)), clamp01((closePos - prevCp) / 0.35));
        const bearRev = avg4(bearAbsorp, clamp01((prevDp - dPct) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)), clamp01((prevCp - closePos) / 0.35));

        const rawBull = clampN(15 * bullSwing + 20 * bullExhaust + 25 * bullAbsorp + 20 * bullTrap + 20 * bullCvd + 15 * bullRev + 10 * bullReject + 10 * strongCloseBull + 5 * lowVol + lsWeight * bullLs);
        const rawBear = clampN(15 * bearSwing + 20 * bearExhaust + 25 * bearAbsorp + 20 * bearTrap + 20 * bearCvd + 15 * bearRev + 10 * bearReject + 10 * strongCloseBear + 5 * lowVol + lsWeight * bearLs);

        const hc = htf15.close[i], he = htf15.ema[i], hep = htf15.emaPrev[i];
        const bearHtf = isFin(hc) && isFin(he) && isFin(hep) && hc < he && he < hep;
        const bullHtf = isFin(hc) && isFin(he) && isFin(hep) && hc > he && he > hep;
        const bearAdx = isFin(dmiA.adx[i]) && dmiA.adx[i] > adxThr && dmiA.minus[i] > dmiA.plus[i];
        const bullAdx = isFin(dmiA.adx[i]) && dmiA.adx[i] > adxThr && dmiA.plus[i] > dmiA.minus[i];
        const strongBear = useTrend && bearHtf && bearAdx;
        const strongBull = useTrend && bullHtf && bullAdx;
        const ct3 = ctSelf[i], c5 = ct5[i];
        const ctBull = ctMode === "3m only" ? ct3 === 1 : ctMode === "5m only" ? c5 === 1 : ctMode === "3m and 5m" ? (ct3 === 1 && c5 === 1) : (ct3 === 1 || c5 === 1);
        const ctBear = ctMode === "3m only" ? ct3 === -1 : ctMode === "5m only" ? c5 === -1 : ctMode === "3m and 5m" ? (ct3 === -1 && c5 === -1) : (ct3 === -1 || c5 === -1);
        const bullReclaim = !useReclaim || C[i] > sessVwap[i] || C[i] > trendEma[i];
        const bearReclaim = !useReclaim || C[i] < sessVwap[i] || C[i] < trendEma[i];
        const bullStruct = isFin(phVal) && isFin(phBar) && i > phBar && (i - phBar) <= structMaxAge && C[i] > phVal;
        const bearStruct = isFin(plVal) && isFin(plBar) && i > plBar && (i - plBar) <= structMaxAge && C[i] < plVal;
        const bullMicroBar = C[i] > H[i - 1];
        const bearMicroBar = C[i] < L[i - 1];
        const mphVal = micro.phVal[i], mphBar = micro.phBar[i], mplVal = micro.plVal[i], mplBar = micro.plBar[i];
        const bullMicroPiv = isFin(mphVal) && isFin(mphBar) && i > mphBar && C[i] > mphVal;
        const bearMicroPiv = isFin(mplVal) && isFin(mplBar) && i > mplBar && C[i] < mplVal;
        const bullMicro = !useMicro || bullMicroBar || bullMicroPiv;
        const bearMicro = !useMicro || bearMicroBar || bearMicroPiv;
        const pbLow = lo(L, pullbackLook, i), pbHigh = hi(H, pullbackLook, i);
        const bullTouch = pbLow <= trendEma[i] + atrV * pullbackBuf || pbLow <= sessVwap[i] + atrV * pullbackBuf;
        const bearTouch = pbHigh >= trendEma[i] - atrV * pullbackBuf || pbHigh >= sessVwap[i] - atrV * pullbackBuf;
        const bullPbReclaim = C[i] > trendEma[i] && (C[i] > sessVwap[i] || C[i] > O[i]);
        const bearPbReclaim = C[i] < trendEma[i] && (C[i] < sessVwap[i] || C[i] < O[i]);
        const bullFlow = avg2(clamp01((dPct - prevDp + 12.5) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)));
        const bearFlow = avg2(clamp01((prevDp - dPct + 12.5) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)));
        const bullReset = clamp01((60.0 - rsiA[i]) / 30.0);
        const bearReset = clamp01((rsiA[i] - 40.0) / 30.0);

        if (bearStruct) { bias = -1; lastBearStructBar = i; }
        if (bullStruct) { bias = 1; lastBullStructBar = i; }
        const bullStructReclaim = bias === -1 && bullMicro && C[i] > trendEma[i] && C[i] > sessVwap[i] && strongCloseBull >= 0.35 && bullFlow >= flowThr;
        const bearStructReclaim = bias === 1 && bearMicro && C[i] < trendEma[i] && C[i] < sessVwap[i] && strongCloseBear >= 0.35 && bearFlow >= flowThr;
        if (bullStructReclaim) { bias = 1; lastBullStructBar = i; }
        if (bearStructReclaim) { bias = -1; lastBearStructBar = i; }
        const sinceBull = isFin(lastBullStructBar) ? i - lastBullStructBar : 100000;
        const sinceBear = isFin(lastBearStructBar) ? i - lastBearStructBar : 100000;
        const bullCooldown = useBiasLock && bias === -1 && sinceBear <= biasCooldown;
        const bearCooldown = useBiasLock && bias === 1 && sinceBull <= biasCooldown;
        const bullLock = useBiasLock && bias === -1 && (ctBear || bullCooldown);
        const bearLock = useBiasLock && bias === 1 && (ctBull || bearCooldown);

        const bullPbQual = usePullback && ctBull && !bullLock && bullTouch && bullPbReclaim && bullMicro && bullFlow >= flowThr && bullReset > 0;
        const bearPbQual = usePullback && ctBear && !bearLock && bearTouch && bearPbReclaim && bearMicro && bearFlow >= flowThr && bearReset > 0;
        const bullPbMetric = bullPbQual ? avg4(1, strongCloseBull, bullFlow, bullReset) : 0;
        const bearPbMetric = bearPbQual ? avg4(1, strongCloseBear, bearFlow, bearReset) : 0;
        const bullPbBonus = pullbackBonusW * bullPbMetric, bearPbBonus = pullbackBonusW * bearPbMetric;
        const bullPbRelief = pullbackReliefW * bullPbMetric, bearPbRelief = pullbackReliefW * bearPbMetric;
        const bullContQual = useCont && ctBull && !bullLock && !bullPbQual && C[i] > trendEma[i] && C[i] > sessVwap[i] && bullMicro && strongCloseBull >= 0.35 && bullFlow >= flowThr && dmiA.plus[i] >= dmiA.minus[i];
        const bearContQual = useCont && ctBear && !bearLock && !bearPbQual && C[i] < trendEma[i] && C[i] < sessVwap[i] && bearMicro && strongCloseBear >= 0.35 && bearFlow >= flowThr && dmiA.minus[i] >= dmiA.plus[i];
        const bullContMetric = bullContQual ? avg4(1, strongCloseBull, bullFlow, clamp01((C[i] - trendEma[i]) / rsafe(atrV * 0.60, i))) : 0;
        const bearContMetric = bearContQual ? avg4(1, strongCloseBear, bearFlow, clamp01((trendEma[i] - C[i]) / rsafe(atrV * 0.60, i))) : 0;
        const bullContBonus = contBonusW * bullContMetric, bearContBonus = contBonusW * bearContMetric;
        const bullContRelief = contReliefW * bullContMetric, bearContRelief = contReliefW * bearContMetric;
        const bullCtPen = useTrend && strongBear ? trendPenW : 0;
        const bearCtPen = useTrend && strongBull ? trendPenW : 0;
        const bullRelief = (useReclaim && bullReclaim ? reclaimReliefW : 0) + (useStructBreak && bullStruct ? structReliefW : 0);
        const bearRelief = (useReclaim && bearReclaim ? reclaimReliefW : 0) + (useStructBreak && bearStruct ? structReliefW : 0);
        const bullSoft = (useReclaim && !bullReclaim ? softPen : 0) + (useStructBreak && !bullStruct ? softPen : 0);
        const bearSoft = (useReclaim && !bearReclaim ? softPen : 0) + (useStructBreak && !bearStruct ? softPen : 0);
        const bullBonus = useTrend && bullHtf && dmiA.plus[i] >= dmiA.minus[i] ? trendBonusW : 0;
        const bearBonus = useTrend && bearHtf && dmiA.minus[i] >= dmiA.plus[i] ? trendBonusW : 0;
        const bullPen = Math.max(0, bullCtPen - bullRelief) + bullSoft;
        const bearPen = Math.max(0, bearCtPen - bearRelief) + bearSoft;

        const bs = clampN(rawBull - bullPen + bullBonus + bullPbBonus + bullContBonus);
        const brr = clampN(rawBear - bearPen + bearBonus + bearPbBonus + bearContBonus);
        bullStr[i] = bs; bearStr[i] = brr;
        const netBuy = bs - brr, netSell = brr - bs;
        bullSetup[i] = bs >= Math.max(0, minStrength - bullPbRelief - bullContRelief) && netBuy >= Math.max(0, netEdgeThr - bullPbRelief - bullContRelief);
        bearSetup[i] = brr >= Math.max(0, minStrength - bearPbRelief - bearContRelief) && netSell >= Math.max(0, netEdgeThr - bearPbRelief - bearContRelief);
        const doji = isDoji(BODY[i], RANGE[i], dojiMax, i);
        bullCandle[i] = !useCandle || doji || isHammer(i, hammerWick, hammerOpp) || isInvHammer(i, hammerWick, hammerOpp);
        bearCandle[i] = !useCandle || doji || isShootingStar(i, hammerWick, hammerOpp);
        // Pine: signal blocked by counter-trend (useCounterTrendSignalBlock) OR by an
        // active structure-bias lock. Both gate the signal base in the second pass.
        bullBlocked[i] = (useCtBlock && ctBear) || (useBiasLock && bullLock);
        bearBlocked[i] = (useCtBlock && ctBull) || (useBiasLock && bearLock);
      }

      const bull = new Array(n).fill(false), bear = new Array(n).fill(false);
      for (let i = 1; i <= endIndex; i++) {
        const base = useConfirm ? (bullSetup[i - 1] && C[i] > H[i - 1]) : (bullSetup[i] && !bullSetup[i - 1]);
        const baseS = useConfirm ? (bearSetup[i - 1] && C[i] < L[i - 1]) : (bearSetup[i] && !bearSetup[i - 1]);
        bull[i] = input.enableIndicator2 !== false && base && !bullBlocked[i] && bullCandle[i];
        bear[i] = input.enableIndicator2 !== false && baseS && !bearBlocked[i] && bearCandle[i];
      }
      return { bull, bear, bullStr, bearStr };
    }

    // ============================ INDICATOR 3 ============================
    function runIndicator3() {
      const emaFast = ema(C, intIn("i3_emaFastLength", 20));
      const emaSlow = ema(C, intIn("i3_emaSlowLength", 50));
      const atrA = atr(H, L, C, intIn("i3_atrLength", 14));
      const rsiA = rsi(C, intIn("i3_rsiLength", 7));
      const volMA = sma(VOL, intIn("i3_volLength", 20));
      const dmiA = dmi(H, L, C, intIn("i3_adxLength", 14), intIn("i3_adxSmoothing", 14));
      const minAdx = numIn("i3_minTrendAdx", 14.0);
      const useHtf = input.i3_useHtfBias !== false;
      const sec15 = ctx.requestSecurity("15m");
      const htfF = mapHtfEma2(sec15, intIn("i3_htfFastLength", 20));
      const htfS = mapHtfEma2(sec15, intIn("i3_htfSlowLength", 50));
      const pullbackLook = intIn("i3_pullbackLookback", 10);
      const zoneAtr = numIn("i3_pullbackZoneAtr", 0.55);
      const maxBreakAtr = numIn("i3_maxTrendBreakAtr", 0.90);
      const minPbAtr = numIn("i3_minPullbackAtr", 0.05);
      const maxPbAtr = numIn("i3_maxPullbackAtr", 2.40);
      const bullRsiFloor = numIn("i3_bullPullbackRsiFloor", 34.0), bullRsiCeil = numIn("i3_bullPullbackRsiCeiling", 66.0);
      const bearRsiFloor = numIn("i3_bearPullbackRsiFloor", 34.0), bearRsiCeil = numIn("i3_bearPullbackRsiCeiling", 66.0);
      const useQuiet = input.i3_useQuietPullbackVolume !== false;
      const pbVolMult = numIn("i3_pullbackVolumeMult", 1.80);
      const deltaEmaLen = intIn("i3_deltaEmaLength", 8);
      const cvdEmaLen = intIn("i3_cvdEmaLength", 21);
      const usePbDelta = input.i3_usePullbackDeltaFilter !== false;
      const maxCounterDp = numIn("i3_maxPullbackCounterDeltaPct", 30.0);
      const useCvd = input.i3_useCvdBias !== false;
      const useFlow = input.i3_useOrderflowTrigger !== false;
      const minTrigDp = numIn("i3_minTriggerDeltaPct", 3.0);
      const trigRatio = numIn("i3_triggerPressureRatio", 1.0);
      const maxSetupBars = intIn("i3_maxSetupBars", 14);
      const breakoutLook = intIn("i3_triggerBreakoutLookback", 1);
      const trigBodyAtr = numIn("i3_triggerBodyAtr", 0.01);
      const useTrigVol = input.i3_useTriggerVolume === true;
      const trigVolMult = numIn("i3_triggerVolumeMult", 1.0);
      const useVwapAlign = input.i3_useVwapAlignment !== false;
      const useFootprint = input.i3_useFootprintConfirm !== false;
      const minFpDp = numIn("i3_minFootprintDeltaPct", 2.0);
      const minStacked = intIn("i3_minStackedImbalances", 1);
      const reqPoc = input.i3_requireFootprintPocLocation === true;
      const useFvg = input.i3_useFvgBoost !== false;
      const fvgWick = String(input.i3_fvgMitigationMode || "Close") === "Wick";
      const fvgMaxAge = intIn("i3_fvgMaxAgeBars", 120);
      const fvgKeep = intIn("i3_fvgMitigatedKeepBars", 400);
      const minFvgAtr = numIn("i3_minFvgAtr", 0.08);
      const minFvgImpulse = numIn("i3_minFvgImpulseBodyAtr", 0.20);
      const fvgProx = numIn("i3_fvgProximityBufferAtr", 0.45);
      const fvgBoostPct = numIn("i3_fvgStrengthBoostPct", 10.0);
      const minBars = intIn("i3_minBarsBetweenSignals", 2);
      const useCandle = input.i3_useSignalCandleFilter !== false;
      const dojiMax = numIn("i3_dojiMaxBodyRange", 0.12);
      const hammerWick = numIn("i3_hammerMinWickBody", 1.8), hammerOpp = numIn("i3_hammerMaxOppositeWickBody", 0.8);

      const deltaPctEma = ema(DPCT, deltaEmaLen);
      const cvdBias = ema(CVD, cvdEmaLen);
      const bandMid = new Array(n);
      for (let i = 0; i < n; i++) bandMid[i] = (emaFast[i] + emaSlow[i]) / 2;

      // FVG stores
      const bullF = { top: [], bot: [], born: [], mit: [] };
      const bearF = { top: [], bot: [], born: [], mit: [] };
      const bull = new Array(n).fill(false), bear = new Array(n).fill(false);
      const bullStr = new Array(n).fill(0), bearStr = new Array(n).fill(0);
      const bullCand = new Array(n).fill(false), bearCand = new Array(n).fill(false);
      let bullSetupAge = NaN, bearSetupAge = NaN, lastBull = NaN, lastBear = NaN;
      let bullTrigEdgePrev = false, bearTrigEdgePrev = false;
      const bullPbCand = new Array(n).fill(false), bearPbCand = new Array(n).fill(false);

      for (let i = 1; i <= endIndex; i++) {
        const atrV = safe(atrA[i], range(i));
        const bullClosePos = CLOSEPOS[i];
        const bearClosePos = RANGE[i] > 0 ? (H[i] - C[i]) / Math.max(RANGE[i], tickSize(i)) : 0.5;
        const hbF = htfF.ema[i], hbFp = htfF.emaPrev[i], hbS = htfS.ema[i], hc = htfF.close[i];
        const bullHtfBias = !useHtf || (isFin(hc) && isFin(hbF) && isFin(hbS) && isFin(hbFp) && hc > hbF && hbF > hbS && hbF > hbFp);
        const bearHtfBias = !useHtf || (isFin(hc) && isFin(hbF) && isFin(hbS) && isFin(hbFp) && hc < hbF && hbF < hbS && hbF < hbFp);
        const bullBand = emaFast[i] > emaSlow[i] && emaSlow[i] >= nzf(emaSlow[i - 1], emaSlow[i]) && bullHtfBias;
        const bearBand = emaFast[i] < emaSlow[i] && emaSlow[i] <= nzf(emaSlow[i - 1], emaSlow[i]) && bearHtfBias;
        const bullTrend = bullBand && C[i] >= emaSlow[i] - atrV * 0.15 && (dmiA.adx[i] >= minAdx || dmiA.plus[i] > dmiA.minus[i]);
        const bearTrend = bearBand && C[i] <= emaSlow[i] + atrV * 0.15 && (dmiA.adx[i] >= minAdx || dmiA.minus[i] > dmiA.plus[i]);

        const delta = D[i], dPct = DPCT[i];
        const buyAbs = Math.abs(BUY[i]), sellAbs = Math.abs(SELL[i]);
        // footprint confirm from parent signals/poc
        const fp = footprintParent(i);
        const hasFp = fp.has;
        const fpDeltaPct = fp.deltaPct;

        const bullPbDepth = (hi(H, pullbackLook, i) - L[i]) / rsafe2(atrV, i);
        const bearPbDepth = (H[i] - lo(L, pullbackLook, i)) / rsafe2(atrV, i);
        const bullZoneDist = Math.abs(L[i] - emaFast[i]) / rsafe2(atrV, i);
        const bearZoneDist = Math.abs(H[i] - emaFast[i]) / rsafe2(atrV, i);
        const bullZoneTouch = L[i] <= emaFast[i] + atrV * zoneAtr;
        const bearZoneTouch = H[i] >= emaFast[i] - atrV * zoneAtr;
        const bullBandTouch = L[i] <= bandMid[i] + atrV * 0.25;
        const bearBandTouch = H[i] >= bandMid[i] - atrV * 0.25;
        const bullMicroPb = C[i] <= emaFast[i] + atrV * 0.35 || L[i] <= L[i - 1] || C[i] <= C[i - 1];
        const bearMicroPb = C[i] >= emaFast[i] - atrV * 0.35 || H[i] >= H[i - 1] || C[i] >= C[i - 1];
        const bullHold = L[i] >= emaSlow[i] - atrV * maxBreakAtr;
        const bearHold = H[i] <= emaSlow[i] + atrV * maxBreakAtr;
        const bullRsiOk = rsiA[i] >= bullRsiFloor && rsiA[i] <= bullRsiCeil;
        const bearRsiOk = rsiA[i] >= bearRsiFloor && rsiA[i] <= bearRsiCeil;
        const quiet = !useQuiet || VOL[i] <= volMA[i] * pbVolMult;
        const bullPbDeltaOk = !usePbDelta || dPct >= -maxCounterDp;
        const bearPbDeltaOk = !usePbDelta || dPct <= maxCounterDp;
        bullPbCand[i] = bullTrend && (bullZoneTouch || bullBandTouch || bullMicroPb) && bullHold && bullPbDepth >= minPbAtr && bullPbDepth <= maxPbAtr && bullRsiOk && quiet && bullPbDeltaOk;
        bearPbCand[i] = bearTrend && (bearZoneTouch || bearBandTouch || bearMicroPb) && bearHold && bearPbDepth >= minPbAtr && bearPbDepth <= maxPbAtr && bearRsiOk && quiet && bearPbDeltaOk;
        const bullInvalid = !bullBand || C[i] < emaSlow[i] - atrV * maxBreakAtr;
        const bearInvalid = !bearBand || C[i] > emaSlow[i] + atrV * maxBreakAtr;

        // FVG births
        const bullGap = L[i] > H[i - 2] ? L[i] - H[i - 2] : 0;
        const bearGap = H[i] < L[i - 2] ? L[i - 2] - H[i] : 0;
        const atrPrev = nzf(atrA[i - 1], atrV);
        const bullImpulse = C[i - 1] > O[i - 1] && BODY[i - 1] >= atrPrev * minFvgImpulse;
        const bearImpulse = C[i - 1] < O[i - 1] && BODY[i - 1] >= atrPrev * minFvgImpulse;
        const bullViable = !bullInvalid && bullPbBarsAgo(bullPbCand, i) <= maxSetupBars;
        const bearViable = !bearInvalid && bearPbBarsAgo(bearPbCand, i) <= maxSetupBars;
        if (bullViable && emaFast[i] > emaSlow[i] && bullImpulse && bullGap / rsafe2(atrPrev, i) >= minFvgAtr) { bullF.top.push(L[i]); bullF.bot.push(H[i - 2]); bullF.born.push(i); bullF.mit.push(false); }
        if (bearViable && emaFast[i] < emaSlow[i] && bearImpulse && bearGap / rsafe2(atrPrev, i) >= minFvgAtr) { bearF.top.push(L[i - 2]); bearF.bot.push(H[i]); bearF.born.push(i); bearF.mit.push(false); }
        const bullFvgScore = scoreFvg(bullF, i, atrV, fvgWick, fvgMaxAge, fvgKeep, minFvgAtr, fvgProx, "bull");
        const bearFvgScore = scoreFvg(bearF, i, atrV, fvgWick, fvgMaxAge, fvgKeep, minFvgAtr, fvgProx, "bear");

        // setup age
        if (bullInvalid) bullSetupAge = NaN;
        else if (bullPbCand[i]) bullSetupAge = 0;
        else if (isFin(bullSetupAge)) { bullSetupAge += 1; if (bullSetupAge > maxSetupBars) bullSetupAge = NaN; }
        if (bearInvalid) bearSetupAge = NaN;
        else if (bearPbCand[i]) bearSetupAge = 0;
        else if (isFin(bearSetupAge)) { bearSetupAge += 1; if (bearSetupAge > maxSetupBars) bearSetupAge = NaN; }

        const bullBreakout = C[i] > hiBefore(H, breakoutLook, i);
        const bearBreakout = C[i] < loBefore(L, breakoutLook, i);
        const bullTrigCandle = (C[i] > O[i] || bullClosePos >= 0.55) && BODY[i] >= atrV * trigBodyAtr;
        const bearTrigCandle = (C[i] < O[i] || bearClosePos >= 0.55) && BODY[i] >= atrV * trigBodyAtr;
        const bullResume = bullBreakout || crossOverAt(C, emaFast, i) || (C[i] >= nzf(H[i - 1], C[i]) - atrV * 0.05) || (C[i] > nzf(C[i - 1], C[i]) && bullClosePos >= 0.55 && C[i] >= emaFast[i] - atrV * 0.15);
        const bearResume = bearBreakout || crossUnderAt(C, emaFast, i) || (C[i] <= nzf(L[i - 1], C[i]) + atrV * 0.05) || (C[i] < nzf(C[i - 1], C[i]) && bearClosePos >= 0.55 && C[i] <= emaFast[i] + atrV * 0.15);
        const bullTrigVol = !useTrigVol || VOL[i] >= volMA[i] * trigVolMult;
        const bearTrigVol = bullTrigVol;
        const bullVwapOk = !useVwapAlign || C[i] > sessVwap[i] || C[i] > emaFast[i];
        const bearVwapOk = !useVwapAlign || C[i] < sessVwap[i] || C[i] < emaFast[i];
        const cvdClose = CVD[i], cvdOpen = CVD[i] - D[i];
        const bullCvdOk = !useCvd || ((cvdClose >= cvdOpen || cvdClose > cvdBias[i]) && cvdClose >= nzf(CVD[i - 1], cvdClose));
        const bearCvdOk = !useCvd || ((cvdClose <= cvdOpen || cvdClose < cvdBias[i]) && cvdClose <= nzf(CVD[i - 1], cvdClose));
        const bullFlowOk = !useFlow || (dPct >= minTrigDp && buyAbs >= sellAbs * trigRatio && dPct >= deltaPctEma[i]);
        const bearFlowOk = !useFlow || (dPct <= -minTrigDp && sellAbs >= buyAbs * trigRatio && dPct <= deltaPctEma[i]);
        const bullFpOk = !useFootprint || !hasFp || (fpDeltaPct >= minFpDp && (minStacked <= 0 || fp.bullStack >= minStacked) && (!reqPoc || C[i] >= fp.poc));
        const bearFpOk = !useFootprint || !hasFp || (fpDeltaPct <= -minFpDp && (minStacked <= 0 || fp.bearStack >= minStacked) && (!reqPoc || C[i] <= fp.poc));

        // scores (kept for strength visibility/future composite use)
        const bullTrendScore = 0.30 * clamp01((dmiA.adx[i] - minAdx) / 20.0) + 0.25 * clamp01((dmiA.plus[i] - dmiA.minus[i]) / 20.0) + 0.25 * clamp01(((emaFast[i] - emaSlow[i]) / rsafe2(atrV, i)) / 1.25) + 0.20 * (bullHtfBias ? 1 : 0);
        const bearTrendScore = 0.30 * clamp01((dmiA.adx[i] - minAdx) / 20.0) + 0.25 * clamp01((dmiA.minus[i] - dmiA.plus[i]) / 20.0) + 0.25 * clamp01(((emaSlow[i] - emaFast[i]) / rsafe2(atrV, i)) / 1.25) + 0.20 * (bearHtfBias ? 1 : 0);
        const bullZoneFit = clamp01(1 - bullZoneDist / Math.max(zoneAtr * 2.5, 0.20));
        const bearZoneFit = clamp01(1 - bearZoneDist / Math.max(zoneAtr * 2.5, 0.20));
        const bullDepthFit = fitToBand(bullPbDepth, minPbAtr, maxPbAtr);
        const bearDepthFit = fitToBand(bearPbDepth, minPbAtr, maxPbAtr);
        const bullRsiFit = fitToBand(rsiA[i], bullRsiFloor, bullRsiCeil);
        const bearRsiFit = fitToBand(rsiA[i], bearRsiFloor, bearRsiCeil);
        const quietFit = !useQuiet ? 1 : clamp01((volMA[i] * pbVolMult - VOL[i]) / Math.max(volMA[i] * pbVolMult, tickSize(i)));
        const bullCounterFit = !usePbDelta ? 1 : clamp01(1 - Math.max(-dPct, 0) / Math.max(maxCounterDp, 1));
        const bearCounterFit = !usePbDelta ? 1 : clamp01(1 - Math.max(dPct, 0) / Math.max(maxCounterDp, 1));
        const bullPbScore = 0.30 * bullZoneFit + 0.25 * bullDepthFit + 0.20 * bullRsiFit + 0.15 * quietFit + 0.10 * bullCounterFit;
        const bearPbScore = 0.30 * bearZoneFit + 0.25 * bearDepthFit + 0.20 * bearRsiFit + 0.15 * quietFit + 0.10 * bearCounterFit;
        const trigBodyFit = clamp01(BODY[i] / Math.max(atrV * Math.max(trigBodyAtr * 2.0, 0.15), tickSize(i)));
        const volFit = !useTrigVol ? clamp01(VOL[i] / Math.max(volMA[i], tickSize(i))) : clamp01(VOL[i] / Math.max(volMA[i] * trigVolMult, tickSize(i)));
        const bullDeltaFit = clamp01(dPct / Math.max(minTrigDp * 2.0, 10.0));
        const bearDeltaFit = clamp01((-dPct) / Math.max(minTrigDp * 2.0, 10.0));
        const bullPressRatio = buyAbs / Math.max(sellAbs, 1e-10), bearPressRatio = sellAbs / Math.max(buyAbs, 1e-10);
        const bullPressFit = clamp01((bullPressRatio - 1) / Math.max(trigRatio - 1, 0.10));
        const bearPressFit = clamp01((bearPressRatio - 1) / Math.max(trigRatio - 1, 0.10));
        const bullTrigScore = 0.15 * (bullBreakout ? 1 : 0) + 0.10 * (bullResume ? 1 : 0) + 0.15 * (bullTrigCandle ? 1 : 0) + 0.10 * trigBodyFit + 0.15 * volFit + 0.20 * bullDeltaFit + 0.10 * bullPressFit + 0.05 * (bullVwapOk ? 1 : 0);
        const bearTrigScore = 0.15 * (bearBreakout ? 1 : 0) + 0.10 * (bearResume ? 1 : 0) + 0.15 * (bearTrigCandle ? 1 : 0) + 0.10 * trigBodyFit + 0.15 * volFit + 0.20 * bearDeltaFit + 0.10 * bearPressFit + 0.05 * (bearVwapOk ? 1 : 0);
        const bullFpDeltaFit = !useFootprint ? 1 : (hasFp ? clamp01(fpDeltaPct / Math.max(minFpDp * 2.0, 10.0)) : 0);
        const bearFpDeltaFit = !useFootprint ? 1 : (hasFp ? clamp01((-fpDeltaPct) / Math.max(minFpDp * 2.0, 10.0)) : 0);
        const bullImbFit = !useFootprint ? 1 : (minStacked <= 0 ? clamp01(fp.bullStack / 2.0) : clamp01(fp.bullStack / (minStacked + 1)));
        const bearImbFit = !useFootprint ? 1 : (minStacked <= 0 ? clamp01(fp.bearStack / 2.0) : clamp01(fp.bearStack / (minStacked + 1)));
        const bullPocFit = (!useFootprint || !reqPoc) ? 1 : (C[i] >= fp.poc ? 1 : 0);
        const bearPocFit = (!useFootprint || !reqPoc) ? 1 : (C[i] <= fp.poc ? 1 : 0);
        const bullFpScore = !useFootprint ? 1 : 0.50 * bullFpDeltaFit + 0.30 * bullImbFit + 0.20 * bullPocFit;
        const bearFpScore = !useFootprint ? 1 : 0.50 * bearFpDeltaFit + 0.30 * bearImbFit + 0.20 * bearPocFit;
        let bbs = clamp01(0.30 * bullTrendScore + 0.25 * bullPbScore + 0.25 * bullTrigScore + 0.20 * bullFpScore);
        let bbr = clamp01(0.30 * bearTrendScore + 0.25 * bearPbScore + 0.25 * bearTrigScore + 0.20 * bearFpScore);
        const bullCtxW = isFin(bullSetupAge) ? 1 : (bullPbCand[i] ? 1 : 0.60);
        const bearCtxW = isFin(bearSetupAge) ? 1 : (bearPbCand[i] ? 1 : 0.60);
        const bullBoost = useFvg ? bullFvgScore * bullCtxW * (fvgBoostPct / 100.0) : 0;
        const bearBoost = useFvg ? bearFvgScore * bearCtxW * (fvgBoostPct / 100.0) : 0;
        bullStr[i] = clamp01(bbs + bullBoost) * 100;
        bearStr[i] = clamp01(bbr + bearBoost) * 100;

        const bullTrigEdge = bullResume && bullTrigCandle && bullTrigVol && bullVwapOk;
        const bearTrigEdge = bearResume && bearTrigCandle && bearTrigVol && bearVwapOk;
        const bullCdOk = !isFin(lastBull) || (i - lastBull) > minBars;
        const bearCdOk = !isFin(lastBear) || (i - lastBear) > minBars;
        const doji = isDoji(BODY[i], RANGE[i], dojiMax, i);
        bullCand[i] = !useCandle || doji || isHammer(i, hammerWick, hammerOpp) || isInvHammer(i, hammerWick, hammerOpp);
        bearCand[i] = !useCandle || doji || isShootingStar(i, hammerWick, hammerOpp);
        // Pine PARITY: i3_bull/bearFlowConfirmed (CVD bias + orderflow trigger + footprint)
        // ARE computed in the Pine source (lines 846/847) but are NEVER referenced in the
        // i3 signal gate (lines 906/907) -- dead code there. So we do NOT gate the signal
        // on them; the trigger edge already encodes resume+candle+volume+VWAP. Keeping
        // them in a void reference documents the mapping without changing signal timing.
        void (bullCvdOk && bullFlowOk && bullFpOk);
        void (bearCvdOk && bearFlowOk && bearFpOk);

        let bSig = input.enableIndicator3 !== false && isFin(bullSetupAge) && bullSetupAge >= 0 && bullBand && C[i] >= emaFast[i] - atrV * 0.35 && bullTrigEdge && !bullTrigEdgePrev && bullCdOk && bullCand[i];
        let sSig = input.enableIndicator3 !== false && isFin(bearSetupAge) && bearSetupAge >= 0 && bearBand && C[i] <= emaFast[i] + atrV * 0.35 && bearTrigEdge && !bearTrigEdgePrev && bearCdOk && bearCand[i];
        bull[i] = bSig; bear[i] = sSig;
        if (bSig) { lastBull = i; bullSetupAge = NaN; }
        if (sSig) { lastBear = i; bearSetupAge = NaN; }
        bullTrigEdgePrev = bullTrigEdge; bearTrigEdgePrev = bearTrigEdge;
      }
      return { bull, bear, bullStr, bearStr };

      function scoreFvg(store, i, atrV, wick, maxAge, keep, minAtr, prox, side) {
        let score = 0;
        for (let k = store.top.length - 1; k >= 0; k--) {
          const top = store.top[k], bot = store.bot[k];
          let age = i - store.born[k];
          let mit = store.mit[k];
          const shouldMit = side === "bull" ? (wick ? L[i] <= bot : C[i] <= bot) : (wick ? H[i] >= top : C[i] >= top);
          if (!mit && shouldMit) { mit = true; store.mit[k] = true; store.born[k] = i; age = 0; }
          const expired = mit ? age > keep : age > maxAge;
          if (expired) { store.top.splice(k, 1); store.bot.splice(k, 1); store.born.splice(k, 1); store.mit.splice(k, 1); continue; }
          if (!mit) {
            const dist = zoneDistAtr(top, bot, H[i], L[i], atrV);
            const sizeFit = clamp01(((top - bot) / rsafe2(atrV, i)) / Math.max(minAtr * 3.0, 0.25));
            const fresh = clamp01(1 - age / Math.max(maxAge, 1));
            const proxFit = clamp01(1 - dist / Math.max(prox, 0.05));
            const mid = (top + bot) / 2;
            const touched = barOverlaps(top, bot, H[i], L[i]);
            const respectFit = side === "bull"
              ? (touched ? (C[i] >= mid ? 1 : C[i] >= bot ? 0.65 : 0.25) : proxFit)
              : (touched ? (C[i] <= mid ? 1 : C[i] <= top ? 0.65 : 0.25) : proxFit);
            const s = 0.45 * proxFit + 0.25 * fresh + 0.15 * sizeFit + 0.15 * respectFit;
            if (s >= score) score = s;
          }
        }
        return score;
      }
    }

    function footprintParent(i) {
      const c = candles[i] || {};
      const sig = c.signals || {};
      const cells = Array.isArray(c.cells) ? c.cells : [];
      const tv = positive(c.totalVolume) || VOL[i];
      const fd = num(c.delta);
      const deltaPct = tv > 0 ? (fd / tv) * 100 : 0;
      let bullStack = 0, bearStack = 0, bs = 0, ss = 0;
      for (let k = 0; k < cells.length; k++) {
        const cell = cells[k] || {};
        if (cell.buyImbalance) { bs++; if (bs > bullStack) bullStack = bs; } else bs = 0;
        if (cell.sellImbalance) { ss++; if (ss > bearStack) bearStack = ss; } else ss = 0;
      }
      const zones = Array.isArray(sig.stackedImbalances) ? sig.stackedImbalances : [];
      for (let z = 0; z < zones.length; z++) {
        const zz = zones[z] || {};
        if (zz.direction === "bullish") bullStack = Math.max(bullStack, Math.max(1, num(zz.count)));
        if (zz.direction === "bearish") bearStack = Math.max(bearStack, Math.max(1, num(zz.count)));
      }
      return { has: cells.length > 0 || zones.length > 0 || finite(c.poc), deltaPct, bullStack, bearStack, poc: finite(c.poc) ? Number(c.poc) : C[i] };
    }

    // ============================ OUTPUT ============================
    function draw(i1, i2, i3) {
      const useI1 = input.enableIndicator1 !== false;
      const useI2 = input.enableIndicator2 !== false;
      const useI3 = input.enableIndicator3 !== false;
      const showMarkers = input.showComponentMarkers !== false;
      const showI1 = input.showI1Markers !== false;
      const showI2 = input.showI2Markers === true;
      const showI3 = input.showI3Markers === true;
      const showSuper = input.showSuperSignals === true;
      const skipConf = input.skipConflictingBars !== false;
      // cooldownBars can be 0 (Pine minval 0) -> use a non-clamping reader, not intIn.
      const cooldown = Math.max(0, Math.floor(numIn("cooldownBars", 0)));
      let lastSuper = -1e9;

      for (let i = 0; i <= endIndex; i++) {
        if (showMarkers && useI1 && showI1) {
          if (i1.bull[i]) mark(i, "(" + r0(i1.bullStr[i]) + "," + r0(i1.bearStr[i]) + ")", "#16a34a", "bull");
          if (i1.bear[i]) mark(i, "(" + r0(i1.bearStr[i]) + "," + r0(i1.bullStr[i]) + ")", "#dc2626", "bear");
        }
        if (showMarkers && useI2 && showI2) {
          if (i2.bull[i]) mark(i, "(" + r0(i2.bullStr[i]) + "," + r0(i2.bearStr[i]) + ")", "#0d9488", "bull");
          if (i2.bear[i]) mark(i, "(" + r0(i2.bearStr[i]) + "," + r0(i2.bullStr[i]) + ")", "#f97316", "bear");
        }
        if (showMarkers && useI3 && showI3) {
          if (i3.bull[i]) mark(i, "(" + r0(i3.bullStr[i]) + "," + r0(i3.bearStr[i]) + ")", "#2563eb", "bull");
          if (i3.bear[i]) mark(i, "(" + r0(i3.bearStr[i]) + "," + r0(i3.bullStr[i]) + ")", "#7c3aed", "bear");
        }

        // Super signal: exactly the supplied Pine -> uses Indicator 1 only.
        let superBuy = useI1 && i1.bull[i];
        let superSell = useI1 && i1.bear[i];
        if (skipConf && superBuy && superSell) { superBuy = false; superSell = false; }
        if ((superBuy || superSell)) {
          if (cooldown > 0 && i - lastSuper <= cooldown) { superBuy = false; superSell = false; }
        }
        if (superBuy || superSell) lastSuper = i;
        if (showSuper && superBuy) mark(i, "B1 " + r0(i1.bullStr[i]) + " " + r0(i1.bearStr[i]), "#15803d", "bull");
        if (showSuper && superSell) mark(i, "S1 " + r0(i1.bearStr[i]) + " " + r0(i1.bullStr[i]), "#7f1d1d", "bear");
      }
    }

    function mark(i, text, color, side) {
      const a = Math.max(range(i), tickSize(i));
      ctx.shape({ time: candles[i].startTime, price: side === "bull" ? L[i] - a * 0.15 : H[i] + a * 0.15, text, color, position: side === "bull" ? "below" : "above" });
    }

    // ============================ HELPERS ============================
    function htfCloses(htf) {
      const cl = [], st = [];
      for (let i = 0; i < htf.length; i++) { cl.push(num(htf[i].close)); st.push(num(htf[i].startTime)); }
      return { cl, st };
    }
    function alignHtf(htfStart, parentT) {
      // for each parent bar, B = index of last htf bar with start <= parent start
      const idx = new Array(n).fill(-1);
      let j = 0;
      for (let i = 0; i < n; i++) {
        while (j + 1 < htfStart.length && htfStart[j + 1] <= parentT[i]) j++;
        idx[i] = (htfStart.length && htfStart[0] <= parentT[i]) ? j : -1;
      }
      return idx;
    }
    function mapHtfEma2(htf, emaLen) {
      const closeArr = new Array(n).fill(NaN), emaArr = new Array(n).fill(NaN), emaPrevArr = new Array(n).fill(NaN);
      if (!Array.isArray(htf) || htf.length < 3) return { close: closeArr, ema: emaArr, emaPrev: emaPrevArr };
      const { cl, st } = htfCloses(htf);
      const e = ema(cl, emaLen);
      const idx = alignHtf(st, T);
      for (let i = 0; i < n; i++) {
        const B = idx[i];
        if (B >= 1) closeArr[i] = cl[B - 1];
        if (B >= 1) emaArr[i] = e[B - 1];
        if (B >= 2) emaPrevArr[i] = e[B - 2];
      }
      return { close: closeArr, ema: emaArr, emaPrev: emaPrevArr };
    }

    function counterTrendState(closeArr, emaLen, dmiA, adxThr, persist) {
      // per-bar trend state on THIS timeframe using [1]-confirmed values (Pine expr)
      const e = ema(closeArr, emaLen);
      const st = new Array(n).fill(0);
      const bullBar = new Array(n).fill(0), bearBar = new Array(n).fill(0);
      for (let i = 1; i < n; i++) {
        const eNow = e[i - 1], ePrev = e[i - 2];
        const ok = isFin(eNow) && isFin(ePrev);
        bullBar[i] = ok && closeArr[i - 1] > eNow && eNow > ePrev && dmiA.plus[i - 1] > dmiA.minus[i - 1] && dmiA.adx[i - 1] > adxThr ? 1 : 0;
        bearBar[i] = ok && closeArr[i - 1] < eNow && eNow < ePrev && dmiA.minus[i - 1] > dmiA.plus[i - 1] && dmiA.adx[i - 1] > adxThr ? 1 : 0;
      }
      for (let i = 0; i < n; i++) {
        let bc = 0, sc = 0;
        for (let k = Math.max(0, i - persist + 1); k <= i; k++) { bc += bullBar[k]; sc += bearBar[k]; }
        st[i] = bc >= persist ? 1 : sc >= persist ? -1 : 0;
      }
      return st;
    }
    function counterTrendState5m(emaLen, adxThr, persist) {
      // literal requestSecurity("5m") so the host prefetches the 5m series
      const sec = ctx.requestSecurity("5m");
      if (!Array.isArray(sec) || sec.length < 5) return new Array(n).fill(0);
      const sc = sec.map(function (x) { return num(x.close); });
      const sh = sec.map(function (x) { return num(x.high); });
      const sl = sec.map(function (x) { return num(x.low); });
      const sst = sec.map(function (x) { return num(x.startTime); });
      const e = ema(sc, emaLen);
      const dmiS = dmi(sh, sl, sc, intIn("i2_adxLength", 14), intIn("i2_adxSmoothing", 14));
      const m = sec.length;
      const stateTf = new Array(m).fill(0);
      const bb = new Array(m).fill(0), sb = new Array(m).fill(0);
      for (let i = 1; i < m; i++) {
        const eNow = e[i - 1], ePrev = e[i - 2];
        const ok = isFin(eNow) && isFin(ePrev);
        bb[i] = ok && sc[i - 1] > eNow && eNow > ePrev && dmiS.plus[i - 1] > dmiS.minus[i - 1] && dmiS.adx[i - 1] > adxThr ? 1 : 0;
        sb[i] = ok && sc[i - 1] < eNow && eNow < ePrev && dmiS.minus[i - 1] > dmiS.plus[i - 1] && dmiS.adx[i - 1] > adxThr ? 1 : 0;
      }
      for (let i = 0; i < m; i++) {
        let bc = 0, ssc = 0;
        for (let k = Math.max(0, i - persist + 1); k <= i; k++) { bc += bb[k]; ssc += sb[k]; }
        stateTf[i] = bc >= persist ? 1 : ssc >= persist ? -1 : 0;
      }
      const idx = alignHtf(sst, T);
      const out = new Array(n).fill(0);
      for (let i = 0; i < n; i++) { const B = idx[i]; out[i] = B >= 0 ? stateTf[B] : 0; }
      return out;
    }

    function bullPbBarsAgo(arr, i) { for (let k = i; k >= 0; k--) if (arr[k]) return i - k; return 1e9; }
    function bearPbBarsAgo(arr, i) { for (let k = i; k >= 0; k--) if (arr[k]) return i - k; return 1e9; }

    function pivots(lowArr, highArr, left, right) {
      const plVal = new Array(n).fill(NaN), plBar = new Array(n).fill(NaN);
      const phVal = new Array(n).fill(NaN), phBar = new Array(n).fill(NaN);
      let lpv = NaN, lpb = NaN, hpv = NaN, hpb = NaN;
      for (let i = 0; i < n; i++) {
        const c = i - right;
        if (c >= left) {
          let isLow = true, isHigh = true;
          for (let j = c - left; j <= c + right; j++) {
            if (j === c) continue;
            if (!(lowArr[c] < lowArr[j])) isLow = false;
            if (!(highArr[c] > highArr[j])) isHigh = false;
          }
          if (isLow) { lpv = lowArr[c]; lpb = c; }
          if (isHigh) { hpv = highArr[c]; hpb = c; }
        }
        plVal[i] = lpv; plBar[i] = lpb; phVal[i] = hpv; phBar[i] = hpb;
      }
      return { plVal, plBar, phVal, phBar };
    }

    function fillVwap(vw, h, l, c, vol, t) {
      let key = "", pv = 0, vv = 0;
      for (let i = 0; i < vw.length; i++) {
        if (Number.isFinite(vw[i])) continue;
        const k = sessionKey(t[i]);
        if (k !== key) { key = k; pv = 0; vv = 0; }
        const src = (h[i] + l[i] + c[i]) / 3, w = Math.max(1, vol[i]);
        pv += src * w; vv += w;
        vw[i] = vv > 0 ? pv / vv : src;
      }
    }
    function sessionKey(t) { const d = new Date(Number(t) + 23 * 3600 * 1000); return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate(); }

    function sma(v, len) { const out = new Array(v.length).fill(NaN); const L = Math.max(1, Math.floor(len)); let s = 0; for (let i = 0; i < v.length; i++) { s += safe(v[i], 0); if (i >= L) s -= safe(v[i - L], 0); if (i >= L - 1) out[i] = s / L; } return out; }
    function ema(v, len) { const out = new Array(v.length).fill(NaN); const L = Math.max(1, Math.floor(len)); const a = 2 / (L + 1); let prev = NaN; for (let i = 0; i < v.length; i++) { const x = safe(v[i], NaN); if (!Number.isFinite(x)) { out[i] = prev; continue; } prev = Number.isFinite(prev) ? a * x + (1 - a) * prev : x; out[i] = prev; } return out; }
    function rma(v, len) { const out = new Array(v.length).fill(NaN); const L = Math.max(1, Math.floor(len)); let prev = NaN, seed = 0, seen = 0; for (let i = 0; i < v.length; i++) { const x = safe(v[i], 0); if (seen < L) { seed += x; seen++; if (seen === L) prev = seed / L; } else prev = (prev * (L - 1) + x) / L; out[i] = prev; } return out; }
    function atr(h, l, c, len) { const tr = new Array(h.length).fill(0); for (let i = 0; i < h.length; i++) tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); return rma(tr, len); }
    function rsi(v, len) { const g = new Array(v.length).fill(0), ls = new Array(v.length).fill(0); for (let i = 1; i < v.length; i++) { const ch = v[i] - v[i - 1]; g[i] = Math.max(0, ch); ls[i] = Math.max(0, -ch); } const ag = rma(g, len), al = rma(ls, len); const out = new Array(v.length).fill(50); for (let i = 0; i < v.length; i++) { if (!Number.isFinite(al[i]) || al[i] === 0) out[i] = Number.isFinite(ag[i]) ? 100 : 50; else out[i] = 100 - 100 / (1 + ag[i] / al[i]); } return out; }
    function dmi(h, l, c, diLen, adxLen) {
      const pdm = new Array(h.length).fill(0), mdm = new Array(h.length).fill(0), tr = new Array(h.length).fill(0);
      for (let i = 1; i < h.length; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0; tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); }
      const trR = rma(tr, diLen), pR = rma(pdm, diLen), mR = rma(mdm, diLen);
      const plus = new Array(h.length).fill(0), minus = new Array(h.length).fill(0), dx = new Array(h.length).fill(0);
      for (let i = 0; i < h.length; i++) { plus[i] = trR[i] ? 100 * pR[i] / trR[i] : 0; minus[i] = trR[i] ? 100 * mR[i] / trR[i] : 0; const s = plus[i] + minus[i]; dx[i] = s ? 100 * Math.abs(plus[i] - minus[i]) / s : 0; }
      return { plus, minus, adx: rma(dx, adxLen) };
    }
    function hi(v, len, i) { let m = -Infinity; for (let j = Math.max(0, i - len + 1); j <= i; j++) if (Number.isFinite(v[j]) && v[j] > m) m = v[j]; return Number.isFinite(m) ? m : v[i]; }
    function lo(v, len, i) { let m = Infinity; for (let j = Math.max(0, i - len + 1); j <= i; j++) if (Number.isFinite(v[j]) && v[j] < m) m = v[j]; return Number.isFinite(m) ? m : v[i]; }
    function hiBefore(v, len, i) { let m = -Infinity; for (let j = Math.max(0, i - len); j < i; j++) if (Number.isFinite(v[j]) && v[j] > m) m = v[j]; return Number.isFinite(m) ? m : v[i]; }
    function loBefore(v, len, i) { let m = Infinity; for (let j = Math.max(0, i - len); j < i; j++) if (Number.isFinite(v[j]) && v[j] < m) m = v[j]; return Number.isFinite(m) ? m : v[i]; }
    function crossOverAt(a, b, i) { return i > 0 && isFin(a[i - 1]) && isFin(b[i - 1]) && isFin(a[i]) && isFin(b[i]) && a[i - 1] <= b[i - 1] && a[i] > b[i]; }
    function crossUnderAt(a, b, i) { return i > 0 && isFin(a[i - 1]) && isFin(b[i - 1]) && isFin(a[i]) && isFin(b[i]) && a[i - 1] >= b[i - 1] && a[i] < b[i]; }

    function isDoji(body, rng, maxBR, i) { return body <= rsafe(rng, i) * maxBR; }
    function isHammer(i, wickM, oppM) { const uw = H[i] - Math.max(O[i], C[i]), lw = Math.min(O[i], C[i]) - L[i]; return lw >= rsafe(BODY[i], i) * wickM && uw <= rsafe(BODY[i], i) * oppM && Math.max(O[i], C[i]) >= H[i] - rsafe(RANGE[i], i) * 0.35; }
    function isInvHammer(i, wickM, oppM) { const uw = H[i] - Math.max(O[i], C[i]), lw = Math.min(O[i], C[i]) - L[i]; return uw >= rsafe(BODY[i], i) * wickM && lw <= rsafe(BODY[i], i) * oppM && Math.min(O[i], C[i]) <= L[i] + rsafe(RANGE[i], i) * 0.35; }
    function isShootingStar(i, wickM, oppM) { const uw = H[i] - Math.max(O[i], C[i]), lw = Math.min(O[i], C[i]) - L[i]; return uw >= rsafe(BODY[i], i) * wickM && lw <= rsafe(BODY[i], i) * oppM && Math.min(O[i], C[i]) <= L[i] + rsafe(RANGE[i], i) * 0.35; }

    function fitToBand(v, lo2, hi2) { const mid = (lo2 + hi2) / 2, half = Math.max((hi2 - lo2) / 2, 0.0001); return clamp01(1 - Math.abs(v - mid) / half); }
    function barOverlaps(top, bot, bh, bl) { return bh >= bot && bl <= top; }
    function zoneDistAtr(top, bot, bh, bl, atrV) { if (barOverlaps(top, bot, bh, bl)) return 0; if (bl > top) return (bl - top) / rsafe2(atrV, 0); if (bh < bot) return (bot - bh) / rsafe2(atrV, 0); return 0; }

    function range(i) { return Math.max(tickSize(i), H[i] - L[i]); }
    function tickSize(i) { const r = candles[i] && Number(candles[i].rowSize); return Number.isFinite(r) && r > 0 ? r : Math.max(1e-6, Math.abs(C[i]) * 1e-5); }
    function rsafe(v, i) { return Math.max(v, tickSize(i)); }
    function rsafe2(v, i) { return Math.max(v, tickSize(i)); }
    function avg2(a, b) { return (a + b) / 2; }
    function avg3(a, b, c) { return (a + b + c) / 3; }
    function avg4(a, b, c, d) { return (a + b + c + d) / 4; }
    function clamp01(v) { return Math.max(0, Math.min(1, safe(v, 0))); }
    function clampN(v) { return Math.max(0, Math.min(100, safe(v, 0))); }
    function r0(v) { return String(Math.round(safe(v, 0))); }
    function intIn(name, fb) { const v = Number(input[name]); return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fb; }
    function numIn(name, fb) { const v = Number(input[name]); return Number.isFinite(v) ? v : fb; }
    function positive(v) { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; }
    function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
    function finite(v) { return Number.isFinite(Number(v)); }
    function isFin(v) { return Number.isFinite(v); }
    function safe(v, fb) { return Number.isFinite(Number(v)) ? Number(v) : fb; }
    function nzv(v) { return Number.isFinite(v) ? v : 0; }
    function nzf(v, fb) { return Number.isFinite(v) ? v : fb; }
  }
});
`;
