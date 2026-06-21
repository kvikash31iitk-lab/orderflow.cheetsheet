"""SC1 research engine: deterministic per-bar diagnostics + candidate classification.

Mirrors sc1_1604_v3.ts (Indicator 1) + sc1_1604_v4.ts (5s lower-orderflow override).
Produces one diagnostic row per bar (strengths, component scores, every filter's
pass/fail) and a candidate list classified as:
  - baseline:            the SC1 super signal actually fires (I1 only + skip-conflict + cooldown).
  - blocked_by_candle:   strength + net-edge passed and a setup transition occurred, but the
                         hard doji/hammer/shooting-star candle filter blocked it.
  - near_miss:           candle filter passes, but strength/net-edge missed the threshold by a
                         small configurable margin (would fire if thresholds were that looser).
No lookahead: a bar's signal uses only data up to and including that bar.
"""
from __future__ import annotations

from typing import Optional

from .config import Sc1Config
from . import indicators as ta
from .indicators import (
    NAN, is_fin, num, positive, safe, nzv, nzf, clamp01, clampN, avg2, avg3, avg4,
)

# chart timeframe -> bucket ms (for the HTF aggregation)
_TF_MS = {
    "1m": 60_000, "2m": 120_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
    "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1D": 86_400_000,
}


def _tf_ms(tf: str) -> int:
    return _TF_MS.get(tf, 900_000)


def aggregate_to_htf(candles: list[dict], htf: str) -> tuple[list[float], list[float]]:
    """Group parent candles into HTF buckets -> (htf_close, htf_start) ascending."""
    bucket = _tf_ms(htf)
    closes: list[float] = []
    starts: list[float] = []
    cur_start = -1
    for c in candles:
        t = num(c.get("startTime"))
        b = int(t // bucket) * bucket
        if b != cur_start:
            closes.append(num(c.get("close")))
            starts.append(float(b))
            cur_start = b
        else:
            closes[-1] = num(c.get("close"))  # last close in the bucket
    return closes, starts


def _apply_5s(O, T, ends, BUY, SELL, D, MAXD, MIND, five_s, parent_ms, min_cov):
    """V4 applyLowerOrderflow: aggregate 5s children into each parent bar and override
    BUY/SELL/D/MAXD/MIND where coverage is sufficient; else keep parent scalars."""
    n = len(T)
    if not five_s:
        return 0
    five = [c for c in five_s if is_fin(num(c.get("startTime")))]
    five.sort(key=lambda c: num(c.get("startTime")))
    if not five:
        return 0
    first_start = num(five[0].get("startTime"))
    used = 0
    j = 0
    for i in range(n):
        start = T[i]
        end = ends[i] if is_fin(ends[i]) and ends[i] > start else start + parent_ms
        while j < len(five) and num(five[j].get("startTime")) < start:
            j += 1
        k = j
        buy = sell = delta = run = maxD = minD = 0.0
        bars = 0
        while k < len(five):
            cs = num(five[k].get("startTime"))
            if cs >= end:
                break
            buy += positive(five[k].get("totalAskVolume"))
            sell += positive(five[k].get("totalBidVolume"))
            cd = num(five[k].get("delta"))
            delta += cd
            run += cd
            if run > maxD:
                maxD = run
            if run < minD:
                minD = run
            bars += 1
            k += 1
        expected = max(1, round((end - start) / 5000.0))
        if start >= first_start and (bars / expected) >= min_cov:
            BUY[i], SELL[i], D[i], MAXD[i], MIND[i] = buy, sell, delta, maxD, minD
            used += 1
    return used


def run_engine(candles: list[dict], cfg: Sc1Config, five_s: Optional[list[dict]] = None,
               collect_bars: bool = True) -> dict:
    """Compute I1 diagnostics + candidates over closed parent candles.

    `candles`: stored footprint dicts (open/high/low/close/startTime/endTime/totalVolume/
    totalAskVolume/totalBidVolume/delta/cumDelta/vwap/poc/rowSize). `five_s`: optional 5s
    child footprints to override the lower-orderflow (V4). Returns {bars, candidates,
    used5s, n}.
    """
    n = len(candles)
    if n < 30:
        return {"bars": [], "candidates": [], "used5s": 0, "n": n}

    O = [num(c.get("open")) for c in candles]
    H = [num(c.get("high")) for c in candles]
    L = [num(c.get("low")) for c in candles]
    C = [num(c.get("close")) for c in candles]
    T = [num(c.get("startTime")) for c in candles]
    ENDS = [num(c.get("endTime")) for c in candles]
    BUY = [positive(c.get("totalAskVolume")) for c in candles]
    SELL = [positive(c.get("totalBidVolume")) for c in candles]
    VOL = [positive(c.get("totalVolume")) or (BUY[i] + SELL[i]) or abs(num(candles[i].get("delta"))) or 1.0 for i, c in enumerate(candles)]
    D = [num(c.get("delta")) for c in candles]
    MAXD = [float(c["maxDelta"]) if is_fin(c.get("maxDelta")) else D[i] for i, c in enumerate(candles)]
    MIND = [float(c["minDelta"]) if is_fin(c.get("minDelta")) else D[i] for i, c in enumerate(candles)]
    CVD = [num(c.get("cumDelta")) for c in candles]
    VWAPv = [float(c["vwap"]) if is_fin(c.get("vwap")) else NAN for c in candles]
    ROW = [float(c["rowSize"]) if is_fin(c.get("rowSize")) and float(c["rowSize"]) > 0 else max(1e-6, abs(C[i]) * 1e-5) for i, c in enumerate(candles)]

    parent_ms = (ENDS[0] - T[0]) if (is_fin(ENDS[0]) and ENDS[0] > T[0]) else (T[1] - T[0] if n > 1 else 60000)
    used5s = 0
    if cfg.use5sOrderflow and five_s:
        used5s = _apply_5s(O, T, ENDS, BUY, SELL, D, MAXD, MIND, five_s, parent_ms, cfg.min5sCoverage)

    VWAPv = ta.fill_vwap(VWAPv, H, L, C, VOL, T)

    RANGE = [H[i] - L[i] for i in range(n)]
    BODY = [abs(C[i] - O[i]) for i in range(n)]
    UWICK = [H[i] - max(C[i], O[i]) for i in range(n)]
    LWICK = [min(C[i], O[i]) - L[i] for i in range(n)]
    CLOSEPOS = [((C[i] - L[i]) / RANGE[i]) if RANGE[i] > 0 else 0.5 for i in range(n)]
    DPCT = [((D[i] / VOL[i]) * 100.0) if VOL[i] > 0 else 0.0 for i in range(n)]

    def rsafe(v, i):
        return max(v, ROW[i])

    def tickrange(i):
        return max(ROW[i], H[i] - L[i])

    # shared TA
    volMA = ta.sma(VOL, cfg.i1_volLength)
    rsiA = ta.rsi(C, cfg.i1_rsiLength)
    atrA = ta.atr(H, L, C, cfg.i1_atrLength)
    trendEma = ta.ema(C, cfg.i1_trendEmaLength)
    dmiA = ta.dmi(H, L, C, cfg.i1_adxLength, cfg.i1_adxSmoothing)
    piv = ta.pivots(L, H, cfg.i1_lsPivotLeft, cfg.i1_lsPivotRight)
    hclose, hstart = aggregate_to_htf(candles, cfg.htfTimeframe)
    htf = ta.map_htf_ema(hclose, hstart, T, cfg.i1_htfEmaLength)

    cvd3 = [D[i] + nzv(ta._at(D, i - 1)) + nzv(ta._at(D, i - 2)) for i in range(n)]

    # candle filters
    def is_doji(i):
        return BODY[i] <= rsafe(RANGE[i], i) * cfg.i1_dojiMaxBodyRange

    def is_hammer(i):
        uw = H[i] - max(O[i], C[i]); lw = min(O[i], C[i]) - L[i]
        return lw >= rsafe(BODY[i], i) * cfg.i1_hammerMinWickBody and uw <= rsafe(BODY[i], i) * cfg.i1_hammerMaxOppositeWickBody and max(O[i], C[i]) >= H[i] - rsafe(RANGE[i], i) * 0.35

    def is_inv_hammer(i):
        uw = H[i] - max(O[i], C[i]); lw = min(O[i], C[i]) - L[i]
        return uw >= rsafe(BODY[i], i) * cfg.i1_hammerMinWickBody and lw <= rsafe(BODY[i], i) * cfg.i1_hammerMaxOppositeWickBody and min(O[i], C[i]) <= L[i] + rsafe(RANGE[i], i) * 0.35

    def is_shooting_star(i):
        return is_inv_hammer(i)  # same wick geometry in the source

    end_index = n - 1
    bars: list[dict] = []
    bull_setup = [False] * n
    bear_setup = [False] * n
    near_bull = [False] * n
    near_bear = [False] * n
    bull_candle = [False] * n
    bear_candle = [False] * n
    bull_str = [0.0] * n
    bear_str = [0.0] * n
    diag: list[Optional[dict]] = [None] * n

    minStr = cfg.i1_minStrength
    netThr = cfg.i1_netEdgeSignalThreshold
    sMargin = cfg.nearMissStrengthMargin
    nMargin = cfg.nearMissNetEdgeMargin

    for i in range(1, end_index + 1):
        atrV = safe(atrA[i], tickrange(i))
        buy, sell = BUY[i], SELL[i]
        prevBuy = nzf(ta._at(BUY, i - 1), buy)
        prevSell = nzf(ta._at(SELL, i - 1), sell)
        prevDp = nzv(ta._at(DPCT, i - 1))
        closePos, dPct = CLOSEPOS[i], DPCT[i]
        swingLow = ta.lo_before(L, cfg.i1_lookback, i)
        swingHigh = ta.hi_before(H, cfg.i1_lookback, i)
        swingWin = rsafe(atrV * cfg.i1_swingAtrMult, i)
        lowVol = clamp01((volMA[i] * cfg.i1_weakVol - VOL[i]) / rsafe(volMA[i] * cfg.i1_weakVol, i))
        strongCloseBull = clamp01((closePos - 0.65) / 0.35)
        strongCloseBear = clamp01((0.35 - closePos) / 0.35)
        bullSwing = clamp01((swingLow + swingWin - L[i]) / swingWin)
        bearSwing = clamp01((H[i] - (swingHigh - swingWin)) / swingWin)
        bullReject = avg2(clamp01((closePos - 0.52) / 0.48), clamp01((LWICK[i] / rsafe(BODY[i], i) - 0.80) / 1.20))
        bearReject = avg2(clamp01((0.48 - closePos) / 0.48), clamp01((UWICK[i] / rsafe(BODY[i], i) - 0.80) / 1.20))

        lsMinDist = atrV * cfg.i1_lsMinSweepAtr
        lsVolThr = volMA[i] * cfg.i1_lsVolumeMult
        plVal, plBar = piv["plVal"][i], piv["plBar"][i]
        phVal, phBar = piv["phVal"][i], piv["phBar"][i]
        bullLsValid = is_fin(plVal) and is_fin(plBar) and i > plBar and (i - plBar) <= cfg.i1_lsMaxAgeBars
        bearLsValid = is_fin(phVal) and is_fin(phBar) and i > phBar and (i - phBar) <= cfg.i1_lsMaxAgeBars
        bullSweepDist = max(plVal - L[i], 0.0) if bullLsValid else 0.0
        bearSweepDist = max(H[i] - phVal, 0.0) if bearLsValid else 0.0
        bullSwept = bullLsValid and L[i] < plVal - lsMinDist
        bearSwept = bearLsValid and H[i] > phVal + lsMinDist
        bullBackIn = bullLsValid and C[i] > plVal
        bearBackIn = bearLsValid and C[i] < phVal
        lsVolOk = cfg.i1_lsVolumeMult <= 0 or VOL[i] >= lsVolThr
        useLS = cfg.i1_useLiquiditySweep
        bullLsActive = useLS and bullSwept and lsVolOk and (not cfg.i1_lsRequireCloseBackIn or bullBackIn)
        bearLsActive = useLS and bearSwept and lsVolOk and (not cfg.i1_lsRequireCloseBackIn or bearBackIn)
        bullLs = avg4(
            clamp01((bullSweepDist - lsMinDist) / rsafe(max(lsMinDist, atrV * 0.5), i)),
            1.0 if bullBackIn else 0.0, strongCloseBull,
            max(clamp01((dPct - prevDp) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)))) if bullLsActive else 0.0
        bearLs = avg4(
            clamp01((bearSweepDist - lsMinDist) / rsafe(max(lsMinDist, atrV * 0.5), i)),
            1.0 if bearBackIn else 0.0, strongCloseBear,
            max(clamp01((prevDp - dPct) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)))) if bearLsActive else 0.0

        bullExhaust = avg4(bullSwing, bullReject, clamp01((45.0 - rsiA[i]) / 45.0),
                           max(lowVol, max(clamp01((dPct - prevDp) / 25.0), clamp01((prevSell - sell) / rsafe(prevSell, i)))))
        bearExhaust = avg4(bearSwing, bearReject, clamp01((rsiA[i] - 55.0) / 45.0),
                           max(lowVol, max(clamp01((prevDp - dPct) / 25.0), clamp01((prevBuy - buy) / rsafe(prevBuy, i)))))
        bullAbsorp = avg3(bullSwing, clamp01(((-dPct) - cfg.i1_absorpDeltaPct) / rsafe(cfg.i1_absorpDeltaPct, i)), clamp01((closePos - 0.58) / 0.42))
        bearAbsorp = avg3(bearSwing, clamp01((dPct - cfg.i1_absorpDeltaPct) / rsafe(cfg.i1_absorpDeltaPct, i)), clamp01((0.42 - closePos) / 0.42))
        bullTrap = avg4(bullSwing, clamp01(((-MIND[i]) - (VOL[i] * cfg.i1_trapDeltaMult)) / rsafe(VOL[i] * cfg.i1_trapDeltaMult, i)),
                        clamp01((dPct + cfg.i1_absorpDeltaPct) / rsafe(cfg.i1_absorpDeltaPct * 2.0, i)), clamp01((closePos - 0.55) / 0.45))
        bearTrap = avg4(bearSwing, clamp01((MAXD[i] - (VOL[i] * cfg.i1_trapDeltaMult)) / rsafe(VOL[i] * cfg.i1_trapDeltaMult, i)),
                        clamp01((cfg.i1_absorpDeltaPct - dPct) / rsafe(cfg.i1_absorpDeltaPct * 2.0, i)), clamp01((0.45 - closePos) / 0.45))
        c3, c3p = cvd3[i], nzv(ta._at(cvd3, i - 1))
        bullCvd = avg2(bullSwing, clamp01((c3 - c3p) / rsafe(abs(c3p) + VOL[i] * 0.1, i)))
        bearCvd = avg2(bearSwing, clamp01((c3p - c3) / rsafe(abs(c3p) + VOL[i] * 0.1, i)))
        prevCp = nzf(ta._at(CLOSEPOS, i - 1), closePos)
        bullRev = avg4(bullAbsorp, clamp01((dPct - prevDp) / 25.0), clamp01((buy - prevBuy) / rsafe(prevBuy, i)), clamp01((closePos - prevCp) / 0.35))
        bearRev = avg4(bearAbsorp, clamp01((prevDp - dPct) / 25.0), clamp01((sell - prevSell) / rsafe(prevSell, i)), clamp01((prevCp - closePos) / 0.35))

        rawBull = clampN(15 * bullSwing + 20 * bullExhaust + 25 * bullAbsorp + 20 * bullTrap + 20 * bullCvd + 15 * bullRev + 10 * bullReject + 10 * strongCloseBull + 5 * lowVol + cfg.i1_lsWeight * bullLs)
        rawBear = clampN(15 * bearSwing + 20 * bearExhaust + 25 * bearAbsorp + 20 * bearTrap + 20 * bearCvd + 15 * bearRev + 10 * bearReject + 10 * strongCloseBear + 5 * lowVol + cfg.i1_lsWeight * bearLs)

        hc, he, hep = htf["close"][i], htf["ema"][i], htf["emaPrev"][i]
        bearHtf = is_fin(hc) and is_fin(he) and is_fin(hep) and hc < he and he < hep
        bullHtf = is_fin(hc) and is_fin(he) and is_fin(hep) and hc > he and he > hep
        bearAdx = is_fin(dmiA["adx"][i]) and dmiA["adx"][i] > cfg.i1_adxTrendThreshold and dmiA["minus"][i] > dmiA["plus"][i]
        bullAdx = is_fin(dmiA["adx"][i]) and dmiA["adx"][i] > cfg.i1_adxTrendThreshold and dmiA["plus"][i] > dmiA["minus"][i]
        useTrend = cfg.i1_useTrendRegimeFilter
        strongBear = useTrend and bearHtf and bearAdx
        strongBull = useTrend and bullHtf and bullAdx
        useReclaim = cfg.i1_useReclaimFilter
        useStruct = cfg.i1_useStructureBreakFilter
        bullReclaim = (not useReclaim) or C[i] > VWAPv[i] or C[i] > trendEma[i]
        bearReclaim = (not useReclaim) or C[i] < VWAPv[i] or C[i] < trendEma[i]
        bullStruct = is_fin(phVal) and is_fin(phBar) and i > phBar and (i - phBar) <= cfg.i1_structureMaxAgeBars and C[i] > phVal
        bearStruct = is_fin(plVal) and is_fin(plBar) and i > plBar and (i - plBar) <= cfg.i1_structureMaxAgeBars and C[i] < plVal
        bullCtPen = cfg.i1_trendPenaltyWeight if (useTrend and strongBear) else 0.0
        bearCtPen = cfg.i1_trendPenaltyWeight if (useTrend and strongBull) else 0.0
        bullRelief = (cfg.i1_reclaimReliefWeight if (useReclaim and bullReclaim) else 0.0) + (cfg.i1_structureReliefWeight if (useStruct and bullStruct) else 0.0)
        bearRelief = (cfg.i1_reclaimReliefWeight if (useReclaim and bearReclaim) else 0.0) + (cfg.i1_structureReliefWeight if (useStruct and bearStruct) else 0.0)
        bullSoft = (cfg.i1_softMissingPenalty if (useReclaim and not bullReclaim) else 0.0) + (cfg.i1_softMissingPenalty if (useStruct and not bullStruct) else 0.0)
        bearSoft = (cfg.i1_softMissingPenalty if (useReclaim and not bearReclaim) else 0.0) + (cfg.i1_softMissingPenalty if (useStruct and not bearStruct) else 0.0)
        bullBonus = cfg.i1_trendAlignedBonusWeight if (useTrend and bullHtf and dmiA["plus"][i] >= dmiA["minus"][i]) else 0.0
        bearBonus = cfg.i1_trendAlignedBonusWeight if (useTrend and bearHtf and dmiA["minus"][i] >= dmiA["plus"][i]) else 0.0
        bullPen = max(0.0, bullCtPen - bullRelief) + bullSoft
        bearPen = max(0.0, bearCtPen - bearRelief) + bearSoft

        bs = clampN(rawBull - bullPen + bullBonus)
        br = clampN(rawBear - bearPen + bearBonus)
        bull_str[i], bear_str[i] = bs, br
        netBuy, netSell = bs - br, br - bs
        bull_setup[i] = bs >= minStr and netBuy >= netThr
        bear_setup[i] = br >= minStr and netSell >= netThr
        near_bull[i] = (not bull_setup[i]) and bs >= (minStr - sMargin) and netBuy >= (netThr - nMargin)
        near_bear[i] = (not bear_setup[i]) and br >= (minStr - sMargin) and netSell >= (netThr - nMargin)
        doji = is_doji(i)
        bull_candle[i] = (not cfg.i1_useSignalCandleFilter) or doji or is_hammer(i) or is_inv_hammer(i)
        bear_candle[i] = (not cfg.i1_useSignalCandleFilter) or doji or is_shooting_star(i)

        # The full per-bar diagnostic dict is heavy (nested components/weights/trend). In
        # large-dataset mode (collect_bars=False) build it ONLY for bars that can become a
        # candidate — so we never retain ~n dicts for hundreds of thousands of bars.
        # Candidate bars need a setup THIS bar (no-confirm path) or the PRIOR bar (confirm
        # path: raw/blocked at i use setup[i-1]) or a near-miss this bar. Candidate output
        # is byte-identical; only the discarded `bars` list shrinks.
        if not (collect_bars or bull_setup[i] or bear_setup[i] or near_bull[i] or near_bear[i]
                or bull_setup[i - 1] or bear_setup[i - 1]):
            continue

        diag[i] = {
            "index": i, "startTime": int(T[i]), "endTime": int(ENDS[i]) if is_fin(ENDS[i]) else int(T[i] + parent_ms),
            "open": O[i], "high": H[i], "low": L[i], "close": C[i],
            "volume": VOL[i], "delta": D[i], "cumDelta": CVD[i], "buy": buy, "sell": sell,
            "maxDelta": MAXD[i], "minDelta": MIND[i], "atr": atrV,
            "bullStrength": round(bs, 2), "bearStrength": round(br, 2),
            "netBullEdge": round(netBuy, 2), "netBearEdge": round(netSell, 2),
            "doji": doji, "hammer": is_hammer(i), "invHammer": is_inv_hammer(i), "shootingStar": is_shooting_star(i),
            "bullCandleOk": bull_candle[i], "bearCandleOk": bear_candle[i],
            "bullStrengthPass": bs >= minStr, "bearStrengthPass": br >= minStr,
            "bullNetEdgePass": netBuy >= netThr, "bearNetEdgePass": netSell >= netThr,
            "bullSetup": bull_setup[i], "bearSetup": bear_setup[i],
            "components": {
                "bull": {"swing": round(bullSwing, 3), "exhaust": round(bullExhaust, 3), "absorption": round(bullAbsorp, 3), "trap": round(bullTrap, 3), "cvd": round(bullCvd, 3), "reversal": round(bullRev, 3), "reject": round(bullReject, 3), "strongClose": round(strongCloseBull, 3), "lowVol": round(lowVol, 3), "liqSweep": round(bullLs, 3)},
                "bear": {"swing": round(bearSwing, 3), "exhaust": round(bearExhaust, 3), "absorption": round(bearAbsorp, 3), "trap": round(bearTrap, 3), "cvd": round(bearCvd, 3), "reversal": round(bearRev, 3), "reject": round(bearReject, 3), "strongClose": round(strongCloseBear, 3), "lowVol": round(lowVol, 3), "liqSweep": round(bearLs, 3)},
                "weights": {"swing": 15, "exhaust": 20, "absorption": 25, "trap": 20, "cvd": 20, "reversal": 15, "reject": 10, "strongClose": 10, "lowVol": 5, "liqSweep": cfg.i1_lsWeight},
            },
            "penalties": {"bull": round(bullPen, 2), "bear": round(bearPen, 2)},
            "bonus": {"bull": round(bullBonus, 2), "bear": round(bearBonus, 2)},
            "rawStrength": {"bull": round(rawBull, 2), "bear": round(rawBear, 2)},
            "trend": {"bullHtf": bullHtf, "bearHtf": bearHtf, "bullAdx": bullAdx, "bearAdx": bearAdx, "adx": round(dmiA["adx"][i], 2) if is_fin(dmiA["adx"][i]) else None},
        }

    # ---- signal derivation (no-confirm path) + super skip-conflict + cooldown ----
    useConfirm = cfg.i1_useConfirm
    raw_bull = [False] * n
    raw_bear = [False] * n
    blk_bull = [False] * n
    blk_bear = [False] * n
    nm_bull = [False] * n
    nm_bear = [False] * n
    for i in range(1, end_index + 1):
        if useConfirm:
            bbase = bull_setup[i - 1] and C[i] > H[i - 1]
            sbase = bear_setup[i - 1] and C[i] < L[i - 1]
        else:
            bbase = bull_setup[i] and not bull_setup[i - 1]
            sbase = bear_setup[i] and not bear_setup[i - 1]
        raw_bull[i] = bbase and bull_candle[i]
        raw_bear[i] = sbase and bear_candle[i]
        blk_bull[i] = bbase and not bull_candle[i]
        blk_bear[i] = sbase and not bear_candle[i]
        nm_bull[i] = near_bull[i] and not near_bull[i - 1] and bull_candle[i] and not bull_setup[i]
        nm_bear[i] = near_bear[i] and not near_bear[i - 1] and bear_candle[i] and not bear_setup[i]

    # super signal = I1 only + skip-conflict + cooldown (baseline class)
    cooldown = max(0, int(cfg.cooldownBars))
    last_super = -10**9
    candidates: list[dict] = []
    for i in range(0, end_index + 1):
        sBuy = raw_bull[i]
        sSell = raw_bear[i]
        if cfg.skipConflictingBars and sBuy and sSell:
            sBuy = sSell = False
        if (sBuy or sSell) and cooldown > 0 and (i - last_super) <= cooldown:
            sBuy = sSell = False
        if sBuy or sSell:
            last_super = i
        d = diag[i]
        if d is None:
            continue
        if sBuy:
            candidates.append(_cand(d, "long", "baseline"))
        if sSell:
            candidates.append(_cand(d, "short", "baseline"))
        # blocked-by-candle (only when NOT a fired baseline this bar/side)
        if blk_bull[i] and not sBuy:
            candidates.append(_cand(d, "long", "blocked_by_candle"))
        if blk_bear[i] and not sSell:
            candidates.append(_cand(d, "short", "blocked_by_candle"))
        if nm_bull[i] and not sBuy:
            candidates.append(_cand(d, "long", "near_miss"))
        if nm_bear[i] and not sSell:
            candidates.append(_cand(d, "short", "near_miss"))

    return {"bars": [d for d in diag if d is not None], "candidates": candidates, "used5s": used5s, "n": n}


def _cand(d: dict, side: str, klass: str) -> dict:
    return {
        "id": f"{klass}:{side}:{d['startTime']}",
        "barIndex": d["index"],
        "startTime": d["startTime"],
        "endTime": d["endTime"],
        "side": side,
        "klass": klass,
        "open": d["open"], "high": d["high"], "low": d["low"], "close": d["close"],
        "volume": d["volume"], "delta": d["delta"], "atr": d["atr"],
        "bullStrength": d["bullStrength"],
        "bearStrength": d["bearStrength"],
        "netEdge": d["netBullEdge"] if side == "long" else d["netBearEdge"],
        "doji": d["doji"], "hammer": d["hammer"], "invHammer": d["invHammer"], "shootingStar": d["shootingStar"],
        # attribution payload (factor-attribution / drilldown panels)
        "components": d["components"]["bull"] if side == "long" else d["components"]["bear"],
        "weights": d["components"]["weights"],
        "penalty": d["penalties"]["bull"] if side == "long" else d["penalties"]["bear"],
        "bonus": d["bonus"]["bull"] if side == "long" else d["bonus"]["bear"],
        "rawStrength": d["rawStrength"]["bull"] if side == "long" else d["rawStrength"]["bear"],
        "trend": d["trend"],
    }
