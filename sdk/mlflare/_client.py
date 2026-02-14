"""HTTP client for MLflare Worker API — zero external dependencies."""

from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
from typing import Any


class Client:
    def __init__(self, url: str | None = None, token: str | None = None):
        self.url = (url or os.environ.get("MLFLARE_URL", "")).rstrip("/")
        self.token = token or os.environ.get("MLFLARE_API_TOKEN", "")
        if not self.url:
            raise ValueError("MLflare URL required: pass url= or set MLFLARE_URL")
        if not self.token:
            raise ValueError("MLflare token required: pass token= or set MLFLARE_API_TOKEN")

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        """Make an HTTP request with retry and backoff."""
        url = f"{self.url}{path}"
        data = json.dumps(body).encode() if body else None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        last_error: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp_data = resp.read().decode()
                    return json.loads(resp_data) if resp_data else {}
            except urllib.error.HTTPError as e:
                if e.code < 500:
                    raise
                last_error = e
            except (urllib.error.URLError, OSError) as e:
                last_error = e

            if attempt < 2:
                time.sleep(2 ** attempt)

        raise RuntimeError(f"MLflare API request failed after 3 attempts: {last_error}")

    def init_run(self, project: str, config: dict | None = None) -> dict[str, Any]:
        return self._request("POST", "/sdk/init", {"project": project, "config": config})

    def log_metrics(self, run_id: str, metrics: dict, step: int) -> dict:
        return self._request("POST", "/sdk/log", {
            "run_id": run_id,
            "metrics": metrics,
            "step": step,
        })

    def finish_run(self, run_id: str, status: str = "completed") -> dict:
        return self._request("POST", "/sdk/finish", {
            "run_id": run_id,
            "status": status,
        })
