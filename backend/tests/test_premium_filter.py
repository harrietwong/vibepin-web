"""Tests for the category-aware crawl save filter (scraper_v2.passes_premium_filter)."""

import unittest

from scraper_v2 import (
    passes_premium_filter,
    FRESHNESS_DAYS,
    MIN_SAVE_COUNT,
    DIGITAL_MIN_SAVE_COUNT,
)


def _rec(category, save_count, days, title="boho living room decor", desc=""):
    return {
        "category": category,
        "save_count": save_count,
        "days_since_creation": days,
        "title": title,
        "description": desc,
        "seed_keyword": title,
    }


class TestNonDigitalUnchanged(unittest.TestCase):
    """Other categories must behave exactly as before the digital fix."""

    def test_stale_rejected(self):
        ok, reason = passes_premium_filter(_rec("home-decor", 5000, FRESHNESS_DAYS + 10))
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("stale:"))

    def test_low_saves_rejected(self):
        ok, reason = passes_premium_filter(_rec("home-decor", MIN_SAVE_COUNT - 1, 10))
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("low_saves:"))

    def test_fresh_high_save_passes(self):
        ok, reason = passes_premium_filter(_rec("home-decor", MIN_SAVE_COUNT + 100, 10))
        self.assertTrue(ok)
        self.assertEqual(reason, "")


class TestDigitalOverrides(unittest.TestCase):
    def test_stale_digital_passes(self):
        """Evergreen digital pin, very old but enough saves → no longer rejected."""
        ok, reason = passes_premium_filter(
            _rec("digital-products", 200, 533, title="printable meal planner"))
        self.assertTrue(ok, f"expected pass, got reject:{reason}")

    def test_digital_low_save_floor(self):
        # below digital floor → rejected
        ok, reason = passes_premium_filter(
            _rec("digital-products", DIGITAL_MIN_SAVE_COUNT - 1, 500, title="printable savings tracker"))
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("low_saves:"))
        # at floor → passes even though old
        ok2, _ = passes_premium_filter(
            _rec("digital-products", DIGITAL_MIN_SAVE_COUNT, 2000, title="printable savings tracker"))
        self.assertTrue(ok2)

    def test_digital_floor_lower_than_default(self):
        """A 150-save evergreen digital pin passes; the same pin in a non-digital
        category would be rejected for low saves."""
        ok_digital, _ = passes_premium_filter(_rec("digital-products", 150, 400, title="canva ebook template"))
        ok_other, reason_other = passes_premium_filter(_rec("home-decor", 150, 10))
        self.assertTrue(ok_digital)
        self.assertFalse(ok_other)
        self.assertTrue(reason_other.startswith("low_saves:"))

    def test_digital_zero_save_still_noise_filtered(self):
        ok, reason = passes_premium_filter(_rec("digital-products", 0, 12, title="printable meal planner"))
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("low_saves:"))


if __name__ == "__main__":
    unittest.main()
