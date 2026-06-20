"""Deterministic Python port of SC1 Indicator 1 (the engine that drives the SC1 super
signal). Faithful to frontend/src/indicators/sc1_1604_v3.ts (the verified Pine-parity
script): same TA, same per-bar metrics, same 0-100 strength weights, penalties/reliefs,
net-edge thresholds, candle filters and signal logic. Pure functions, no I/O, no
lookahead — used by the SC1 research engine for offline diagnostics.

Every helper matches the JS NaN/seed behaviour (rma seeding, EMA carry-forward, the
23h-shifted CME session key for VWAP). Backward refs use `_at()` so Python's negative
indexing can never wrap.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional

NAN = float("nan")


def is_fin(v: float) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(v)


def _at(arr: list, i: int) -> float:
    return arr[i] if 0 <= i < len(arr) else NAN


def safe(v, fb: float) -> float:
    return float(v) if is_fin(v) else fb


def num(v) -> float:
    return float(v) if is_fin(v) else 0.0


def positive(v) -> float:
    x = float(v) if is_fin(v) else 0.0
    return x if x > 0 else 0.0


def nzv(v) -> float:
    return float(v) if is_fin(v) else 0.0


def nzf(v, fb: float) -> float:
    return float(v) if is_fin(v) else fb


def clamp01(v) -> float:
    return max(0.0, min(1.0, safe(v, 0.0)))


def clampN(v) -> float:
    return max(0.0, min(100.0, safe(v, 0.0)))


def avg2(a, b):
    return (a + b) / 2.0


def avg3(a, b, c):
    return (a + b + c) / 3.0


def avg4(a, b, c, d):
    return (a + b + c + d) / 4.0


# ----------------------------- TA -----------------------------
def sma(v: list, length: int) -> list:
    n = len(v)
    out = [NAN] * n
    L = max(1, int(length))
    s = 0.0
    for i in range(n):
        s += safe(v[i], 0.0)
        if i >= L:
            s -= safe(v[i - L], 0.0)
        if i >= L - 1:
            out[i] = s / L
    return out


def ema(v: list, length: int) -> list:
    n = len(v)
    out = [NAN] * n
    L = max(1, int(length))
    a = 2.0 / (L + 1)
    prev = NAN
    for i in range(n):
        x = safe(v[i], NAN)
        if not is_fin(x):
            out[i] = prev
            continue
        prev = (a * x + (1 - a) * prev) if is_fin(prev) else x
        out[i] = prev
    return out


def rma(v: list, length: int) -> list:
    n = len(v)
    out = [NAN] * n
    L = max(1, int(length))
    prev = NAN
    seed = 0.0
    seen = 0
    for i in range(n):
        x = safe(v[i], 0.0)
        if seen < L:
            seed += x
            seen += 1
            if seen == L:
                prev = seed / L
        else:
            prev = (prev * (L - 1) + x) / L
        out[i] = prev
    return out


def atr(h: list, l: list, c: list, length: int) -> list:
    n = len(h)
    tr = [0.0] * n
    for i in range(n):
        if i == 0:
            tr[i] = h[i] - l[i]
        else:
            tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    return rma(tr, length)


def rsi(v: list, length: int) -> list:
    n = len(v)
    g = [0.0] * n
    ls = [0.0] * n
    for i in range(1, n):
        ch = v[i] - v[i - 1]
        g[i] = max(0.0, ch)
        ls[i] = max(0.0, -ch)
    ag = rma(g, length)
    al = rma(ls, length)
    out = [50.0] * n
    for i in range(n):
        if not is_fin(al[i]) or al[i] == 0:
            out[i] = 100.0 if is_fin(ag[i]) else 50.0
        else:
            out[i] = 100.0 - 100.0 / (1 + ag[i] / al[i])
    return out


def dmi(h: list, l: list, c: list, di_len: int, adx_len: int) -> dict:
    n = len(h)
    pdm = [0.0] * n
    mdm = [0.0] * n
    tr = [0.0] * n
    for i in range(1, n):
        up = h[i] - h[i - 1]
        dn = l[i - 1] - l[i]
        pdm[i] = up if (up > dn and up > 0) else 0.0
        mdm[i] = dn if (dn > up and dn > 0) else 0.0
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    trR = rma(tr, di_len)
    pR = rma(pdm, di_len)
    mR = rma(mdm, di_len)
    plus = [0.0] * n
    minus = [0.0] * n
    dx = [0.0] * n
    for i in range(n):
        plus[i] = 100 * pR[i] / trR[i] if trR[i] else 0.0
        minus[i] = 100 * mR[i] / trR[i] if trR[i] else 0.0
        s = plus[i] + minus[i]
        dx[i] = 100 * abs(plus[i] - minus[i]) / s if s else 0.0
    return {"plus": plus, "minus": minus, "adx": rma(dx, adx_len)}


def hi_before(v: list, length: int, i: int) -> float:
    m = -math.inf
    for j in range(max(0, i - length), i):
        if is_fin(v[j]) and v[j] > m:
            m = v[j]
    return m if math.isfinite(m) else v[i]


def lo_before(v: list, length: int, i: int) -> float:
    m = math.inf
    for j in range(max(0, i - length), i):
        if is_fin(v[j]) and v[j] < m:
            m = v[j]
    return m if math.isfinite(m) else v[i]


def pivots(low: list, high: list, left: int, right: int) -> dict:
    n = len(low)
    plVal = [NAN] * n
    plBar = [NAN] * n
    phVal = [NAN] * n
    phBar = [NAN] * n
    lpv = lpb = hpv = hpb = NAN
    for i in range(n):
        c = i - right
        if c >= left:
            is_low = True
            is_high = True
            for j in range(c - left, c + right + 1):
                if j == c:
                    continue
                if not (low[c] < low[j]):
                    is_low = False
                if not (high[c] > high[j]):
                    is_high = False
            if is_low:
                lpv, lpb = low[c], c
            if is_high:
                hpv, hpb = high[c], c
        plVal[i], plBar[i], phVal[i], phBar[i] = lpv, lpb, hpv, hpb
    return {"plVal": plVal, "plBar": plBar, "phVal": phVal, "phBar": phBar}


def _session_key(t_ms: float) -> str:
    # CME-style trading day: shift +23h so evening Globex rolls into the next key
    d = datetime.fromtimestamp((float(t_ms) + 23 * 3600 * 1000) / 1000.0, tz=timezone.utc)
    return f"{d.year}-{d.month}-{d.day}"


def fill_vwap(vw: list, h: list, l: list, c: list, vol: list, t: list) -> list:
    out = list(vw)
    key = ""
    pv = 0.0
    vv = 0.0
    for i in range(len(out)):
        if is_fin(out[i]):
            continue
        k = _session_key(t[i])
        if k != key:
            key, pv, vv = k, 0.0, 0.0
        src = (h[i] + l[i] + c[i]) / 3.0
        w = max(1.0, vol[i])
        pv += src * w
        vv += w
        out[i] = pv / vv if vv > 0 else src
    return out


def map_htf_ema(htf_close: list, htf_start: list, parent_t: list, ema_len: int) -> dict:
    """Pine request.security("15", close[1]/ema[1]/ema[2], lookahead_on): for each parent
    bar pick the PRIOR completed HTF bar (bucket B -> B-1 / B-2)."""
    n = len(parent_t)
    close = [NAN] * n
    e_arr = [NAN] * n
    e_prev = [NAN] * n
    if len(htf_close) < 3:
        return {"close": close, "ema": e_arr, "emaPrev": e_prev}
    e = ema(htf_close, ema_len)
    # align: B = index of last htf bar with start <= parent start
    idx = [-1] * n
    j = 0
    for i in range(n):
        while j + 1 < len(htf_start) and htf_start[j + 1] <= parent_t[i]:
            j += 1
        idx[i] = j if (htf_start and htf_start[0] <= parent_t[i]) else -1
    for i in range(n):
        B = idx[i]
        if B >= 1:
            close[i] = htf_close[B - 1]
            e_arr[i] = e[B - 1]
        if B >= 2:
            e_prev[i] = e[B - 2]
    return {"close": close, "ema": e_arr, "emaPrev": e_prev}
