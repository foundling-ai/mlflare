import json
from unittest.mock import MagicMock, patch, call
import pytest

from mlflare._client import Client
from mlflare._run import Run


def make_mock_client():
    client = MagicMock(spec=Client)
    client.init_run.return_value = {"run_id": "test-run-123"}
    client.log_metrics.return_value = {"ok": True}
    client.finish_run.return_value = {"ok": True}
    return client


class TestRun:
    def test_start_initializes_run(self):
        client = make_mock_client()
        run = Run(client=client, project="test-project", config={"lr": 0.001})
        run._start()
        client.init_run.assert_called_once_with("test-project", {"lr": 0.001})
        assert run.id == "test-run-123"

    def test_log_auto_increments_step(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()

        run.log({"loss": 1.0})
        run.log({"loss": 0.5})
        run.log({"loss": 0.3})

        assert client.log_metrics.call_count == 3
        calls = client.log_metrics.call_args_list
        assert calls[0] == call("test-run-123", {"loss": 1.0}, 0)
        assert calls[1] == call("test-run-123", {"loss": 0.5}, 1)
        assert calls[2] == call("test-run-123", {"loss": 0.3}, 2)

    def test_log_explicit_step(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()

        run.log({"loss": 1.0}, step=10)
        client.log_metrics.assert_called_once_with("test-run-123", {"loss": 1.0}, 10)

        # Next auto-step should be 11
        run.log({"loss": 0.5})
        assert client.log_metrics.call_args == call("test-run-123", {"loss": 0.5}, 11)

    def test_finish(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()
        run.finish()
        client.finish_run.assert_called_once_with("test-run-123", "completed")

    def test_finish_idempotent(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()
        run.finish()
        run.finish()
        assert client.finish_run.call_count == 1

    def test_log_after_finish_raises(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()
        run.finish()
        with pytest.raises(RuntimeError, match="finished"):
            run.log({"loss": 0.5})

    def test_context_manager_success(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()
        with run:
            run.log({"loss": 0.5})
        client.finish_run.assert_called_once_with("test-run-123", "completed")

    def test_context_manager_exception(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        run._start()
        try:
            with run:
                run.log({"loss": 0.5})
                raise ValueError("training crashed")
        except ValueError:
            pass
        client.finish_run.assert_called_once_with("test-run-123", "failed")

    def test_log_without_init_raises(self):
        client = make_mock_client()
        run = Run(client=client, project="test")
        with pytest.raises(RuntimeError, match="not initialized"):
            run.log({"loss": 0.5})


class TestModuleLevelAPI:
    @patch("mlflare.Client")
    def test_init_log_finish(self, MockClient):
        mock_instance = make_mock_client()
        MockClient.return_value = mock_instance

        import mlflare
        mlflare._active_run = None  # Reset state

        run = mlflare.init(project="test", url="http://localhost:8787", token="tok")
        assert run.id == "test-run-123"

        mlflare.log({"loss": 0.5})
        mock_instance.log_metrics.assert_called()

        mlflare.finish()
        mock_instance.finish_run.assert_called()

    def test_log_without_init_raises(self):
        import mlflare
        mlflare._active_run = None
        with pytest.raises(RuntimeError, match="No active run"):
            mlflare.log({"loss": 0.5})

    def test_finish_without_init_raises(self):
        import mlflare
        mlflare._active_run = None
        with pytest.raises(RuntimeError, match="No active run"):
            mlflare.finish()
