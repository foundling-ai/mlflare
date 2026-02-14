"""Run object — tracks a single MLflare experiment run."""

from __future__ import annotations

import atexit
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mlflare._client import Client


class Run:
    def __init__(self, client: Client, project: str, config: dict | None = None):
        self._client = client
        self.project = project
        self.config = config or {}
        self.id: str | None = None
        self._step = 0
        self._finished = False

    def _start(self) -> None:
        resp = self._client.init_run(self.project, self.config)
        self.id = resp.get("run_id")
        atexit.register(self._atexit_finish)

    def log(self, data: dict, step: int | None = None) -> None:
        if self._finished:
            raise RuntimeError("Cannot log to a finished run.")
        if self.id is None:
            raise RuntimeError("Run not initialized.")
        if step is None:
            step = self._step
            self._step += 1
        else:
            self._step = step + 1
        self._client.log_metrics(self.id, data, step)

    def finish(self, status: str = "completed") -> None:
        if self._finished:
            return
        self._finished = True
        if self.id is not None:
            self._client.finish_run(self.id, status)

    def _atexit_finish(self) -> None:
        if not self._finished:
            try:
                self.finish(status="completed")
            except Exception:
                pass

    def __enter__(self) -> Run:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        status = "failed" if exc_type is not None else "completed"
        self.finish(status=status)
