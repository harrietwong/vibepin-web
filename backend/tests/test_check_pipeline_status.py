"""Unit tests for scripts/check_pipeline_status.py."""

import importlib.util
import os
import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _load_status_module():
    path = BACKEND_ROOT / "scripts" / "check_pipeline_status.py"
    spec = importlib.util.spec_from_file_location("check_pipeline_status", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class TestCheckPipelineStatus(unittest.TestCase):
    def test_missing_env_exits_nonzero(self):
        mod = _load_status_module()
        with patch.dict(os.environ, {}, clear=True):
            with patch("sys.stdout", new_callable=StringIO):
                code = mod.main()
        self.assertEqual(code, 1)

    def test_empty_db_does_not_crash(self):
        sys.path.insert(0, str(BACKEND_ROOT))
        sys.path.insert(0, str(BACKEND_ROOT / "db"))
        mock_http = MagicMock()
        mock_http.head.return_value = MagicMock(
            status_code=200, headers={"Content-Range": "0-0/0"}
        )

        with patch.dict(os.environ, {"SUPABASE_URL": "https://x.supabase.co",
                                     "SUPABASE_SERVICE_ROLE_KEY": "test-key"}):
            with patch("db._get_http", return_value=mock_http):
                with patch("db.select_many", return_value=[]):
                    with patch("sys.stdout", new_callable=StringIO) as out:
                        mod = _load_status_module()
                        code = mod.main()
                        output = out.getvalue()

        self.assertEqual(code, 0)
        self.assertIn("Done.", output)
        self.assertIn("none yet", output.lower())


if __name__ == "__main__":
    unittest.main()
