"""Unit tests for official_v5_seed_quality dedup, routing, and quality gates."""

from __future__ import annotations

import os
import unittest

from official_v5_seed_quality import (
    assign_v5_crawl_tier,
    detect_viral_noise,
    finalize_canonical_seed,
    global_dedupe_job_seeds,
    passes_v5_category_gate,
    resolve_p0_bucket,
    route_best_p0_bucket,
    score_category_relevance,
)
from trend_fetcher import build_trend_keyword_row


def _seed(keyword: str, *, interest: str, category: str = "fashion", **extra) -> dict:
    row = {
        "keyword": keyword,
        "interest_slug": interest,
        "normalized_category": category,
        "trend_source": "pinterest_trends_v5",
        "pct_growth_yoy": 200,
        "pct_growth_wow": 10,
        "volume_score": 4,
        "crawl_priority": "medium",
        "refresh_cadence": "every_3_days",
        "crawl_queue_eligible": True,
        "trend_seed_score": 55,
        "commercial_intent_score": 50,
        "category_relevance_score": 60,
    }
    row.update(extra)
    return row


class TestFalsePositivesRejected(unittest.TestCase):
    """Terms that must not route to home-decor or enter daily queue."""

    HOME_DECOR_FALSE_POSITIVES = (
        "dinner ideas",
        "drawing ideas",
        "father's day gifts ideas",
        "fathers day card ideas",
        "badazel ideas",
    )

    VIRAL_OR_NOISE = (
        "love island",
        "celebrity name trend",
        "wallpaper",
        "fanart",
        "meme",
        "super bowl party",
    )

    def test_home_decor_false_positives_rejected(self):
        for kw in self.HOME_DECOR_FALSE_POSITIVES:
            with self.subTest(keyword=kw):
                ok, reason = passes_v5_category_gate(kw, p0_bucket="home-decor")
                self.assertFalse(ok, msg=f"{kw} should not pass home-decor gate")
                self.assertIsNotNone(reason)

    def test_viral_noise_rejected(self):
        for kw in self.VIRAL_OR_NOISE:
            with self.subTest(keyword=kw):
                is_viral, reason = detect_viral_noise(kw)
                self.assertTrue(is_viral, msg=f"{kw} should be viral/noise")
                self.assertIsNotNone(reason)

    def test_food_art_gift_not_routed_to_home_decor(self):
        for kw in self.HOME_DECOR_FALSE_POSITIVES:
            with self.subTest(keyword=kw):
                routed = route_best_p0_bucket(kw)
                self.assertNotEqual(routed, "home-decor", msg=f"{kw} routed to home-decor")


class TestFalseNegativesAccepted(unittest.TestCase):
    """Short commercial terms that must not be rejected as viral_hashtag_only."""

    ACCEPTABLE_TERMS = (
        "nails",
        "hairstyles",
        "outfit",
        "nail inspo",
        "summer outfits",
        "linen pants outfit",
        "skirt outfit",
        "home decor ideas",
        "gallery wall ideas",
        "small bedroom ideas",
    )

    def test_not_viral_hashtag_only(self):
        for kw in self.ACCEPTABLE_TERMS:
            with self.subTest(keyword=kw):
                is_viral, reason = detect_viral_noise(kw)
                self.assertFalse(is_viral, msg=f"{kw} rejected as {reason}")

    def test_beauty_fashion_terms_pass_gate(self):
        cases = {
            "nails": "beauty",
            "hairstyles": "beauty",
            "outfit": "fashion",
            "nail inspo": "beauty",
            "summer outfits": "womens-fashion",
            "home decor ideas": "home-decor",
            "gallery wall ideas": "home-decor",
            "small bedroom ideas": "home-decor",
        }
        for kw, bucket in cases.items():
            with self.subTest(keyword=kw, bucket=bucket):
                gate_bucket = route_best_p0_bucket(kw) or bucket
                ok, reason = passes_v5_category_gate(kw, p0_bucket=gate_bucket)
                self.assertTrue(ok, msg=f"{kw} rejected: {reason}")


class TestWomensFashionRouting(unittest.TestCase):
    def test_womens_fashion_interest_maps_to_bucket(self):
        self.assertEqual(resolve_p0_bucket(interest_slug="womens_fashion"), "womens-fashion")

    def test_generic_outfit_routes_to_fashion_not_kids(self):
        routed = route_best_p0_bucket("linen pants outfit")
        self.assertIn(routed, ("fashion", "womens-fashion"))
        self.assertNotEqual(routed, "kids-fashion")

    def test_womens_tokens_prefer_womens_fashion(self):
        routed = route_best_p0_bucket("midi skirt outfit women")
        self.assertEqual(routed, "womens-fashion")

    def test_womens_fashion_interest_canonicalizes_bucket(self):
        rows = [
            _seed("fall outfits", interest="womens_fashion", normalized_category="fashion"),
            _seed("fall outfits", interest="fashion", normalized_category="fashion"),
        ]
        canon = finalize_canonical_seed("fall outfits", rows)
        self.assertEqual(canon["p0_bucket"], "womens-fashion")


class TestDedup(unittest.TestCase):
    def test_same_keyword_across_interests_deduped(self):
        acc = {
            "seeds": [
                _seed("spring nails", interest="beauty", normalized_category="beauty"),
                _seed("spring nails", interest="womens_fashion", normalized_category="fashion"),
            ],
            "watchlist": [],
        }
        report = global_dedupe_job_seeds(acc)
        self.assertEqual(report["rawAcceptedCount"], 2)
        self.assertEqual(report["uniqueAcceptedCount"], 1)
        self.assertEqual(len(acc["seeds"]), 1)
        self.assertEqual(report["duplicateGroups"], 1)

    def test_cross_category_fashion_home_decor_canonical(self):
        acc = {
            "seeds": [
                _seed("cozy living room", interest="home_decor", normalized_category="home-decor",
                      category="home-decor"),
                _seed("cozy living room", interest="architecture", normalized_category="home-decor",
                      category="home-decor"),
            ],
            "watchlist": [],
        }
        global_dedupe_job_seeds(acc)
        self.assertEqual(len(acc["seeds"]), 1)
        canon = acc["seeds"][0]
        self.assertEqual(canon.get("normalized_category"), "home-decor")
        self.assertIn("matched_interests", canon)

    def test_duplicate_provenance_preserved(self):
        acc = {
            "seeds": [
                _seed("outfit inspo", interest="fashion", normalized_category="fashion"),
                _seed("outfit inspo", interest="womens_fashion", normalized_category="fashion"),
            ],
            "watchlist": [],
        }
        global_dedupe_job_seeds(acc)
        canon = acc["seeds"][0]
        self.assertGreaterEqual(canon.get("dedup_merged_count", 0), 2)
        self.assertIn("fashion", canon.get("matched_interests", []))
        self.assertIn("womens_fashion", canon.get("matched_interests", []))

    def test_finalize_canonical_before_writes(self):
        rows = [
            _seed("gallery wall ideas", interest="home_decor", normalized_category="home-decor",
                  category="home-decor"),
            _seed("gallery wall ideas", interest="design", normalized_category="home-decor",
                  category="home-decor"),
        ]
        canon = finalize_canonical_seed("gallery wall ideas", rows)
        self.assertEqual(canon["p0_bucket"], "home-decor")
        self.assertEqual(canon["normalized_category"], "home-decor")
        self.assertTrue(canon.get("_provenance") or canon.get("matched_interests"))

    def test_apply_path_receives_deduped_only(self):
        acc = {
            "seeds": [
                _seed("nails", interest="beauty", normalized_category="beauty", category="beauty"),
                _seed("nails", interest="beauty", normalized_category="beauty", category="beauty"),
            ],
            "watchlist": [],
        }
        global_dedupe_job_seeds(acc)
        self.assertEqual(len(acc["seeds"]), 1)
        self.assertTrue(acc.get("_dedup_report", {}).get("applySafe"))


class TestCadence(unittest.TestCase):
    def test_high_growth_low_commercial_watchlist_or_reject(self):
        kw = {"keyword": "love island recap", "pct_growth_yoy": 900}
        tier, cadence, eligible, reason = assign_v5_crawl_tier(
            trend_seed_score=80,
            commercial_intent=15,
            category_relevance=20,
            kw=kw,
        )
        self.assertIn(tier, ("excluded", "watchlist"))
        self.assertNotEqual(cadence, "daily")
        self.assertFalse(eligible)

    def test_high_growth_strong_commercial_daily(self):
        tier, cadence, eligible, _ = assign_v5_crawl_tier(
            trend_seed_score=70,
            commercial_intent=60,
            category_relevance=65,
            kw={"keyword": "gallery wall ideas"},
        )
        self.assertEqual(tier, "high")
        self.assertEqual(cadence, "daily")
        self.assertTrue(eligible)

    def test_weak_relevance_rejected(self):
        ok, reason = passes_v5_category_gate("random xyz topic", p0_bucket="beauty")
        self.assertFalse(ok)
        self.assertIn(reason, ("category_irrelevant", "low_commercial_intent"))


class TestV29RowWriting(unittest.TestCase):
    def test_trend_type_included_when_flag_enabled(self):
        prev = os.environ.get("ENABLE_TREND_V29_PROVENANCE_COLUMNS")
        os.environ["ENABLE_TREND_V29_PROVENANCE_COLUMNS"] = "true"
        try:
            row = build_trend_keyword_row(
                {
                    "keyword": "spring nails",
                    "trend_source": "pinterest_trends_v5",
                    "trend_type": "growing",
                    "v5_interest_param": "beauty",
                    "normalized_category": "beauty",
                },
                "beauty",
            )
            self.assertEqual(row.get("trend_type"), "growing")
            self.assertEqual(row.get("v5_interest_param"), "beauty")
        finally:
            if prev is None:
                os.environ.pop("ENABLE_TREND_V29_PROVENANCE_COLUMNS", None)
            else:
                os.environ["ENABLE_TREND_V29_PROVENANCE_COLUMNS"] = prev

    def test_no_v29_columns_when_flag_disabled(self):
        prev = os.environ.get("ENABLE_TREND_V29_PROVENANCE_COLUMNS")
        os.environ["ENABLE_TREND_V29_PROVENANCE_COLUMNS"] = "false"
        try:
            row = build_trend_keyword_row(
                {
                    "keyword": "spring nails",
                    "trend_source": "pinterest_trends_v5",
                    "trend_type": "growing",
                    "v5_interest_param": "beauty",
                    "normalized_category": "beauty",
                },
                "beauty",
            )
            self.assertNotIn("trend_type", row)
            self.assertNotIn("v5_interest_param", row)
        finally:
            if prev is None:
                os.environ.pop("ENABLE_TREND_V29_PROVENANCE_COLUMNS", None)
            else:
                os.environ["ENABLE_TREND_V29_PROVENANCE_COLUMNS"] = prev


if __name__ == "__main__":
    unittest.main()
