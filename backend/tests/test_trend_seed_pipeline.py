"""Tests for automated trend seed pipeline."""

from __future__ import annotations

from trend_seed_pipeline import (
    assign_crawl_priority,
    cluster_keywords,
    compute_trend_seed_score,
    example_outputs,
    normalize_category,
    process_trend_seeds,
    TrendSeed,
)


def test_normalize_category_maps_home_decor():
    assert normalize_category("home", "home_decor") == "home-decor"


def test_negative_term_excluded():
    result = process_trend_seeds(
        [{
            "keyword": "funny cat meme wallpaper",
            "trend_source": "pinterest_trends_api",
            "pct_growth_yoy": 400,
            "pct_growth_wow": 20,
            "volume_score": 4,
        }],
        category="home-decor",
        interest_slug="home_decor",
        top_n=5,
    )
    assert len(result.seeds) == 0
    assert len(result.excluded) == 1
    assert result.excluded[0]["reason"]


def test_high_medium_watchlist_tiers():
    keywords = [
        {
            "keyword": "boho living room decor ideas",
            "trend_source": "pinterest_trends_api",
            "pct_growth_yoy": 280, "pct_growth_wow": 12, "pct_growth_mom": 40,
            "volume_score": 4,
        },
        {
            "keyword": "spring nail aesthetic",
            "trend_source": "internal_resource",
            "pct_growth_yoy": 150, "pct_growth_wow": 5, "pct_growth_mom": 20,
            "volume_score": 3,
        },
        {
            "keyword": "soft pastel aesthetic",
            "trend_source": "typeahead_estimate",
            "pct_growth_yoy": 15, "pct_growth_wow": 1, "pct_growth_mom": 3,
            "volume_score": 1,
        },
    ]
    result = process_trend_seeds(keywords, category="home-decor", top_n=5)
    priorities = {s["keyword"]: s["crawl_priority"] for s in result.seeds}
    assert priorities["boho living room decor ideas"] == "high"
    assert priorities["spring nail aesthetic"] == "medium"
    assert result.watchlist
    assert result.watchlist[0]["crawl_priority"] == "watchlist"


def test_cluster_near_duplicates():
    seeds = [
        TrendSeed("boho living room decor", "home-decor", 80, "high", "daily", raw={}),
        TrendSeed("boho living room aesthetic", "home-decor", 78, "high", "daily", raw={}),
    ]
    clusters = cluster_keywords(seeds)
    assert any(len(v) >= 2 for v in clusters.values())
    assert seeds[0].cluster_id == seeds[1].cluster_id


def test_watchlist_not_queue_eligible():
    score = compute_trend_seed_score({
        "keyword": "soft aesthetic",
        "trend_source": "typeahead_estimate",
        "pct_growth_yoy": 10,
        "pct_growth_wow": 1,
        "volume_score": 1,
    })
    pri, cadence, eligible = assign_crawl_priority(score, {"trend_source": "typeahead_estimate"})
    assert pri == "watchlist"
    assert eligible is False
    assert cadence == "paused"


def test_refresh_cadence_scheduling():
    from datetime import datetime, timezone, timedelta
    from trend_seed_pipeline import next_crawl_at_from_cadence

    now = datetime(2026, 6, 8, 12, 0, tzinfo=timezone.utc)
    daily = next_crawl_at_from_cadence(now, "daily")
    weekly = next_crawl_at_from_cadence(now, "weekly")
    assert daily is not None and weekly is not None
    assert datetime.fromisoformat(daily) - now <= timedelta(days=1, seconds=1)
    assert datetime.fromisoformat(weekly) - now <= timedelta(days=7, seconds=1)
    assert next_crawl_at_from_cadence(now, "paused") is None


def test_example_outputs_structure():
    ex = example_outputs()
    assert ex["high_priority_seed"]["crawl_priority"] == "high"
    assert ex["medium_priority_seed"]["crawl_priority"] == "medium"
    assert ex["excluded_seed"]["reason"]
    assert len(ex["keyword_cluster"]["keywords"]) >= 2
    assert ex["crawl_queue_entry"]["status"] == "pending"
