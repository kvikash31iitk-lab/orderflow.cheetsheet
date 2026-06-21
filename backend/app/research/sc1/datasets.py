"""Chronological dataset splits for walk-forward research. Pure index math over a candle
count — no I/O — so it is trivially testable and the worker just maps ranges to slices.

Non-overlapping walk-forward: the timeline is cut into `windows` equal spans (oldest→newest);
within each span the first `trainFrac` is TRAIN, the next `valFrac` is VALIDATION, the rest is
TEST. Splits never overlap and are strictly ordered in time, so a parameter chosen on
train/val is always tested on data that comes AFTER it — no lookahead, no train leakage
between folds. Degradation train→val→test (per fold and across folds) is the headline output.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Window:
    index: int
    train: tuple[int, int]   # [lo, hi) bar indices
    val: tuple[int, int]
    test: tuple[int, int]

    def to_dict(self, t_of) -> dict:
        def seg(s):
            lo, hi = s
            return {"loIdx": lo, "hiIdx": hi, "bars": hi - lo,
                    "startTime": t_of(lo) if hi > lo else None,
                    "endTime": t_of(hi - 1) if hi > lo else None}
        return {"index": self.index, "train": seg(self.train), "val": seg(self.val), "test": seg(self.test)}


def make_windows(n: int, windows: int = 4, train_frac: float = 0.6, val_frac: float = 0.2,
                 test_frac: float = 0.2, min_seg_bars: int = 50) -> list[Window]:
    """Split `n` bars into `windows` non-overlapping train/val/test folds.

    Raises ValueError on degenerate config so the API can return a clean 422 instead of
    silently producing meaningless one-bar segments."""
    if n < min_seg_bars * 3:
        raise ValueError(f"not enough bars ({n}) for walk-forward; need >= {min_seg_bars * 3}")
    if windows < 1:
        raise ValueError("windows must be >= 1")
    tot = train_frac + val_frac + test_frac
    if tot <= 0:
        raise ValueError("train/val/test fractions must sum > 0")
    train_frac, val_frac, test_frac = train_frac / tot, val_frac / tot, test_frac / tot
    span = n // windows
    if span < min_seg_bars * 3:
        raise ValueError(f"{windows} windows over {n} bars gives only {span} bars/window; "
                         f"need >= {min_seg_bars * 3}. Use fewer windows or more data.")
    out: list[Window] = []
    for w in range(windows):
        base = w * span
        tr = max(min_seg_bars, int(span * train_frac))
        va = max(min_seg_bars, int(span * val_frac))
        # the LAST window's test extends to n so no recent bars are silently dropped;
        # earlier windows end at the span boundary (non-overlapping).
        span_end = n if w == windows - 1 else base + span
        train = (base, base + tr)
        val = (base + tr, base + tr + va)
        test = (base + tr + va, span_end)
        if test[1] - test[0] < min_seg_bars:
            # squeeze val rather than drop the fold, then re-validate (no silent tiny segs)
            short = min_seg_bars - (test[1] - test[0])
            val = (val[0], max(val[0] + min_seg_bars, val[1] - short))
            test = (val[1], span_end)
        win = Window(w, train, val, test)
        for name, seg in (("train", train), ("val", val), ("test", test)):
            if seg[1] - seg[0] < min_seg_bars:
                raise ValueError(f"window {w} {name} segment is {seg[1] - seg[0]} bars (< {min_seg_bars}); "
                                 f"use fewer windows or adjust train/val/test fractions.")
        out.append(win)
    return out
