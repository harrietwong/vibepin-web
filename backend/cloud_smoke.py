"""
cloud_smoke.py — Safe verification sequence for cloud worker deployment.

Run via: python run_worker.py --job smoke
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))

REQUIRED_ENV_VARS = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")

OPTIONAL_ENV_VARS = (
    "DATABASE_URL",
    "OPENAI_API_KEY",
    "LINAPI_KEY",
    "PINTEREST_APP_ID",
    "PINTEREST_APP_SECRET",
)

REQUIRED_TABLES = ("pipeline_runs", "crawl_queue", "trend_keywords")

MIGRATION_COLUMNS: dict[str, tuple[str, ...]] = {
    "crawl_queue":    ("last_crawled_at", "next_crawl_at"),
    "trend_keywords": ("data_quality", "confidence"),
}

SMOKE_LOCK_NAME = "smoke"


@dataclass
class SmokeCheck:
    label: str
    ok: bool
    detail: str = ""
    fix: str = ""


@dataclass
class SmokeReport:
    checks: list[SmokeCheck] = field(default_factory=list)
    pending_crawl: int | None = None
    crawl_keywords: int | None = None

    def add_ok(self, label: str, detail: str = "") -> None:
        self.checks.append(SmokeCheck(label=label, ok=True, detail=detail))

    def add_fail(self, label: str, detail: str, fix: str = "") -> None:
        self.checks.append(SmokeCheck(label=label, ok=False, detail=detail, fix=fix))

    @property
    def passed(self) -> bool:
        return all(c.ok for c in self.checks)

    def print_summary(self) -> None:
        print("VibePin Cloud Smoke Test", flush=True)
        for check in self.checks:
            mark = "✅" if check.ok else "❌"
            line = f"{mark} {check.label}"
            if check.detail:
                line += f" — {check.detail}"
            print(line, flush=True)
            if not check.ok and check.fix:
                print(f"   Suggested fix: {check.fix}", flush=True)
        if self.pending_crawl is not None:
            print(f"✅ pending crawl items: {self.pending_crawl}", flush=True)
        if self.crawl_keywords is not None:
            print(f"✅ crawl smoke completed: {self.crawl_keywords} keywords", flush=True)
        print("Done." if self.passed else "Smoke test failed. Fix the items above and re-run.", flush=True)


def check_env_vars() -> tuple[list[str], list[str]]:
    """Return (missing_required, present_optional)."""
    missing = [k for k in REQUIRED_ENV_VARS if not (os.environ.get(k) or "").strip()]
    optional = [k for k in OPTIONAL_ENV_VARS if (os.environ.get(k) or "").strip()]
    return missing, optional


def check_db_connection(get_http: Callable[[], Any] | None = None) -> tuple[bool, str]:
    try:
        if get_http is None:
            from db import _get_http  # type: ignore
            get_http = _get_http
        http = get_http()
        resp = http.get("pipeline_runs", params={"limit": "1", "select": "id"})
        if resp.status_code == 200:
            return True, "connected"
        return False, f"HTTP {resp.status_code}: {resp.text[:120]}"
    except Exception as exc:
        return False, str(exc)


def check_table_exists(table: str, get_http: Callable[[], Any] | None = None) -> tuple[bool, str]:
    try:
        if get_http is None:
            from db import _get_http  # type: ignore
            get_http = _get_http
        http = get_http()
        resp = http.get(table, params={"limit": "1", "select": "id"})
        if resp.status_code == 200:
            return True, "exists"
        if resp.status_code == 404:
            return False, "table not found (run migrations?)"
        return False, f"HTTP {resp.status_code}: {resp.text[:120]}"
    except Exception as exc:
        return False, str(exc)


def check_columns_exist(
    table: str,
    columns: tuple[str, ...],
    select_many: Callable[..., list] | None = None,
) -> tuple[bool, str]:
    """Verify PostgREST can select migration columns."""
    try:
        if select_many is None:
            from db import DB  # type: ignore
            select_many = DB().select_many
        cols = ",".join(columns)
        select_many(table, columns=cols, limit=1)
        return True, ", ".join(columns)
    except Exception as exc:
        msg = str(exc)
        if "column" in msg.lower() or "42703" in msg:
            return False, f"missing columns on {table} — run migrate_v23.sql"
        return False, msg


def check_lock_roundtrip(
    *,
    acquire: Callable[..., bool] | None = None,
    release: Callable[[str], None] | None = None,
    identity: str = "smoke:test",
) -> tuple[bool, str]:
    try:
        if acquire is None or release is None:
            from pipeline_tracking import acquire_lock, release_lock, worker_identity  # type: ignore
            identity = worker_identity("smoke")
            acquire = acquire_lock
            release = release_lock
        if not acquire(SMOKE_LOCK_NAME, identity):
            return False, "could not acquire smoke lock (another run active?)"
        release(SMOKE_LOCK_NAME)
        return True, "acquire/release OK"
    except Exception as exc:
        return False, str(exc)


def run_env_checks(report: SmokeReport) -> bool:
    missing, _optional = check_env_vars()
    if missing:
        report.add_fail(
            "Env vars loaded",
            f"missing: {', '.join(missing)}",
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your cloud platform secrets.",
        )
        return False
    report.add_ok("Env vars loaded")
    return True


def run_db_checks(report: SmokeReport, get_http: Callable[[], Any] | None = None) -> bool:
    ok, detail = check_db_connection(get_http)
    if not ok:
        report.add_fail(
            "DB connected",
            detail,
            "Verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Check network/firewall from worker.",
        )
        return False
    report.add_ok("DB connected", detail)
    return True


def run_table_checks(
    report: SmokeReport,
    get_http: Callable[[], Any] | None = None,
    select_many: Callable[..., list] | None = None,
) -> bool:
    all_ok = True
    for table in REQUIRED_TABLES:
        ok, detail = check_table_exists(table, get_http)
        if ok:
            report.add_ok(f"{table} exists", detail)
        else:
            fix = (
                "Run migrate_v24.sql in Supabase SQL Editor (pipeline_runs, pipeline_locks)."
                if table == "pipeline_runs"
                else "Ensure base schema migrations are applied in Supabase."
            )
            report.add_fail(f"{table} exists", detail, fix)
            all_ok = False

    for table, cols in MIGRATION_COLUMNS.items():
        ok, detail = check_columns_exist(table, cols, select_many)
        if ok:
            report.add_ok(f"{table} migration columns", detail)
        else:
            report.add_fail(
                f"{table} migration columns",
                detail,
                "Run migrate_v23.sql in Supabase SQL Editor.",
            )
            all_ok = False
    return all_ok


async def run_smoke_pipeline_steps(
    report: SmokeReport,
    *,
    top_n: int = 5,
    crawl_limit: int = 3,
    region: str = "US",
) -> bool:
    """Small trends + crawl sample — skips if prior checks failed."""
    import pipeline  # noqa: WPS433
    from crawl_queue_ops import count_pending_items  # noqa: WPS433

    try:
        interests = await pipeline.step_interests(region, run_probe=False)
        if not interests:
            report.add_fail(
                "trends step ran",
                "no interests available",
                "Check trend_interests table or interest_discovery config.",
            )
            return False
        kw_count = await pipeline.step_trends(interests=interests, region=region, top_n=top_n)
        if isinstance(kw_count, dict):
            kw_count = kw_count.get("keywords", 0)
        report.add_ok("trends step ran", f"{kw_count} keywords")
    except Exception as exc:
        report.add_fail(
            "trends step ran",
            str(exc),
            "Trends may need Pinterest API access; set ENABLE_PINTEREST_TRENDS_L1=false if L1 404s.",
        )
        return False

    try:
        report.pending_crawl = count_pending_items(pipeline._db_select, due_only=False)
    except Exception as exc:
        report.add_fail("pending crawl count", str(exc))
        return False

    try:
        stats = await pipeline.step_crawl(
            concurrency=1,
            limit_keywords=crawl_limit,
            replenish=False,
            region=region,
            top_n=top_n,
        )
        processed = int(stats.get("processed", 0) if isinstance(stats, dict) else 0)
        report.crawl_keywords = processed
        report.add_ok("crawl smoke step", f"{processed} keywords processed")
    except Exception as exc:
        report.add_fail(
            "crawl smoke step",
            str(exc),
            "Crawl may need network/cookies; verify worker can reach Pinterest.",
        )
        return False

    return True


async def run_smoke(
    *,
    top_n: int = 5,
    crawl_limit: int = 3,
    region: str = "US",
    skip_pipeline: bool = False,
    get_http: Callable[[], Any] | None = None,
    select_many: Callable[..., list] | None = None,
) -> int:
    report = SmokeReport()

    if not run_env_checks(report):
        report.print_summary()
        return 1

    if not run_db_checks(report, get_http):
        report.print_summary()
        return 1

    if not run_table_checks(report, get_http, select_many):
        report.print_summary()
        return 1

    ok_lock, detail = check_lock_roundtrip()
    if ok_lock:
        report.add_ok("locks working", detail)
    else:
        report.add_fail(
            "locks working",
            detail,
            "Run migrate_v24.sql (pipeline_locks). Wait for stale locks to expire.",
        )

    if not skip_pipeline and report.passed:
        await run_smoke_pipeline_steps(
            report, top_n=top_n, crawl_limit=crawl_limit, region=region
        )

    report.print_summary()
    return 0 if report.passed else 1
