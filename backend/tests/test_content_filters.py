"""Tests for negative-term content filtering."""

from __future__ import annotations

from content_filters import evaluate_pin_content, reset_filter_stats, get_filter_stats


def test_rejects_wallpaper():
    reset_filter_stats()
    d = evaluate_pin_content(title="cute phone wallpaper aesthetic", description="")
    assert d.reject is True
    assert get_filter_stats()["negative_term"] >= 1


def test_allows_digital_printable():
    reset_filter_stats()
    d = evaluate_pin_content(
        title="weekly planner printable template",
        description="digital download",
        category="digital-products",
    )
    assert d.reject is False


def test_allows_commercial_quote_template():
    reset_filter_stats()
    d = evaluate_pin_content(
        title="motivational quote printable wall art",
        description="etsy template",
        category="digital-products",
    )
    assert d.reject is False
