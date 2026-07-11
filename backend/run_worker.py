#!/usr/bin/env python3
"""
run_worker.py — Cloud-ready pipeline entry point.

Usage:
  python run_worker.py --job trends
  python run_worker.py --job crawl --limit-keywords 80
  python run_worker.py --job stl-score
  python run_worker.py --job daily
  python run_worker.py --job smoke
  python run_worker.py --job daily --created-by manual

Each job is independently runnable with DB tracking and overlap locks.
Smoke is a safe deployment verification (no full pipeline).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

import pipeline  # noqa: E402
import joblock  # noqa: E402 — cross-job Pinterest / pin_products file locks
from crawl_queue_ops import count_pending_items, MIN_PENDING_FOR_CRAWL  # noqa: E402
from cloud_smoke import run_smoke  # noqa: E402
from pipeline_tracking import (  # noqa: E402
    get_last_completed_run,
    pipeline_job,
)


def _log(msg: str) -> None:
    print(msg, flush=True)


async def job_trends(
    ctx: dict,
    *,
    top_n: int = 30,
    region: str = "US",
    limit_interests: int = 0,
    dry_run: bool = False,
) -> None:
    interests = await pipeline.step_interests(region, run_probe=False)
    if not interests:
        raise RuntimeError("No interests available for trends job")
    result = await pipeline.step_trends(
        interests=interests,
        region=region,
        top_n=top_n,
        limit_interests=limit_interests,
        dry_run=dry_run,
    )
    if isinstance(result, dict):
        ctx["stats"] = result
        ctx["seedReport"] = result.get("seedReport")
        if ctx["seedReport"]:
            from seed_report import query_queue_verification  # noqa: E402
            ctx["seedReport"]["queueVerification"] = query_queue_verification(hours=2)
    else:
        ctx["stats"] = {"keywords": result, "processed": result, "rows": result, "pins": 0}


async def job_seed_report(ctx: dict, *, hours: int = 24, format: str = "json", include_test_fixtures: bool = False) -> None:
    from seed_report import build_seed_report_from_db, format_report_markdown, query_queue_verification  # noqa: E402

    report = build_seed_report_from_db(hours=hours, include_test_fixtures=include_test_fixtures)
    report["queueVerification"] = query_queue_verification(
        hours=hours, include_test_fixtures=include_test_fixtures,
    )
    ctx["seedReport"] = report
    ctx["stats"] = {"seedsScored": report.get("seedsScored", 0)}

    if format == "markdown":
        print(format_report_markdown(report))
    else:
        import json
        print(json.dumps(report, indent=2, default=str, ensure_ascii=False))


async def job_crawl(
    ctx: dict,
    *,
    limit_keywords: int = 80,
    concurrency: int = 3,
    region: str = "US",
    top_n: int = 30,
    category: str | None = None,
    dry_run: bool = False,
    first_crawl: bool = False,
) -> None:
    # Category-scoped crawl: only crawl_queue rows for `category` are selected
    # (existing pipeline.step_crawl → fetch_due_crawl_items category filter).
    # Scheduling / lock / retry / scoring are unchanged. When category is set we
    # disable trends replenish so a scoped crawl can never trigger a (blocked)
    # trends run. first_crawl=True additionally selects not-yet-due bootstrap
    # rows for this one run (stored next_crawl_at untouched).
    stats = await pipeline.step_crawl(
        concurrency=concurrency,
        limit_keywords=limit_keywords,
        replenish=(category is None and not dry_run and not first_crawl),
        region=region,
        top_n=top_n,
        category=category,
        dry_run=dry_run,
        first_crawl=first_crawl,
    )
    ctx["stats"] = stats


def refresh_pipeline_views() -> dict[str, Any]:
    """Best-effort check of DB views used by the app (regular views auto-update)."""
    sys.path.insert(0, str(ROOT / "db"))
    from db import select_many  # type: ignore

    views = ("trend_opportunities_view",)
    checked: list[str] = []
    for name in views:
        try:
            select_many(name, limit=1)
            checked.append(name)
        except Exception:
            pass
    return {"views_checked": checked}


async def job_stl_score(ctx: dict, *, stl_limit: int = 300) -> None:
    rc = await pipeline.step_stl(limit=stl_limit)
    if rc != 0:
        raise RuntimeError(f"shop_the_look exited with code {rc}")
    await pipeline.step_score()
    ctx["stats"] = {"processed": stl_limit, "stl_exit": rc}


async def job_stl_scoped(ctx: dict, *, since_hours: int, category: str | None = None,
                         source: str | None = None, limit: int = 600, dry_run: bool = False) -> None:
    """Scoped Shop-the-Look pass for recently-crawled (bootstrap) pins only.
    since_hours bounds the window (never legacy); category defaults to the P0 set;
    source='bootstrap' restricts to manual/csv bootstrap pins. Does NOT run step_score
    (global product scoring) — extraction only. dry_run = read-only preflight."""
    from trend_seed_pipeline import P0_CATEGORIES  # noqa: E402
    cats = category or ",".join(sorted(P0_CATEGORIES))
    rc = await pipeline.step_stl(category=cats, limit=limit, dry_run=dry_run,
                                 since_hours=since_hours, source=source)
    ctx["stats"] = {"stl_exit": rc, "dryRun": dry_run,
                    "scope": {"sinceHours": since_hours, "categories": cats,
                              "source": source, "limit": limit}}
    if rc != 0 and not dry_run:
        raise RuntimeError(f"scoped STL exited with code {rc}")


async def job_classify(ctx: dict, *, opp_limit: int = 2000) -> None:
    """Classify product signals + reference pins, then regenerate opportunities.

    Produces Pin Ideas (pin_samples.is_reference_eligible) and Product Ideas
    (pin_products.product_type + opportunities table). Must run after crawl/stl/score.
    """
    classify_stats = await pipeline.step_classify()
    opp_stats = await pipeline.step_opportunities(limit=opp_limit)
    ctx["stats"] = {**classify_stats, **opp_stats}


async def job_classify_references_scoped(ctx: dict, *, since_hours: int, category: str | None = None) -> None:
    """Scoped reference-pin classification only — for recently-crawled (e.g. bootstrap)
    pins. Classifies pin_samples scraped within `since_hours`, restricted to the given
    category or the P0 set. Never sweeps older legacy rows; does NOT regenerate
    opportunities or touch products."""
    import json
    from datetime import datetime, timedelta, timezone
    from classify_reference_pins import run as classify_pins  # noqa: E402
    from trend_seed_pipeline import P0_CATEGORIES  # noqa: E402

    since = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    cats = [category] if category else sorted(P0_CATEGORIES)
    res = classify_pins(reclassify_all=False, min_saves=500, limit=5000,
                        since=since, categories=cats) or {}
    ctx["stats"] = res
    print(json.dumps({"scope": {"sinceHours": since_hours, "since": since, "categories": cats},
                      "result": res}, indent=2, ensure_ascii=False, default=str))


async def job_classify_references_with_dims(ctx: dict, *, category: str | None = None,
                                            dry_run: bool = False) -> None:
    """Targeted dims-only re-band of reference pins. Reclassifies pin_samples that
    now have real image_width AND image_height (e.g. after the scraper dimension
    fix / a backfill), reprocessing already-classified rows so stale bands get
    re-scored. Scoped to the given category or the P0 set. Does NOT regenerate
    opportunities or touch products. dry_run = read-only preflight (no writes)."""
    import json
    from classify_reference_pins import run as classify_pins  # noqa: E402
    from trend_seed_pipeline import P0_CATEGORIES  # noqa: E402

    cats = [category] if category else sorted(P0_CATEGORIES)
    res = classify_pins(reclassify_all=False, min_saves=500, limit=5000,
                        categories=cats, require_dims=True, dry_run=dry_run) or {}
    ctx["stats"] = res
    print(json.dumps({"scope": {"categories": cats, "onlyWithDims": True, "dryRun": dry_run},
                      "result": res}, indent=2, ensure_ascii=False, default=str))


async def job_classify_products_scoped(ctx: dict, *, since_hours: int, limit: int = 50) -> None:
    """Scoped product-signal classification for recently-created (bootstrap STL) products
    only — pin_products with product_type IS NULL created within `since_hours`. Never
    touches the legacy product table; does NOT regenerate opportunities or link products."""
    import json
    from datetime import datetime, timedelta, timezone
    from classify_product_signals import run as classify_products  # noqa: E402

    since = (datetime.now(tz=timezone.utc) - timedelta(hours=since_hours)).isoformat()
    res = classify_products(reclassify_all=False, limit=limit, since=since) or {}
    ctx["stats"] = res
    print(json.dumps({"scope": {"sinceHours": since_hours, "since": since, "limit": limit},
                      "result": res}, indent=2, ensure_ascii=False, default=str))


async def job_daily(
    ctx: dict,
    *,
    limit_keywords: int = 80,
    concurrency: int = 3,
    region: str = "US",
    top_n: int = 30,
    stl_limit: int = 300,  # accepted but ignored — STL is decoupled (use --job stl-score)
) -> None:
    """DEPRECATED — backward-compatible convenience wrapper only.

    job_daily used to be the single production entrypoint, which made the whole
    pipeline a single point of failure (one STL/Playwright timeout aborted crawl,
    classify and opportunities together).

    Production should now schedule the three INDEPENDENT jobs instead:
        run_crawl.py  →  run_classify.py  →  run_opportunities.py
    (or `--job crawl`, `--job classify`, `--job opportunities`).

    This wrapper just chains crawl → classify → opportunities so existing cron /
    Task Scheduler entries that call `--job daily` keep working. It no longer runs
    STL (decoupled; run separately via `--job stl-score`). Any step failing raises
    and the run is recorded as failed (no partial "completed").
    """
    _log("⚠️  job_daily is DEPRECATED — prefer run_crawl.py / run_classify.py / run_opportunities.py")
    combined: dict[str, Any] = {"steps": [], "deprecated": True}

    _log("── daily(deprecated): crawl ──")
    # trends prelude is best-effort; crawl failure is fatal.
    try:
        interests = await pipeline.step_interests(region, run_probe=False)
        if interests:
            await pipeline.step_trends(interests=interests, region=region, top_n=top_n)
    except Exception as exc:  # noqa: BLE001 — trends is non-fatal by design
        _log(f"   trends prelude failed (non-fatal): {exc}")
    crawl_stats = await pipeline.step_crawl(
        concurrency=concurrency, limit_keywords=limit_keywords,
        replenish=True, region=region, top_n=top_n,
    )
    combined["steps"].append({"step": "crawl", **(crawl_stats or {})})

    _log("── daily(deprecated): classify ──")
    combined["steps"].append({"step": "classify", **(await pipeline.step_classify())})

    _log("── daily(deprecated): opportunities ──")
    combined["steps"].append({"step": "opportunities", **(await pipeline.step_opportunities(limit=2000))})

    ctx["stats"] = combined


async def job_seed_bootstrap(ctx: dict, *, file: str, apply: bool = False) -> None:
    """Manual/CSV seed bootstrap. Dry-run by default; writes only with apply=True."""
    from seed_bootstrap import run_bootstrap  # noqa: E402
    import json

    report = run_bootstrap(file, apply=apply)
    ctx["seedBootstrap"] = report
    ctx["stats"] = {
        "mode": report.get("mode"),
        "seedsScored": report.get("seedsScored", 0),
        "crawlQueueEntriesCreated": report.get("crawlQueueEntriesCreated", report.get("projectedCrawlQueueEntries", 0)),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))


async def job_harvest_outbound(ctx: dict, *, since_hours: int, source: str | None = None,
                               category: str | None = None, limit: int = 600,
                               apply: bool = False) -> None:
    """Scoped harvest of pin_samples.outbound_link → pin_products (no scraping).
    Dry-run by default; writes only with apply=True. Bootstrap/recent scope only."""
    import json
    from product_harvest import harvest  # noqa: E402

    cats = [category] if category else None
    report = harvest(since_hours=since_hours, source=source, categories=cats,
                     limit=limit or 600, apply=apply)
    ctx["productHarvest"] = report
    ctx["stats"] = {"mode": report.get("mode"),
                    "accepted": report.get("ecommerceProductLinksAccepted"),
                    "projectedInserts": report.get("projectedInserts"),
                    "legacyPinsTouched": report.get("legacyPinsTouched")}
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))


async def job_product_supply_expand(ctx: dict, *, engine: str = "shop-the-look",
                                    since_hours: int = 168, source: str | None = None,
                                    categories: str | None = None, category_mix: str | None = None,
                                    limit: int = 50, seed_pin_limit: int = 100,
                                    related_per_pin: int = 8, depth: int = 1,
                                    apply: bool = False,
                                    source_report: str | None = None) -> None:
    """Bounded product-supply expansion. Shop-the-Look is the production default;
    the old related outbound path remains available only as an explicit engine."""
    import json
    if engine == "shop-the-look":
        from shop_the_look_expand import parse_category_mix, run_shop_the_look_expand  # noqa: E402
        mix = parse_category_mix(category_mix)
        report = await run_shop_the_look_expand(
            limit=limit,
            category_mix=mix,
            since_hours=since_hours or 168,
            apply=apply,
            source_report_path=source_report,
        )
    elif engine == "related-outbound":
        from product_supply_expand import expand  # noqa: E402
        cats = [c.strip() for c in categories.split(",")] if categories else None
        report = await expand(since_hours=since_hours, source=source, categories=cats,
                              seed_pin_limit=seed_pin_limit, related_per_pin=related_per_pin,
                              depth=depth, apply=apply)
    else:
        raise ValueError(f"Unsupported product-supply engine: {engine}")
    ctx["productSupplyExpand"] = report
    aggregate = report.get("aggregate") or report
    ctx["stats"] = {
        "mode": report.get("mode"),
        "engine": engine,
        "accepted": aggregate.get("uniqueAcceptedProducts", report.get("acceptedProductLinks")),
        "legacyRowsTouched": report.get("legacyRowsTouched", report.get("legacyPinsTouched", 0)),
        "reportPath": report.get("reportPath"),
    }
    print(json.dumps({"stats": ctx["stats"], "aggregate": aggregate,
                      "sourceSelection": report.get("sourceSelection")},
                     indent=2, ensure_ascii=False, default=str))


async def job_trend_provider_health(ctx: dict, *, region: str = "US") -> None:
    from trend_provider_health import run_provider_health  # noqa: E402
    import json

    health = await run_provider_health(region=region)
    ctx["providerHealth"] = health
    ctx["stats"] = {"blocker": health.get("blocker"), "sampleCount": (health.get("official_v5") or {}).get("sampleCount", 0)}
    print(json.dumps(health, indent=2, ensure_ascii=False, default=str))
    if health.get("blocker"):
        raise RuntimeError(f"Provider blocker: {health.get('blockerReason')}")


JOB_HANDLERS = {
    "trends":       job_trends,
    "crawl":        job_crawl,
    "stl-score":    job_stl_score,
    "classify":     job_classify,
    "daily":        job_daily,
}


async def run_job(args: argparse.Namespace) -> int:
    if args.job == "smoke":
        return await run_smoke(
            top_n=min(args.top_n, 5),
            crawl_limit=min(args.limit_keywords, 3),
            region=args.region,
        )

    # Read-only ops report — no pipeline lock (fast, safe to run anytime)
    if args.job == "seed-report":
        ctx: dict = {}
        await job_seed_report(
            ctx,
            hours=args.report_hours,
            format=args.report_format,
            include_test_fixtures=args.include_test_fixtures,
        )
        return 0

    if args.job == "trend-provider-health":
        ctx = {}
        try:
            await job_trend_provider_health(ctx, region=args.region)
        except RuntimeError:
            return 1
        return 0

    if args.job == "product-supply-expand":
        # Bounded dry-run by default. Shop-the-Look uses an explicit category
        # mix; the deprecated related-outbound engine remains time-scoped.
        if args.engine == "related-outbound" and not args.since_hours:
            _log("Job 'product-supply-expand' requires --since-hours (refuses to run unscoped).")
            return 2
        if args.apply and args.dry_run:
            _log("Choose either --dry-run or --apply, not both.")
            return 2
        kwargs = dict(
            engine=args.engine,
            since_hours=args.since_hours or 168,
            source=args.source,
            categories=args.categories,
            category_mix=args.category_mix,
            limit=args.limit or 50,
            seed_pin_limit=args.seed_pin_limit,
            related_per_pin=args.related_per_pin,
            depth=args.depth,
            apply=args.apply,
            source_report=args.source_report,
        )
        if not args.apply:
            # Dry-run navigates Pinterest (the frozen source pins) and reads a
            # pin_products sentinel. Hold the Pinterest lock; do NOT take the
            # writer lock (no writes), but refuse if a writer is active because
            # the sentinel would be unstable.
            _plock = joblock.pinterest_lock(job="product-supply-expand-dryrun")
            if not _plock.acquire():
                _log(f"product-supply-expand dry-run skipped — pinterest_network.lock held by {_plock.read_holder()}")
                return 0
            _wlock = joblock.pin_products_writer_lock()
            if _wlock.is_held_by_live_holder():
                _plock.release()
                _log(f"product-supply-expand dry-run skipped — pin_products_writer.lock active (sentinel unstable): {_wlock.read_holder()}")
                return 0
            try:
                await job_product_supply_expand({}, **kwargs)
            finally:
                _plock.release()
            return 0
        # Apply: holds BOTH the Pinterest lock and the pin_products writer lock so
        # no crawler and no other writer can run concurrently.
        _plock = joblock.pinterest_lock(job="product-supply-expand-apply")
        if not _plock.acquire():
            _log(f"product-supply-expand apply skipped — pinterest_network.lock held by {_plock.read_holder()}")
            return 0
        _wlock = joblock.pin_products_writer_lock(job="product-supply-expand-apply")
        if not _wlock.acquire():
            _plock.release()
            _log(f"product-supply-expand apply skipped — pin_products_writer.lock held by {_wlock.read_holder()}")
            return 0
        try:
            with pipeline_job("product-supply-expand", created_by=args.created_by) as ctx:
                if ctx.get("skipped"):
                    _log("Job 'product-supply-expand' skipped — lock held.")
                    return 0
                await job_product_supply_expand(ctx, **kwargs)
            _log("Job 'product-supply-expand' completed.")
            return 0
        finally:
            _wlock.release()
            _plock.release()

    if args.job == "product-related-pins":
        # Resolve REAL target Product Pin save counts from Shop-the-Look / Shop-
        # similar cards. Navigates Pinterest (source pin + each target pin), so it
        # holds the shared pinterest_network.lock. Dry-run writes nothing; apply
        # additionally holds the pin_products writer lock and needs the confirm token.
        if not args.source_category:
            _log("Job 'product-related-pins' requires --source-category.")
            return 2
        if args.apply and args.dry_run:
            _log("Choose either --dry-run or --apply, not both.")
            return 2
        import product_related_pins  # noqa: E402
        kwargs = dict(
            category=args.source_category,
            limit=args.limit or 10,
            related_per_pin=args.related_per_pin,
        )
        if not args.apply:
            _plock = joblock.pinterest_lock(job="product-related-pins-dryrun")
            if not _plock.acquire():
                _log(f"product-related-pins dry-run skipped — pinterest_network.lock held by {_plock.read_holder()}")
                return 0
            try:
                await product_related_pins.run(apply=False, **kwargs)
            finally:
                _plock.release()
            return 0
        if args.confirm != product_related_pins.APPLY_CONFIRM_TOKEN:
            _log(f"Refusing apply: pass --confirm {product_related_pins.APPLY_CONFIRM_TOKEN}.")
            return 2
        _plock = joblock.pinterest_lock(job="product-related-pins-apply")
        if not _plock.acquire():
            _log(f"product-related-pins apply skipped — pinterest_network.lock held by {_plock.read_holder()}")
            return 0
        _wlock = joblock.pin_products_writer_lock(job="product-related-pins-apply")
        if not _wlock.acquire():
            _plock.release()
            _log(f"product-related-pins apply skipped — pin_products_writer.lock held by {_wlock.read_holder()}")
            return 0
        try:
            with pipeline_job("product-related-pins", created_by=args.created_by) as ctx:
                if ctx.get("skipped"):
                    _log("Job 'product-related-pins' skipped — lock held.")
                    return 0
                await product_related_pins.run(apply=True, confirm=args.confirm, **kwargs)
            _log("Job 'product-related-pins' completed.")
            return 0
        finally:
            _wlock.release()
            _plock.release()

    if args.job == "harvest-outbound-products":
        # Scoped outbound_link → pin_products harvest (no scraping). Requires
        # --since-hours so it can never run unscoped (no legacy sweep).
        if not args.since_hours:
            _log("Job 'harvest-outbound-products' requires --since-hours (refuses to run unscoped).")
            return 2
        if not args.apply:
            # Dry-run reads pin_samples + pin_products only (writes nothing), so it does
            # NOT take the writer lock — a dry-run must never block a real writer.
            await job_harvest_outbound({}, since_hours=args.since_hours, source=args.source,
                                       category=args.category, limit=args.limit or 600, apply=False)
            return 0
        # Apply writes pin_products — hold the cross-job pin_products_writer lock so it
        # cannot interleave with the STL product-supply apply (which also takes/checks
        # this lock). No pinterest_network.lock: the harvest does no Pinterest navigation.
        # Non-blocking skip convention (matches product-supply-expand apply): if another
        # writer holds it, log and return 0 rather than interleaving.
        _wlock = joblock.pin_products_writer_lock(job="harvest-outbound-apply")
        if not _wlock.acquire():
            _log(f"harvest-outbound-products apply skipped — pin_products_writer.lock held by {_wlock.read_holder()}")
            return 0
        try:
            with pipeline_job("harvest-outbound-products", created_by=args.created_by) as ctx:
                if ctx.get("skipped"):
                    _log("Job 'harvest-outbound-products' skipped — lock held.")
                    return 0
                await job_harvest_outbound(ctx, since_hours=args.since_hours, source=args.source,
                                           category=args.category, limit=args.limit or 600, apply=True)
            _log("Job 'harvest-outbound-products' completed.")
            return 0
        finally:
            _wlock.release()

    if args.job == "stl":
        # Scoped Shop-the-Look. Requires --since-hours so it can never run unscoped
        # (no legacy sweep). Dry-run is a read-only preflight (no lock needed).
        if not args.since_hours:
            _log("Job 'stl' requires --since-hours (refuses to run unscoped to avoid legacy sweep).")
            return 2
        if args.dry_run:
            await job_stl_scoped({}, since_hours=args.since_hours, category=args.category,
                                 source=args.source, limit=args.limit or 600, dry_run=True)
            return 0
        with pipeline_job("stl-score", created_by=args.created_by) as ctx:
            if ctx.get("skipped"):
                _log("Job 'stl' skipped — lock 'stl-score' held.")
                return 0
            await job_stl_scoped(ctx, since_hours=args.since_hours, category=args.category,
                                 source=args.source, limit=args.limit or 600, dry_run=False)
        _log("Job 'stl' completed.")
        return 0

    if args.job == "seed-bootstrap":
        if not args.file:
            _log("seed-bootstrap requires --file <path>")
            return 2
        # Dry-run is read-only — no lock. Apply takes the pipeline lock for safety.
        if not args.apply:
            try:
                await job_seed_bootstrap({}, file=args.file, apply=False)
            except FileNotFoundError as exc:
                _log(str(exc))
                return 2
            return 0
        with pipeline_job("seed-bootstrap", created_by=args.created_by) as ctx:
            if ctx.get("skipped"):
                _log("Job 'seed-bootstrap' skipped — lock held or child job running.")
                return 0
            try:
                await job_seed_bootstrap(ctx, file=args.file, apply=True)
            except FileNotFoundError as exc:
                _log(str(exc))
                return 2
        _log("Job 'seed-bootstrap' completed.")
        return 0

    handler = JOB_HANDLERS.get(args.job)
    if not handler:
        _log(f"Unknown job: {args.job}")
        return 2

    lock_name = "daily" if args.job == "daily" else args.job

    # Cross-job Pinterest mutual exclusion: crawl/daily navigate Pinterest from the
    # single residential IP. Hold the shared advisory lock so a manual STL bootstrap
    # (or another crawler) cannot run concurrently and cause throttle collisions.
    _plock = None
    if args.job in ("crawl", "daily"):
        _plock = joblock.pinterest_lock(job=args.job)
        if not _plock.acquire():
            _log(f"Job '{args.job}' skipped — pinterest_network.lock held by {_plock.read_holder()}")
            return 0
    try:
        with pipeline_job(args.job, created_by=args.created_by) as ctx:
            if ctx.get("skipped"):
                _log(f"Job '{args.job}' skipped — lock '{lock_name}' held or child job running.")
                return 0

            if args.job == "trends":
                await handler(ctx, top_n=args.top_n, region=args.region,
                              limit_interests=args.limit_interests, dry_run=args.dry_run)
            elif args.job == "seed-report":
                pass  # handled above
            elif args.job == "crawl":
                await handler(ctx, limit_keywords=args.limit_keywords,
                              concurrency=args.concurrency, region=args.region, top_n=args.top_n,
                              category=args.category, dry_run=args.dry_run,
                              first_crawl=args.first_crawl)
            elif args.job == "stl-score":
                await handler(ctx, stl_limit=args.stl_limit)
            elif args.job == "classify":
                if args.only_with_dims:
                    # Targeted dims-only re-band: re-score already-classified reference
                    # pins that now have real image dimensions. Category-scoped; dry-run ok.
                    await job_classify_references_with_dims(
                        ctx, category=args.category, dry_run=args.dry_run)
                elif args.since_hours and args.products:
                    # Scoped product-signal classify for recently-created (bootstrap STL) products.
                    await job_classify_products_scoped(
                        ctx, since_hours=args.since_hours, limit=args.limit or 50)
                elif args.since_hours:
                    # Scoped reference-only classify for recently-crawled (bootstrap) pins.
                    await job_classify_references_scoped(
                        ctx, since_hours=args.since_hours, category=args.category)
                else:
                    await handler(ctx)
            elif args.job == "daily":
                await handler(ctx, limit_keywords=args.limit_keywords,
                              concurrency=args.concurrency, region=args.region,
                              top_n=args.top_n, stl_limit=args.stl_limit)

        _log(f"Job '{args.job}' completed.")
        return 0
    finally:
        if _plock:
            _plock.release()


def main() -> int:
    ap = argparse.ArgumentParser(description="VibePin cloud pipeline worker")
    job_choices = list(JOB_HANDLERS.keys()) + ["smoke", "seed-report", "trend-provider-health", "seed-bootstrap", "stl", "harvest-outbound-products", "product-supply-expand", "product-related-pins"]
    ap.add_argument("--job", required=True, choices=job_choices,
                    help="Pipeline job to run (smoke = deployment verification)")
    ap.add_argument("--limit-keywords", type=int, default=80,
                    help="Max crawl_queue items per crawl job")
    ap.add_argument("--concurrency", type=int, default=3,
                    help="Parallel keyword crawlers (max 5)")
    ap.add_argument("--top", "--top-n", dest="top_n", type=int, default=30,
                    help="Keywords per interest for trends")
    ap.add_argument("--stl-limit", type=int, default=300,
                    help="Max pins for Shop the Look")
    ap.add_argument("--limit-interests", type=int, default=0,
                    help="Cap interests processed for trends job (0=all)")
    ap.add_argument("--region", default="US")
    ap.add_argument("--report-hours", type=int, default=24,
                    help="Lookback hours for seed-report job")
    ap.add_argument("--report-format", default="json", choices=["json", "markdown"],
                    help="Output format for seed-report job")
    ap.add_argument("--include-test-fixtures", action="store_true",
                    help="Include e2e/fixture seed rows in seed-report (default: exclude)")
    ap.add_argument("--category", default=None,
                    help="Crawl job: restrict crawl_queue selection to one category "
                         "(e.g. fashion, home-decor, beauty). Omit to crawl all due items.")
    ap.add_argument("--first-crawl", action="store_true",
                    help="Crawl job: one-time first crawl of freshly-bootstrapped seeds — "
                         "select not-yet-due bootstrap rows (by source_interest) for this run "
                         "only; stored next_crawl_at scheduling is untouched.")
    ap.add_argument("--since-hours", type=int, default=0,
                    help="Classify/STL jobs: scope to pins scraped within the last N hours "
                         "(e.g. 24 for the bootstrap crawl). No legacy sweep.")
    ap.add_argument("--source", default=None,
                    help="STL job: pin_samples.source_interest filter; 'bootstrap' = manual/csv bootstrap pins.")
    ap.add_argument("--products", action="store_true",
                    help="Classify job: with --since-hours, run scoped PRODUCT-signal classify "
                         "(pin_products) instead of reference-pin classify.")
    ap.add_argument("--only-with-dims", action="store_true",
                    help="Classify job: targeted dims-only re-band of reference pins that now "
                         "have real image_width AND image_height. Reprocesses already-classified "
                         "rows (which a normal classify leaves untouched). Use --category to scope; "
                         "--dry-run supported. Run after a dimension backfill / new extraction.")
    ap.add_argument("--categories", default=None,
                    help="product-supply-expand: comma-separated categories (e.g. fashion,home-decor).")
    ap.add_argument("--source-category", default=None,
                    help="product-related-pins: single source category to resolve target "
                         "Product Pin saves for (e.g. fashion).")
    ap.add_argument("--confirm", default=None,
                    help="Confirm token required for guarded apply jobs "
                         "(e.g. product-related-pins --apply).")
    ap.add_argument("--engine", default="shop-the-look",
                    choices=["shop-the-look", "related-outbound"],
                    help="product-supply-expand engine; Shop-the-Look is the default.")
    ap.add_argument("--category-mix", default=None,
                    help="Shop-the-Look source allocation, e.g. "
                         "fashion:18,womens-fashion:14,home-decor:18")
    ap.add_argument("--seed-pin-limit", type=int, default=100,
                    help="product-supply-expand: max high-save source pins to open.")
    ap.add_argument("--related-per-pin", type=int, default=8,
                    help="product-supply-expand: related pins to inspect per source pin.")
    ap.add_argument("--depth", type=int, default=1,
                    help="product-supply-expand: expansion depth (1 = related pins; max 1 here).")
    ap.add_argument("--limit", type=int, default=0,
                    help="STL job: max pins to process (default 600 when scoped).")
    ap.add_argument("--source-report", default=None,
                    help="product-supply-expand (shop-the-look): path to an approved dry-run JSON "
                         "report. When provided, source pins are loaded from the report instead of "
                         "being reselected; pin IDs, count, and category distribution are validated "
                         "before crawling begins.")
    ap.add_argument("--file", default=None,
                    help="CSV path for seed-bootstrap job")
    ap.add_argument("--apply", action="store_true",
                    help="seed-bootstrap: write to DB. Omit for dry-run (default).")
    ap.add_argument("--dry-run", action="store_true",
                    help="trends/seed-bootstrap/crawl/stl: no DB writes (read-only report)")
    ap.add_argument("--created-by", default="cloud",
                    choices=["cloud", "local", "manual"],
                    help="Who triggered this run (for pipeline_runs)")
    args = ap.parse_args()

    try:
        return asyncio.run(run_job(args))
    except KeyboardInterrupt:
        _log("Interrupted.")
        return 130
    except Exception as exc:
        pipeline._err(f"Worker failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
