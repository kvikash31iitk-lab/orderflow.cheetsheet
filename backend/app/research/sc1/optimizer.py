"""Auditable parameter search for SC1. Generates candidate configs (overrides relative to
baseline) by one of three transparent methods, and scores a config's summary with an
explicit, penalised objective. No black box: every candidate is a small, named set of
changes; the baseline is always included; complexity is penalised.

Methods:
  - grid:        cartesian product of each selected param's discrete grid (bounded).
  - random:      seeded uniform/categorical samples from the param ranges (reproducible).
  - coordinate:  vary exactly ONE param at a time off baseline (most interpretable; never
                 changes >1 param — directly answers "which single knob helps").

Search space is intentionally limited to interpretable I1 knobs. Weights are excluded by
default (changing the 0-100 weighting is high-overfit-risk and hard to justify).
"""
from __future__ import annotations

import random as _random

from .config import Sc1Config

_DEFAULTS = Sc1Config().to_dict()


def _strip_baseline(changed: dict) -> dict:
    """Drop any override whose value already equals the baseline default — those are not
    real changes and shouldn't waste search budget or inflate configsEvaluated."""
    return {k: v for k, v in changed.items() if v != _DEFAULTS.get(k)}

# bounded, interpretable space. `grid` = discrete values; `lo/hi` = random-sample range.
DEFAULT_SPACE: dict[str, dict] = {
    "i1_minStrength": {"type": "float", "lo": 30.0, "hi": 60.0, "grid": [35, 40, 45, 50, 55]},
    "i1_netEdgeSignalThreshold": {"type": "float", "lo": 40.0, "hi": 75.0, "grid": [40, 50, 60, 70]},
    "i1_useSignalCandleFilter": {"type": "bool", "grid": [True, False]},
    "i1_dojiMaxBodyRange": {"type": "float", "lo": 0.06, "hi": 0.20, "grid": [0.08, 0.12, 0.16]},
    "i1_hammerMinWickBody": {"type": "float", "lo": 1.2, "hi": 2.4, "grid": [1.4, 1.8, 2.2]},
    "i1_hammerMaxOppositeWickBody": {"type": "float", "lo": 0.5, "hi": 1.1, "grid": [0.6, 0.8, 1.0]},
}

DEFAULT_PARAMS = ["i1_minStrength", "i1_netEdgeSignalThreshold", "i1_useSignalCandleFilter"]
MAX_EVALS = 60  # hard ceiling on candidates per optimisation (auditable + bounded wall-time)


def select_space(param_names: list[str] | None) -> dict[str, dict]:
    names = param_names or DEFAULT_PARAMS
    return {k: DEFAULT_SPACE[k] for k in names if k in DEFAULT_SPACE}


def _round(spec: dict, v: float):
    if spec["type"] == "bool":
        return bool(v)
    return round(float(v), 4)


def generate(space: dict, method: str = "coordinate", budget: int = MAX_EVALS, seed: int = 1) -> list[dict]:
    """Return a list of `changed` dicts (param->value), baseline {} always FIRST, bounded by
    min(budget, MAX_EVALS)."""
    budget = max(1, min(int(budget), MAX_EVALS))
    out: list[dict] = [{}]  # baseline always included
    if not space:
        return out

    if method == "grid":
        combos: list[dict] = [{}]
        for k, spec in space.items():
            grid = spec.get("grid", [])
            combos = [{**c, k: g} for c in combos for g in grid]
        for c in combos:
            c = _strip_baseline(c)
            if c and c not in out:
                out.append(c)

    elif method == "random":
        rng = _random.Random(seed)
        keys = list(space.keys())
        seen = set()
        attempts = 0
        while len(out) < budget + 1 and attempts < budget * 20:
            attempts += 1
            changed = {}
            for k in keys:
                spec = space[k]
                if spec["type"] == "bool":
                    changed[k] = rng.choice(spec["grid"])
                else:
                    changed[k] = _round(spec, rng.uniform(spec["lo"], spec["hi"]))
            changed = _strip_baseline(changed)
            sig = tuple(sorted(changed.items()))
            if not changed or sig in seen:
                continue
            seen.add(sig)
            out.append(changed)

    else:  # coordinate (default) — one param at a time
        for k, spec in space.items():
            for g in spec.get("grid", []):
                c = _strip_baseline({k: g})
                if c and c not in out:
                    out.append(c)

    return out[: budget + 1]


def objective(summary: dict, changed: dict, min_sample: int = 25, complexity_weight: float = 0.03) -> dict:
    """Penalised objective for ranking. Higher is better. Returns the score + a breakdown so
    the UI can show WHY a config ranks where it does (no opaque number)."""
    n = summary.get("n", 0)
    exp_r = summary.get("expectancyR", 0.0) or 0.0
    mdd = summary.get("maxDrawdownR", 0.0) or 0.0
    sample_pen = 0.0 if n >= min_sample else (min_sample - n) * 0.05
    dd_pen = 0.02 * max(0.0, mdd)
    complexity_pen = complexity_weight * len(changed)  # prefer fewer changes from baseline
    score = round(exp_r - sample_pen - dd_pen - complexity_pen, 4)
    return {
        "score": score,
        "penalties": {"sample": round(sample_pen, 4), "drawdown": round(dd_pen, 4),
                      "complexity": round(complexity_pen, 4)},
    }


def warnings_for(summary: dict, changed: dict, min_sample: int = 25) -> list[str]:
    w: list[str] = []
    n = summary.get("n", 0)
    if n < min_sample:
        w.append(f"low sample (n={n}<{min_sample})")
    if len(changed) > 2:
        w.append("changes >2 params (overfit risk)")
    return w
