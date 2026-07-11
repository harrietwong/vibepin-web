"""Validation for the disabled VPS Product-Supply scheduler prep.

Structural / unit checks only — no crawler, no apply, no dry-run, no Playwright,
no DB writes. (bash -n / shellcheck / systemd-analyze are run on the Linux VPS;
this host has no bash, so the wrapper is validated structurally here.)
"""
import unittest
from pathlib import Path


def _noncomment(text: str) -> str:
    """Drop comment lines (# ...) so descriptive mentions in comments don't count
    as code references."""
    return "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("#"))

BACKEND = Path(__file__).resolve().parent.parent
WRAPPER = BACKEND / "scripts" / "cloud_run_product_supply.sh"
SERVICE = BACKEND / "deploy" / "systemd" / "vibepin-product-supply.service"
TIMER = BACKEND / "deploy" / "systemd" / "vibepin-product-supply.timer"
REQS = BACKEND / "requirements-cloud.txt"
READINESS = BACKEND / "scripts" / "cloud_readiness_check.py"


class TestCloudRequirements(unittest.TestCase):
    def test_psutil_in_cloud_requirements(self):
        text = REQS.read_text(encoding="utf-8")
        self.assertRegex(text, r"(?im)^\s*psutil\b", "psutil must be in requirements-cloud.txt")


class TestWrapperScript(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.txt = WRAPPER.read_text(encoding="utf-8")

    def test_exists_and_bash_shebang(self):
        self.assertTrue(WRAPPER.exists())
        self.assertTrue(self.txt.startswith("#!/usr/bin/env bash"))

    def test_strict_mode(self):
        self.assertIn("set -euo pipefail", self.txt)

    def test_never_calls_run_worker_directly(self):
        # Comments may mention run_worker.py; no executable line may invoke it.
        self.assertNotIn("run_worker.py", _noncomment(self.txt),
                         "wrapper must never invoke run_worker.py directly")

    def test_calls_hardened_runner(self):
        self.assertIn("run_bootstrap_product_supply.py", self.txt)

    def test_default_mode_is_preflight(self):
        # MODE defaults to preflight when no arg / env provided.
        self.assertRegex(self.txt, r'MODE="\$\{1:-\$\{VIBEPIN_CLOUD_MODE:-preflight\}\}"')

    def test_modes_separated(self):
        for mode in ("preflight)", "dry-run)", "apply)", "crawl)"):
            self.assertIn(mode, self.txt, f"mode case missing: {mode}")

    def test_no_overlap_flock_guard(self):
        self.assertIn("flock -n 200", self.txt)
        self.assertIn("exit 9", self.txt)  # overlap → nonzero

    def test_preflight_gate_before_jobs(self):
        # preflight recommendation parsed, and WAIT/unsafe refuses with nonzero.
        self.assertIn("preflight_product_supply.py", self.txt)
        self.assertIn("recommendation", self.txt)
        self.assertIn("exit 8", self.txt)  # unsafe preflight → nonzero

    def test_apply_requires_confirm_token(self):
        self.assertIn("VIBEPIN_APPLY_CONFIRM", self.txt)
        self.assertIn("APPLY_BOOTSTRAP_PRODUCTS", self.txt)
        self.assertIn("exit 5", self.txt)  # apply without confirm → nonzero

    def test_crawl_mode_disabled(self):
        self.assertIn("exit 3", self.txt)  # crawl reserved/disabled

    def test_sets_linux_lock_dir(self):
        self.assertIn("VIBEPIN_LOCK_DIR", self.txt)
        self.assertIn("/opt/vibepin/locks", self.txt)

    def test_creates_log_and_lock_dirs(self):
        self.assertRegex(self.txt, r'mkdir -p "\$LOG_DIR" "\$LOCK_DIR"')

    def test_enforces_timeout(self):
        self.assertIn("--timeout-seconds", self.txt)


class TestSystemdService(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.txt = SERVICE.read_text(encoding="utf-8")

    def test_oneshot(self):
        self.assertIn("Type=oneshot", self.txt)

    def test_calls_wrapper_not_run_worker(self):
        self.assertRegex(self.txt, r"ExecStart=.*cloud_run_product_supply\.sh")
        self.assertNotIn("run_worker.py", _noncomment(self.txt))

    def test_runtime_limit_and_killmode(self):
        # Type=oneshot ignores RuntimeMaxSec, so the outer bound must be
        # TimeoutStartSec (RuntimeMaxSec must NOT be used here).
        self.assertRegex(self.txt, r"TimeoutStartSec=\d+")
        self.assertNotRegex(_noncomment(self.txt), r"RuntimeMaxSec=\d+")
        self.assertIn("KillMode=control-group", self.txt)

    def test_no_auto_retry(self):
        self.assertIn("Restart=no", self.txt)

    def test_environment_file_not_inline_secrets(self):
        self.assertIn("EnvironmentFile=", self.txt)
        # No obvious inlined secret values.
        self.assertNotRegex(self.txt, r"(?i)(SERVICE_ROLE_KEY|SUPABASE_URL\s*=\s*https)")

    def test_default_mode_safe(self):
        self.assertIn("VIBEPIN_CLOUD_MODE=preflight", self.txt)


class TestSystemdTimer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.txt = TIMER.read_text(encoding="utf-8")

    def test_oncalendar_present(self):
        self.assertRegex(self.txt, r"OnCalendar=.*\d\d:\d\d:\d\d")

    def test_no_boot_catchup(self):
        self.assertIn("Persistent=false", self.txt)

    def test_bound_to_service(self):
        self.assertIn("Unit=vibepin-product-supply.service", self.txt)

    def test_install_section_present_but_file_does_not_self_enable(self):
        # [Install] makes it enable-able; presence of the file does NOT enable it
        # (enabling requires `systemctl enable`, which is not done here).
        self.assertIn("[Install]", self.txt)
        self.assertIn("WantedBy=timers.target", self.txt)


class TestReadinessScriptCompiles(unittest.TestCase):
    def test_readiness_script_compiles(self):
        import py_compile
        py_compile.compile(str(READINESS), doraise=True)


if __name__ == "__main__":
    unittest.main()
