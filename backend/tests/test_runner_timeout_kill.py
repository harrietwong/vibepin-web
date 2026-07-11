"""Tests for run_bootstrap_product_supply.run_worker_with_timeout — the timeout
process-tree termination hardening.

Reproduces the orphan-write incident in miniature: a fake worker spawns a child
that would "write" (touch a marker file) AFTER a delay. A bare subprocess.run
timeout left such a child alive to write post-timeout. These tests assert the new
helper kills the FULL tree (parent + child) and verifies death before returning.

No real Product-Supply worker, no Playwright, no crawler, no DB, no Pinterest.
"""

import inspect
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

import psutil

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND / "scripts"))
import run_bootstrap_product_supply as runner  # noqa: E402


# Fake worker: spawn a child that writes an "orphan" marker after `delay` seconds,
# record both PIDs, then sleep long. If the tree is killed, the marker never appears.
FAKE_WORKER = (
    "import os, sys, subprocess, time\n"
    "pidfile, marker, delay = sys.argv[1], sys.argv[2], sys.argv[3]\n"
    "child = subprocess.Popen([sys.executable, '-c',\n"
    "    'import time,sys; time.sleep(float(sys.argv[1])); open(sys.argv[2],\"w\").write(\"orphan-wrote\")',\n"
    "    delay, marker])\n"
    "open(pidfile, 'w').write(f'{os.getpid()},{child.pid}')\n"
    "time.sleep(60)\n"
)

# Fake worker that exits cleanly and fast.
FAKE_SUCCESS = "import sys\nsys.exit(0)\n"


class TestRunWorkerWithTimeout(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rwt_"))
        self.worker = self.tmp / "fake_worker.py"
        self.worker.write_text(FAKE_WORKER, encoding="utf-8")
        self.success = self.tmp / "fake_success.py"
        self.success.write_text(FAKE_SUCCESS, encoding="utf-8")
        self.pidfile = self.tmp / "pids.txt"
        self.marker = self.tmp / "orphan_marker.txt"

    def _run_worker(self, *, delay: str, timeout: int):
        cmd = [sys.executable, str(self.worker), str(self.pidfile), str(self.marker), delay]
        return runner.run_worker_with_timeout(cmd, cwd=str(self.tmp), timeout=timeout)

    def _read_pids(self) -> tuple[int, int]:
        # Give the worker a moment to write its pidfile.
        for _ in range(50):
            if self.pidfile.exists() and self.pidfile.read_text().strip():
                break
            time.sleep(0.1)
        wpid, cpid = self.pidfile.read_text().strip().split(",")
        return int(wpid), int(cpid)

    # 1 + 2: timed-out worker parent AND its child are killed.
    def test_timeout_kills_parent_and_child(self):
        result = self._run_worker(delay="4", timeout=2)
        wpid, cpid = self._read_pids()
        self.assertEqual(result.status, "timeout_killed")
        self.assertEqual(result.exit_code, 20)
        self.assertFalse(_alive(wpid), "worker parent still alive after timeout kill")
        self.assertFalse(_alive(cpid), "worker child still alive after timeout kill")

    # 3: exit 20 only after the full tree is terminated (no surviving pids at return).
    def test_exits_20_only_after_tree_dead(self):
        result = self._run_worker(delay="4", timeout=2)
        self.assertEqual(result.status, "timeout_killed")
        self.assertEqual(result.remaining_pids, [])
        wpid, cpid = self._read_pids()
        # Verified IMMEDIATELY on return — no extra grace here.
        self.assertFalse(_alive(wpid))
        self.assertFalse(_alive(cpid))

    # 4: no orphan can write after the runner reports timeout.
    def test_no_orphan_write_after_timeout(self):
        result = self._run_worker(delay="4", timeout=2)
        self.assertEqual(result.status, "timeout_killed")
        # The child would touch the marker at ~4s; helper returns at ~3s having
        # killed it. Wait past the child's write delay and confirm it never wrote.
        time.sleep(4)
        self.assertFalse(self.marker.exists(),
                         "orphan child wrote the marker AFTER the runner reported timeout")

    # 5: normal successful worker still returns exit 0.
    def test_normal_success_returns_0(self):
        cmd = [sys.executable, str(self.success)]
        result = runner.run_worker_with_timeout(cmd, cwd=str(self.tmp), timeout=30)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.remaining_pids, [])

    # 6: the patch does not weaken preflight / lock gating.
    def test_preflight_and_lock_gating_intact(self):
        main_src = inspect.getsource(runner.main)
        # Preflight is still run and the apply path still gates on SAFE_FOR_APPLY.
        self.assertIn("_run_preflight", main_src)
        self.assertIn("SAFE_FOR_APPLY", main_src)
        # The timeout helper is pure process management — it must not touch
        # preflight or locks (no silent weakening of the safety gate).
        helper_src = inspect.getsource(runner.run_worker_with_timeout)
        self.assertNotIn("_run_preflight", helper_src)
        self.assertNotIn("joblock", helper_src)
        self.assertNotIn("lock", helper_src.lower())


def _alive(pid: int) -> bool:
    try:
        return psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


if __name__ == "__main__":
    unittest.main()
