"""Unit tests for joblock.py — file-lock acquire/release/stale/refusal.

No Pinterest crawl, no live DB, no scheduled-task changes. Uses a temp lock dir."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import joblock  # noqa: E402


class TestJobLock(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="joblock_test_")
        self.lock_dir = Path(self._tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    # ── acquire / release ─────────────────────────────────────────────────────
    def test_acquire_creates_lock_with_metadata(self):
        lk = joblock.JobLock("pinterest_network", job="unit-test", lock_dir=self.lock_dir)
        self.assertTrue(lk.acquire())
        self.assertTrue(lk.path.exists(), "lock file must exist after acquire")
        meta = json.loads(lk.path.read_text(encoding="utf-8"))
        self.assertEqual(meta["pid"], os.getpid())
        self.assertEqual(meta["job"], "unit-test")
        self.assertEqual(meta["name"], "pinterest_network")
        self.assertIn("started_at", meta)
        self.assertIn("command", meta)
        lk.release()
        self.assertFalse(lk.path.exists(), "lock file must be gone after release")

    def test_release_is_idempotent(self):
        lk = joblock.JobLock("x", lock_dir=self.lock_dir)
        self.assertTrue(lk.acquire())
        lk.release()
        lk.release()  # must not raise
        self.assertFalse(lk.path.exists())

    # ── active lock refusal ───────────────────────────────────────────────────
    def test_second_acquire_refused_while_live_holder(self):
        a = joblock.JobLock("pinterest_network", job="A", lock_dir=self.lock_dir)
        b = joblock.JobLock("pinterest_network", job="B", lock_dir=self.lock_dir)
        self.assertTrue(a.acquire())
        # b sees a lock file owned by THIS (alive) pid → must refuse
        self.assertFalse(b.acquire(), "must refuse while a live holder owns the lock")
        a.release()
        # now b can take it
        self.assertTrue(b.acquire())
        b.release()

    def test_context_manager_raises_when_held(self):
        a = joblock.JobLock("writer", lock_dir=self.lock_dir)
        self.assertTrue(a.acquire())
        with self.assertRaises(joblock.JobLockHeld):
            with joblock.JobLock("writer", lock_dir=self.lock_dir):
                pass
        a.release()

    # ── stale detection ───────────────────────────────────────────────────────
    def test_stale_lock_dead_pid_is_reclaimed(self):
        lk_path = self.lock_dir / "pinterest_network.lock"
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        # Write a lock owned by a PID that is virtually certain to be dead.
        dead = 999999
        self.assertFalse(joblock.pid_alive(dead), "test precondition: pid must be dead")
        lk_path.write_text(json.dumps({"pid": dead, "job": "ghost", "name": "pinterest_network"}), encoding="utf-8")
        lk = joblock.JobLock("pinterest_network", job="reclaimer", lock_dir=self.lock_dir)
        self.assertTrue(lk.acquire(), "stale lock (dead holder) must be reclaimed")
        meta = json.loads(lk.path.read_text(encoding="utf-8"))
        self.assertEqual(meta["pid"], os.getpid())
        lk.release()

    def test_live_holder_not_reclaimed(self):
        # A lock owned by THIS process (alive) must NOT be reclaimed by another JobLock.
        a = joblock.JobLock("pinterest_network", lock_dir=self.lock_dir)
        self.assertTrue(a.acquire())
        b = joblock.JobLock("pinterest_network", lock_dir=self.lock_dir)
        self.assertFalse(b.acquire())
        self.assertTrue(a.path.exists())
        a.release()

    def test_release_does_not_remove_foreign_lock(self):
        # A JobLock that did NOT acquire must never delete an existing lock on release.
        foreign = self.lock_dir / "writer.lock"
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        foreign.write_text(json.dumps({"pid": os.getpid(), "job": "owner"}), encoding="utf-8")
        non_owner = joblock.JobLock("writer", lock_dir=self.lock_dir)  # never acquired
        non_owner.release()
        self.assertTrue(foreign.exists(), "release() must not remove a lock it does not own")

    # ── liveness ──────────────────────────────────────────────────────────────
    def test_pid_alive_self_true_dead_false(self):
        self.assertTrue(joblock.pid_alive(os.getpid()))
        self.assertFalse(joblock.pid_alive(999999))
        self.assertFalse(joblock.pid_alive(0))
        self.assertFalse(joblock.pid_alive(-1))

    # ── named constructors + describe ─────────────────────────────────────────
    def test_named_constructors(self):
        p = joblock.pinterest_lock(job="j", lock_dir=self.lock_dir)
        w = joblock.pin_products_writer_lock(job="j", lock_dir=self.lock_dir)
        self.assertEqual(p.name, "pinterest_network")
        self.assertEqual(w.name, "pin_products_writer")

    def test_describe_locks_reflects_state(self):
        d0 = joblock.describe_locks(lock_dir=self.lock_dir)
        self.assertFalse(d0["pinterest_network"]["present"])
        self.assertFalse(d0["pinterest_network"]["live"])
        lk = joblock.pinterest_lock(job="held", lock_dir=self.lock_dir)
        self.assertTrue(lk.acquire())
        d1 = joblock.describe_locks(lock_dir=self.lock_dir)
        self.assertTrue(d1["pinterest_network"]["present"])
        self.assertTrue(d1["pinterest_network"]["live"])
        self.assertEqual(d1["pinterest_network"]["holder"]["job"], "held")
        lk.release()


class TestDryRunGateSemantics(unittest.TestCase):
    """Simulate the run_worker dry-run gate: a live writer lock must make the
    dry-run treat the sentinel as unstable (is_held_by_live_holder == True)."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="joblock_gate_")
        self.lock_dir = Path(self._tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_dryrun_detects_active_writer(self):
        writer = joblock.pin_products_writer_lock(job="legacy-stl", lock_dir=self.lock_dir)
        self.assertTrue(writer.acquire())
        # The dry-run path checks this exact condition before proceeding:
        observer = joblock.pin_products_writer_lock(lock_dir=self.lock_dir)
        self.assertTrue(observer.is_held_by_live_holder(),
                        "dry-run must see an active writer (sentinel unstable → skip)")
        writer.release()
        self.assertFalse(observer.is_held_by_live_holder(),
                         "after writer releases, sentinel is stable again")

    def test_pinterest_and_writer_are_independent_locks(self):
        p = joblock.pinterest_lock(lock_dir=self.lock_dir)
        self.assertTrue(p.acquire())
        w = joblock.pin_products_writer_lock(lock_dir=self.lock_dir)
        # Holding the Pinterest lock must NOT block the writer lock (separate files).
        self.assertTrue(w.acquire())
        p.release(); w.release()


if __name__ == "__main__":
    unittest.main()
