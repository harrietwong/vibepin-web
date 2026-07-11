"""
pipeline.py 鈥?Pinterest Intelligence Pipeline Orchestrator

Replaces run_scheduler.py. Fully driven by Pinterest Trends 鈥?no manual keyword lists.

Pipeline flow:
  Step 1  interest_discovery         鈫?trend_interests (DB)
  Step 2  trend_fetcher              鈫?trend_keywords + crawl_queue (DB)
  Step 3  scraper_v2                 鈫?pin_samples (DB) + keyword_expansions
  Step 4  shop_the_look              鈫?pin_products (DB)
  Step 5  calculate_product_scores   鈫?product_scores + keyword_product_map (DB)
  Step 6  classify_product_signals   鈫?pin_products.product_type/source_platform/... (DB)
  Step 7  classify_reference_pins    鈫?pin_samples.is_reference_eligible/... (DB)
  Step 8  generate_opportunities     鈫?opportunities + relation tables (DB)

Quality targets (high-signal, not archive):
  鈥?Keywords sourced from Pinterest Trends (priority_score-ranked)
  鈥?Pins:     save_count 鈮?500, age 鈮?90 days
  鈥?Products: source pin save_count 鈮?5 000

Usage:
  py pipeline.py                          # full run, all interests
  py pipeline.py --interest home_decor    # single interest
  py pipeline.py --step trends            # only run trend fetch
  py pipeline.py --step crawl             # only process crawl_queue
  py pipeline.py --step stl              # only run shop_the_look
  py pipeline.py --step score            # only run product scoring
  py pipeline.py --step classify          # classify products + reference pins
  py pipeline.py --step opportunities     # generate opportunities table
  py pipeline.py --concurrency 3         # parallel keyword processing
  py pipeline.py --limit-interests 5     # cap how many interests to process
  py pipeline.py --dry-run               # discover only, no DB writes
"""

import argparse
import asyncio
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

# 鈹€鈹€ ANSI colors 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
G = "\033[92m"; Y = "\033[93m"; C = "\033[96m"; R = "\033[91m"; B = "\033[1m"; X = "\033[0m"

def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")

def _banner(msg: str) -> None:
    w = 70
    print(f"\n{B}{C}{'鈹€'*w}{X}")
    print(f"{B}{C}  {msg}{X}")
    print(f"{B}{C}{'鈹€'*w}{X}\n")

def _ok(msg: str)   -> None: print(f"{G}  鉁? {msg}{X}")
def _info(msg: str) -> None: print(f"{C}  路  {msg}{X}")
def _warn(msg: str) -> None: print(f"{Y}  !  {msg}{X}")
def _err(msg: str)  -> None: print(f"{R}  鉁? {msg}{X}")


# 鈹€鈹€ DB helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def _db_select(table: str, filters: dict | None = None,
               order: str | None = None, limit: int | None = None) -> list[dict]:
    sys.path.insert(0, str(ROOT / "db"))
    try:
        from db import select_many  # type: ignore
        return select_many(table, filters=filters, order=order, limit=limit) or []
    except Exception as exc:
        _err(f"DB select {table}: {exc}")
        return []


# 鈹€鈹€ Step 1: Interest Discovery 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def step_interests(country: str = "US", run_probe: bool = False) -> list[dict]:
    _banner(f"Step 1 鈥?Interest Discovery  [{_ts()}]")
    try:
        from interest_discovery import discover_and_upsert, upsert_interests  # type: ignore
        interests = await discover_and_upsert(country=country, run_probe=run_probe)
        written = upsert_interests(interests, country)
        _ok(f"{written} interests upserted  (active: {sum(1 for i in interests if i.get('is_active',True))})")
        return interests
    except Exception as exc:
        _err(f"Interest discovery failed: {exc}")
        # Fall back to loading from DB
        from interest_discovery import load_interests_from_db  # type: ignore
        rows = load_interests_from_db(country, active_only=True)
        _warn(f"Using {len(rows)} interests from DB cache")
        return rows


# 鈹€鈹€ Step 2: Trend Keyword Fetch 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def step_trends(
    interests: list[dict],
    region:    str = "US",
    top_n:     int = 30,
    proxy:     Optional[str] = None,
    dry_run:   bool = False,
    limit_interests: int = 0,
) -> int | dict:
    _banner(f"Step 2 鈥?Trend Keyword Fetch  [{_ts()}]")

    from trend_fetcher import (  # type: ignore
        ALLOW_DEGRADED_L3_WRITES,
        CRAWL_QUEUE_LAST_STATS,
        TrendSession,
        discover_trends_for_interest,
        enabled_layer_flags,
        write_deduped_seed_batch,
        source_layer,
        PROVIDER_RUN_SUMMARY,
        reset_provider_run_summary,
    )
    from trend_seed_pipeline import (  # type: ignore
        SEED_LAST_STATS,
        reset_run_accumulator,
        record_interest_result,
        build_job_report,
        next_crawl_at_from_cadence,
        P0_CATEGORIES,
    )
    import trend_seed_pipeline as _tsp  # noqa: E402 — mutable run state lives on module
    try:
        from interest_discovery import slug_to_category  # type: ignore
    except ImportError:
        def slug_to_category(s: str) -> str: return s

    if limit_interests:
        interests = interests[:limit_interests]

    reset_run_accumulator()
    reset_provider_run_summary()

    from collections import Counter

    total_kw = 0
    source_counts: Counter[str] = Counter()
    queue_totals: Counter[str] = Counter()
    authoritative_scored = 0
    session_stats: dict = {}
    flags = enabled_layer_flags()
    v5_auth_available = flags.get("official_v5_auth", False)
    _info(f"Layer flags: {flags}")

    async with TrendSession(proxy=proxy) as session:
        for rec in interests:
            slug     = rec.get("interest_slug") or rec.get("slug", "")
            category = slug_to_category(slug)
            _info(f"{slug}  鈫? {category}")

            try:
                keywords = await discover_trends_for_interest(
                    interest_slug=slug,
                    category=category,
                    region=region,
                    top_n=top_n,
                    proxy=proxy,
                    session=session,
                )
            except Exception as exc:
                _err(f"  {slug}: {exc}")
                keywords = []

            queue_stats_for_interest: dict[str, int] = {}

            if not keywords and not _tsp.WATCHLIST_LAST and not _tsp.LAST_PROCESS_RESULT:
                _warn(f"  {slug}: 0 keywords returned")
                continue

            if not keywords:
                _warn(f"  {slug}: 0 queue-eligible seeds (watchlist={len(_tsp.WATCHLIST_LAST)})")
            else:
                _ok(f"  {slug}: {len(keywords)} keywords")
                for kw in keywords:
                    layer = source_layer(kw.get("trend_source", "typeahead_estimate"))
                    source_counts[layer] += 1
                    if layer in ("official_v5", "L1", "L2"):
                        authoritative_scored += 1

            proc = _tsp.LAST_PROCESS_RESULT
            if proc:
                if dry_run and not queue_stats_for_interest:
                    eligible = sum(1 for s in proc.seeds if s.get("crawl_queue_eligible"))
                    queue_stats_for_interest = {
                        "inserted": eligible,
                        "updated_pending": 0,
                        "requeued": 0,
                        "requeued_failed": 0,
                        "skipped": len(proc.seeds) - eligible,
                        "written": eligible,
                    }
                record_interest_result(
                    interest_slug=slug,
                    category=category,
                    result=proc,
                    queue_stats=queue_stats_for_interest or None,
                )

            total_kw += len(keywords) + len(_tsp.WATCHLIST_LAST)
            await asyncio.sleep(random.uniform(0.8, 1.5))


        _info(
            "Layer results: "
            f"v5={PROVIDER_RUN_SUMMARY.get('official_v5_count', 0)} "
            f"L1={source_counts.get('L1', 0)} L2={source_counts.get('L2', 0)} "
            f"L3={source_counts.get('L3', 0)} | "
            f"errors L1={session.stats.get('l1_http_errors', 0)} "
            f"L2={session.stats.get('l2_http_errors', 0)} "
            f"L3={session.stats.get('l3_http_errors', 0)} | "
            f"disabled L1={session.stats.get('l1_disabled', 0)} "
            f"L2={session.stats.get('l2_disabled', 0)} "
            f"L3={session.stats.get('l3_disabled', 0)}"
        )
        session_stats = dict(session.stats)
        if queue_totals:
            _info(
                "Crawl queue totals: "
                f"inserted={queue_totals['inserted']} "
                f"updated_pending={queue_totals['updated_pending']} "
                f"requeued={queue_totals['requeued']} "
                f"requeued_failed={queue_totals['requeued_failed']} "
                f"skipped={queue_totals['skipped']} "
                f"written={queue_totals['written']}"
            )
    _ok(f"Total keywords discovered: {total_kw}")

    flags = enabled_layer_flags()
    providers = []
    if flags.get("official_v5"):
        providers.append("pinterest_trends_v5")
    if flags.get("L1"):
        providers.append("pinterest_trends_l1")
    if flags.get("L2"):
        providers.append("pinterest_trends_l2")
    if flags.get("L3"):
        providers.append("pinterest_trends_l3")

    from trend_provider_health import run_provider_health  # noqa: E402

    from official_v5_seed_quality import global_dedupe_job_seeds  # noqa: E402

    global_dedupe_job_seeds(_tsp.SEED_RUN_ACCUMULATOR)

    if not dry_run:
        batch_stats = write_deduped_seed_batch(
            _tsp.SEED_RUN_ACCUMULATOR,
            region=region,
            v5_auth_available=v5_auth_available,
        )
        queue_totals.update(CRAWL_QUEUE_LAST_STATS)
        _info(
            "Deduped batch write: "
            f"trend_keywords={batch_stats.get('trend_keywords', 0)} "
            f"crawl_queue={batch_stats.get('crawl_queue', 0)} "
            f"watchlist={batch_stats.get('watchlist_keywords', 0)} "
            f"interests_updated={batch_stats.get('interests_updated', 0)}"
        )
    elif _tsp.SEED_RUN_ACCUMULATOR.get("queue_stats"):
        queue_totals.update(_tsp.SEED_RUN_ACCUMULATOR["queue_stats"])

    provider_health = await run_provider_health(region=region)

    job_report = build_job_report(
        crawl_queue_entries_created=queue_totals.get("written", 0),
        providers_used=providers or ["none"],
    )
    job_report["providerHealth"] = provider_health
    job_report["providerRunSummary"] = dict(PROVIDER_RUN_SUMMARY)
    job_report["officialV5Count"] = PROVIDER_RUN_SUMMARY.get("official_v5_count", 0)
    job_report["layerCounts"] = {
        "official_v5": PROVIDER_RUN_SUMMARY.get("official_v5_count", 0),
        "L1": source_counts.get("L1", 0),
        "L2": source_counts.get("L2", 0),
        "L3": source_counts.get("L3", 0),
    }
    job_report["httpErrors"] = {
        "official_v5": (PROVIDER_RUN_SUMMARY.get("v5_status") or {}).get("http_status"),
        "L1": session_stats.get("l1_http_errors", 0),
        "L2": session_stats.get("l2_http_errors", 0),
        "L3": session_stats.get("l3_http_errors", 0),
    }
    seeds_scored = job_report.get("seedsScored", 0)
    queue_written = queue_totals.get("written", 0)

    no_usable_seeds_reason: str | None = None
    if provider_health.get("blocker"):
        job_status = "blocked_provider"
    elif seeds_scored == 0 and queue_written == 0 and not dry_run:
        job_status = "no_usable_seeds"
        no_usable_seeds_reason = (
            "No keywords passed pipeline filters and no crawl queue entries were created"
        )
    elif authoritative_scored == 0 and source_counts.get("L3", 0) > 0 and ALLOW_DEGRADED_L3_WRITES:
        job_status = "degraded_fallback"
    else:
        job_status = "successful"

    job_report["jobStatus"] = job_status
    job_report["seedsAfterFilters"] = total_kw
    job_report["crawlQueueEntriesCreated"] = queue_written
    job_report["providerStatus"] = provider_health.get("selectedPrimaryProvider") or "none"
    job_report["providerBlocker"] = bool(provider_health.get("blocker"))
    job_report["blockerReason"] = provider_health.get("blockerReason")
    job_report["noUsableSeedsReason"] = no_usable_seeds_reason
    job_report["selectedPrimaryProvider"] = provider_health.get("selectedPrimaryProvider")
    job_report["missingP0Categories"] = job_report.get("p0CategoriesMissing", [])
    job_report["queueVerification"] = None
    if dry_run:
        projected = _tsp.SEED_RUN_ACCUMULATOR.get("queue_stats", {}).get("written", 0)
        if not projected:
            projected = sum(
                int(r.get("stats", {}).get("queue_eligible", 0))
                for r in _tsp.SEED_RUN_ACCUMULATOR.get("_interest_stats", [])
            )
        job_report["dryRun"] = True
        job_report["projectedCrawlQueueEntriesCreated"] = projected
        job_report["fallbackUsed"] = source_counts.get("L3", 0) > 0
        job_report["categoriesCovered"] = job_report.get("p0CategoriesPresent", [])
        from trend_seed_pipeline import enrich_dry_run_report  # noqa: E402
        job_report.update(enrich_dry_run_report())
    import json as _json
    _info("Seed job report:")
    print(_json.dumps(job_report, indent=2, ensure_ascii=False))

    if provider_health.get("blocker") and not dry_run:
        reason = provider_health.get("blockerReason") or "Pinterest Trends provider unavailable"
        _err(f"PROVIDER BLOCKER — trends job not production-ready: {reason}")
        raise RuntimeError(f"Provider blocker: {reason}")

    if job_status == "no_usable_seeds" and not dry_run:
        _err(f"NO USABLE SEEDS — trends job produced no results: {no_usable_seeds_reason}")
        raise RuntimeError(f"No usable seeds: {no_usable_seeds_reason}")

    return {"keywords": total_kw, "seedReport": job_report}


# 鈹€鈹€ Crawl queue guard 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def replenish_crawl_queue_if_needed(
    region:          str = "US",
    top_n:           int = 30,
    proxy:           Optional[str] = None,
    dry_run:         bool = False,
    limit_interests: int = 0,
    min_pending:     int = 20,
) -> int:
    """
    When pending crawl_queue count is below min_pending, run trends replenish.
    Returns pending count after replenish attempt.
    """
    from crawl_queue_ops import count_pending_items, MIN_PENDING_FOR_CRAWL, fetch_due_crawl_items  # type: ignore

    threshold = min_pending or MIN_PENDING_FOR_CRAWL
    pending = count_pending_items(_db_select, due_only=True)
    if pending >= threshold:
        return pending

    _info(f"Pending crawl_queue is low ({pending} < {threshold}). Requeueing stale completed keywords.")
    try:
        from db import update_where  # type: ignore
        from crawl_queue_ops import requeue_stale_completed_items  # type: ignore
        requeued = requeue_stale_completed_items(_db_select, update_where)
        if requeued:
            _info(f"Requeued {requeued} stale completed crawl_queue keywords")
        pending = count_pending_items(_db_select, due_only=True)
        if pending >= threshold:
            return pending
    except Exception as exc:
        _warn(f"Stale requeue failed: {exc}")

    _info(f"Pending still low ({pending} < {threshold}). Running trends replenish.")
    interests = await step_interests(region, run_probe=False)
    if interests:
        await step_trends(
            interests=interests,
            region=region,
            top_n=top_n,
            proxy=proxy,
            dry_run=dry_run,
            limit_interests=limit_interests,
        )
    pending = count_pending_items(_db_select, due_only=True)
    return pending


# 鈹€鈹€ Step 3: Crawl Queue Processing 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

# Residential-proxy support for the Pinterest crawl. The scheduled `--job crawl`
# and `--job daily` paths pass no explicit proxy, so they fall back to this env
# var. Anonymous direct-from-datacenter-IP crawling gets soft-gated (HTTP 200 with
# empty pin payloads); routing through a residential proxy avoids that. The value
# is a URL that may embed credentials — it is NEVER logged (only presence is).
CRAWL_PROXY_ENV = "PINTEREST_CRAWL_PROXY_URL"


def _resolve_crawl_proxy(explicit: Optional[str]) -> Optional[str]:
    """Pick the crawl proxy: an explicit argument wins; otherwise fall back to the
    PINTEREST_CRAWL_PROXY_URL env var; otherwise None (unchanged anonymous direct
    behaviour). Returns None for an unset/blank env so callers stay proxy-less.
    Never logs or returns anything that exposes the value to the caller's logs."""
    if explicit:
        return explicit
    return (os.environ.get(CRAWL_PROXY_ENV) or "").strip() or None


async def step_crawl(
    concurrency:    int = 3,
    max_pins:       int = 75,
    proxy:          Optional[str] = None,
    dry_run:        bool = False,
    limit_keywords: int = 0,
    category:       Optional[str] = None,
    replenish:      bool = True,
    top_n:          int = 30,
    region:         str = "US",
    limit_interests: int = 0,
    first_crawl:    bool = False,
) -> dict:
    _banner(f"Step 3 鈥?Pin Discovery (crawl_queue)  [{_ts()}]")

    # Resolve the residential proxy (explicit arg > PINTEREST_CRAWL_PROXY_URL env >
    # none). Presence only is logged — never the URL/credentials.
    proxy = _resolve_crawl_proxy(proxy)
    _info(f"[crawl] proxy={'configured' if proxy else 'none (direct)'}")

    if replenish and not dry_run:
        pending = await replenish_crawl_queue_if_needed(
            region=region,
            top_n=top_n,
            proxy=proxy,
            dry_run=dry_run,
            limit_interests=limit_interests,
        )
        if pending == 0:
            _warn("No pending crawl items after trends replenish. Exiting cleanly.")
            return {"processed": 0, "pins": 0, "premium": 0, "skipped": True}

    from crawl_queue_ops import clamp_concurrency, count_pending_items, fetch_due_crawl_items  # type: ignore
    from scraper_v2 import PinterestSession, process_queue_item  # type: ignore
    try:
        from interest_discovery import slug_to_category  # type: ignore
    except ImportError:
        def slug_to_category(s: str) -> str: return s

    if category:
        _info(f"Filtering crawl_queue to category={category}")
    if first_crawl:
        _info("First-crawl mode: selecting not-yet-due bootstrap seeds (one-time, scheduling untouched)")

    pending_due_before = count_pending_items(_db_select, due_only=True)
    items = fetch_due_crawl_items(
        _db_select,
        category=category,
        limit=limit_keywords or 0,
        first_crawl=first_crawl,
    )

    if not items:
        _warn("No due pending items in crawl_queue. Exiting cleanly.")
        _info(f"[crawl] selected_keywords=0 pending_due_before={pending_due_before}")
        return {"processed": 0, "pins": 0, "premium": 0, "skipped": True}

    concurrency = clamp_concurrency(concurrency)
    _info(f"[crawl] selected_keywords={len(items)} pending_due_before={pending_due_before}")
    _info(f"{len(items)} due keywords to process (concurrency={concurrency})")

    sem = asyncio.Semaphore(concurrency)
    stats = {"processed": 0, "pins": 0, "premium": 0, "errors": 0, "failed_keywords": 0}

    async with PinterestSession(proxy=proxy, delay=1.2) as session:
        async def _process(item: dict) -> None:
            keyword  = item["keyword"]
            slug     = item.get("source_interest") or ""
            cat      = item.get("category") or slug_to_category(slug)
            safe_slug = slug.replace(":", "_").replace("/", "_").replace("\\", "_") if slug else "pipeline"
            out_dir  = ROOT / "vibe_library" / f"style_library_{safe_slug}"

            async with sem:
                try:
                    await asyncio.sleep(random.uniform(0.3, 0.8))
                    pins_saved, premium = await process_queue_item(
                        keyword=keyword,
                        source_interest=slug,
                        category=cat,
                        session=session,
                        max_pins=max_pins,
                        expand_related=True,
                        write_db=not dry_run,
                        out_dir=out_dir,
                    )
                    stats["processed"] += 1
                    stats["pins"]      += pins_saved
                    stats["premium"]   += len(premium)
                except Exception as exc:
                    stats["errors"] += 1
                    stats["failed_keywords"] += 1
                    _err(f"  {keyword}: {exc}")

        tasks = [_process(item) for item in items]
        await asyncio.gather(*tasks, return_exceptions=True)

    _info(
        f"[crawl] completed keywords={stats['processed']} "
        f"inserted_total={stats['pins']} premium_total={stats['premium']} "
        f"failed={stats['failed_keywords']}"
    )
    _ok(f"Crawl complete: {stats['processed']} keywords, "
        f"{stats['pins']} pins, {stats['premium']} premium")
    return stats


# 鈹€鈹€ Step 4: Shop the Look 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def _legacy_stl_writer_allowed(allow_legacy: bool = False) -> bool:
    """Gate for the RETIRED legacy STL pin_products writer (real, writing run).

    Legacy STL is retired as a production writer; the supported path is the
    bootstrap v28 path (run_worker.py --job product-supply-expand). A real write
    run is only permitted when an operator explicitly opts in via the allow_legacy
    argument or VIBEPIN_ALLOW_LEGACY_STL=1. Dry-run (read-only preflight) never
    needs this gate.
    """
    import os
    return bool(allow_legacy) or os.environ.get("VIBEPIN_ALLOW_LEGACY_STL", "") == "1"


async def step_stl(
    category:    Optional[str] = None,
    limit:       int = 200,
    dry_run:     bool = False,
    since_hours: int = 0,
    source:      Optional[str] = None,
    allow_legacy: bool = False,
) -> int:
    _banner(f"Step 4 鈥?Product Discovery (Shop the Look)  [{_ts()}]")

    # ── Retired legacy writer guard ───────────────────────────────────────────
    # A real (writing) legacy STL run is retired as a production pin_products
    # writer. Skip-safe BEFORE launching the subprocess / Pinterest / any write.
    # Read-only dry-run preflight is always allowed.
    if not dry_run and not _legacy_stl_writer_allowed(allow_legacy):
        _warn("Legacy STL step is RETIRED as a production writer — skipping (no write).")
        _warn("Use the bootstrap v28 path: py run_worker.py --job product-supply-expand")
        _warn("See backend/docs/product_supply_migration.md")
        _warn("To force the deprecated legacy writer: set VIBEPIN_ALLOW_LEGACY_STL=1")
        return 0  # skip-safe: no subprocess, no Pinterest navigation, no DB write

    import subprocess
    cmd = [sys.executable, str(ROOT / "shop_the_look.py")]
    if not dry_run:
        cmd.append("--db")  # only the real run writes pin_products
        # Operator opted in above — propagate the opt-in to the child guard so the
        # two layers agree (shop_the_look.py also refuses --db without it).
        cmd.append("--allow-legacy-db-write")
    if category:
        cmd += ["--category", category]
    if limit:
        cmd += ["--limit", str(limit)]
    if since_hours:
        cmd += ["--since-hours", str(since_hours)]
    if source:
        cmd += ["--source", source]
    if dry_run:
        cmd += ["--dry-run"]  # read-only preflight inside shop_the_look (no scrape, no write)

    _info(f"Launching: {' '.join(cmd)}")
    # Use PIPE to isolate Playwright's Node.js stdout/stderr from the parent process
    # pipe. Without this, Playwright crashes with EPIPE when the parent pipe closes.
    result = subprocess.run(
        cmd, cwd=str(ROOT),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    # Echo captured output so it appears in our log
    if result.stdout:
        for line in result.stdout.splitlines():
            print(f"  [stl] {line}")
    if result.returncode == 0:
        _ok("shop_the_look.py completed")
    else:
        _err(f"shop_the_look.py exited with code {result.returncode}")
    return result.returncode


# 鈹€鈹€ Step 6a: Trend History Enrichment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def step_enrich(
    limit:   int  = 0,
    region:  str  = "US",
    dry_run: bool = False,
) -> dict:
    _banner(f"Step 6a 鈥?Trend History Enrichment  [{_ts()}]")
    try:
        from enrich_trend_history import _load_keywords, enrich_all  # type: ignore
    except ImportError as exc:
        _err(f"enrich_trend_history import failed: {exc}")
        return {}

    keywords = _load_keywords(force=False, limit=limit)
    _info(f"{len(keywords)} keywords need trend_history")
    if not keywords:
        _ok("Nothing to enrich")
        return {"enriched": 0}

    return await enrich_all(keywords, region=region, write_db=not dry_run, verbose=False)


# 鈹€鈹€ Step 6b: Competition Enrichment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def step_enrich_competition(
    limit:   int  = 0,
    dry_run: bool = False,
) -> None:
    _banner(f"Step 6b 鈥?Competition Enrichment  [{_ts()}]")
    try:
        from enrich_competition import run as _run_comp  # type: ignore
    except ImportError as exc:
        _err(f"enrich_competition import failed: {exc}")
        return
    await _run_comp(limit=limit, dry_run=dry_run)


# 鈹€鈹€ Step 6: Digital Product Scrape 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def step_digital(
    groups:   list[str] | None = None,
    max_pins: int  = 100,
    dry_run:  bool = False,
) -> dict:
    _banner(f"Step 6 鈥?Digital Product Signals  [{_ts()}]")
    try:
        from digital_product_scraper import run_scrape  # type: ignore
    except ImportError as exc:
        _err(f"digital_product_scraper import failed: {exc}")
        return {}
    return await run_scrape(
        groups=groups,
        max_pins=max_pins,
        write_db=not dry_run,
        dry_run=dry_run,
    )


# 鈹€鈹€ Step 5: Product Intelligence Scoring 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def step_score(dry_run: bool = False) -> dict:
    _banner(f"Step 5 鈥?Product Intelligence Scoring  [{_ts()}]")

    try:
        from calculate_product_scores import compute_scores, _upsert  # type: ignore
    except ImportError as exc:
        _err(f"calculate_product_scores import failed: {exc}")
        return {"scored": 0, "mapped": 0}

    scored_rows, kpm_rows = compute_scores(verbose=False)

    if not scored_rows:
        _warn("No products to score 鈥?run step_stl first")
        return {"scored": 0, "mapped": 0}

    _info(f"{len(scored_rows)} products scored  |  {len(kpm_rows)} keyword-product links")

    if dry_run:
        _info("dry-run: skipping DB writes")
        return {"scored": len(scored_rows), "mapped": len(kpm_rows)}

    written_scores = _upsert("product_scores",      scored_rows, "product_id")
    written_kpm    = _upsert("keyword_product_map", kpm_rows,    "keyword_id,product_id")

    _ok(f"{written_scores} product_scores upserted")
    _ok(f"{written_kpm} keyword_product_map entries upserted")
    return {"scored": written_scores, "mapped": written_kpm}


async def step_classify(dry_run: bool = False) -> dict:
    """Steps 7+8 — classify product signals (Product Ideas) + reference pins (Pin Ideas)."""
    import traceback

    _banner(f"Step 7 — Classify Product Signals  [{_ts()}]")
    try:
        from classify_product_signals import run as classify_products  # type: ignore
        prod = classify_products(reclassify_all=False, limit=10_000, dry_run=dry_run, verbose=False) or {}
        _ok("Product signal classification done")
    except Exception as exc:
        _err(f"classify_product_signals failed: {exc}")
        traceback.print_exc()
        raise

    _banner(f"Step 8 — Classify Reference Pins  [{_ts()}]")
    try:
        from classify_reference_pins import run as classify_pins  # type: ignore
        from trend_seed_pipeline import P0_CATEGORIES as _P0  # type: ignore
        ref = classify_pins(
            reclassify_all=False,
            min_saves=500,
            limit=2000,
            dry_run=dry_run,
            verbose=False,
            categories=list(_P0),
        ) or {}
        _ok("Reference pin classification done")
    except Exception as exc:
        _err(f"classify_reference_pins failed: {exc}")
        traceback.print_exc()
        raise

    return {
        "product_signals": True,
        "reference_pins":  True,
        "product_rows":    prod.get("product_rows", 0),
        "reference_rows":  ref.get("reference_rows", 0),
        "updated_rows":    prod.get("updated_rows", 0) + ref.get("updated_rows", 0),
        "physical":        prod.get("physical", 0),
        "digital":         prod.get("digital", 0),
        "eligible":        ref.get("eligible", 0),
    }


async def step_opportunities(category: str | None = None, limit: int = 2000,
                             dry_run: bool = False) -> dict:
    """Step 9 — regenerate the opportunities table (Product Ideas / Opportunities views)."""
    import traceback

    _banner(f"Step 9 — Generate Opportunities  [{_ts()}]")
    try:
        from generate_opportunities import run as gen_opps  # type: ignore
        res = gen_opps(category=category, limit=limit, dry_run=dry_run, verbose=False) or {}
        _ok("Opportunities table populated")
        return {
            "opportunities":      True,
            "processed":          res.get("processed", 0),
            "created_or_updated": res.get("created_or_updated", 0),
            "skipped":            res.get("skipped", 0),
        }
    except Exception as exc:
        _err(f"generate_opportunities failed: {exc}")
        traceback.print_exc()
        raise


# 鈹€鈹€ Progress summary 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

def print_summary(start_ts: float) -> None:
    elapsed = time.monotonic() - start_ts
    _banner(f"Pipeline Summary  [{_ts()}]  elapsed={elapsed:.0f}s")

    for table, label in [
        ("trend_interests",    "Interests"),
        ("trend_keywords",     "Trend Keywords"),
        ("keyword_expansions", "Expanded Keywords"),
        ("crawl_queue",        "Queue Items"),
        ("pin_samples",        "Pins"),
        ("pin_products",       "Products"),
        ("product_scores",     "Product Scores"),
        ("keyword_product_map","Keyword-Product Links"),
    ]:
        rows = _db_select(table)
        count = len(rows)
        _info(f"  {label:<22}  {count:>6}")


# 鈹€鈹€ Main 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async def main() -> None:
    ap = argparse.ArgumentParser(
        description="Pinterest Intelligence Pipeline 鈥?trend-driven, high-signal"
    )
    ap.add_argument("--step",    choices=[
                        "all", "interests", "trends", "crawl", "stl", "score",
                        "digital", "enrich", "enrich_competition",
                        "classify", "opportunities",
                    ],
                    default="all", help="Which step(s) to run (default: all)")
    ap.add_argument("--interest", default=None,
                    help="Single interest slug (skips DB load)")
    ap.add_argument("--region",  default="US")
    ap.add_argument("--proxy",   default=None)
    ap.add_argument("--top", "--top-n", dest="top", type=int, default=30,
                    help="Max keywords per interest (default 30)")
    ap.add_argument("--concurrency", type=int, default=3,
                    help="Parallel keyword crawlers (default 3, max 5)")
    ap.add_argument("--max-pins",    type=int, default=75,
                    help="Max pins per keyword (default 75)")
    ap.add_argument("--limit-interests", type=int, default=0,
                    help="Cap number of interests to process (0=all)")
    ap.add_argument("--limit-keywords",  type=int, default=0,
                    help="Cap crawl_queue items to process per run (0=all)")
    ap.add_argument("--limit",           type=int, default=0,
                    help="Alias for --limit-keywords (convenience shorthand)")
    ap.add_argument("--category",        default=None,
                    help="Filter crawl_queue to one category (home/fashion/beauty/鈥?")
    ap.add_argument("--stl-limit",       type=int, default=200,
                    help="Max pins to STL-scan per run (default 200)")
    ap.add_argument("--digital-group",   nargs="+", metavar="GROUP", default=None,
                    help="Digital keyword groups (default: all). Used with --step digital")
    ap.add_argument("--probe",    action="store_true",
                    help="Run interest probe (slower, checks liveness)")
    ap.add_argument("--dry-run",  action="store_true",
                    help="Discover but do not write to DB")
    ap.add_argument("--allow-legacy-stl", action="store_true",
                    help="Emergency/manual opt-in to the RETIRED legacy STL writer for "
                         "--step stl. Without this (or VIBEPIN_ALLOW_LEGACY_STL=1) a real "
                         "STL run is skipped. Prefer: run_worker.py --job product-supply-expand")
    args = ap.parse_args()

    start = time.monotonic()
    _banner(f"VibePin Intelligence Pipeline  [{_ts()}]  step={args.step}")

    # 鈹€鈹€ Step 1: Interest Discovery 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "interests", "trends"):
        if args.interest:
            from interest_discovery import SLUG_LABELS  # type: ignore
            interests = [{"interest_slug": args.interest,
                          "interest_name": SLUG_LABELS.get(args.interest, args.interest)}]
        else:
            interests = await step_interests(args.region, run_probe=args.probe)

        if not interests:
            _err("No interests available. Check DB or run: py interest_discovery.py")
            return
    else:
        interests = []

    # 鈹€鈹€ Step 2: Trend Keywords 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "trends"):
        await step_trends(
            interests=interests,
            region=args.region,
            top_n=args.top,
            proxy=args.proxy,
            dry_run=args.dry_run,
            limit_interests=args.limit_interests,
        )

    # 鈹€鈹€ Step 3: Crawl Queue 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "crawl"):
        kw_limit = args.limit or args.limit_keywords
        await step_crawl(
            concurrency=args.concurrency,
            max_pins=args.max_pins,
            proxy=args.proxy,
            dry_run=args.dry_run,
            limit_keywords=kw_limit,
            category=args.category,
            replenish=(args.step == "crawl" or args.step == "all"),
            top_n=args.top,
            region=args.region,
            limit_interests=args.limit_interests,
        )

    # 鈹€鈹€ Step 4: Shop the Look 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "stl"):
        await step_stl(
            limit=args.stl_limit,
            dry_run=args.dry_run,
            allow_legacy=args.allow_legacy_stl,
        )

    # 鈹€鈹€ Step 5: Product Intelligence Scoring 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "score"):
        await step_score(dry_run=args.dry_run)

    # 鈹€鈹€ Step 6a: Trend History Enrichment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step == "enrich":
        await step_enrich(dry_run=args.dry_run)

    # 鈹€鈹€ Step 6b: Competition Enrichment 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step == "enrich_competition":
        kw_limit = args.limit or args.limit_keywords
        await step_enrich_competition(limit=kw_limit, dry_run=args.dry_run)

    # 鈹€鈹€ Step 6: Digital Product Signals 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step == "digital":
        await step_digital(
            groups=args.digital_group,
            max_pins=args.stl_limit,
            dry_run=args.dry_run,
        )

    # 鈹€鈹€ Steps 7+8: Classify product signals + reference pins 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "classify"):
        await step_classify(dry_run=args.dry_run)

    # 鈹€鈹€ Step 9: Generate opportunities table 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    if args.step in ("all", "opportunities"):
        kw_limit = args.limit or args.limit_keywords or 2000
        await step_opportunities(category=args.category, limit=kw_limit, dry_run=args.dry_run)

    print_summary(start)
    _ok("Pipeline done.")


if __name__ == "__main__":
    asyncio.run(main())
