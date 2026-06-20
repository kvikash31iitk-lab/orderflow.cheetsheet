"""SC1 V4 research engine: deterministic Python re-implementation of Indicator 1 (the
SC1 super signal) for offline diagnostics, exit scoring and bounded optimisation. Does
not touch the live indicator. See engine.py / exits.py / service.py."""
from .config import ExitConfig, Sc1Config
from . import service

__all__ = ["Sc1Config", "ExitConfig", "service"]
