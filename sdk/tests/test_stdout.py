import json
import io
import sys

from mlflare.stdout import log_metrics


def test_log_metrics_outputs_json(capsys):
    log_metrics(loss=0.5, accuracy=0.8)
    captured = capsys.readouterr()
    data = json.loads(captured.out.strip())
    assert "__mlflare__" in data
    assert data["__mlflare__"]["loss"] == 0.5
    assert data["__mlflare__"]["accuracy"] == 0.8


def test_log_metrics_single_value(capsys):
    log_metrics(loss=1.23)
    captured = capsys.readouterr()
    data = json.loads(captured.out.strip())
    assert data["__mlflare__"] == {"loss": 1.23}


def test_log_metrics_multiple_calls(capsys):
    log_metrics(loss=1.0)
    log_metrics(loss=0.5)
    captured = capsys.readouterr()
    lines = captured.out.strip().split("\n")
    assert len(lines) == 2
    d1 = json.loads(lines[0])
    d2 = json.loads(lines[1])
    assert d1["__mlflare__"]["loss"] == 1.0
    assert d2["__mlflare__"]["loss"] == 0.5
