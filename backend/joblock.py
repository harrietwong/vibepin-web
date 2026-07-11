"""joblock.py — cross-process file locks for VibePin Pinterest / pin_products jobs.

Why this exists
---------------
Multiple jobs (daily keyword crawl, legacy Shop-the-Look, the new STL bootstrap)
run on ONE Windows host sharing ONE residential Pinterest IP, and several of them
write the same `pin_products` table. The existing DB lock (`pipeline_locks`) is
keyed per job-name, so different jobs do NOT mutually exclude — two Pinterest
crawlers can still run at once and trigger ERR_TIMED_OUT throttling, and two
writers can interleave `pin_products` writes.

This module adds two *cross-cutting* advisory file locks that every relevant job
acquires regardless of job name or codebase:

  * pinterest_network.lock  — held by ANY job that navigates/requests Pinterest
  * pin_products_writer.lock — held by ANY job that writes pin_products

No schema change is needed: the host + IP are singular, so a local file lock
fully models the required mutual exclusion.

Canonical lock directory
------------------------
Default: C:\\vibepinlocks  (override with env VIBEPIN_LOCK_DIR)
Chosen because BOTH codebases live on this machine:
  - D:\\代码\\Pinterest flow\\backend  (bootstrap / crawl path)
  - C:\\vibepinbackend               (legacy STL path)
Both import an identical copy of this file and point at the SAME lock dir, so the
lock files interoperate across codebases. The neutral C:\\ path avoids non-ASCII
path issues and matches the existing C:\\vibepinlogs convention.

Design
------
* Advisory, non-blocking by default: acquire() returns True/False, never waits.
* Atomic reservation via O_CREAT|O_EXCL.
* Stale-lock detection: if the holder PID is dead, the lock is reclaimed.
* Never silently removes a lock whose holder is still alive.
* Metadata (pid, job, name, started_at, command, host, user) stored as JSON.
* Released on normal exit; best-effort release on exception via context manager.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _default_lock_dir() -> Path:
    env = os.environ.get("VIBEPIN_LOCK_DIR")
    if env:
        return Path(env)
    return Path(r"C:\vibepinlocks")


LOCK_DIR = _default_lock_dir()

# A brand-new lock may briefly be empty between O_EXCL create and metadata write.
# Don't treat an unparseable lock as stale unless it's older than this.
_EMPTY_LOCK_GRACE_SEC = 15


class JobLockHeld(RuntimeError):
    """Raised when entering a JobLock context that is held by a live holder."""


def pid_alive(pid: int) -> bool:
    """Cross-platform liveness check. Never sends a real signal on Windows."""
    if pid is None or pid <= 0:
        return False
    try:
        import psutil  # type: ignore
        return psutil.pid_exists(int(pid))
    except Exception:
        pass
    # Fallback without psutil.
    if os.name == "nt":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        SYNCHRONIZE = 0x00100000
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, int(pid)
        )
        if handle:
            # Distinguish "alive" from "exited but handle still openable".
            still_active = ctypes.c_ulong(0)
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(still_active))
            kernel32.CloseHandle(handle)
            STILL_ACTIVE = 259
            if ok:
                return still_active.value == STILL_ACTIVE
            return True
        return False
    # POSIX: signal 0 is a permission/existence probe, does not kill.
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but owned by another user
    except Exception:
        return False


class JobLock:
    """A single advisory file lock.

    Usage (non-blocking skip pattern — scheduled jobs):
        lock = JobLock("pinterest_network", job="crawl")
        if not lock.acquire():
            log(f"skip — {lock.name} held by {lock.read_holder()}")
            return
        try:
            ... do Pinterest work ...
        finally:
            lock.release()

    Usage (must-hold pattern — manual apply, fail fast):
        with JobLock("pin_products_writer", job="bootstrap-apply"):
            ... write ...
    """

    def __init__(self, name: str, *, job: str = "", lock_dir: Optional[os.PathLike] = None):
        self.name = name
        self.job = job
        self.lock_dir = Path(lock_dir) if lock_dir else LOCK_DIR
        self.path = self.lock_dir / f"{name}.lock"
        self._owned = False

    # ── introspection ────────────────────────────────────────────────────────
    def read_holder(self) -> Optional[dict]:
        """Return the current holder's metadata, or None if no lock file."""
        for _ in range(3):
            try:
                raw = self.path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return None
            except Exception:
                return None
            if raw.strip():
                try:
                    return json.loads(raw)
                except Exception:
                    return {"_unparseable": True, "_raw": raw[:200]}
            time.sleep(0.05)  # empty: writer may be mid-write
        return {"_empty": True}

    def is_held_by_live_holder(self) -> bool:
        """True if a lock file exists AND its holder PID is alive (or unknown-but-fresh)."""
        holder = self.read_holder()
        if holder is None:
            return False
        pid = holder.get("pid")
        if isinstance(pid, int) and pid > 0:
            return pid_alive(pid)
        # No usable pid (empty/unparseable): treat as held only if recently created.
        try:
            age = time.time() - self.path.stat().st_mtime
        except FileNotFoundError:
            return False
        return age < _EMPTY_LOCK_GRACE_SEC

    # ── lifecycle ─────────────────────────────────────────────────────────────
    def _metadata(self) -> dict:
        return {
            "name": self.name,
            "job": self.job,
            "pid": os.getpid(),
            "started_at": datetime.now(tz=timezone.utc).isoformat(),
            "command": " ".join(sys.argv)[:500],
            "host": socket.gethostname(),
            "user": os.environ.get("USERNAME") or os.environ.get("USER") or "",
        }

    def _try_create(self) -> bool:
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        try:
            os.write(fd, json.dumps(self._metadata(), ensure_ascii=False).encode("utf-8"))
        finally:
            os.close(fd)
        self._owned = True
        return True

    def acquire(self) -> bool:
        """Non-blocking. Return True if acquired, False if held by a live holder.

        Reclaims a stale lock (holder PID dead, or empty/unparseable past grace).
        """
        if self._try_create():
            return True
        # Lock file exists — decide stale vs live.
        if self.is_held_by_live_holder():
            return False
        # Stale: reclaim. Remove only if still stale right before deletion.
        try:
            if not self.is_held_by_live_holder():
                self.path.unlink(missing_ok=True)
        except Exception:
            return False
        # One retry after reclaiming.
        return self._try_create()

    def release(self) -> None:
        """Remove the lock only if we own it and still hold our own pid."""
        if not self._owned:
            return
        try:
            holder = self.read_holder()
            if holder and holder.get("pid") == os.getpid():
                self.path.unlink(missing_ok=True)
        except Exception:
            pass
        finally:
            self._owned = False

    # ── context manager (must-hold) ───────────────────────────────────────────
    def __enter__(self) -> "JobLock":
        if not self.acquire():
            holder = self.read_holder()
            raise JobLockHeld(f"{self.name} held by {holder}")
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


# ── named convenience constructors ────────────────────────────────────────────
def pinterest_lock(job: str = "", lock_dir=None) -> JobLock:
    """Lock for ANY job that navigates/requests Pinterest."""
    return JobLock("pinterest_network", job=job, lock_dir=lock_dir)


def pin_products_writer_lock(job: str = "", lock_dir=None) -> JobLock:
    """Lock for ANY job that writes pin_products."""
    return JobLock("pin_products_writer", job=job, lock_dir=lock_dir)


def describe_locks(lock_dir=None) -> dict:
    """Read-only snapshot of both standard locks for preflight reporting."""
    out = {}
    for name in ("pinterest_network", "pin_products_writer"):
        lk = JobLock(name, lock_dir=lock_dir)
        holder = lk.read_holder()
        out[name] = {
            "present": holder is not None,
            "live": lk.is_held_by_live_holder(),
            "holder": holder,
            "path": str(lk.path),
        }
    return out
