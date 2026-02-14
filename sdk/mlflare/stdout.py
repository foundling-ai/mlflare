"""Stdout-based metric logging for agent-parsed experiments."""

from __future__ import annotations

import json
import sys


def log_metrics(**kwargs: float) -> None:
    """Emit metrics as JSON to stdout for agent parsing.

    Usage:
        from mlflare.stdout import log_metrics
        log_metrics(loss=0.5, accuracy=0.8)
    """
    payload = json.dumps({"__mlflare__": kwargs})
    print(payload, flush=True)
