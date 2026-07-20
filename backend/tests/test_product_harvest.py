"""Tests for the scoped outbound_link → pin_products harvest (product_harvest.py)."""

import unittest
from unittest.mock import patch

import product_harvest as ph
from product_harvest import (
    accept_link, build_pin_filters, build_product_row, classify_link,
    normalize_product_url, url_hash, harvest, PROVENANCE, BOOTSTRAP_SOURCES,
)


def _pin(pid, cat, url, title="boho living room decor", saves=8000, kw="small bedroom decor ideas",
         source="manual_bootstrap"):
    return {"pin_id": pid, "category": cat, "outbound_link": url, "title": title,
            "save_count": saves, "seed_keyword": kw, "source_interest": source,
            "image_url": "https://img/x.jpg"}


class TestScopeFilters(unittest.TestCase):
    def test_selection_excludes_legacy_via_source_filter(self):
        f = build_pin_filters("2026-06-19T00:00:00+00:00", "bootstrap",
                              ["home-decor", "beauty"])
        self.assertEqual(f["source_interest"], "in.(manual_bootstrap,csv_bootstrap)")
        self.assertTrue(f["scraped_at"].startswith("gte."))
        self.assertEqual(f["outbound_link"], "not.is.null")
        self.assertIn("home-decor", f["category"])


class TestAcceptance(unittest.TestCase):
    def test_known_commerce_accepted(self):
        # Amazon uses a real 10-char ASIN: the PDP gate requires /dp/[A-Z0-9]{10},
        # so a placeholder like /dp/x is (correctly) NOT a product-detail page.
        for u in ("https://www.etsy.com/listing/1/x", "https://www.amazon.com/dp/B0CPSBDQBR",
                  "https://payhip.com/b/abc", "https://www.ikea.com/us/en/p/x"):
            ok, reason = accept_link(u)
            self.assertTrue(ok, f"{u} should be accepted ({reason})")

    def test_non_product_rejected(self):
        cases = {
            "https://www.instagram.com/p/abc": "social_media",
            "https://www.tiktok.com/@user/video/123": "social_media",
            "https://www.pinterest.com/pin/123": "pinterest_internal",
            "https://maytheray.com/yellow-nail-designs/": "non_commerce_domain",
            "": "empty_or_relative",
        }
        for u, expected in cases.items():
            ok, reason = accept_link(u)
            self.assertFalse(ok, f"{u} should be rejected")
            self.assertEqual(reason, expected)

    def test_shopify_products_path_accepted(self):
        # Unlisted merchant domain, but clear Shopify /products/ path.
        ok, reason = accept_link("https://www.tileandtop.com/collections/mosaics/products/3x8-athens-gray")
        self.assertTrue(ok)
        self.assertEqual(reason, "shopify_product_path")

    def test_teepublic_product_accepted_profile_rejected(self):
        ok_prod, r1 = accept_link("https://www.teepublic.com/t-shirt/12345-cool-design")
        self.assertTrue(ok_prod, f"teepublic product should be accepted ({r1})")
        ok_user, r2 = accept_link("https://www.teepublic.com/user/anulf")
        self.assertFalse(ok_user)
        self.assertEqual(r2, "marketplace_profile")

    def test_payhip_gumroad_accepted(self):
        for u in ("https://payhip.com/b/abc123", "https://gumroad.com/l/xyz"):
            ok, _ = accept_link(u)
            self.assertTrue(ok, f"{u} should be accepted")

    def test_generic_blog_rejected(self):
        ok, reason = accept_link("https://glamideashub.com/13-cute-march-nail-ideas/")
        self.assertFalse(ok)
        self.assertEqual(reason, "non_commerce_domain")

    def test_shop_the_look_retailer_product_paths(self):
        urls = (
            "https://us.puma.com/us/en/pd/fade-overload-mens-sneakers/408353?size=10",
            "https://www.ebay.com/itm/257457918335?mkcid=16",
            "https://www.anthropologie.com/shop/the-love-knot-slouchy-bag",
            "https://www.anthropologie.com/en-gb/shop/melie-bianco-brigitte-large-faux-leather-shoulder",
            "https://www.flightclub.com/air-jordan-1-retro-high-og-dz5485-612",
            "https://www.dsw.com/product/kelly-and-katie-golda-mary-jane-flat/603847",
            "https://www.quince.com/women/organic-cotton-micro-rib-button-tee?color=black",
            "https://www.wconcept.com/product/marenheart-keychain/720785511.html",
        )
        for url in urls:
            ok, reason = accept_link(url)
            self.assertTrue(ok, f"{url} should be accepted ({reason})")
            self.assertEqual(reason, "retailer_product_path")

    def test_shop_the_look_retailer_navigation_paths_rejected(self):
        urls = (
            "https://us.puma.com/",
            "https://www.ebay.com/sch/i.html?_nkw=shoes",
            "https://www.anthropologie.com/shop/dresses",
            "https://www.flightclub.com/collections/air-jordan",
            "https://www.dsw.com/category/womens/shoes",
            "https://www.quince.com/women",
            "https://www.wconcept.com/category/women/100",
            "https://www.wconcept.com/login",
        )
        for url in urls:
            ok, reason = accept_link(url)
            self.assertFalse(ok, f"{url} should be rejected ({reason})")

    def test_cart_checkout_and_profiles_rejected_even_on_commerce_domains(self):
        urls = (
            "https://www.amazon.com/cart",
            "https://www.amazon.com/shop/morganle444/list/ABC123",
            "https://www.etsy.com/search?q=wall+art",
            "https://www.teepublic.com/user/anulf",
            "https://www.ebay.com/checkout",
        )
        for url in urls:
            ok, _reason = accept_link(url)
            self.assertFalse(ok, f"{url} should be rejected")


class TestPdpGateGuard(unittest.TestCase):
    """CI door: fail loudly if the domain-aware PDP gate is missing or if accept_link
    is silently swapped back to the OLD gateless version (the stash-incident casualty
    that let Amazon /s?k= search pages and TPT /browse pages become fake 'products').

    A regression here means dirty product data can re-enter pin_products. Do not weaken.
    """

    def test_pdp_gate_symbol_exists(self):
        # The gate function must exist AND be wired into accept_link. The old gateless
        # product_harvest.py has neither — importing this symbol would AttributeError.
        self.assertTrue(hasattr(ph, "is_product_detail_url"),
                        "is_product_detail_url() is missing — PDP gate reverted to a gateless build")
        self.assertTrue(callable(ph.is_product_detail_url))

    def test_search_and_browse_pages_are_rejected(self):
        # These are the exact URLs the gateless build wrongly accepted as products.
        for u in ("https://www.amazon.com/Terrific-Patio-Garden/s?k=patio+garden",
                  "https://www.teacherspayteachers.com/browse/free?search=printable",
                  "https://www.etsy.com/search?q=wall+art"):
            ok, reason = accept_link(u)
            self.assertFalse(ok, f"{u} must be rejected by the PDP gate (got accept, reason={reason})")

    def test_is_product_detail_url_rejects_search_query(self):
        ok, _ = ph.is_product_detail_url("https://www.amazon.com/s?k=patio+garden")
        self.assertFalse(ok)
        # A real ASIN detail page (even with tracking query noise) IS a PDP.
        ok2, _ = ph.is_product_detail_url(
            "https://www.amazon.com/Wall-Decor/dp/B09QFWX7RL?dchild=1&keywords=home")
        self.assertTrue(ok2)

    def test_teepublic_gate_consistency(self):
        # accept_link exempts Teepublic via its own precise rule; the raw PDP gate must
        # AGREE (this is the inconsistency that failed the first 20-row batch pre-write).
        for u in ("https://www.teepublic.com/t-shirt/77625009-softball-ice-cream-drip",
                  "https://www.teepublic.com/poster-and-art/80640861-jeff-buckley"):
            a_ok, _ = accept_link(u)
            p_ok, _ = ph.is_product_detail_url(u)
            self.assertTrue(a_ok, f"accept_link should accept teepublic product {u}")
            self.assertTrue(p_ok, f"is_product_detail_url must AGREE it is a PDP: {u}")
        # profile/store pages: both gates reject
        for u in ("https://www.teepublic.com/user/anulf", "https://www.teepublic.com/stores/foo"):
            self.assertFalse(accept_link(u)[0])
            self.assertFalse(ph.is_product_detail_url(u)[0])


class TestNormalizeDedup(unittest.TestCase):
    def test_tracking_params_stripped_same_hash(self):
        a = "https://www.etsy.com/listing/917/rug?utm_source=pinterest&utm_medium=pin"
        b = "https://etsy.com/listing/917/rug/"
        self.assertEqual(normalize_product_url(a), normalize_product_url(b))
        self.assertEqual(url_hash(normalize_product_url(a)), url_hash(normalize_product_url(b)))

    def test_dedup_collapses(self):
        rows = [
            build_product_row(_pin("p1", "home-decor", "https://www.etsy.com/listing/1/x?utm_source=pin", saves=100), "https://www.etsy.com/listing/1/x?utm_source=pin", classify_link("https://www.etsy.com/listing/1/x", "rug")),
            build_product_row(_pin("p1", "home-decor", "https://etsy.com/listing/1/x/", saves=900), "https://etsy.com/listing/1/x/", classify_link("https://etsy.com/listing/1/x/", "rug")),
        ]
        deduped, dups = ph._dedup(rows)
        self.assertEqual(len(deduped), 1)
        self.assertEqual(dups, 1)
        self.assertEqual(deduped[0]["save_count"], 900)  # keeps higher-save evidence


class TestClassification(unittest.TestCase):
    def test_digital_platform(self):
        c = classify_link("https://payhip.com/b/abc", "printable budget planner")
        self.assertEqual(c["product_type"], "digital")

    def test_physical_platform(self):
        c = classify_link("https://www.amazon.com/dp/x", "Tradare Dresser")
        self.assertEqual(c["product_type"], "physical")


class TestRowProvenanceInheritance(unittest.TestCase):
    def test_row_fields(self):
        pin = _pin("pid1", "home-decor", "https://www.etsy.com/listing/9/x", saves=12345, kw="mudroom decor ideas")
        row = build_product_row(pin, pin["outbound_link"], classify_link(pin["outbound_link"], pin["title"]))
        self.assertEqual(row["discovery_method"], PROVENANCE)
        self.assertEqual(row["discovery_method"], "outbound_link_bootstrap")
        self.assertTrue(row["inspiration_only"])
        self.assertFalse(row["is_user_ownable"])
        self.assertFalse(row["is_seed"])
        self.assertEqual(row["parent_pin_id"], "pid1")          # parent inherited
        self.assertEqual(row["source_pin_url"], "https://www.pinterest.com/pin/pid1/")  # set at insert
        self.assertEqual(row["seed_keyword"], "mudroom decor ideas")  # keyword inherited
        self.assertEqual(row["save_count"], 12345)              # save inherited (not fabricated)
        self.assertIsNone(row["product_pin_id"])               # not a product pin


class TestHarvestDryRun(unittest.TestCase):
    def _fake_select(self):
        pins = [
            _pin("A", "home-decor", "https://www.etsy.com/listing/1/rug?utm_source=pin"),
            _pin("B", "beauty", "https://payhip.com/b/xyz", title="press on nails", kw="press on nails ideas"),
            _pin("C", "beauty", "https://www.instagram.com/p/abc", kw="summer nail aesthetic"),
            _pin("D", "home-decor", "https://maytheray.com/post/x"),
            _pin("E", "home-decor", "https://etsy.com/listing/1/rug/"),  # dup of A
        ]
        def fake(table, filters=None, order=None, limit=None):
            if table == "pin_samples":
                return pins
            return []  # pin_products: no existing
        return fake

    def test_dry_run_writes_nothing(self):
        with patch.object(ph, "_db_select", return_value=self._fake_select()), \
             patch.object(ph, "_apply_rows", side_effect=AssertionError("must not write in dry-run")) as mock_apply:
            rep = harvest(since_hours=24, source="bootstrap", apply=False)
        mock_apply.assert_not_called()
        self.assertEqual(rep["mode"], "dry-run")
        self.assertEqual(rep["pinsScanned"], 5)
        self.assertEqual(rep["ecommerceProductLinksAccepted"], 3)   # A, B, E
        self.assertEqual(rep["duplicatesByNormalizedUrl"], 1)        # E dups A
        self.assertEqual(rep["projectedInserts"], 2)                 # A/E collapsed + B
        self.assertEqual(rep["legacyPinsTouched"], 0)
        self.assertEqual(rep["writes"]["pin_products"], 0)
        self.assertIn("social_media", rep["rejectReasonDistribution"])
        self.assertIn("non_commerce_domain", rep["rejectReasonDistribution"])
        self.assertEqual(rep["provenanceLabel"], "outbound_link_bootstrap")

    def test_apply_calls_writer(self):
        with patch.object(ph, "_db_select", return_value=self._fake_select()), \
             patch.object(ph, "_apply_rows", return_value={"written": 2}) as mock_apply:
            rep = harvest(since_hours=24, source="bootstrap", apply=True)
        mock_apply.assert_called_once()
        self.assertEqual(rep["mode"], "apply")
        self.assertEqual(rep["applied"]["written"], 2)


if __name__ == "__main__":
    unittest.main()
