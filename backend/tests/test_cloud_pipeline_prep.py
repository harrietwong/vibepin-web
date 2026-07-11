"""Validation for the disabled UNIFIED daily pipeline scheduler (pin-crawl,
keyword-trends, product-supply). Static/structural checks only — no crawler,
trends, apply, dry-run, Playwright, or DB writes. (bash -n / shellcheck /
systemd-analyze run on the Linux VPS.)
"""
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
S = BACKEND / "scripts"
D = BACKEND / "deploy" / "systemd"

PIN = S / "cloud_run_pin_crawl.sh"
TREND = S / "cloud_run_keyword_trends.sh"
SUPPLY = S / "cloud_run_product_supply.sh"
LIB = S / "cloud_lib.sh"
READINESS = S / "cloud_pipeline_readiness_check.py"


def noncomment(p: Path) -> str:
    return "\n".join(l for l in p.read_text(encoding="utf-8").splitlines()
                     if not l.lstrip().startswith("#"))


class TestWrappersExist(unittest.TestCase):
    def test_all_present(self):
        for p in (PIN, TREND, SUPPLY, LIB, READINESS):
            self.assertTrue(p.exists(), f"missing {p.name}")


class TestPinCrawlWrapper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = PIN.read_text(encoding="utf-8")

    def test_default_preflight_noop(self):  # (1)
        self.assertRegex(self.t, r'MODE="\$\{1:-\$\{VIBEPIN_CRAWL_MODE:-preflight\}\}"')
        self.assertIn("preflight-only mode", self.t)

    def test_crawl_requires_confirm(self):
        self.assertIn("VIBEPIN_CRAWL_CONFIRM", self.t)
        self.assertIn("RUN_CRAWL", self.t)
        self.assertIn("exit 5", self.t)

    def test_uses_shared_lib_gate_and_flock(self):  # (4)(5)
        self.assertIn("cloud_lib.sh", self.t)
        self.assertIn("cloud_flock", self.t)
        self.assertIn("cloud_preflight_gate", self.t)

    def test_tree_timeout(self):
        self.assertIn("cloud_run_with_tree_timeout", self.t)


class TestKeywordTrendsWrapper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = TREND.read_text(encoding="utf-8")

    def test_default_preflight_noop(self):  # (2)
        self.assertRegex(self.t, r'MODE="\$\{1:-\$\{VIBEPIN_TRENDS_MODE:-preflight\}\}"')
        self.assertIn("preflight-only mode", self.t)

    def test_trends_requires_confirm(self):
        self.assertIn("VIBEPIN_TRENDS_CONFIRM", self.t)
        self.assertIn("RUN_TRENDS", self.t)
        self.assertIn("exit 5", self.t)

    def test_uses_gate_and_flock(self):  # (4)(5)
        self.assertIn("cloud_flock", self.t)
        self.assertIn("cloud_preflight_gate", self.t)


class TestProductSupplyWrapperUnchanged(unittest.TestCase):
    def test_avoids_run_worker_direct(self):  # (3)
        self.assertNotIn("run_worker.py", noncomment(SUPPLY))

    def test_apply_confirm_and_cooldown(self):  # (9)
        t = SUPPLY.read_text(encoding="utf-8")
        self.assertIn("VIBEPIN_APPLY_CONFIRM", t)
        self.assertIn("APPLY_BOOTSTRAP_PRODUCTS", t)
        # cooldown waive only appears inside the apply path (confirm-gated).
        self.assertIn("--waive-cooldown", t)
        self.assertIn("exit 5", t)  # apply without confirm refused


class TestSharedLib(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = LIB.read_text(encoding="utf-8")

    def test_flock_overlap_guard(self):  # (4)
        self.assertIn("flock -n 201", self.t)
        self.assertIn("exit 9", self.t)

    def test_preflight_gate_refuses_unsafe(self):  # (5)
        self.assertIn("preflight_product_supply.py", self.t)
        self.assertIn("WAIT", self.t)
        self.assertIn("exit 8", self.t)

    def test_tree_kill_uses_process_group(self):
        self.assertIn("setsid", self.t)
        self.assertRegex(self.t, r'kill -KILL -- "-\$pid"')


class TestPreflightSelfTripFix(unittest.TestCase):
    """Contract checks for the wrapper preflight self-trip fix."""

    def test_preflight_ignores_wrapper_logs(self):
        t = (S / "preflight_product_supply.py").read_text(encoding="utf-8")
        # logs_growing must exclude wrapper-owned cloud_run_*.log files.
        self.assertIn("IGNORED_LOG_GLOBS", t)
        self.assertIn("cloud_run_*.log", t)
        self.assertIn("_is_ignored_log", t)
        # the exclusion must be wired into logs_growing's loop.
        body = t.split("def logs_growing")[1]
        self.assertIn("_is_ignored_log", body)

    def test_gate_is_pipefail_safe(self):
        t = LIB.read_text(encoding="utf-8")
        gate = t.split("cloud_preflight_gate()")[1].split("\n}")[0]
        # assert on executable lines only — comments legitimately mention the old
        # pattern when documenting the fix.
        code = "\n".join(l for l in gate.splitlines() if not l.lstrip().startswith("#"))
        # the old garbling pattern must be gone: piping preflight straight into the
        # parser with a trailing `|| echo FAIL` produced rec="WAIT\nFAIL" under pipefail.
        self.assertNotIn("echo FAIL", code)
        # preflight output is captured first (its nonzero WAIT/FAIL exit tolerated).
        self.assertIn("|| true", code)
        # safe refusal preserved: empty/garbled rec falls back to FAIL, still exit 8.
        self.assertIn('rec="FAIL"', code)
        self.assertIn("exit 8", code)

    def test_idle_preflight_branch_exits_zero(self):
        # each wrapper's preflight branch is a safe no-op that exits 0.
        for w in (PIN, TREND, SUPPLY):
            t = w.read_text(encoding="utf-8")
            self.assertIn("preflight-only mode", t)
            # the preflight case returns success (exit 0), writing nothing.
            self.assertRegex(t, r"preflight\)\s*\n(?:.*\n)*?\s*exit 0")


class TestSystemdUnits(unittest.TestCase):
    JOBS = ["pin-crawl", "keyword-trends", "product-supply"]

    def test_all_unit_files_present(self):
        for j in self.JOBS:
            self.assertTrue((D / f"vibepin-{j}.service").exists(), f"{j}.service missing")
            self.assertTrue((D / f"vibepin-{j}.timer").exists(), f"{j}.timer missing")

    def test_services_no_inline_secrets_and_envfile(self):  # (7)
        for j in self.JOBS:
            t = (D / f"vibepin-{j}.service").read_text(encoding="utf-8")
            self.assertIn("EnvironmentFile=", t)
            self.assertNotRegex(t, r"(?i)(SERVICE_ROLE_KEY|SUPABASE_URL\s*=\s*https)")

    def test_no_auto_retry(self):  # (8)
        for j in self.JOBS:
            t = (D / f"vibepin-{j}.service").read_text(encoding="utf-8")
            self.assertIn("Restart=no", t)
            self.assertIn("KillMode=control-group", t)

    def test_new_services_call_wrappers_not_run_worker(self):
        for j in ("pin-crawl", "keyword-trends"):
            t = noncomment(D / f"vibepin-{j}.service")
            self.assertRegex(t, rf"ExecStart=.*cloud_run_{j.replace('-', '_')}\.sh")
            self.assertNotIn("run_worker.py", t)

    def test_timers_present_oncalendar_disabled_by_default(self):  # (6)
        for j in self.JOBS:
            t = (D / f"vibepin-{j}.timer").read_text(encoding="utf-8")
            self.assertRegex(t, r"OnCalendar=.*\d\d:\d\d:\d\d")
            self.assertIn("Persistent=false", t)
            # A shipped timer file does NOT enable itself; enabling needs systemctl.
            self.assertRegex(t, r"(?i)disabled by default")


class TestUnifiedReadiness(unittest.TestCase):
    def test_compiles(self):
        import py_compile
        py_compile.compile(str(READINESS), doraise=True)

    def test_not_ready_when_shared_lock_live(self):  # (10)
        t = READINESS.read_text(encoding="utf-8")
        # readiness ties per-job READY to a free shared lock + no live workers.
        self.assertIn("shared_live", t)
        self.assertIn("env_block", t)
        self.assertIn('"--job crawl"', t)


if __name__ == "__main__":
    unittest.main()
