"""MLflare Python SDK — zero-dependency ML experiment tracking."""

from mlflare._run import Run
from mlflare._client import Client

try:
    from mlflare._version import __version__
except ImportError:
    __version__ = "0.0.0-dev"

__all__ = ["init", "log", "finish", "Run", "__version__"]

_active_run: "Run | None" = None


def init(
    project: str,
    config: dict | None = None,
    url: str | None = None,
    token: str | None = None,
) -> Run:
    """Initialize a new MLflare run."""
    global _active_run
    client = Client(url=url, token=token)
    run = Run(client=client, project=project, config=config)
    run._start()
    _active_run = run
    return run


def log(data: dict, step: int | None = None) -> None:
    """Log metrics to the active run."""
    if _active_run is None:
        raise RuntimeError("No active run. Call mlflare.init() first.")
    _active_run.log(data, step=step)


def finish(status: str = "completed") -> None:
    """Finish the active run."""
    global _active_run
    if _active_run is None:
        raise RuntimeError("No active run. Call mlflare.init() first.")
    _active_run.finish(status=status)
    _active_run = None
