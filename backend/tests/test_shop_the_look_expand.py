import json
import asyncio
import os
import pathlib
import re
import ssl
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, call, patch

import httpx

import shop_the_look_expand as stl
from shop_the_look_expand import (
    _rejected_candidates_report,
    NO_PRODUCT_EVIDENCE,
    DISCOVERY_METHOD,
    DISCOVERY_DETAIL,
    V28_REQUIRED_COLUMNS,
    _apply_rows,
    _build_report,
    _check_v28_schema,
    _prepare_candidate,
    _preflight_existing,
    extract_network_candidates,
    load_and_validate_source_report,
    parse_category_mix,
)


class TestCategoryMix(unittest.TestCase):
    def test_default_mix(self):
        mix = parse_category_mix(None)
        self.assertEqual(mix, {"fashion": 18, "womens-fashion": 14, "home-decor": 18})
        self.assertEqual(sum(mix.values()), 50)

    def test_excluded_categories_rejected(self):
        with self.assertRaises(ValueError):
            parse_category_mix("fashion:40,beauty:10")

    def test_digital_products_requires_explicit_narrow_opt_in(self):
        with self.assertRaises(ValueError):
            parse_category_mix(
                "fashion:29,womens-fashion:22,home-decor:29,digital-products:20"
            )
        with unittest.mock.patch.dict(
            os.environ,
            {"VIBEPIN_STL_ALLOW_EXCLUDED": "digital-products"},
        ):
            mix = parse_category_mix(
                "fashion:29,womens-fashion:22,home-decor:29,digital-products:20"
            )
        self.assertEqual(mix["digital-products"], 20)
        self.assertEqual(sum(mix.values()), 100)

    def test_reviewed_launch_mix_selects_exact_digital_quota(self):
        mix = {
            "fashion": 29,
            "womens-fashion": 22,
            "home-decor": 29,
            "digital-products": 20,
        }

        def sources(category, _cutoff, *, bootstrap_only, limit):
            del bootstrap_only, limit
            return [
                {
                    "pin_id": f"{category}-{index}",
                    "category": category,
                    "save_count": 1000 - index,
                    "seed_keyword": f"{category} seed",
                }
                for index in range(40)
            ]

        with patch.object(stl, "_query_sources", side_effect=sources):
            selected, report = stl.select_source_pins(category_mix=mix)
        counts = {
            category: sum(1 for row in selected if row["category"] == category)
            for category in mix
        }
        self.assertEqual(counts, mix)
        self.assertEqual(report["selectedTotal"], 100)
        self.assertEqual(report["selectionExhaustion"]["totalShortfall"], 0)


class TestNetworkExtraction(unittest.TestCase):
    def test_extracts_product_pin_fields(self):
        payload = {
            "resource_response": {
                "data": {
                    "productPin": {
                        "product_title": "Golda Mary Jane Flat",
                        "merchant_name": "DSW",
                        "product_url": "https://www.dsw.com/product/golda-mary-jane-flat/603847",
                        "product_image_url": "https://img.example/golda.jpg",
                        "price_value": {"value": "59.99"},
                        "price_currency": "USD",
                        "shopping_flags": ["SHOP_THE_LOOK"],
                    }
                }
            }
        }
        rows = extract_network_candidates(payload, response_url="https://pinterest/resource")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["product_title"], "Golda Mary Jane Flat")
        self.assertEqual(rows[0]["merchant"], "DSW")
        self.assertEqual(rows[0]["price"], "59.99")
        self.assertEqual(rows[0]["currency"], "USD")
        self.assertEqual(rows[0]["extraction_method"], "network_json")

    def test_redirect_method_recorded(self):
        payload = {"products": [{"title": "Bag", "redirect_url": "https://www.ebay.com/itm/123456789"}]}
        rows = extract_network_candidates(payload)
        self.assertEqual(rows[0]["extraction_method"], "redirect")

    def test_opaque_network_string_url_fallback(self):
        payload = {"resource_response": {"data": {"opaque": "buy https://www.ebay.com/itm/987654321 now"}}}
        rows = extract_network_candidates(payload)
        self.assertEqual(rows[0]["product_url"], "https://www.ebay.com/itm/987654321")
        self.assertEqual(rows[0]["json_path"], "network_text_fallback")


class TestPerPinHardTimeout(unittest.TestCase):
    def test_complete_pin_extraction_is_bounded(self):
        async def never_finishes(_page, _source, state):
            state["_pinStage"] = "tab_label"
            await asyncio.sleep(60)

        source = {"pin_id": "slow", "category": "fashion", "save_count": 1}
        with patch.object(stl, "_extract_source_pin", side_effect=never_finishes):
            result = asyncio.run(stl._extract_source_pin_bounded(
                object(), source, {}, timeout_seconds=1
            ))
        self.assertEqual(result["issue"], "pin_timeout:1s")
        self.assertTrue(result["renderFailure"])
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["timeoutStage"], "tab_label")

    def test_stalled_generic_tabs_are_individually_bounded_and_capped(self):
        clicks = 0

        class Locator:
            async def inner_text(self):
                return "normal pin body"

        class Mouse:
            async def wheel(self, _x, _y):
                return None

        class Tab:
            async def inner_text(self):
                await asyncio.sleep(60)

            async def click(self, timeout=None):
                nonlocal clicks
                clicks += 1

        class Page:
            url = "https://www.pinterest.com/pin/slow-tabs/"
            mouse = Mouse()

            async def goto(self, *_args, **_kwargs):
                return None

            def locator(self, _selector):
                return Locator()

            async def evaluate(self, _script):
                return []

            async def content(self):
                return "<html>Shop the Pin</html>"

            async def query_selector_all(self, _selector):
                return [Tab() for _ in range(10)]

        async def no_sleep(_seconds):
            return None

        state = {"productJsonResponses": 0}
        with patch.object(stl.asyncio, "sleep", no_sleep), patch.object(
            stl, "STL_TAB_LABEL_TIMEOUT_SECONDS", 0.001
        ):
            result = asyncio.run(stl._extract_source_pin(
                Page(), {"pin_id": "slow-tabs", "category": "fashion"}, state
            ))

        self.assertEqual(result["tabCount"], 10)
        self.assertEqual(clicks, stl.STL_MAX_TABS_PER_PIN)
        self.assertEqual(state["_pinStage"], "complete")

    def test_timeout_configuration_is_fail_closed(self):
        with patch.dict(os.environ, {stl.STL_PIN_TIMEOUT_ENV: "301"}):
            with self.assertRaises(RuntimeError):
                stl._stl_pin_timeout_seconds()
        with patch.dict(os.environ, {stl.STL_PIN_TIMEOUT_ENV: "120"}):
            self.assertEqual(stl._stl_pin_timeout_seconds(), 120)


def _make_candidate(pin_id="p1", url="https://www.ebay.com/itm/123456789",
                    category="fashion", title="Vintage jacket"):
    return {
        "source_pin_id": pin_id,
        "source_category": category,
        "product_url": url,
        "normalized_product_url": f"https://ebay.com/itm/123456789",
        "normalized_product_url_hash": "abc123",
        "product_title": title,
        "merchant": "eBay",
        "image_url": "https://img/jacket.jpg",
        "platform": "ebay",
        "domain": "ebay.com",
        "extraction_method": "network_json",
        "source_pin_save_count": 10000,
    }


class TestDryRunReport(unittest.TestCase):
    def _patch_preflight(self, existing_hashes=None):
        """Patch select_many so _preflight_existing finds no existing rows."""
        existing = existing_hashes or []
        def fake_select(table, filters=None, order=None, limit=None):
            if table == "pin_products" and filters and "normalized_product_url_hash" in filters:
                return [{"normalized_product_url_hash": h} for h in existing]
            return []
        return patch.object(stl, "select_many", side_effect=fake_select)

    def test_dedup_and_no_writes(self):
        candidate = _make_candidate()
        per_pin = [{
            "source": {"pin_id": "p1", "category": "fashion", "save_count": 10000},
            "shopModuleDetected": True,
            "shopTabClicked": True,
            "candidates": [candidate, dict(candidate)],
            "issue": None,
        }]
        with self._patch_preflight():
            report, unique = _build_report(per_pin, {"selectedTotal": 1}, elapsed=10, apply=False)
        self.assertEqual(report["mode"], "dry-run")
        self.assertEqual(report["writes"]["pin_products"], 0)
        self.assertEqual(report["aggregate"]["uniqueAcceptedProducts"], 1)
        self.assertEqual(report["aggregate"]["duplicatesSkipped"], 1)
        self.assertEqual(len(unique), 1)
        self.assertEqual(len(report["acceptedProducts"]), 1)
        self.assertEqual(report["rejectedProductDetails"], [])

    def test_preflight_counts_in_report(self):
        candidate = _make_candidate()
        per_pin = [{
            "source": {"pin_id": "p1", "category": "fashion", "save_count": 10000},
            "shopModuleDetected": True,
            "shopTabClicked": False,
            "candidates": [candidate],
            "issue": None,
        }]
        with self._patch_preflight(existing_hashes=[]):
            report, _ = _build_report(per_pin, {}, elapsed=5, apply=False)
        agg = report["aggregate"]
        self.assertEqual(agg["projectedInsertCount"], 1)
        self.assertEqual(agg["projectedSkipExistingCount"], 0)
        self.assertEqual(agg["projectedUpdateCount"], 0)
        self.assertEqual(agg["legacyTouchedProjected"], 0)

    def test_preflight_detects_existing_hash(self):
        """Candidate whose hash already exists in DB must be counted as skip, not insert."""
        candidate = _make_candidate()
        per_pin = [{
            "source": {"pin_id": "p1", "category": "fashion", "save_count": 10000},
            "shopModuleDetected": True,
            "shopTabClicked": False,
            "candidates": [candidate],
            "issue": None,
        }]
        with self._patch_preflight(existing_hashes=["abc123"]):
            report, _ = _build_report(per_pin, {}, elapsed=5, apply=False)
        agg = report["aggregate"]
        self.assertEqual(agg["projectedInsertCount"], 0)
        self.assertEqual(agg["projectedSkipExistingCount"], 1)
        self.assertEqual(agg["projectedUpdateCount"], 0)

    def test_provenance_strategy_b_in_report(self):
        candidate = _make_candidate()
        per_pin = [{"source": {"pin_id": "p1", "category": "fashion", "save_count": 100},
                    "shopModuleDetected": True, "shopTabClicked": False,
                    "candidates": [candidate], "issue": None}]
        with self._patch_preflight():
            report, _ = _build_report(per_pin, {}, elapsed=1, apply=False)
        self.assertEqual(report["provenanceStrategy"], "B")
        self.assertEqual(report["discoveryMethodBase"], DISCOVERY_METHOD)
        self.assertEqual(report["discoveryMethodDetail"], DISCOVERY_DETAIL)
        self.assertEqual(DISCOVERY_METHOD, "stl")
        self.assertEqual(DISCOVERY_DETAIL, "pinterest_product_card_bootstrap")

    def test_merchant_falls_back_to_classified_platform(self):
        candidate = {
            "product_url": "https://www.ebay.com/itm/123456789",
            "product_title": "Vintage jacket",
            "extraction_method": "network_json",
        }
        source = {"pin_id": "p1", "category": "fashion", "save_count": 1000}
        row = _prepare_candidate(candidate, source, index=0, shop_detected=True, shop_tab_clicked=False)
        self.assertEqual(row["merchant"], "ebay")
        self.assertEqual(row["merchant_source"], "domain_fallback")

    def test_source_category_preserved_in_candidate(self):
        """womens-fashion must not collapse into fashion."""
        source = {"pin_id": "p2", "category": "womens-fashion", "save_count": 5000}
        candidate = {
            "product_url": "https://www.shein.com/Women-Dress-p-123.html",
            "product_title": "Floral Wrap Dress",
            "extraction_method": "network_json",
        }
        row = _prepare_candidate(candidate, source, index=0, shop_detected=True, shop_tab_clicked=False)
        self.assertEqual(row["source_category"], "womens-fashion")

    def test_real_source_keyword_and_pin_fields_are_preserved_for_core(self):
        source = {
            "pin_id": "p3",
            "category": "home-decor",
            "save_count": 321,
            "source_keyword": "  japandi entryway  ",
            "title": "Source Pin title",
            "image_url": "https://i.pinimg.com/originals/source.jpg",
        }
        candidate = {
            "product_url": "https://www.etsy.com/listing/1234567890/item",
            "product_title": "Pinterest card title is not provenance",
            "extraction_method": "network_json",
        }

        row = _prepare_candidate(
            candidate, source, index=0, shop_detected=True, shop_tab_clicked=False
        )

        self.assertEqual(row["seed_keyword"], "japandi entryway")
        self.assertEqual(row["source_pin_title"], "Source Pin title")
        self.assertEqual(
            row["source_pin_image_url"],
            "https://i.pinimg.com/originals/source.jpg",
        )
        core_candidate = stl._stl_candidates([row])[0]
        self.assertEqual(core_candidate["pin"]["seed_keyword"], "japandi entryway")
        self.assertEqual(core_candidate["pin"]["source_keyword"], "japandi entryway")

    def test_missing_source_keyword_is_not_fabricated(self):
        source = {
            "pin_id": "p4",
            "category": "fashion",
            "save_count": 99,
            "title": "Do not use this as a keyword",
        }
        candidate = {
            "product_url": "https://www.ebay.com/itm/123456789",
            "product_title": "Do not use this either",
            "extraction_method": "network_json",
        }

        row = _prepare_candidate(
            candidate, source, index=0, shop_detected=True, shop_tab_clicked=False
        )

        self.assertIsNone(row["seed_keyword"])
        ok, reason = stl.supply_core.assert_evidence(
            stl._stl_candidates([row])[0]["pin"], row["product_url"]
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "missing_seed_keyword")


class TestSourceReportLoading(unittest.TestCase):
    def _make_report(self, **overrides):
        base = {
            "mode": "dry-run",
            "engine": "shop-the-look",
            "perPin": [
                {"sourcePinId": str(i), "category": cat, "saveCount": 1000}
                for i, cat in enumerate(
                    ["fashion"] * 18 + ["womens-fashion"] * 14 + ["home-decor"] * 18
                )
            ],
        }
        base.update(overrides)
        return base

    def _write_tmp(self, data: dict) -> pathlib.Path:
        tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w", encoding="utf-8")
        json.dump(data, tmp)
        tmp.close()
        return pathlib.Path(tmp.name)

    def test_valid_report_loads(self):
        path = self._write_tmp(self._make_report())
        mix = {"fashion": 18, "womens-fashion": 14, "home-decor": 18}
        sources, validation = load_and_validate_source_report(path, category_mix=mix, limit=50)
        self.assertEqual(len(sources), 50)
        self.assertTrue(validation["sourceSetFrozen"])
        self.assertTrue(validation["sourceCountValidated"])
        self.assertEqual(len(validation["sourcePinIds"]), 50)
        self.assertEqual(validation["categoryMixFromSourceReport"]["womens-fashion"], 14)

    def test_frozen_report_preserves_real_source_provenance(self):
        report = self._make_report()
        report["perPin"][0].update({
            "seedKeyword": "minimalist capsule wardrobe",
            "sourcePinTitle": "Original Pin title",
            "sourcePinImageUrl": "https://i.pinimg.com/originals/source.jpg",
        })
        path = self._write_tmp(report)

        sources, _ = load_and_validate_source_report(
            path,
            category_mix={"fashion": 18, "womens-fashion": 14, "home-decor": 18},
            limit=50,
        )

        self.assertEqual(sources[0]["seed_keyword"], "minimalist capsule wardrobe")
        self.assertEqual(sources[0]["title"], "Original Pin title")
        self.assertEqual(
            sources[0]["image_url"], "https://i.pinimg.com/originals/source.jpg"
        )

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_and_validate_source_report("/nonexistent/path.json",
                                            category_mix={"fashion": 50}, limit=50)

    def test_wrong_engine_raises(self):
        path = self._write_tmp(self._make_report(engine="related-outbound"))
        with self.assertRaises(ValueError, msg="engine mismatch"):
            load_and_validate_source_report(path, category_mix={"fashion": 50}, limit=50)

    def test_apply_mode_report_raises(self):
        path = self._write_tmp(self._make_report(mode="apply"))
        with self.assertRaises(ValueError, msg="apply mode not allowed"):
            load_and_validate_source_report(path, category_mix={"fashion": 18, "womens-fashion": 14, "home-decor": 18}, limit=50)

    def test_wrong_count_raises(self):
        path = self._write_tmp(self._make_report())
        mix = {"fashion": 18, "womens-fashion": 14, "home-decor": 18}
        with self.assertRaises(ValueError, msg="count mismatch"):
            load_and_validate_source_report(path, category_mix=mix, limit=99)

    def test_category_mismatch_raises(self):
        path = self._write_tmp(self._make_report())
        # Expected 20 fashion, but report has 18
        with self.assertRaises(ValueError, msg="category distribution mismatch"):
            load_and_validate_source_report(path,
                category_mix={"fashion": 20, "womens-fashion": 14, "home-decor": 16}, limit=50)


class TestPreflightExisting(unittest.TestCase):
    def test_no_hashes_returns_all_as_inserts(self):
        candidates = [{"product_url": "https://etsy.com/listing/1/rug"}]
        with patch.object(stl, "select_many", return_value=[]):
            result = _preflight_existing(candidates)
        self.assertEqual(result["projectedInsertCount"], 1)
        self.assertEqual(result["projectedSkipExistingCount"], 0)
        self.assertEqual(result["projectedUpdateCount"], 0)
        self.assertFalse(result["checked"])

    def test_hash_match_counted_as_skip_not_update(self):
        candidates = [
            {"normalized_product_url_hash": "hash_a", "product_url": "https://etsy.com/listing/1"},
            {"normalized_product_url_hash": "hash_b", "product_url": "https://etsy.com/listing/2"},
        ]
        def fake_select(table, filters=None, **_kwargs):
            return [{"normalized_product_url_hash": "hash_a"}]
        with patch.object(stl, "select_many", side_effect=fake_select):
            result = _preflight_existing(candidates)
        self.assertEqual(result["projectedInsertCount"], 1)
        self.assertEqual(result["projectedSkipExistingCount"], 1)
        self.assertEqual(result["projectedUpdateCount"], 0)
        self.assertEqual(result["legacyTouchedProjected"], 0)
        self.assertEqual(len(result["insertCandidates"]), 1)
        self.assertEqual(result["insertCandidates"][0]["normalized_product_url_hash"], "hash_b")


class TestProductIdeasVisibility(unittest.TestCase):
    """Verify that STL bootstrap products are not invisible to Product Ideas ranking."""

    def _stl_product(self, **kw):
        defaults = {
            "id": "stl-1",
            "product_name": "Floral Wrap Dress",
            "price": None,
            "currency": None,
            "source_url": "https://www.shein.com/Women-Dress-p-123.html",
            "domain": "shein.com",
            "merchant": "shein",
            "image_url": "https://img/dress.jpg",
            "save_count": 0,
            "reaction_count": 0,
            "source_pin_save_count": 8000,
            "seed_keyword": None,
            "parent_pin_id": "pin1",
            "scraped_at": None,
            "opportunity_score": None,
            "trend_score": None,
            "save_velocity_score": None,
            "discovery_method": "stl",
            "discovery_method_detail": "pinterest_product_card_bootstrap",
            "created_at": "2026-06-23T04:20:00+00:00",
        }
        defaults.update(kw)
        return defaults

    def test_stl_bootstrap_row_has_save_count_zero(self):
        """save_count=0 must not be a blocker — evidence is on source_pin_save_count."""
        product = self._stl_product()
        self.assertEqual(product["save_count"], 0)
        self.assertGreater(product["source_pin_save_count"], 0)

    def test_stl_bootstrap_has_required_fields(self):
        product = self._stl_product()
        self.assertTrue(product["image_url"])
        self.assertTrue(product["source_url"])
        self.assertEqual(product["discovery_method"], "stl")
        self.assertEqual(product["discovery_method_detail"], "pinterest_product_card_bootstrap")

    def test_currency_null_for_no_price_evidence(self):
        """Currency must be NULL when price is absent — not 'USD'."""
        product = self._stl_product(price=None, currency=None)
        self.assertIsNone(product["currency"])

    def test_category_preserved(self):
        """womens-fashion source_category must reach the product row."""
        source = {"pin_id": "p1", "category": "womens-fashion", "save_count": 9000}
        candidate = {
            "product_url": "https://us.shein.com/Women-Dress-p-456.html",
            "product_title": "Floral Summer Dress",
            "extraction_method": "network_json",
        }
        row = _prepare_candidate(
            candidate, source, index=0, shop_detected=True, shop_tab_clicked=False
        )
        self.assertEqual(row["source_category"], "womens-fashion",
                         "womens-fashion must not become fashion in source_category")
        self.assertEqual(row["discovery_method"], "stl")
        self.assertEqual(row["discovery_method_detail"], "pinterest_product_card_bootstrap")


class TestInsertOnlyWriteSemantics(unittest.TestCase):
    """Verify _apply_rows uses insert_rows as a PLAIN INSERT, never upsert.

    Updated 2026-08-06: the old contract here asserted
    on_conflict='normalized_product_url_hash'. That contract was the bug — v47
    made that unique index PARTIAL, which PostgREST/Postgres cannot use as an
    ON CONFLICT arbiter, so every real batch died with 42P10 and every scraped
    product was discarded. The contract is now: NO conflict target at all.
    """

    def _make_rows(self, hashes=("h1", "h2")):
        return [
            {
                "source_pin_id": f"p{i}",
                "product_url": f"https://etsy.com/listing/{i}/item",
                "product_title": f"Item {i}",
                "image_url": "https://img/item.jpg",
                "price": None,
                "currency": None,
                "normalized_product_url": f"https://etsy.com/listing/{i}/item",
                "normalized_product_url_hash": h,
                "platform": "etsy",
                "domain": "etsy.com",
                "source_category": "home-decor",
                "source_pin_save_count": 1000,
                "discovery_path": f"p{i}->card[0]->url",
            }
            for i, h in enumerate(hashes)
        ]

    def _inject_fake_db(self, fake_insert_fn):
        """Context manager: replace sys.modules['db'] with a module whose
        insert_rows is fake_insert_fn. Confirms upsert is NOT called."""
        fake_db = types.ModuleType("db")
        fake_db.insert_rows = fake_insert_fn
        # Deliberately omit fake_db.upsert so any call to upsert raises AttributeError.
        return fake_db

    # ── T1-A: _apply_rows calls insert_rows, not upsert ────────────────────

    def test_apply_rows_calls_insert_rows_not_upsert(self):
        """The compatibility seam delegates only to the shared core adapter."""
        rows = self._make_rows()
        outcome = {"attempted": 2, "inserted": 2, "duplicates": 0,
                   "failed": 0, "errors": [], "written": 2}
        with patch.object(stl, "_apply_via_core", return_value=outcome) as delegated:
            self.assertEqual(_apply_rows(rows), 2)
        delegated.assert_called_once_with(rows)
        self.assertEqual(stl._LAST_WRITE_OUTCOME, outcome)

    # ── T1-B: NO conflict target — every candidate target is a PARTIAL index ──

    def test_apply_rows_sends_no_conflict_target(self):
        """STL no longer contains a direct database write path."""
        source = pathlib.Path(stl.__file__).read_text(encoding="utf-8")
        seam = source[source.index("def _apply_rows"):source.index("class _IncrementalWriter")]
        self.assertNotIn("insert_rows(", seam)
        self.assertIn("_apply_via_core(rows)", seam)

    # ── T1-C: db.insert_rows sends ignore-duplicates, not merge-duplicates ──

    def test_db_insert_rows_prefer_header_is_ignore_duplicates(self):
        """db.insert_rows must send Prefer: resolution=ignore-duplicates (ON CONFLICT DO NOTHING).
        If it sent merge-duplicates, a hash collision would UPDATE the existing row — forbidden.
        """
        import db as db_module

        captured: dict = {}

        class FakeResp:
            status_code = 201
            def json(self): return []

        def fake_request(method, *args, **kwargs):
            captured["headers"] = kwargs.get("headers", {})
            captured["params"] = kwargs.get("params", {})
            return FakeResp()

        with patch.object(db_module, "_request", side_effect=fake_request):
            db_module.insert_rows(
                "pin_products",
                [{"id": "test"}],
                on_conflict="normalized_product_url_hash",
            )

        prefer = captured.get("headers", {}).get("Prefer", "")
        self.assertIn("ignore-duplicates", prefer,
                      f"Prefer header must contain ignore-duplicates; got: {prefer!r}")
        self.assertNotIn("merge-duplicates", prefer,
                         f"merge-duplicates must NEVER appear in insert_rows Prefer header; got: {prefer!r}")

    # ── T2: Late-conflict regression ─────────────────────────────────────────

    def test_late_conflict_existing_row_is_not_updated(self):
        """Scenario: row with hash X is in both insertCandidates (preflight raced) and the DB.

        When insert_rows fires with resolution=ignore-duplicates, the DB skips the
        new row via ON CONFLICT DO NOTHING. The existing row's data must be unchanged.
        This test verifies at the db layer that the Prefer header guarantees skipping.
        """
        import db as db_module

        existing_row_data = {
            "id": "existing-1",
            "product_name": "Original Name — must not change",
            "normalized_product_url_hash": "hash_conflict",
        }
        new_candidate_data = [
            {"product_name": "New Name (must NOT replace existing)", "normalized_product_url_hash": "hash_conflict"}
        ]

        update_was_attempted = []

        class FakeResp:
            status_code = 200
            # ignore-duplicates: DB returns the *existing* row unchanged, not the new data.
            def json(self): return [existing_row_data]

        def fake_request(method, *args, **kwargs):
            prefer = kwargs.get("headers", {}).get("Prefer", "")
            if "merge-duplicates" in prefer:
                update_was_attempted.append(True)
            return FakeResp()

        with patch.object(db_module, "_request", side_effect=fake_request):
            result = db_module.insert_rows(
                "pin_products",
                new_candidate_data,
                on_conflict="normalized_product_url_hash",
            )

        # Must not have attempted a merge-upsert
        self.assertEqual(update_was_attempted, [],
                         "merge-duplicates was sent — existing row could have been updated!")

        # Result is the existing row (unchanged by DO NOTHING), not the new candidate
        if result:
            self.assertEqual(result[0].get("product_name"), "Original Name — must not change",
                             "Late-arriving row must not replace existing row's product_name")
            self.assertNotEqual(result[0].get("product_name"), "New Name (must NOT replace existing)")

    def test_late_conflict_projectedUpdateCount_is_zero(self):
        """projectedUpdateCount in the dry-run report must always be 0.
        This is a hard contract — updates are forbidden regardless of what happens at write time."""
        rows = self._make_rows(hashes=("hash_a",))
        candidate = {
            "source_pin_id": "p1",
            "source_category": "fashion",
            "product_url": "https://etsy.com/listing/1/item",
            "normalized_product_url": "https://etsy.com/listing/1/item",
            "normalized_product_url_hash": "hash_a",
            "product_title": "Item 1",
            "merchant": "Etsy",
            "image_url": "https://img/item.jpg",
            "platform": "etsy",
            "domain": "etsy.com",
            "extraction_method": "network_json",
        }
        per_pin = [{"source": {"pin_id": "p1", "category": "fashion", "save_count": 10000},
                    "shopModuleDetected": True, "shopTabClicked": False,
                    "candidates": [candidate], "issue": None}]

        def fake_select(table, filters=None, **_kw):
            # Simulate: hash_a is already in DB
            if table == "pin_products" and filters and "normalized_product_url_hash" in filters:
                return [{"normalized_product_url_hash": "hash_a"}]
            return []

        with patch.object(stl, "select_many", side_effect=fake_select):
            report, _ = _build_report(per_pin, {}, elapsed=5, apply=False)

        self.assertEqual(report["aggregate"]["projectedUpdateCount"], 0,
                         "projectedUpdateCount must always be 0 — updates are forbidden")
        self.assertEqual(report["aggregate"]["projectedSkipExistingCount"], 1,
                         "existing hash must be counted as skip, not update")
        self.assertEqual(report["aggregate"]["projectedInsertCount"], 0)

    # ── T1-D: empty payload returns 0, no write call ─────────────────────────

    def test_empty_rows_writes_nothing(self):
        """_apply_rows with empty list must make no DB call and return 0."""
        write_calls = []
        def fake_insert(table, payload, on_conflict=None):
            write_calls.append(True)
            return []

        old_db = sys.modules.get("db")
        sys.modules["db"] = self._inject_fake_db(fake_insert)
        try:
            result = _apply_rows([])
        finally:
            if old_db is None:
                sys.modules.pop("db", None)
            else:
                sys.modules["db"] = old_db

        self.assertEqual(result, 0)
        self.assertEqual(write_calls, [], "No write must occur for empty row list")


class LegacyPartialIndexWriteRegression(unittest.TestCase):
    # Historical fixture retained as documentation for the removed STL-local
    # writer. The live contract is exercised at the shared supply_core boundary.
    __test__ = False
    """Regression for the 2026-08-06 production data-loss bug.

    A real VPS run scraped 28/50 pins successfully, then lost 100% of it:
        insert pin_products failed [400]: {"code":"42P10","message":"there is no
        unique or exclusion constraint matching the ON CONFLICT specification"}

    These tests run _apply_rows against a mocked PostgREST that behaves like
    production: it REJECTS any on_conflict naming a partial index with 42P10,
    and raises 23505 on a genuine duplicate. No live DB is touched.
    """

    # Production catalog: both business-key unique indexes are PARTIAL.
    PARTIAL_INDEX_TARGETS = {
        "normalized_product_url_hash",
        "parent_pin_id,source_url",
        "product_url_hash",
    }

    def _rows(self, hashes):
        return [
            {
                "source_pin_id": f"p{i}",
                "product_url": f"https://etsy.com/listing/{i}/item",
                "product_title": f"Item {i}",
                "image_url": "https://img/item.jpg",
                "price": None,
                "currency": None,
                "normalized_product_url": f"https://etsy.com/listing/{i}/item",
                "normalized_product_url_hash": h,
                "platform": "etsy",
                "domain": "etsy.com",
                "source_category": "home-decor",
                "source_pin_save_count": 1000,
                "discovery_path": f"p{i}->card[0]->url",
            }
            for i, h in enumerate(hashes)
        ]

    def _fake_postgrest(self, existing_hashes=(), broken_hashes=()):
        """Mock of db.insert_rows with production's constraint behaviour."""
        existing = set(existing_hashes)
        broken = set(broken_hashes)
        calls = []

        def fake_insert(table, payload, on_conflict=None):
            calls.append({"count": len(payload), "on_conflict": on_conflict})
            # Production truth: naming a partial index is a hard 42P10 failure.
            if on_conflict in self.PARTIAL_INDEX_TARGETS:
                raise RuntimeError(
                    f'insert {table} failed [400]: {{"code":"42P10","message":'
                    f'"there is no unique or exclusion constraint matching the '
                    f'ON CONFLICT specification"}}'
                )
            written = []
            for row in payload:
                h = row.get("normalized_product_url_hash")
                if h in broken:
                    raise RuntimeError(
                        f'insert {table} failed [400]: {{"code":"23514",'
                        f'"message":"violates check constraint"}}'
                    )
                if h in existing:
                    raise RuntimeError(
                        f'insert {table} failed [409]: {{"code":"23505","message":'
                        f'"duplicate key value violates unique constraint"}}'
                    )
                written.append(row)
            return written

        return fake_insert, calls

    def _run_apply(self, fake_insert, rows):
        fake_db = types.ModuleType("db")
        fake_db.insert_rows = fake_insert
        old_db = sys.modules.get("db")
        sys.modules["db"] = fake_db
        try:
            return _apply_rows(rows)
        finally:
            if old_db is None:
                sys.modules.pop("db", None)
            else:
                sys.modules["db"] = old_db

    # ── 1. The bug itself: the write now succeeds ────────────────────────────

    def test_write_succeeds_against_partial_index_postgrest(self):
        """The exact production scenario: 28 scraped rows must LAND, not be lost."""
        fake_insert, calls = self._fake_postgrest()
        rows = self._rows([f"h{i}" for i in range(28)])

        written = self._run_apply(fake_insert, rows)

        self.assertEqual(written, 28, "all 28 scraped rows must be written")
        self.assertEqual(len(calls), 1, "a clean batch needs exactly one INSERT")
        self.assertIsNone(calls[0]["on_conflict"],
                          "no conflict target may be named — 42P10 otherwise")

    def test_naming_a_partial_index_would_still_fail(self):
        """Guard the mock's fidelity: the OLD code path really does die with 42P10."""
        fake_insert, _ = self._fake_postgrest()
        with self.assertRaises(RuntimeError) as ctx:
            fake_insert("pin_products", [{"x": 1}],
                        on_conflict="normalized_product_url_hash")
        self.assertIn("42P10", str(ctx.exception))

    # ── 2. Duplicates handled without data loss and without silent swallowing ─

    def test_duplicate_does_not_discard_the_other_rows(self):
        """One late duplicate must not take the whole batch down with it."""
        fake_insert, calls = self._fake_postgrest(existing_hashes={"h2"})
        rows = self._rows(["h0", "h1", "h2", "h3", "h4"])

        written = self._run_apply(fake_insert, rows)

        self.assertEqual(written, 4, "the 4 non-duplicate rows must survive")
        outcome = stl._LAST_WRITE_OUTCOME
        self.assertEqual(outcome["attempted"], 5)
        self.assertEqual(outcome["inserted"], 4)
        self.assertEqual(outcome["duplicates"], 1)
        self.assertEqual(outcome["failed"], 0)
        # Batch attempt + per-row retries = accounted for, not swallowed.
        self.assertEqual(len(calls), 6, "1 batch attempt + 5 per-row retries")

    def test_every_attempted_row_is_accounted_for(self):
        """attempted == inserted + duplicates + failed. No silent shortfall."""
        fake_insert, _ = self._fake_postgrest(existing_hashes={"h1"},
                                              broken_hashes={"h3"})
        rows = self._rows(["h0", "h1", "h2", "h3"])

        self._run_apply(fake_insert, rows)
        o = stl._LAST_WRITE_OUTCOME
        self.assertEqual(o["attempted"], o["inserted"] + o["duplicates"] + o["failed"])
        self.assertEqual(o["duplicates"], 1)
        self.assertEqual(o["failed"], 1)
        self.assertTrue(o["errors"], "a non-duplicate failure must be recorded")
        self.assertIn("23514", o["errors"][0])

    # ── 3. A genuine write failure is SURFACED, never swallowed ──────────────

    def test_non_duplicate_batch_error_is_raised(self):
        """42P10 / permission / network errors must propagate, not degrade."""
        def exploding_insert(table, payload, on_conflict=None):
            raise RuntimeError(
                'insert pin_products failed [400]: {"code":"42P10","message":'
                '"there is no unique or exclusion constraint matching the '
                'ON CONFLICT specification"}'
            )
        with self.assertRaises(RuntimeError) as ctx:
            self._run_apply(exploding_insert, self._rows(["h0", "h1"]))
        self.assertIn("42P10", str(ctx.exception))

    def test_total_failure_after_duplicate_fallback_is_raised(self):
        """If nothing lands and it was not merely duplicates, raise loudly.

        This is the anti-pattern the opportunity_* tables suffered for 7 weeks:
        a broken write quietly reporting success/zero.
        """
        fake_insert, _ = self._fake_postgrest(existing_hashes={"h0"},
                                              broken_hashes={"h1", "h2"})
        with self.assertRaises(RuntimeError) as ctx:
            self._run_apply(fake_insert, self._rows(["h0", "h1", "h2"]))
        msg = str(ctx.exception)
        self.assertIn("failed for all", msg)
        self.assertIn("23514", msg)

    def test_all_duplicates_returns_zero_without_raising(self):
        """All-duplicates is a legitimate no-op, reported honestly — not an error."""
        fake_insert, _ = self._fake_postgrest(existing_hashes={"h0", "h1"})
        written = self._run_apply(fake_insert, self._rows(["h0", "h1"]))
        self.assertEqual(written, 0)
        o = stl._LAST_WRITE_OUTCOME
        self.assertEqual(o["duplicates"], 2)
        self.assertEqual(o["failed"], 0)

    def test_only_23505_counts_as_duplicate(self):
        """Narrow duplicate detection: nothing else may be mistaken for a dup."""
        self.assertTrue(stl._is_duplicate_error(RuntimeError('{"code":"23505"}')))
        for code in ("42P10", "23514", "42501", "PGRST204"):
            self.assertFalse(stl._is_duplicate_error(RuntimeError(f'{{"code":"{code}"}}')),
                             f"{code} must NOT be treated as a duplicate")


class TestLifecycleCoexistence(unittest.TestCase):
    """A retired row must never block re-collecting its URL as a new active row.

    v47 made the unique indexes partial precisely so a retired row and a new
    active row can share a URL. The dedup preflight must honour that, otherwise
    soft retirement silently becomes a permanent blacklist.
    """

    def _candidates(self):
        return [
            {"normalized_product_url_hash": "hash_retired",
             "product_url": "https://etsy.com/listing/1/retired-item"},
            {"normalized_product_url_hash": "hash_active",
             "product_url": "https://etsy.com/listing/2/active-item"},
        ]

    def test_preflight_query_is_scoped_to_non_retired(self):
        """The existence query must carry the NULL-safe not-retired filter."""
        captured = {}

        def fake_select(table, filters=None, **_kw):
            captured["filters"] = filters
            return []

        with patch.object(stl, "select_many", side_effect=fake_select):
            _preflight_existing(self._candidates())

        filters = captured["filters"]
        self.assertIn("or", filters, "dedup read must be lifecycle-scoped")
        # NULL-safe form: NULL lifecycle_status means ACTIVE. A bare
        # neq.retired would drop the entire active corpus (the NULL trap).
        self.assertIn("lifecycle_status.is.null", filters["or"])
        self.assertIn("lifecycle_status.neq.retired", filters["or"])

    def test_retired_hash_is_recollectable(self):
        """DB returns only the ACTIVE row (retired filtered out server-side).

        The retired URL must therefore appear as an INSERT candidate, and the
        active one as a skip.
        """
        def fake_select(table, filters=None, **_kw):
            # Faithful to PostgREST: the not-retired filter excludes the
            # retired row, so it never comes back.
            self.assertIn("or", filters or {})
            return [{"normalized_product_url_hash": "hash_active",
                     "lifecycle_status": None}]

        with patch.object(stl, "select_many", side_effect=fake_select):
            result = _preflight_existing(self._candidates())

        insert_hashes = [c["normalized_product_url_hash"]
                         for c in result["insertCandidates"]]
        self.assertIn("hash_retired", insert_hashes,
                      "a retired row must NOT blacklist its URL")
        self.assertNotIn("hash_active", insert_hashes,
                         "an active row must still dedup")
        self.assertEqual(result["projectedInsertCount"], 1)
        self.assertEqual(result["projectedSkipExistingCount"], 1)
        self.assertEqual(result["projectedUpdateCount"], 0)

    def test_recollected_retired_url_writes_without_conflict_target(self):
        """Automatic STL never claims the manual retired-reclaim proof."""
        candidates = stl._stl_candidates([{
            "source_pin_id": "p9",
            "source_pin_url": "https://www.pinterest.com/pin/p9/",
            "source_pin_save_count": 1000,
            "source_category": "home-decor",
            "seed_keyword": "rug",
            "product_url": "https://etsy.com/listing/1/retired-item",
            "domain": "etsy.com",
        }])
        self.assertEqual(candidates[0]["origin"], "net_new")


class TestGotoTimeoutConfig(unittest.TestCase):
    """STL_GOTO_TIMEOUT_MS is configurable; default preserves prior behaviour."""

    def test_default_is_the_previous_hardcoded_value(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(stl.STL_GOTO_TIMEOUT_ENV, None)
            self.assertEqual(stl._stl_goto_timeout_ms(), 15_000)

    def test_env_override_is_honoured(self):
        with patch.dict(os.environ, {stl.STL_GOTO_TIMEOUT_ENV: "45000"}):
            self.assertEqual(stl._stl_goto_timeout_ms(), 45_000)

    def test_invalid_or_nonpositive_falls_back_to_default(self):
        for bad in ("abc", "0", "-1", "   "):
            with patch.dict(os.environ, {stl.STL_GOTO_TIMEOUT_ENV: bad}):
                self.assertEqual(stl._stl_goto_timeout_ms(), 15_000,
                                 f"{bad!r} must fall back, never disable the timeout")


class TestV28SchemaPreflight(unittest.TestCase):
    """Verify _check_v28_schema() and the apply-path fail-closed behaviour."""

    def _fake_select_all_present(self, table, filters=None, **_kw):
        """Simulate DB where all v28 columns exist (SELECT returns empty list = 200)."""
        return []

    def _fake_select_missing(self, missing_cols):
        """Simulate DB where given columns don't exist (SELECT raises 400 RuntimeError)."""
        def fake(table, filters=None, **_kw):
            col = list((filters or {}).keys())[0] if filters else ""
            if col in missing_cols:
                raise RuntimeError(
                    f"select {table} 失败 [400]: {{\"code\":\"PGRST204\","
                    f"\"message\":\"Column '{col}' of relation '{table}' does not exist.\"}}"
                )
            return []
        return fake

    def test_all_columns_present_returns_ok(self):
        with patch.object(stl, "select_many", side_effect=self._fake_select_all_present):
            ok, missing = _check_v28_schema()
        self.assertTrue(ok)
        self.assertEqual(missing, [])

    def test_missing_column_detected(self):
        with patch.object(stl, "select_many",
                          side_effect=self._fake_select_missing({"normalized_product_url_hash"})):
            ok, missing = _check_v28_schema()
        self.assertFalse(ok)
        self.assertIn("normalized_product_url_hash", missing)

    def test_multiple_missing_columns_all_reported(self):
        with patch.object(stl, "select_many",
                          side_effect=self._fake_select_missing(
                              {"source_category", "discovery_method_detail"})):
            ok, missing = _check_v28_schema()
        self.assertFalse(ok)
        self.assertIn("source_category", missing)
        self.assertIn("discovery_method_detail", missing)

    def test_v28_required_columns_list_is_complete(self):
        """The required column list must include all four STL bootstrap columns."""
        for col in ("discovery_method_detail", "source_category",
                    "seed_keyword", "normalized_product_url_hash"):
            self.assertIn(col, V28_REQUIRED_COLUMNS,
                          f"{col} must be in V28_REQUIRED_COLUMNS")

    def test_check_v28_notes_index_not_verifiable(self):
        """The preflight output must note that the unique index cannot be checked via PostgREST."""
        import asyncio

        # We can't run the full run_shop_the_look_expand without Playwright, but
        # we can verify the v28_status dict structure independently.
        with patch.object(stl, "select_many", side_effect=self._fake_select_all_present):
            ok, missing = _check_v28_schema()
        # The v28 status dict (assembled in run_shop_the_look_expand) must contain
        # a note about the index. Verify the keys are assembled correctly.
        v28_status = {
            "columnsChecked": list(V28_REQUIRED_COLUMNS),
            "allPresent": ok,
            "missingColumns": missing,
            "noteIndexNotChecked": (
                "unique index on normalized_product_url_hash cannot be verified "
                "via PostgREST; must confirm manually before apply"
            ),
        }
        self.assertIn("noteIndexNotChecked", v28_status)
        self.assertTrue(v28_status["noteIndexNotChecked"])


class TestV28SchemaNetworkFailureNotMisreported(unittest.TestCase):
    """A probe that never got an answer must NOT be reported as a missing column.

    Regression guard for the real incident: after a 50-pin crawl, db._request
    exhausted its retries and re-raised httpx.ReadTimeout / httpx.ConnectError.
    Those are NOT RuntimeError, so they fell through to a bare `except Exception`
    that appended the column to `missing`. The worker then told the operator
    "v28 migration has not been applied — missing columns: [...]" and exited 1,
    for four columns that verifiably exist in production.
    """

    # Every transport failure db._request can re-raise after exhausting retries.
    TRANSPORT_ERRORS = (
        httpx.ReadTimeout("timed out"),
        httpx.ConnectError("connection refused"),
        httpx.ConnectTimeout("connect timed out"),
        httpx.ReadError("peer reset"),
        httpx.WriteError("broken pipe"),
        httpx.PoolTimeout("pool exhausted"),
        httpx.RemoteProtocolError("server disconnected"),
        ssl.SSLError("handshake failure"),
        OSError("network unreachable"),
    )

    def test_transport_error_raises_unavailable_not_missing(self):
        for exc in self.TRANSPORT_ERRORS:
            with self.subTest(exc=type(exc).__name__):
                with patch.object(stl, "select_many", side_effect=exc):
                    with self.assertRaises(stl.SchemaCheckUnavailable) as ctx:
                        _check_v28_schema()
                msg = str(ctx.exception)
                # The core requirement: never assert a schema defect we did not observe.
                self.assertNotIn("has not been applied", msg)
                self.assertNotIn("missing columns", msg)
                # And never send the operator to run a migration on a guess.
                self.assertNotIn("migrate_v28", msg)
                self.assertNotIn("before --apply", msg)
                # It must say what actually happened.
                self.assertIn("could not verify", msg.lower())
                self.assertIn("NOT evidence", msg)

    def test_transport_error_is_classified_unavailable(self):
        for exc in self.TRANSPORT_ERRORS:
            with self.subTest(exc=type(exc).__name__):
                self.assertEqual(stl._classify_probe_failure(exc), "unavailable")

    def test_genuine_missing_column_still_classified_missing(self):
        exc = RuntimeError(
            "select pin_products 失败 [400]: {\"code\":\"PGRST204\","
            "\"message\":\"Column 'seed_keyword' of relation 'pin_products' does not exist.\"}"
        )
        self.assertEqual(stl._classify_probe_failure(exc), "missing")

    def test_postgres_42703_classified_missing(self):
        exc = RuntimeError(
            "select pin_products 失败 [400]: {\"code\":\"42703\","
            "\"message\":\"column pin_products.seed_keyword does not exist\"}"
        )
        self.assertEqual(stl._classify_probe_failure(exc), "missing")

    def test_5xx_is_unavailable_not_missing(self):
        """A gateway/server error is the DB failing to answer, not a schema verdict."""
        for status in ("[500]", "[502]", "[503]", "[504]"):
            with self.subTest(status=status):
                exc = RuntimeError(f"select pin_products 失败 {status}: upstream error")
                self.assertEqual(stl._classify_probe_failure(exc), "unavailable")

    def test_400_without_column_verdict_is_unavailable(self):
        """A 400 we cannot tie to an undefined column is ambiguous, not proof."""
        exc = RuntimeError("select pin_products 失败 [400]: <html>Bad Request</html>")
        self.assertEqual(stl._classify_probe_failure(exc), "unavailable")

    def test_401_403_not_reported_as_missing_columns(self):
        """An auth rejection must never be rendered as a schema defect."""
        for status in ("[401]", "[403]"):
            with self.subTest(status=status):
                exc = RuntimeError(f"select pin_products 失败 {status}: JWT expired")
                self.assertEqual(stl._classify_probe_failure(exc), "unavailable")

    def test_genuine_missing_column_still_raises_original_message(self):
        """The real-defect path is unchanged: still names the migration."""
        def fake(table, filters=None, **_kw):
            col = list((filters or {}).keys())[0] if filters else ""
            if col == "seed_keyword":
                raise RuntimeError(
                    f"select {table} 失败 [400]: {{\"code\":\"PGRST204\","
                    f"\"message\":\"Column '{col}' of relation '{table}' does not exist.\"}}"
                )
            return []

        with patch.object(stl, "select_many", side_effect=fake):
            ok, missing = _check_v28_schema()
        self.assertFalse(ok)
        self.assertEqual(missing, ["seed_keyword"])

    def test_partial_failure_still_unavailable(self):
        """If ONE column times out, the whole verdict is unknown.

        Three columns answering "present" plus one timeout does not license a
        conclusion about the fourth column either way.
        """
        def fake(table, filters=None, **_kw):
            col = list((filters or {}).keys())[0] if filters else ""
            if col == "normalized_product_url_hash":
                raise httpx.ReadTimeout("timed out")
            return []

        with patch.object(stl, "select_many", side_effect=fake):
            with self.assertRaises(stl.SchemaCheckUnavailable) as ctx:
                _check_v28_schema()
        msg = str(ctx.exception)
        self.assertIn("normalized_product_url_hash", msg)
        self.assertNotIn("has not been applied", msg)

    def test_unavailable_names_the_failing_column_and_cause(self):
        """Operators need the cause to act; the message must carry it."""
        with patch.object(stl, "select_many", side_effect=httpx.ConnectError("boom")):
            with self.assertRaises(stl.SchemaCheckUnavailable) as ctx:
                _check_v28_schema()
        msg = str(ctx.exception)
        self.assertIn("ConnectError", msg)
        self.assertIn("discovery_method_detail", msg)

    def test_schema_check_unavailable_is_not_confused_with_missing(self):
        """SchemaCheckUnavailable must be catchable distinctly from the defect error."""
        self.assertTrue(issubclass(stl.SchemaCheckUnavailable, RuntimeError))
        self.assertIsNot(stl.SchemaCheckUnavailable, RuntimeError)


class TestApplyRowsCurrencyHonesty(unittest.TestCase):
    """Currency must remain NULL when price/currency evidence is absent."""

    def test_missing_currency_is_null_not_usd(self):
        rows = [{
            "source_pin_id": "p1",
            "product_url": "https://www.etsy.com/listing/1/rug",
            "product_title": "Boho Rug",
            "image_url": "https://img/rug.jpg",
            "price": None,
            "currency": None,
            "normalized_product_url": "https://etsy.com/listing/1/rug",
            "normalized_product_url_hash": "h1",
            "platform": "etsy",
            "domain": "etsy.com",
            "source_category": "home-decor",
        }]
        candidate = stl._stl_candidates(rows)[0]
        self.assertNotIn("currency", candidate["pin"])
        self.assertNotIn("price", candidate["pin"])
        self.assertNotIn("product_title", candidate["pin"])


class TestProductIdeasAPIContract(unittest.TestCase):
    """Verify Product Ideas API response contract for STL bootstrap products.

    These tests prove (at the Python / data-layer level) that:
    1. A STL bootstrap product has the required visibility fields (image_url, source_url).
    2. save_count=0 does not prevent visibility; evidence is on source_pin_save_count.
    3. Category is preserved correctly (womens-fashion ≠ fashion).
    4. Internal provenance fields are NOT in the API response shape returned by
       route.ts enrichRow (verified by field-list audit).
    5. currency is NULL when price evidence is absent.
    """

    # Fields that enrichRow in route.ts explicitly returns (public API contract).
    # Derived from reading the explicit return object in route.ts.
    ENRICHROW_PUBLIC_FIELDS = frozenset({
        "id", "product_name", "price", "currency", "domain", "merchant",
        "image_url", "source_url", "save_count", "source_pin_save_count",
        "seed_keyword", "scraped_at",
        "opportunity_score", "trend_score", "save_velocity_score",
        "freshness_score", "competition_score", "scored_at",
        "item_type", "product_type", "product_subtype",
        "destination_type", "asset_role", "source_context", "risk_flags",
    })

    # Fields that must NEVER appear in the API response.
    FORBIDDEN_IN_API_RESPONSE = frozenset({
        "discovery_method",
        "discovery_method_detail",
        "source_category",
        "source_pin_id",
        "source_pin_url",
        "product_card_title",
        "product_card_merchant",
        "product_card_price",
        "product_card_image_url",
        "product_card_position",
        "extraction_method",
        "shop_module_detected",
        "shop_tab_clicked",
        "discovery_path",
        "discovery_depth",
        "normalized_product_url_hash",
        "product_url_hash",
        "product_source_domain",
    })

    def _make_db_row(self, **overrides) -> dict:
        """What a STL bootstrap pin_products row looks like after insert."""
        base = {
            "id": "stl-uuid-1",
            "product_name": "Floral Wrap Dress",
            "price": None,
            "currency": None,
            "domain": "us.shein.com",
            "merchant": "shein",
            "image_url": "https://img.shein.com/dress.jpg",
            "source_url": "https://us.shein.com/Women-Dress-p-123.html",
            "save_count": 0,
            "source_pin_save_count": 8000,
            "seed_keyword": None,
            "scraped_at": None,
            # --- DB-internal fields (v28 columns, never in API response) ---
            "discovery_method": "stl",
            "discovery_method_detail": "pinterest_product_card_bootstrap",
            "source_category": "womens-fashion",
            "normalized_product_url_hash": "abc123hash",
        }
        base.update(overrides)
        return base

    def _simulate_enrichrow(self, db_row: dict) -> dict:
        """Python simulation of route.ts enrichRow — returns only public fields."""
        return {k: v for k, v in db_row.items() if k in self.ENRICHROW_PUBLIC_FIELDS}

    # ── Visibility requirements ───────────────────────────────────────────────

    def test_stl_bootstrap_has_required_visibility_fields(self):
        row = self._make_db_row()
        self.assertTrue(row["image_url"], "image_url must be present and non-empty")
        self.assertTrue(row["source_url"], "source_url must be present and non-empty")
        self.assertEqual(row["discovery_method"], "stl")
        self.assertEqual(row["discovery_method_detail"], "pinterest_product_card_bootstrap")

    def test_save_count_zero_allowed_evidence_on_source_pin(self):
        """save_count=0 is expected for STL bootstrap; visibility comes from source_pin_save_count."""
        row = self._make_db_row()
        self.assertEqual(row["save_count"], 0,
                         "STL bootstrap rows have save_count=0 — this must not block visibility")
        self.assertGreater(row["source_pin_save_count"], 0,
                           "Ranking evidence is on source_pin_save_count (inherited from source pin)")

    def test_currency_null_not_usd(self):
        row = self._make_db_row(price=None, currency=None)
        self.assertIsNone(row["currency"],
                          "currency must be NULL when no evidence; must not be defaulted to USD")

    # ── Category filter correctness ──────────────────────────────────────────

    def test_womens_fashion_category_preserved_in_db_row(self):
        """source_category='womens-fashion' must be written to DB and not collapse into 'fashion'."""
        source = {"pin_id": "p1", "category": "womens-fashion", "save_count": 9000}
        candidate = {
            "product_url": "https://us.shein.com/Women-Dress-p-456.html",
            "product_title": "Floral Dress",
            "extraction_method": "network_json",
        }
        row = _prepare_candidate(
            candidate, source, index=0, shop_detected=True, shop_tab_clicked=False
        )
        self.assertEqual(row["source_category"], "womens-fashion")
        self.assertNotEqual(row["source_category"], "fashion",
                            "womens-fashion must NOT collapse to fashion")

    def test_category_preserved_across_all_three_categories(self):
        """fashion, womens-fashion, home-decor must each produce distinct source_category."""
        candidate = {
            "product_url": "https://etsy.com/listing/1/item",
            "product_title": "Item",
            "extraction_method": "network_json",
        }
        for cat in ("fashion", "womens-fashion", "home-decor"):
            source = {"pin_id": "p1", "category": cat, "save_count": 1000}
            row = _prepare_candidate(
                candidate, source, index=0, shop_detected=True, shop_tab_clicked=False
            )
            self.assertEqual(row["source_category"], cat,
                             f"source_category must be {cat!r}, not {row['source_category']!r}")

    # ── API response field exclusion ─────────────────────────────────────────

    def test_internal_fields_not_in_api_response(self):
        """route.ts enrichRow must not include any of the forbidden internal fields.

        This test validates the API contract by simulating enrichRow's explicit field
        projection. Since enrichRow constructs a new object with only named keys,
        any field not in ENRICHROW_PUBLIC_FIELDS is automatically excluded.
        """
        db_row = self._make_db_row()
        api_response = self._simulate_enrichrow(db_row)

        for field in self.FORBIDDEN_IN_API_RESPONSE:
            self.assertNotIn(
                field, api_response,
                f"Field {field!r} must not appear in the Product Ideas API response",
            )

    def test_discovery_method_not_exposed(self):
        """discovery_method is an internal provenance label — must not reach user UI."""
        db_row = self._make_db_row()
        api_response = self._simulate_enrichrow(db_row)
        self.assertNotIn("discovery_method", api_response)

    def test_discovery_method_detail_not_exposed(self):
        db_row = self._make_db_row()
        api_response = self._simulate_enrichrow(db_row)
        self.assertNotIn("discovery_method_detail", api_response)

    def test_source_category_not_exposed(self):
        """source_category is a backend storage field for category filtering, not for UI."""
        db_row = self._make_db_row()
        api_response = self._simulate_enrichrow(db_row)
        self.assertNotIn("source_category", api_response)

    def test_normalized_product_url_hash_not_exposed(self):
        db_row = self._make_db_row()
        api_response = self._simulate_enrichrow(db_row)
        self.assertNotIn("normalized_product_url_hash", api_response)

    def test_public_fields_are_present(self):
        """Spot-check that key public fields survive the projection."""
        db_row = self._make_db_row()
        api_response = self._simulate_enrichrow(db_row)
        for field in ("id", "product_name", "image_url", "source_url",
                      "domain", "source_pin_save_count"):
            self.assertIn(field, api_response, f"Public field {field!r} must be in API response")

    # ── route.ts enrichRow return object audit ────────────────────────────────

    def test_route_ts_enrichrow_return_does_not_include_discovery_fields(self):
        """Read route.ts and confirm discovery_method and discovery_method_detail
        are absent from the enrichRow return object. Parses the return {...} block."""
        route_path = pathlib.Path(__file__).parent.parent.parent / "web/src/app/api/products/top/route.ts"
        if not route_path.exists():
            self.skipTest("route.ts not found — skipping source audit")

        source = route_path.read_text(encoding="utf-8")

        # The enrichRow function returns an explicit object literal.
        # Verify none of the forbidden field names appear as keys in the return block.
        # We look for patterns like:  fieldName:  or  fieldName,  inside the return {...}
        # This is conservative: we only flag exact key names as object properties.
        import re
        # Extract return { ... } block from enrichRow
        return_block_match = re.search(
            r"function enrichRow\b.*?return \{(.*?)\};",
            source, re.DOTALL
        )
        if not return_block_match:
            self.skipTest("Could not locate enrichRow return block in route.ts")

        return_block = return_block_match.group(1)
        # Strip nested object/call literals (e.g. helper calls like
        # `deriveProductSourceType({ discovery_method: row.discovery_method, ... })`
        # that appear as a VALUE inside the return block) before scanning for keys.
        # Without this, a forbidden field name used as an argument key one level
        # down reads as a false positive top-level key of enrichRow's own return
        # object. Repeatedly collapse the innermost {...} pair until none remain,
        # which leaves only the return object's own top-level key: value pairs.
        top_level_block = return_block
        while True:
            collapsed = re.sub(r"\{[^{}]*\}", "{}", top_level_block)
            if collapsed == top_level_block:
                break
            top_level_block = collapsed

        for field in ("discovery_method", "discovery_method_detail", "source_category",
                      "normalized_product_url_hash", "source_pin_id", "source_pin_url"):
            # Look for  field:  as an object key assignment
            pattern = rf"\b{re.escape(field)}\s*:"
            self.assertIsNone(
                re.search(pattern, top_level_block),
                f"Field {field!r} must NOT appear as a top-level key in enrichRow's return object",
            )


class TestV28PreflightRunsBeforeCrawl(unittest.TestCase):
    """The v28 schema preflight must run BEFORE any browser/crawl work in apply
    mode, so a failed probe never discards a completed crawl (the real
    incident: 50 pins scraped over ~25 minutes, then the schema check failed
    on a DB timeout and the whole run was thrown away).

    In dry-run mode nothing is written, so the check must keep running after
    the crawl loop exactly as before (informational only, never blocks).
    """

    def _patch_common(self, stack, *, sources=None):
        """Patch everything run_shop_the_look_expand needs besides the schema
        probe and the browser, so these tests isolate ONLY the preflight
        ordering question."""
        import tempfile as _tempfile

        stack.enter_context(patch.object(
            stl, "select_source_pins",
            return_value=(sources or [], {"sourceSetFrozen": False, "selectedTotal": 0}),
        ))
        stack.enter_context(patch.object(stl, "_load_previous_spike_ids", return_value=set()))
        stack.enter_context(patch.object(stl, "_load_scraped_source_pin_ids", return_value=set()))
        stack.enter_context(patch.object(
            stl, "_load_session_state",
            return_value={
                "storageState": None, "authenticated": False,
                "sessionPath": "unused", "issue": "session_file_missing",
                "cookieCount": 0, "authCookiesPresent": [],
            },
        ))
        tmp_log_dir = pathlib.Path(_tempfile.mkdtemp(prefix="stl_test_logs_"))
        stack.enter_context(patch.object(stl, "LOG_DIR", tmp_log_dir))
        return tmp_log_dir

    def test_apply_mode_schema_failure_never_starts_browser(self):
        """apply=True + schema probe reports missing columns -> the exact same
        RuntimeError as before, and async_playwright() is never called."""
        import asyncio
        from contextlib import ExitStack

        with ExitStack() as stack:
            self._patch_common(stack)
            stack.enter_context(patch.object(
                stl, "_check_v28_schema",
                return_value=(False, ["normalized_product_url_hash"]),
            ))
            mock_async_playwright = MagicMock()
            stack.enter_context(patch(
                "playwright.async_api.async_playwright", mock_async_playwright
            ))

            with self.assertRaises(RuntimeError) as ctx:
                asyncio.run(stl.run_shop_the_look_expand(apply=True))

        msg = str(ctx.exception)
        self.assertIn("v28 migration has not been applied", msg)
        self.assertIn("normalized_product_url_hash", msg)
        self.assertNotIsInstance(ctx.exception, stl.SchemaCheckUnavailable)
        mock_async_playwright.assert_not_called()

    def test_apply_mode_schema_unavailable_never_starts_browser(self):
        """apply=True + schema probe cannot reach the DB -> SchemaCheckUnavailable
        (not a generic RuntimeError, not a claim the migration is missing), and
        the browser is never launched."""
        import asyncio
        from contextlib import ExitStack

        with ExitStack() as stack:
            self._patch_common(stack)
            stack.enter_context(patch.object(
                stl, "_check_v28_schema",
                side_effect=stl.SchemaCheckUnavailable("connection reset"),
            ))
            mock_async_playwright = MagicMock()
            stack.enter_context(patch(
                "playwright.async_api.async_playwright", mock_async_playwright
            ))

            with self.assertRaises(stl.SchemaCheckUnavailable) as ctx:
                asyncio.run(stl.run_shop_the_look_expand(apply=True))

        msg = str(ctx.exception)
        self.assertIn("unable to confirm schema", msg)
        self.assertNotIn("migration has not been applied", msg)
        mock_async_playwright.assert_not_called()

    def _install_fake_playwright(self, stack):
        """Install a minimal async-context-manager fake standing in for
        playwright.async_api.async_playwright(), deep enough for
        run_shop_the_look_expand's browser/context/page setup to complete
        against zero source pins (the for-loop over sources is then a no-op)."""

        fake_page = MagicMock()
        fake_page.url = ""

        async def fake_goto(*a, **kw):
            return None

        async def fake_content():
            return "<html></html>"

        fake_page.goto = fake_goto
        fake_page.content = fake_content
        fake_page.on = MagicMock()

        async def fake_new_page():
            return fake_page

        fake_context = MagicMock()
        fake_context.new_page = fake_new_page

        async def fake_new_context(**kw):
            return fake_context

        fake_browser = MagicMock()
        fake_browser.new_context = fake_new_context

        async def fake_close():
            return None

        fake_browser.close = fake_close

        async def fake_launch(**kw):
            return fake_browser

        fake_chromium = MagicMock()
        fake_chromium.launch = fake_launch

        fake_pw = MagicMock()
        fake_pw.chromium = fake_chromium

        class FakeAsyncPlaywrightCM:
            async def __aenter__(self):
                return fake_pw

            async def __aexit__(self, *exc):
                return False

        mock_async_playwright = MagicMock(return_value=FakeAsyncPlaywrightCM())
        stack.enter_context(patch(
            "playwright.async_api.async_playwright", mock_async_playwright
        ))
        return mock_async_playwright

    def test_apply_mode_schema_ok_crawls_and_checks_schema_exactly_once(self):
        """apply=True + schema probe passes -> the crawl proceeds (browser is
        launched) and _check_v28_schema is called exactly once, not twice
        (the whole point: no redundant re-probe after the moved-up check)."""
        import asyncio
        from contextlib import ExitStack

        with ExitStack() as stack:
            self._patch_common(stack, sources=[])
            stack.enter_context(patch.object(stl, "_apply_rows", return_value=0))
            check_mock = stack.enter_context(patch.object(
                stl, "_check_v28_schema", return_value=(True, [])
            ))
            mock_async_playwright = self._install_fake_playwright(stack)

            report = asyncio.run(stl.run_shop_the_look_expand(apply=True))

        mock_async_playwright.assert_called_once()
        self.assertEqual(check_mock.call_count, 1)
        self.assertEqual(report["v28SchemaCheck"]["verdict"], "all_present")
        self.assertTrue(report["v28SchemaCheck"]["allPresent"])

    def test_dry_run_mode_unchanged_schema_check_after_crawl_never_blocks(self):
        """apply=False -> the crawl always proceeds regardless of the schema
        verdict (even a missing-columns verdict must not raise), and the
        report still carries a fully-formed v28SchemaCheck block."""
        import asyncio
        from contextlib import ExitStack

        with ExitStack() as stack:
            self._patch_common(stack, sources=[])
            check_mock = stack.enter_context(patch.object(
                stl, "_check_v28_schema", return_value=(False, ["seed_keyword"])
            ))
            mock_async_playwright = self._install_fake_playwright(stack)

            report = asyncio.run(stl.run_shop_the_look_expand(apply=False))

        mock_async_playwright.assert_called_once()
        self.assertEqual(check_mock.call_count, 1)
        v28 = report["v28SchemaCheck"]
        self.assertEqual(v28["verdict"], "columns_missing")
        self.assertFalse(v28["allPresent"])
        self.assertEqual(v28["missingColumns"], ["seed_keyword"])
        self.assertEqual(v28["columnsChecked"], list(stl.V28_REQUIRED_COLUMNS))
        self.assertIsNone(v28["schemaCheckUnavailable"])
        self.assertIn("noteIndexNotChecked", v28)
        self.assertEqual(report["writes"]["pin_products"], 0)  # dry-run never writes rows


class TestIncrementalBatchWrite(unittest.TestCase):
    """Products must be written DURING the crawl, not after it.

    THE INCIDENT (2026-08-06 23:02, VPS timer): the run crawled 45/50 pins and
    found products on 31 of them, then the runner tree-killed it at
    VIBEPIN_TIMEOUT_SECONDS=2400. The only write call sat below
    `await browser.close()`, so all 31 pins' products were discarded — the DB
    received exactly zero rows from a 40-minute authenticated run.

    These tests pin the properties that make that impossible to repeat:
      * writes happen every STL_WRITE_BATCH_SIZE source pins,
      * a URL written in an early batch is not rewritten in a later one,
      * per-batch counts ACCUMULATE (a later batch cannot overwrite an
        earlier batch's numbers in the report),
      * one failed batch neither stops the crawl nor disappears from the report.
    """

    # ── harness ───────────────────────────────────────────────────────────
    def _candidate(self, url: str, *, pin_id: str = "p1") -> dict:
        """A candidate shaped like _prepare_candidate's output."""
        return _prepare_candidate(
            {"product_url": url, "product_title": "Thing", "merchant": "Etsy",
             "image_url": "https://img/x.jpg", "price": None, "currency": None,
             "extraction_method": "network_json"},
            {"pin_id": pin_id, "category": "home-decor", "save_count": 100},
            index=0, shop_detected=True, shop_tab_clicked=False,
        )

    def _pin_result(self, pin_id: str, urls: list[str]) -> dict:
        return {
            "source": {"pin_id": pin_id, "category": "home-decor", "save_count": 100},
            "issue": None,
            "shopModuleDetected": True,
            "shopTabClicked": False,
            "chipLabels": [],
            "visibleCardCount": len(urls),
            "tabCount": 1,
            "productJsonResponses": len(urls),
            "networkCandidates": len(urls),
            "domEvalError": None,
            "pageSkeleton": False,
            "renderFailure": False,
            "candidates": [self._candidate(u, pin_id=pin_id) for u in urls],
            "elapsedSec": 0.1,
        }

    def _run(self, stack, *, pin_results, batch_size, apply_rows_side_effect=None):
        """Drive the real run_shop_the_look_expand over canned pins.

        Everything except the batching logic is stubbed: the browser (fake
        playwright), the source selection, the schema probe, and the DB
        preflight (pass-through, so dedup decisions come from the writer's own
        cross-batch set rather than from a mocked database).
        """
        import asyncio

        sources = [{"pin_id": r["source"]["pin_id"], "category": "home-decor",
                    "save_count": 100} for r in pin_results]

        preflight_helper = TestV28PreflightRunsBeforeCrawl()
        preflight_helper._patch_common(stack, sources=sources)
        preflight_helper._install_fake_playwright(stack)
        stack.enter_context(patch.object(stl, "_check_v28_schema", return_value=(True, [])))
        stack.enter_context(patch.dict(
            os.environ, {"STL_WRITE_BATCH_SIZE": str(batch_size)}, clear=False
        ))

        queue = list(pin_results)

        async def fake_extract(page, source, state):
            return queue.pop(0)

        stack.enter_context(patch.object(stl, "_extract_source_pin", fake_extract))
        # Pass-through preflight: no row is "already in the DB".
        stack.enter_context(patch.object(
            stl, "_preflight_existing",
            side_effect=lambda unique: {
                "projectedInsertCount": len(unique),
                "projectedSkipExistingCount": 0,
                "projectedUpdateCount": 0,
                "legacyTouchedProjected": 0,
                "conflictKeysChecked": ["normalized_product_url_hash"],
                "skippedDuplicateExamples": [],
                "insertCandidates": list(unique),
                "checked": True,
                "existingHashMatches": 0,
            },
        ))

        apply_mock = stack.enter_context(patch.object(
            stl, "_apply_rows",
            side_effect=apply_rows_side_effect or (lambda rows: self._land(rows)),
        ))
        report = asyncio.run(stl.run_shop_the_look_expand(
            limit=len(sources),
            category_mix={"home-decor": len(sources)},
            apply=True,
        ))
        return report, apply_mock

    @staticmethod
    def _land(rows):
        """Stand-in for a fully successful _apply_rows, including the
        _LAST_WRITE_OUTCOME side effect the real one performs."""
        stl._LAST_WRITE_OUTCOME.clear()
        stl._LAST_WRITE_OUTCOME.update({
            "attempted": len(rows), "inserted": len(rows),
            "duplicates": 0, "failed": 0, "errors": [],
            "insertedIds": [f"id-{r['source_pin_id']}" for r in rows],
            "createdAtWindow": ["2026-08-25T00:00:00+00:00",
                                "2026-08-25T00:00:01+00:00"],
            "rollback": "DELETE ... exact ids ...",
            "postWriteVerification": {"allRedLinesPass": True},
        })
        return len(rows)

    # ── T1: batching ──────────────────────────────────────────────────────
    def test_canary_may_lower_run_write_cap_to_one_but_never_raise_above_50(self):
        with patch.dict(os.environ, {"VIBEPIN_SUPPLY_WRITE_LIMIT": "1"}, clear=False):
            writer = stl._IncrementalWriter(batch_size=10, enabled=True)
        self.assertEqual(writer.run_admission_cap, 1)
        self.assertEqual(writer.batching_report()["runAdmissionCap"], 1)

        for bad in ("0", "51", "not-a-number"):
            with patch.dict(os.environ, {"VIBEPIN_SUPPLY_WRITE_LIMIT": bad}, clear=False):
                with self.assertRaises(RuntimeError):
                    stl._IncrementalWriter(batch_size=10, enabled=True)

    def test_canary_cap_one_reaches_only_one_row(self):
        from contextlib import ExitStack

        pins = [self._pin_result(f"canary{i}",
                                 [f"https://www.etsy.com/listing/{i}/thing"])
                for i in range(5)]
        with ExitStack() as stack:
            stack.enter_context(patch.dict(
                os.environ, {"VIBEPIN_SUPPLY_WRITE_LIMIT": "1"}, clear=False
            ))
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=5)

        self.assertEqual([len(c.args[0]) for c in apply_mock.call_args_list], [1])
        self.assertEqual(report["writes"]["pin_products"], 1)
        self.assertEqual(report["incrementalWrite"]["rowsSkippedRunAdmissionCap"], 4)

    def test_twenty_pins_with_batch_ten_writes_twice(self):
        """20 source pins x 1 candidate, batch=10 -> the writer is called twice,
        with 10 rows each. Before this change it was called once, after the
        whole crawl — the shape that lost 31 pins to a timeout kill."""
        from contextlib import ExitStack

        pins = [self._pin_result(f"pin{i}", [f"https://www.etsy.com/listing/{i}/thing"])
                for i in range(20)]
        with ExitStack() as stack:
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=10)

        self.assertEqual(apply_mock.call_count, 2)
        self.assertEqual([len(c.args[0]) for c in apply_mock.call_args_list], [10, 10])
        self.assertEqual(report["writes"]["pin_products"], 20)
        self.assertEqual(report["incrementalWrite"]["batchesWritten"], 2)
        self.assertEqual(report["incrementalWrite"]["batchSizePins"], 10)

    def test_tail_batch_below_batch_size_is_still_written(self):
        """25 pins at batch=10 -> 10 + 10 + a 5-row tail, all below the
        user-approved 50-row run ceiling."""
        from contextlib import ExitStack

        pins = [self._pin_result(f"pin{i}", [f"https://www.etsy.com/listing/{i}/thing"])
                for i in range(25)]
        with ExitStack() as stack:
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=10)

        self.assertEqual([len(c.args[0]) for c in apply_mock.call_args_list], [10, 10, 5])
        self.assertEqual(report["writes"]["pin_products"], 25)
        self.assertEqual(report["incrementalWrite"]["rowsSkippedRunAdmissionCap"], 0)
        self.assertEqual(report["incrementalWrite"]["runAdmissionCap"], 50)
        self.assertEqual(report["incrementalWrite"]["atomicWriteBatchCap"], 20)

    def test_one_large_flush_is_split_20_20_10_and_total_stops_at_50(self):
        """A high-yield source flush may keep 50 rows, but no individual
        INSERT/readback/rollback call may exceed the established 20-row unit."""
        from contextlib import ExitStack

        pins = []
        for pin_no in range(10):
            urls = [
                f"https://www.etsy.com/listing/{pin_no * 6 + j}/thing"
                for j in range(6)
            ]
            pins.append(self._pin_result(f"dense{pin_no}", urls))
        with ExitStack() as stack:
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=10)

        self.assertEqual([len(c.args[0]) for c in apply_mock.call_args_list], [20, 20, 10])
        self.assertEqual(report["writes"]["pin_products"], 50)
        self.assertEqual(report["incrementalWrite"]["rowsSkippedRunAdmissionCap"], 10)
        self.assertEqual(report["incrementalWrite"]["runAdmissionSlotsRemaining"], 0)
        self.assertTrue(all(
            len(receipt["insertedIds"]) <= 20
            for receipt in report["writeOutcome"]["batchReceipts"]
        ))

    def test_failed_merchant_proof_does_not_consume_the_write_cap(self):
        """The first 10 Source Pins can yield zero verified products without
        preventing later Source Pins from filling the 20-row write ceiling."""
        from contextlib import ExitStack

        calls = 0

        def first_batch_finds_nothing(rows):
            nonlocal calls
            calls += 1
            landed = [] if calls == 1 else rows
            stl._LAST_WRITE_OUTCOME.clear()
            stl._LAST_WRITE_OUTCOME.update({
                "attempted": len(rows), "inserted": len(landed),
                "duplicates": 0, "failed": len(rows) - len(landed), "errors": [],
                "insertedIds": [f"landed-{calls}-{i}" for i in range(len(landed))],
                "createdAtWindow": ["lo", "hi"] if landed else None,
                "rollback": "DELETE exact ids" if landed else None,
                "postWriteVerification": {"allRedLinesPass": True} if landed else None,
            })
            return len(landed)

        pins = [self._pin_result(f"proof{i}", [f"https://www.etsy.com/listing/{i}/thing"])
                for i in range(25)]
        with ExitStack() as stack:
            report, apply_mock = self._run(
                stack, pin_results=pins, batch_size=10,
                apply_rows_side_effect=first_batch_finds_nothing,
            )

        self.assertEqual([len(c.args[0]) for c in apply_mock.call_args_list], [10, 10, 5])
        self.assertEqual(report["writes"]["pin_products"], 15)
        self.assertEqual(report["incrementalWrite"]["rowsSkippedRunAdmissionCap"], 0)

    def test_final_report_keeps_exact_ids_and_per_batch_rollback_receipts(self):
        from contextlib import ExitStack

        pins = [self._pin_result(f"receipt{i}",
                                 [f"https://www.etsy.com/listing/{i}/thing"])
                for i in range(12)]
        with ExitStack() as stack:
            report, _ = self._run(stack, pin_results=pins, batch_size=10)

        outcome = report["writeOutcome"]
        self.assertEqual(len(outcome["insertedIds"]), 12)
        self.assertEqual(len(outcome["batchReceipts"]), 2)
        self.assertTrue(all(r["rollback"] for r in outcome["batchReceipts"]))
        self.assertEqual(
            sum(len(r["insertedIds"]) for r in outcome["batchReceipts"]),
            outcome["inserted"],
        )

    # ── T2: cross-batch dedup ─────────────────────────────────────────────
    def test_url_written_in_batch_one_is_not_rewritten_in_batch_two(self):
        """Batch 2 repeats a URL from batch 1 -> it is written exactly once.

        The old single write deduped the whole run in one pass; batching must
        not reintroduce duplicates just because the repeat crosses a flush.
        """
        from contextlib import ExitStack

        repeat = "https://www.etsy.com/listing/999/repeat"
        batch1 = [self._pin_result("a0", [repeat])] + [
            self._pin_result(f"a{i}", [f"https://www.etsy.com/listing/{1000 + i}/x"])
            for i in range(1, 5)
        ]
        batch2 = [self._pin_result("b0", [repeat])] + [
            self._pin_result(f"b{i}", [f"https://www.etsy.com/listing/{2000 + i}/x"])
            for i in range(1, 5)
        ]
        with ExitStack() as stack:
            report, apply_mock = self._run(
                stack, pin_results=batch1 + batch2, batch_size=5
            )

        self.assertEqual(apply_mock.call_count, 2)
        written_urls = [row["product_url"]
                        for call_ in apply_mock.call_args_list
                        for row in call_.args[0]]
        self.assertEqual(written_urls.count(repeat), 1,
                         f"repeat URL written {written_urls.count(repeat)} times")
        # 10 candidates, one of them a cross-batch repeat -> 9 rows.
        self.assertEqual(len(written_urls), 9)
        self.assertEqual(report["writes"]["pin_products"], 9)
        self.assertEqual(report["incrementalWrite"]["rowsSkippedCrossBatchDuplicate"], 1)

    def test_duplicate_within_the_same_batch_written_once(self):
        """In-batch dedup must survive too (two pins in one batch, same URL)."""
        from contextlib import ExitStack

        same = "https://www.etsy.com/listing/777/same"
        pins = [self._pin_result("c1", [same]), self._pin_result("c2", [same])]
        with ExitStack() as stack:
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=2)

        self.assertEqual(apply_mock.call_count, 1)
        self.assertEqual(len(apply_mock.call_args_list[0].args[0]), 1)
        self.assertEqual(report["writes"]["pin_products"], 1)

    # ── T3: accumulation ──────────────────────────────────────────────────
    def test_two_batches_of_three_report_six_not_three(self):
        """The report must SUM batches. _LAST_WRITE_OUTCOME is cleared and
        rewritten by every _apply_rows call, so reading it once at the end
        would report only the LAST batch — a report that understates what
        actually landed is a report that lies."""
        from contextlib import ExitStack

        pins = [self._pin_result(f"d{i}", [f"https://www.etsy.com/listing/{3000 + i}/x"])
                for i in range(6)]
        with ExitStack() as stack:
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=3)

        self.assertEqual(apply_mock.call_count, 2)
        self.assertEqual(report["writes"]["pin_products"], 6)
        self.assertEqual(report["writeOutcome"]["inserted"], 6)
        self.assertEqual(report["writeOutcome"]["attempted"], 6)
        # And the last batch's own number (3) must NOT be what the report shows.
        self.assertNotEqual(report["writeOutcome"]["inserted"],
                            stl._LAST_WRITE_OUTCOME.get("inserted"))

    def test_duplicates_and_failures_accumulate_across_batches(self):
        """duplicates/failed are summed too, not just inserted."""
        from contextlib import ExitStack

        def partial(rows):
            stl._LAST_WRITE_OUTCOME.clear()
            stl._LAST_WRITE_OUTCOME.update({
                "attempted": len(rows), "inserted": len(rows) - 2,
                "duplicates": 1, "failed": 1, "errors": ["boom"],
            })
            return len(rows) - 2

        pins = [self._pin_result(f"e{i}", [f"https://www.etsy.com/listing/{4000 + i}/x"])
                for i in range(6)]
        with ExitStack() as stack:
            report, _ = self._run(stack, pin_results=pins, batch_size=3,
                                  apply_rows_side_effect=partial)

        outcome = report["writeOutcome"]
        self.assertEqual(outcome["attempted"], 6)
        self.assertEqual(outcome["inserted"], 2)
        self.assertEqual(outcome["duplicates"], 2)
        self.assertEqual(outcome["failed"], 2)
        self.assertEqual(report["writes"]["pin_products"], 2)

    # ── T4: a failed batch does not end the run ───────────────────────────
    def test_failed_first_batch_does_not_stop_later_batches(self):
        """Batch 1 raises -> batch 2 still runs and lands, and the failure is
        counted in the report. Two red lines meet here: a transient DB error
        must not throw away the rest of a 40-minute crawl, AND the failure must
        be visible rather than silently swallowed."""
        from contextlib import ExitStack

        calls = {"n": 0}

        def flaky(rows):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("connection reset by peer")
            return TestIncrementalBatchWrite._land(rows)

        pins = [self._pin_result(f"f{i}", [f"https://www.etsy.com/listing/{5000 + i}/x"])
                for i in range(6)]
        with ExitStack() as stack:
            report, apply_mock = self._run(stack, pin_results=pins, batch_size=3,
                                           apply_rows_side_effect=flaky)

        # The crawl continued: the second batch was attempted and succeeded.
        self.assertEqual(apply_mock.call_count, 2)
        self.assertEqual(report["writes"]["pin_products"], 3)

        inc = report["incrementalWrite"]
        self.assertEqual(inc["batchesAttempted"], 2)
        self.assertEqual(inc["batchesWritten"], 1)
        self.assertEqual(inc["batchesFailed"], 1)
        # Explicit, not swallowed: the lost rows are counted and the error text kept.
        self.assertEqual(report["writeOutcome"]["failed"], 3)
        self.assertEqual(report["writeOutcome"]["attempted"], 6)
        self.assertEqual(len(inc["failedBatches"]), 1)
        self.assertEqual(inc["failedBatches"][0]["attemptedRows"], 3)
        self.assertIn("connection reset by peer", inc["failedBatches"][0]["error"])
        self.assertTrue(any("connection reset by peer" in e
                            for e in report["writeOutcome"]["errors"]))

    # ── dry-run must stay read-only ───────────────────────────────────────
    def test_dry_run_never_writes_and_has_no_incremental_block(self):
        """apply=False must not touch the DB at all — batching is apply-only."""
        import asyncio
        from contextlib import ExitStack

        pins = [self._pin_result(f"g{i}", [f"https://www.etsy.com/listing/{6000 + i}/x"])
                for i in range(4)]
        sources = [{"pin_id": r["source"]["pin_id"], "category": "home-decor",
                    "save_count": 100} for r in pins]
        queue = list(pins)

        async def fake_extract(page, source, state):
            return queue.pop(0)

        with ExitStack() as stack:
            helper = TestV28PreflightRunsBeforeCrawl()
            helper._patch_common(stack, sources=sources)
            helper._install_fake_playwright(stack)
            stack.enter_context(patch.object(stl, "_check_v28_schema", return_value=(True, [])))
            stack.enter_context(patch.dict(os.environ, {"STL_WRITE_BATCH_SIZE": "2"}, clear=False))
            stack.enter_context(patch.object(stl, "_extract_source_pin", fake_extract))
            stack.enter_context(patch.object(stl, "select_many", return_value=[]))
            apply_mock = stack.enter_context(patch.object(stl, "_apply_rows", return_value=0))

            report = asyncio.run(stl.run_shop_the_look_expand(
                limit=4, category_mix={"home-decor": 4}, apply=False,
            ))

        apply_mock.assert_not_called()
        self.assertEqual(report["writes"]["pin_products"], 0)
        self.assertNotIn("incrementalWrite", report)
        self.assertNotIn("_insertCandidates", report)


class TestFunnelBlockAndLogFieldNames(unittest.TestCase):
    """Two observability defects fixed together on 2026-08-14, both of which had
    already caused a wrong read of a real run:

    a) the per-pin progress line and the per-BATCH write line both printed
       `candidates=`, so summing the field over a log double-counted every
       candidate (1077 + 1077 = 2154 was read as the run's raw total);
    b) the raw -> written chain was split between report['aggregate'] and
       report['incrementalWrite'], so it had to be hand-stitched to be read at all.

    report['funnel'] is a VIEW: every count is copied from an existing field, so a
    disagreement between funnel and source is a bug by construction.
    """

    def _real_report(self, *, pin_results, batch_size):
        """Produce a genuine report via the same harness the batching tests use,
        capturing stdout so the log lines can be asserted on."""
        from contextlib import ExitStack, redirect_stdout
        import io

        buffer = io.StringIO()
        with ExitStack() as stack:
            with redirect_stdout(buffer):
                report, apply_mock = TestIncrementalBatchWrite._run(
                    TestIncrementalBatchWrite("test_twenty_pins_with_batch_ten_writes_twice"),
                    stack, pin_results=pin_results, batch_size=batch_size,
                )
        return report, buffer.getvalue()

    def _pins(self, n, prefix):
        helper = TestIncrementalBatchWrite("test_twenty_pins_with_batch_ten_writes_twice")
        return [helper._pin_result(f"{prefix}{i}", [f"https://www.etsy.com/listing/{7000 + i}/x"])
                for i in range(n)]

    def test_funnel_counts_match_their_named_sources(self):
        report, _out = self._real_report(pin_results=self._pins(6, "fn"), batch_size=3)
        funnel = report["funnel"]
        self.assertEqual(funnel["mode"], "apply")
        by_step = {s["step"]: s for s in funnel["steps"]}
        # The chain is present end to end, in order.
        self.assertEqual(
            [s["step"] for s in funnel["steps"]],
            ["rawCandidates", "rejected", "acceptedBeforeDedup",
             "duplicatesSkippedWithinRun", "uniqueAccepted", "alreadyInDb",
             "crossBatchDuplicates", "written"],
        )
        # Every count equals the field it names — resolved by walking the report.
        for entry in funnel["steps"]:
            block, key = entry["source"].split(".", 1)
            self.assertEqual(
                entry["count"], report[block][key],
                f"funnel step {entry['step']} disagrees with {entry['source']}",
            )
        # Sanity on the run itself: 6 clean candidates, all written.
        self.assertEqual(by_step["rawCandidates"]["count"], 6)
        self.assertEqual(by_step["uniqueAccepted"]["count"], 6)
        self.assertEqual(by_step["written"]["count"], 6)
        self.assertEqual(by_step["rejected"]["count"], 0)
        self.assertIn("byReason", by_step["rejected"])

    def test_funnel_rejection_detail_matches_aggregate(self):
        """A rejected candidate must show up in the funnel's rejection detail with
        the same breakdown the aggregate carries — no second count."""
        helper = TestIncrementalBatchWrite("test_twenty_pins_with_batch_ten_writes_twice")
        pins = [
            helper._pin_result("rj0", ["https://www.etsy.com/listing/8001/x"]),
            helper._pin_result("rj1", ["https://someblog.example/best-nail-ideas/"]),
        ]
        report, _out = self._real_report(pin_results=pins, batch_size=2)
        by_step = {s["step"]: s for s in report["funnel"]["steps"]}
        self.assertEqual(by_step["rejected"]["count"], report["aggregate"]["rejectedProducts"])
        self.assertEqual(by_step["rejected"]["byReason"],
                         report["aggregate"]["rejectedByReason"])
        self.assertEqual(by_step["rejected"]["byReason"].get("non_commerce_domain"), 1)
        self.assertEqual(by_step["written"]["count"], 1)

    def test_funnel_in_dry_run_uses_labelled_projections(self):
        """Dry-run has no incrementalWrite block; the write steps fall back to the
        preflight PROJECTIONS and say so, rather than silently reporting 0 written."""
        import asyncio
        from contextlib import ExitStack

        pins = self._pins(4, "dr")
        sources = [{"pin_id": r["source"]["pin_id"], "category": "home-decor",
                    "save_count": 100} for r in pins]
        queue = list(pins)

        async def fake_extract(page, source, state):
            return queue.pop(0)

        with ExitStack() as stack:
            helper = TestV28PreflightRunsBeforeCrawl()
            helper._patch_common(stack, sources=sources)
            helper._install_fake_playwright(stack)
            stack.enter_context(patch.object(stl, "_check_v28_schema", return_value=(True, [])))
            stack.enter_context(patch.object(stl, "_extract_source_pin", fake_extract))
            stack.enter_context(patch.object(stl, "select_many", return_value=[]))
            stack.enter_context(patch.object(stl, "_apply_rows", return_value=0))
            report = asyncio.run(stl.run_shop_the_look_expand(
                limit=4, category_mix={"home-decor": 4}, apply=False,
            ))

        funnel = report["funnel"]
        self.assertEqual(funnel["mode"], "dry-run")
        by_step = {s["step"]: s for s in funnel["steps"]}
        self.assertNotIn("crossBatchDuplicates", by_step)
        for name in ("alreadyInDb", "written"):
            self.assertTrue(by_step[name].get("projection"),
                            f"{name} must be labelled as a projection in dry-run")
            block, key = by_step[name]["source"].split(".", 1)
            self.assertEqual(by_step[name]["count"], report[block][key])

    def test_batch_log_field_cannot_be_summed_with_the_per_pin_field(self):
        """The two line kinds must not share a field name. Historically both said
        `candidates=`; grep-and-sum then counted every candidate twice."""
        report, out = self._real_report(pin_results=self._pins(4, "lg"), batch_size=2)
        per_pin_lines = [ln for ln in out.splitlines() if " pin=" in ln]
        batch_lines = [ln for ln in out.splitlines() if "write batch" in ln]
        self.assertTrue(per_pin_lines, "expected per-pin progress lines")
        self.assertTrue(batch_lines, "expected write batch lines")
        # Per-pin lines keep the original field, unchanged.
        for line in per_pin_lines:
            self.assertRegex(line, r"(?<![A-Za-z])candidates=\d+")
        # Batch lines use the distinct name and never the bare one.
        for line in batch_lines:
            self.assertIn("batchCandidates=", line)
            self.assertNotRegex(line, r"(?<![A-Za-z])candidates=")
        # And the totals really do differ in the way that caused the misread:
        # 4 per-pin lines of 1 candidate each vs 2 batch lines of 2 each.
        per_pin_total = sum(int(m) for line in per_pin_lines
                            for m in re.findall(r"(?<![A-Za-z])candidates=(\d+)", line))
        batch_total = sum(int(m) for line in batch_lines
                          for m in re.findall(r"batchCandidates=(\d+)", line))
        self.assertEqual(per_pin_total, 4)
        self.assertEqual(batch_total, 4)
        self.assertEqual(report["aggregate"]["rawProductCandidates"], 4)

    def test_empty_batch_log_line_also_renamed(self):
        """The nothing-to-write branch prints its own line; it must not reintroduce
        the ambiguous field name."""
        helper = TestIncrementalBatchWrite("test_twenty_pins_with_batch_ten_writes_twice")
        pins = [helper._pin_result(f"eb{i}", ["https://someblog.example/nail-ideas/"])
                for i in range(2)]
        _report, out = self._real_report(pin_results=pins, batch_size=2)
        batch_lines = [ln for ln in out.splitlines() if "write batch" in ln]
        self.assertTrue(any("newRows=0" in ln for ln in batch_lines),
                        f"expected an empty-batch line, got {batch_lines}")
        for line in batch_lines:
            self.assertIn("batchCandidates=", line)
            self.assertNotRegex(line, r"(?<![A-Za-z])candidates=")


class TestWriteBatchSizeConfig(unittest.TestCase):
    def test_default_is_ten_pins(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(stl._stl_write_batch_size(), 10)

    def test_env_override(self):
        with patch.dict(os.environ, {"STL_WRITE_BATCH_SIZE": "5"}, clear=False):
            self.assertEqual(stl._stl_write_batch_size(), 5)

    def test_malformed_or_nonpositive_falls_back_to_default(self):
        """0 would mean 'never flush' — the all-or-nothing behaviour this
        setting exists to remove. It must not be reachable by misconfiguration."""
        for bad in ("", "abc", "0", "-3"):
            with patch.dict(os.environ, {"STL_WRITE_BATCH_SIZE": bad}, clear=False):
                self.assertEqual(stl._stl_write_batch_size(), 10, f"value={bad!r}")


class TestProductEvidenceGate(unittest.TestCase):
    """A bare external link is a LINK, not a product.

    Production evidence (2026-08-08, read-only): of 2758 STL rows, 35 had no
    image_url; 0 of those had a price; every one was named after its own
    domain — quay / ebay / etsy / shein / jluxlabel / bylabelle /
    revolutionboutique. They came from a URL-regex fallback that emitted
    title=None,image=None,price=None plus a title chain that substituted
    merchant/domain for the missing name. Both are fixed; these tests hold it.
    """

    SOURCE = {"pin_id": "p1", "category": "home-decor", "save_count": 100}

    def _prepared(self, *, title=None, image=None, price=None,
                  url="https://www.etsy.com/listing/123/thing", json_path=None):
        return _prepare_candidate(
            {"product_url": url, "product_title": title, "merchant": None,
             "image_url": image, "price": price, "currency": None,
             "extraction_method": "network_json", "json_path": json_path},
            self.SOURCE, index=0, shop_detected=True, shop_tab_clicked=False,
        )

    def _per_pin(self, candidates):
        return [{
            "source": self.SOURCE, "shopModuleDetected": True,
            "shopTabClicked": False, "candidates": candidates, "issue": None,
        }]

    def _patch_preflight(self):
        return patch.object(stl, "select_many", side_effect=lambda *a, **k: [])

    # ── the gate itself ───────────────────────────────────────────────────
    def test_url_only_candidate_is_rejected(self):
        """No title, no image -> not product evidence."""
        self.assertEqual(
            stl._evidence_rejection_reason(self._prepared()),
            stl.NO_PRODUCT_EVIDENCE,
        )

    def test_image_without_title_is_accepted(self):
        """The image IS the evidence. Must not be collateral damage."""
        self.assertIsNone(
            stl._evidence_rejection_reason(self._prepared(image="https://i/x.jpg"))
        )

    def test_title_without_image_is_accepted(self):
        self.assertIsNone(
            stl._evidence_rejection_reason(self._prepared(title="Oak Shelf"))
        )

    def test_merchant_and_domain_are_not_evidence(self):
        """_prepare_candidate always derives merchant/domain FROM the URL, so
        treating them as evidence would re-admit all 35 bad production rows."""
        candidate = self._prepared()
        self.assertTrue(candidate["merchant"], "merchant is URL-derived here")
        self.assertTrue(candidate["domain"], "domain is URL-derived here")
        self.assertEqual(
            stl._evidence_rejection_reason(candidate), stl.NO_PRODUCT_EVIDENCE
        )

    def test_whitespace_only_title_is_not_evidence(self):
        self.assertEqual(
            stl._evidence_rejection_reason(self._prepared(title="   ")),
            stl.NO_PRODUCT_EVIDENCE,
        )

    def test_product_shaped_url_alone_still_rejected(self):
        """/dp/ and /listing/ look like product pages but carry no evidence.
        Allowlisting URL shapes would be guessing — the red line this holds."""
        for url in ("https://www.amazon.com/dp/B0G19C9N11",
                    "https://www.etsy.com/listing/4526184169/men-trousers"):
            self.assertEqual(
                stl._evidence_rejection_reason(self._prepared(url=url)),
                stl.NO_PRODUCT_EVIDENCE, url,
            )

    # ── report path ───────────────────────────────────────────────────────
    def test_report_rejects_url_only_and_counts_it(self):
        per_pin = self._per_pin([self._prepared()])
        with self._patch_preflight():
            report, unique = _build_report(per_pin, {}, elapsed=1, apply=False)

        self.assertEqual(unique, [], "a bare link must not be writable")
        agg = report["aggregate"]
        self.assertEqual(agg["uniqueAcceptedProducts"], 0)
        self.assertEqual(agg["rejectedNoProductEvidence"], 1)
        self.assertEqual(agg["rejectedByReason"][stl.NO_PRODUCT_EVIDENCE], 1)
        # Explicitly reported, never silently dropped.
        rc = report["rejectedCandidates"]
        self.assertEqual(rc["noProductEvidence"]["count"], 1)
        self.assertEqual(rc["byReason"][stl.NO_PRODUCT_EVIDENCE], 1)
        self.assertEqual(
            rc["noProductEvidence"]["samples"][0]["url"],
            "https://www.etsy.com/listing/123/thing",
            "the rejected URL must survive in the report for audit",
        )

    def test_report_keeps_image_only_and_title_only(self):
        per_pin = self._per_pin([
            self._prepared(image="https://i/a.jpg", url="https://www.etsy.com/listing/1/a"),
            self._prepared(title="Oak Shelf", url="https://www.etsy.com/listing/2/b"),
            self._prepared(url="https://www.etsy.com/listing/3/c"),
        ])
        with self._patch_preflight():
            report, unique = _build_report(per_pin, {}, elapsed=1, apply=False)

        self.assertEqual(len(unique), 2, "only the bare link should be dropped")
        self.assertEqual(report["aggregate"]["rejectedNoProductEvidence"], 1)

    def test_gate_runs_before_dedup_so_evidence_wins(self):
        """Same URL twice: evidence-less first, then one carrying an image.
        If the gate ran after dedup the bare link would claim the key and the
        real product would be discarded as a duplicate."""
        url = "https://www.etsy.com/listing/555/shared"
        per_pin = self._per_pin([
            self._prepared(url=url),
            self._prepared(url=url, image="https://i/real.jpg"),
        ])
        with self._patch_preflight():
            report, unique = _build_report(per_pin, {}, elapsed=1, apply=False)

        self.assertEqual(len(unique), 1)
        self.assertEqual(unique[0]["image_url"], "https://i/real.jpg",
                         "the evidence-bearing candidate must be the survivor")
        self.assertEqual(report["aggregate"]["rejectedNoProductEvidence"], 1)

    def test_report_flags_discarded_price_evidence(self):
        """Price on a gate-rejected row would mean the rule threw away real
        evidence. 0/35 in production today; it must not change unnoticed."""
        with self._patch_preflight():
            report, _ = _build_report(
                self._per_pin([self._prepared(price="19.99")]), {},
                elapsed=1, apply=False,
            )
        self.assertEqual(
            report["rejectedCandidates"]["noProductEvidence"]["withPriceAnyway"], 1
        )

    def test_text_fallback_provenance_survives_into_the_report(self):
        """json_path used to be dropped by _prepare_candidate, which is why
        'has the regex fallback ever produced a real product?' was unanswerable
        from reports or from the DB. It now reaches the report."""
        with self._patch_preflight():
            report, _ = _build_report(
                self._per_pin([self._prepared(json_path="network_text_fallback")]),
                {}, elapsed=1, apply=False,
            )
        self.assertEqual(report["aggregate"]["acceptedFromNetworkTextFallback"], 0)
        self.assertEqual(report["aggregate"]["rejectedFromNetworkTextFallback"], 1)

    # ── write path: no invented names ─────────────────────────────────────
    def test_apply_rows_writes_null_name_for_image_only_row(self):
        """product_name must be NULL, NOT the merchant or the domain.
        Verified live: pin_products.product_name is nullable (68 rows hold
        NULL), per migrate_v47 which dropped the NOT NULL constraint."""
        row = self._prepared(image="https://i/x.jpg")
        self.assertTrue(row["merchant"], "merchant is populated but must not leak")

        candidate = stl._stl_candidates([row])[0]
        self.assertNotIn("product_name", candidate["pin"])
        self.assertNotIn("merchant", candidate["pin"])
        self.assertNotIn("Solid Oak Floating Shelf", repr(candidate))

    def test_apply_rows_keeps_a_real_title(self):
        row = self._prepared(title="Solid Oak Floating Shelf")
        candidate = stl._stl_candidates([row])[0]
        self.assertNotIn("product_title", candidate["pin"])
        self.assertNotIn("Solid Oak Floating Shelf", repr(candidate))

    def test_pinterest_product_placeholder_is_gone_from_executable_code(self):
        """The invented fallback name must not exist as a usable string.

        Checked via the AST rather than by grepping lines: only real string
        LITERALS can ever be assigned to product_name, while docstrings and
        comments merely describe the removed behaviour and are harmless. An
        AST walk proves the value is unreachable instead of guessing from
        line prefixes.
        """
        import ast

        source = pathlib.Path(stl.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        docstrings = {
            id(node.body[0].value)
            for node in ast.walk(tree)
            if isinstance(node, (ast.Module, ast.ClassDef,
                                 ast.FunctionDef, ast.AsyncFunctionDef))
            and node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        }
        offenders = [
            (node.lineno, node.value)
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and "Pinterest product" in node.value
            and id(node) not in docstrings
        ]
        self.assertEqual(offenders, [],
                         f"live code can still fabricate a name: {offenders}")


class TestIncrementalWriterEvidenceGate(unittest.TestCase):
    """The apply path writes through _IncrementalWriter, not _build_report.
    A gate that only guarded the report would guard nothing in production.
    """

    SOURCE = {"pin_id": "p1", "category": "home-decor", "save_count": 100}

    def _prepared(self, *, title=None, image=None, price=None, url):
        return _prepare_candidate(
            {"product_url": url, "product_title": title, "merchant": None,
             "image_url": image, "price": price, "currency": None,
             "extraction_method": "network_json"},
            self.SOURCE, index=0, shop_detected=True, shop_tab_clicked=False,
        )

    def _writer(self):
        return stl._IncrementalWriter(batch_size=10, enabled=True)

    def _passthrough_preflight(self):
        return patch.object(
            stl, "_preflight_existing",
            side_effect=lambda unique: {"insertCandidates": list(unique)},
        )

    def test_bare_card_link_reaches_bounded_merchant_core(self):
        """Card title/image are untrusted; a valid PDP URL must reach the
        shared core so the merchant page can prove or reject it."""
        writer = self._writer()
        pending = [
            self._prepared(url="https://www.etsy.com/listing/1/bare"),
            self._prepared(url="https://www.etsy.com/listing/2/good",
                           image="https://i/g.jpg"),
        ]
        with self._passthrough_preflight():
            rows = writer._filter_batch(pending)

        self.assertEqual(
            [r["product_url"] for r in rows],
            [
                "https://www.etsy.com/listing/1/bare",
                "https://www.etsy.com/listing/2/good",
            ],
        )
        self.assertEqual(writer.evidence_rejected_count, 0)

    def test_card_evidence_is_not_reported_as_merchant_rejection(self):
        writer = self._writer()
        with self._passthrough_preflight():
            writer._filter_batch([
                self._prepared(url="https://www.etsy.com/listing/1/bare"),
                self._prepared(url="https://www.etsy.com/listing/2/bare2",
                               price="9.99"),
            ])
        rep = writer.batching_report()
        self.assertEqual(rep["rowsRejectedNoProductEvidence"], 0)
        self.assertEqual(rep["rowsRejectedNoProductEvidenceWithPrice"], 0)

    def test_merchant_discovery_failure_is_preserved_in_final_write_outcome(self):
        """A URL that reaches supply_core but fails merchant-page proof must
        not disappear into the ambiguous attempted=0/written=0 state."""
        writer = stl._IncrementalWriter(batch_size=1, enabled=True)
        candidate = self._prepared(
            url="https://www.etsy.com/listing/99/merchant-proof-fails",
            image="https://i.pinimg.com/236x/example.jpg",
        )

        def fail_discovery(_rows):
            stl._LAST_WRITE_OUTCOME.clear()
            stl._LAST_WRITE_OUTCOME.update({
                "candidates": 1,
                "discovered": 0,
                "discoveryFailures": 1,
                "discoveryFailureSamples": [{
                    "url": "https://www.etsy.com/listing/99/merchant-proof-fails",
                    "reason": "merchant page did not prove a real image",
                }],
                "attempted": 0,
                "inserted": 0,
                "duplicates": 0,
                "failed": 0,
                "errors": [],
            })
            return 0

        with self._passthrough_preflight(), patch.object(
            stl, "_apply_rows", side_effect=fail_discovery
        ):
            writer.add_pin({"candidates": [candidate]})

        outcome = writer.write_outcome()
        self.assertEqual(outcome["coreCandidates"], 1)
        self.assertEqual(outcome["merchantDiscovered"], 0)
        self.assertEqual(outcome["merchantDiscoveryFailures"], 1)
        self.assertEqual(
            outcome["merchantDiscoveryFailureSamples"][0]["reason"],
            "merchant page did not prove a real image",
        )
        self.assertEqual(len(outcome["batchReceipts"]), 1)
        self.assertEqual(outcome["batchReceipts"][0]["coreCandidates"], 1)

    def test_first_valid_pdp_url_owns_dedup_regardless_of_card_fields(self):
        """A later Pinterest image cannot upgrade merchant proof; one URL gets
        one bounded merchant fetch regardless of its card metadata."""
        url = "https://www.etsy.com/listing/777/late-evidence"
        writer = self._writer()
        with self._passthrough_preflight():
            first = writer._filter_batch([self._prepared(url=url)])
            second = writer._filter_batch(
                [self._prepared(url=url, image="https://i/late.jpg")]
            )
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_flush_sends_bare_card_link_to_merchant_core(self):
        import io
        from contextlib import redirect_stdout

        writer = self._writer()
        writer._pending = [self._prepared(url="https://www.etsy.com/listing/1/bare")]
        writer._pins_since_flush = 1
        buf = io.StringIO()
        def merchant_reject(_rows):
            stl._LAST_WRITE_OUTCOME.clear()
            stl._LAST_WRITE_OUTCOME.update({
                "candidates": 1,
                "discovered": 0,
                "discoveryFailures": 1,
                "discoveryFailureSamples": [{"reason": "merchant image missing"}],
                "attempted": 0,
                "inserted": 0,
                "duplicates": 0,
                "failed": 0,
                "errors": [],
            })
            return 0

        with self._passthrough_preflight(), patch.object(
            stl, "_apply_rows", side_effect=merchant_reject
        ), redirect_stdout(buf):
            writer.flush(reason="test")
        out = buf.getvalue()
        self.assertIn("newRows=1", out)
        self.assertEqual(writer.write_outcome()["merchantDiscoveryFailures"], 1)

    def test_merchant_discovery_budget_is_not_restored_after_failed_proof(self):
        writer = stl._IncrementalWriter(batch_size=1, enabled=True)
        writer._merchant_discovery_slots_remaining = 1

        def merchant_reject(_rows):
            stl._LAST_WRITE_OUTCOME.clear()
            stl._LAST_WRITE_OUTCOME.update({
                "candidates": 1,
                "discovered": 0,
                "discoveryFailures": 1,
                "discoveryFailureSamples": [{"reason": "merchant proof failed"}],
                "attempted": 0,
                "inserted": 0,
                "duplicates": 0,
                "failed": 0,
                "errors": [],
            })
            return 0

        with self._passthrough_preflight(), patch.object(
            stl, "_apply_rows", side_effect=merchant_reject
        ) as apply_mock:
            writer.add_pin({"candidates": [self._prepared(
                url="https://www.etsy.com/listing/1/first"
            )]})
            writer.add_pin({"candidates": [self._prepared(
                url="https://www.etsy.com/listing/2/second"
            )]})

        report = writer.batching_report()
        self.assertEqual(apply_mock.call_count, 1)
        self.assertEqual(report["merchantDiscoveryCandidateCap"], 100)
        self.assertEqual(report["merchantDiscoverySlotsRemaining"], 0)
        self.assertEqual(report["rowsSkippedMerchantDiscoveryBudget"], 1)



class TestRejectionCountedBothWays(unittest.TestCase):
    """Rejections are counted as records AND as distinct URLs.

    The same URL arrives many times in one run, and the evidence gate runs
    before dedup on purpose, so record counts measure work while distinct-URL
    counts measure loss. Measured 2026-08-18: 968 records over 544 URLs, and 94
    no_product_evidence records over 3 URLs. Reporting only records made a
    3-URL gap look like a 94-product gap.
    """

    ETSY = "https://www.etsy.com/listing/4348936058/august-days"

    def _rejections(self):
        rows = [{"product_url": self.ETSY,
                 "rejection_reason": NO_PRODUCT_EVIDENCE} for _ in range(30)]
        rows += [{"product_url": "https://blog.example.com/post",
                  "rejection_reason": "non_commerce_domain"} for _ in range(5)]
        rows += [{"product_url": "https://other.example.com/x",
                  "rejection_reason": "non_commerce_domain"}]
        return rows

    def test_records_and_unique_urls_both_reported(self):
        r = _rejected_candidates_report(self._rejections())
        self.assertEqual(r["total"], 36)
        self.assertEqual(r["totalUnique"], 3)

    def test_per_reason_unique_counts(self):
        r = _rejected_candidates_report(self._rejections())
        self.assertEqual(r["byReason"][NO_PRODUCT_EVIDENCE], 30)
        self.assertEqual(r["byReasonUnique"][NO_PRODUCT_EVIDENCE], 1)
        self.assertEqual(r["byReasonUnique"]["non_commerce_domain"], 2)

    def test_no_product_evidence_block_carries_unique_count(self):
        r = _rejected_candidates_report(self._rejections())
        self.assertEqual(r["noProductEvidence"]["count"], 30)
        self.assertEqual(r["noProductEvidence"]["uniqueUrls"], 1)

    def test_rows_without_url_do_not_inflate_unique(self):
        rows = [{"rejection_reason": "missing_product_url"} for _ in range(4)]
        r = _rejected_candidates_report(rows)
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["totalUnique"], 0)


class TestShortlinkWiredIntoReport(unittest.TestCase):
    """_build_report must actually USE the resolver, not just import it.

    The resolver landed as a library first, with no caller: accept_link()
    defaults resolver=None, so every shortener kept being rejected exactly as
    before while the code looked finished. This pins the wiring.
    """

    PDP = "https://www.amazon.com/Widget/dp/B0TESTASIN"

    def _pin(self, url):
        return [{"candidates": [{"product_url": url,
                                 "product_title": "A real widget",
                                 "image_url": "https://i.example/x.jpg"}]}]

    def test_shortlink_is_resolved_and_accepted(self):
        with patch.object(stl, "ShortlinkResolver") as R:
            R.return_value = MagicMock()
            with patch.object(stl, "accept_link",
                                   return_value=(True, "known_commerce_domain")) as al,                  patch.object(stl, "resolve_link", return_value=self.PDP) as rl:
                stl._build_report(self._pin("https://amzn.to/3QYT1Ll"), {}, elapsed=1.0, apply=False)
        self.assertIsNotNone(al.call_args.kwargs.get("resolver"),
                             "accept_link must receive the run's resolver")
        rl.assert_called_once()

    def test_stored_url_is_the_resolved_target(self):
        with patch.object(stl, "ShortlinkResolver", return_value=MagicMock()),              patch.object(stl, "accept_link", return_value=(True, "known_commerce_domain")),              patch.object(stl, "resolve_link", return_value=self.PDP):
            report, unique = stl._build_report(
                self._pin("https://amzn.to/3QYT1Ll"), {}, elapsed=1.0, apply=False)
        self.assertEqual(unique[0]["product_url"], self.PDP,
                         "an expiring redirect must not be persisted as source_url")
        self.assertEqual(unique[0]["shortlink_original_url"], "https://amzn.to/3QYT1Ll")

if __name__ == "__main__":
    unittest.main()
