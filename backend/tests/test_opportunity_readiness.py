"""Tests for MVP launch readiness tiers and label gating."""

from __future__ import annotations

from opportunity_readiness import (
    adjust_primary_label,
    adjust_trend_state_display,
    availability_tier,
    build_readiness_payload,
    compute_readiness_status,
    effective_product_count,
    readiness_score_adjustment,
)


class TestAvailabilityTier:
    def test_buckets(self):
        assert availability_tier(0) == "none"
        assert availability_tier(3) == "weak"
        assert availability_tier(10) == "testable"
        assert availability_tier(20) == "strong"
        assert availability_tier(60) == "deep"


class TestBestBetGating:
    def test_zero_products_not_best_bet(self):
        assert adjust_primary_label("Best Bet", "needs_products", "none") == "Steady"
        assert adjust_primary_label("Best Bet", "insight_only", "weak") == "Steady"

    def test_testable_products_not_best_bet(self):
        assert adjust_primary_label("Best Bet", "testable", "testable") == "Steady"

    def test_launch_ready_keeps_best_bet(self):
        assert adjust_primary_label("Best Bet", "launch_ready", "strong") == "Best Bet"
        assert adjust_primary_label("Best Bet", "strong_opportunity", "deep") == "Best Bet"

    def test_steady_unchanged(self):
        assert adjust_primary_label("Steady", "needs_products", "weak") == "Steady"


class TestTrendDisplay:
    def test_rising_weak_products(self):
        assert adjust_trend_state_display("Rising", "needs_products", True) == "Rising · Needs Products"

    def test_insight_only(self):
        assert adjust_trend_state_display("Rising", "insight_only", True) == "Insight Only"

    def test_launch_ready_rising_unchanged(self):
        assert adjust_trend_state_display("Rising", "launch_ready", True) == "Rising"


class TestReadinessStatus:
    def test_no_products_insight(self):
        status, reasons = compute_readiness_status(
            product_tier="none",
            reference_tier="none",
            pin_evidence_count=8,
            trend_score=30,
            rising=False,
        )
        assert status == "insight_only"
        assert reasons

    def test_launch_ready(self):
        status, _ = compute_readiness_status(
            product_tier="strong",
            reference_tier="testable",
            pin_evidence_count=12,
            trend_score=70,
            rising=True,
        )
        assert status == "launch_ready"


class TestScoreAdjustment:
    def test_weak_products_penalized(self):
        weak = readiness_score_adjustment(
            70, product_tier="weak", reference_tier="none",
            products_with_url=0, products_with_image=0, category_match=0,
        )
        strong = readiness_score_adjustment(
            70, product_tier="strong", reference_tier="testable",
            products_with_url=5, products_with_image=5, category_match=3,
        )
        assert strong > weak


class TestBuildPayload:
    def test_payload_fields(self):
        payload = build_readiness_payload(
            opportunity_id=None,
            keyword_id="kw-1",
            category="fashion",
            pin_evidence_count=10,
            reference_eligible_count=6,
            total_saves=5000,
            avg_save_velocity=1.2,
            trend_score=65,
            freshness_score=50,
            products=[
                {"source_url": "https://x.com", "image_url": "https://img", "product_name": "Dress"},
            ] * 16,
            rising=True,
        )
        assert payload["productAvailabilityTier"] == "strong"
        assert payload["referenceAvailabilityTier"] == "testable"
        assert payload["readinessStatus"] in ("launch_ready", "strong_opportunity")
        assert payload["readinessReasons"]
