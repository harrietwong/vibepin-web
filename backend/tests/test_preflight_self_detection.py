"""Unit tests for preflight_product_supply self-detection exclusions.

Covers two false-positive fixes:
  1. active_procs: the controlled runner spawns the preflight and passes
     --source-report ..._shop_the_look_...json, whose path matches PROC_HINTS.
     The preflight must NOT count itself or that controlled-runner parent as an
     active Pinterest worker, while STILL detecting genuine external workers.
  2. logs_growing: each cloud_run_*.sh wrapper writes its OWN
     logs/cloud_run_<job>_<stamp>.log before calling preflight; logs_growing must
     ignore those wrapper-owned logs (else every scheduled run self-trips to WAIT),
     while STILL flagging real non-wrapper pipeline logs that are actively growing.

No Pinterest crawl, no Playwright, no live DB, no DB writes. psutil is mocked.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import preflight_product_supply as pf  # noqa: E402


# ── Fakes ─────────────────────────────────────────────────────────────────────
class _FakeProc:
    def __init__(self, pid, name="python.exe", cmdline=None):
        self.pid = pid
        self._name = name
        self._cmdline = cmdline or []
        self.info = {"pid": pid, "name": name, "cmdline": self._cmdline, "create_time": 0}

    def cmdline(self):
        return self._cmdline

    # parent() is set per-test where needed
    def parent(self):
        return getattr(self, "_parent", None)


class _FakePsutil:
    """Minimal psutil stand-in. process_iter ignores the attrs arg."""
    def __init__(self, procs, proc_by_pid=None):
        self._procs = procs
        self._by_pid = proc_by_pid or {}

    def process_iter(self, attrs=None):
        return list(self._procs)

    def Process(self, pid):
        if pid in self._by_pid:
            return self._by_pid[pid]
        return _FakeProc(pid)


class TestActiveProcsExclusion(unittest.TestCase):
    def setUp(self):
        self.self_pid = os.getpid()
        self._orig = sys.modules.get("psutil")

    def tearDown(self):
        if self._orig is not None:
            sys.modules["psutil"] = self._orig
        elif "psutil" in sys.modules:
            del sys.modules["psutil"]

    def _install(self, procs, me=None):
        by_pid = {self.self_pid: me} if me is not None else {}
        sys.modules["psutil"] = _FakePsutil(procs, by_pid)

    # 1. current process is never reported
    def test_excludes_current_process(self):
        me = _FakeProc(self.self_pid, cmdline=["python", "run_worker.py", "--job", "crawl"])
        me._parent = _FakeProc(999, cmdline=["powershell"])  # non-runner parent
        self._install([me], me=me)
        pids = [h.get("pid") for h in pf.active_procs()]
        self.assertNotIn(self.self_pid, pids, "current preflight process must be excluded")

    # 2. controlled-runner parent with shop_the_look source-report is excluded
    def test_excludes_controlled_runner_parent(self):
        runner_pid = 4242
        runner_cmd = ["python", "scripts/run_bootstrap_product_supply.py",
                      "--source-report",
                      "logs/product_supply_expand_shop_the_look_20260623_042058.json",
                      "--limit", "50"]
        runner = _FakeProc(runner_pid, cmdline=runner_cmd)
        me = _FakeProc(self.self_pid, cmdline=["python", "scripts/preflight_product_supply.py"])
        me._parent = runner
        # process_iter sees both the runner (matches shop_the_look) and us
        self._install([runner, me], me=me)
        pids = [h.get("pid") for h in pf.active_procs()]
        self.assertNotIn(runner_pid, pids,
                         "controlled runner parent must be excluded (shop_the_look in --source-report)")
        self.assertNotIn(self.self_pid, pids)
        self.assertEqual(pids, [], "no active workers should be reported in the self-detect scenario")

    # 3. genuine external workers are STILL detected
    def test_detects_external_workers(self):
        me = _FakeProc(self.self_pid, cmdline=["python", "scripts/preflight_product_supply.py"])
        me._parent = _FakeProc(999, cmdline=["powershell"])  # non-runner parent
        ext_worker = _FakeProc(5555, cmdline=["python", "run_worker.py", "--job",
                                              "product-supply-expand", "--engine", "shop_the_look"])
        ext_stl = _FakeProc(5556, cmdline=["python", "shop_the_look.py", "--db"])
        self._install([me, ext_worker, ext_stl], me=me)
        pids = [h.get("pid") for h in pf.active_procs()]
        self.assertIn(5555, pids, "external run_worker product-supply job must be detected")
        self.assertIn(5556, pids, "external shop_the_look worker must be detected")
        self.assertNotIn(self.self_pid, pids)

    # 3b. a non-runner parent that happens to contain shop_the_look is NOT excluded
    def test_does_not_exclude_non_runner_parent(self):
        parent_pid = 7777
        # parent cmdline contains shop_the_look but is NOT the controlled runner
        weird_parent = _FakeProc(parent_pid, cmdline=["python", "run_worker.py",
                                                      "--engine", "shop_the_look"])
        me = _FakeProc(self.self_pid, cmdline=["python", "scripts/preflight_product_supply.py"])
        me._parent = weird_parent
        self._install([weird_parent, me], me=me)
        pids = [h.get("pid") for h in pf.active_procs()]
        self.assertIn(parent_pid, pids,
                      "a non-runner parent must NOT be excluded even if it matches PROC_HINTS")

    # 4. exclusion set: self always present; runner parent only when marker matches
    def test_excluded_pids_set(self):
        runner = _FakeProc(4242, cmdline=["python", "scripts/run_bootstrap_product_supply.py",
                                          "--source-report", "x_shop_the_look.json"])
        me = _FakeProc(self.self_pid, cmdline=["python", "preflight"])
        me._parent = runner
        self._install([], me=me)
        excluded = pf._self_and_runner_parent_pids()
        self.assertIn(self.self_pid, excluded)
        self.assertIn(4242, excluded)

        # non-runner parent -> only self excluded
        me2 = _FakeProc(self.self_pid, cmdline=["python", "preflight"])
        me2._parent = _FakeProc(888, cmdline=["powershell"])
        self._install([], me=me2)
        excluded2 = pf._self_and_runner_parent_pids()
        self.assertEqual(excluded2, {self.self_pid})


class TestLogsGrowingExclusion(unittest.TestCase):
    """logs_growing() must ignore wrapper-owned cloud_run_*.log files but still
    detect genuinely-growing non-wrapper logs."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self._orig_dirs = pf.LOG_DIRS
        pf.LOG_DIRS = [self.dir]  # scan only our temp dir

    def tearDown(self):
        pf.LOG_DIRS = self._orig_dirs
        self._tmp.cleanup()

    def _touch(self, name: str, age_seconds: float = 0.0) -> Path:
        p = self.dir / name
        p.write_text("x", encoding="utf-8")
        if age_seconds:
            old = time.time() - age_seconds
            os.utime(p, (old, old))
        return p

    # filename classifier
    def test_is_ignored_log_classifier(self):
        self.assertTrue(pf._is_ignored_log("cloud_run_pin_crawl_20260627_010203Z.log"))
        self.assertTrue(pf._is_ignored_log("cloud_run_preflight_20260627_010203Z.log"))
        self.assertTrue(pf._is_ignored_log("cloud_run_keyword_trends_x.log"))
        self.assertFalse(pf._is_ignored_log("pipeline_20260627_1204.log"))
        self.assertFalse(pf._is_ignored_log("cron_daily.log"))
        self.assertFalse(pf._is_ignored_log("stl_manual.log"))

    # the self-trip case: a fresh wrapper log must NOT count as growing
    def test_wrapper_log_ignored(self):
        self._touch("cloud_run_pin_crawl_20260627_010203Z.log")          # fresh
        self._touch("cloud_run_preflight_20260627_010203Z.log")          # fresh
        self.assertEqual(pf.logs_growing(), [],
                         "wrapper-owned cloud_run_*.log must be ignored by logs_growing")

    # a real, non-wrapper, freshly-written pipeline log MUST still be flagged
    def test_real_log_still_detected(self):
        self._touch("cloud_run_pin_crawl_x.log")                         # ignored
        real = self._touch("pipeline_20260627_1204_classify.log")        # fresh, real
        growing = pf.logs_growing()
        self.assertIn(str(real), growing,
                      "a genuinely-growing non-wrapper pipeline log must still be detected")
        self.assertEqual(len(growing), 1, "only the real log should be reported")

    # an OLD non-wrapper log (>2 min) must not be flagged (cutoff still works)
    def test_old_real_log_not_detected(self):
        self._touch("pipeline_old.log", age_seconds=300)                 # 5 min old
        self.assertEqual(pf.logs_growing(), [],
                         "a non-wrapper log older than the 2-min cutoff must not be flagged")


if __name__ == "__main__":
    unittest.main(verbosity=2)
