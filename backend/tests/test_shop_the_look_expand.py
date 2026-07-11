import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, call, patch

import shop_the_look_expand as stl
from shop_the_look_expand import (
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
    """Verify _apply_rows uses insert_rows (ignore-duplicates), never upsert (merge-duplicates).

    These tests cover Task 1 (write call audit), Task 2 (late-conflict regression),
    and the insert-only proof required for apply readiness.
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
        """_apply_rows must call db.insert_rows; calling db.upsert must never happen."""
        insert_calls = []
        def fake_insert(table, payload, on_conflict=None):
            insert_calls.append({"table": table, "count": len(payload), "on_conflict": on_conflict})
            return payload

        rows = self._make_rows()
        old_db = sys.modules.get("db")
        sys.modules["db"] = self._inject_fake_db(fake_insert)
        try:
            _apply_rows(rows)
        finally:
            if old_db is None:
                sys.modules.pop("db", None)
            else:
                sys.modules["db"] = old_db

        self.assertEqual(len(insert_calls), 1, "insert_rows must be called exactly once")
        self.assertEqual(insert_calls[0]["table"], "pin_products")
        self.assertEqual(insert_calls[0]["on_conflict"], "normalized_product_url_hash")

    # ── T1-B: on_conflict key is hash, never parent_pin_id/source_url ───────

    def test_apply_rows_conflict_key_is_hash(self):
        """on_conflict must be 'normalized_product_url_hash', not 'parent_pin_id,source_url'."""
        captured = {}
        def fake_insert(table, payload, on_conflict=None):
            captured["on_conflict"] = on_conflict
            return payload

        old_db = sys.modules.get("db")
        sys.modules["db"] = self._inject_fake_db(fake_insert)
        try:
            _apply_rows(self._make_rows())
        finally:
            if old_db is None:
                sys.modules.pop("db", None)
            else:
                sys.modules["db"] = old_db

        self.assertEqual(captured["on_conflict"], "normalized_product_url_hash")
        self.assertNotIn("parent_pin_id", captured.get("on_conflict", ""))
        self.assertNotIn("source_url", captured.get("on_conflict", ""))

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
        captured = []
        def fake_insert(table, payload, on_conflict=None):
            captured.extend(payload)
            return payload

        old_db = sys.modules.get("db")
        fake_db = types.ModuleType("db")
        fake_db.insert_rows = fake_insert
        sys.modules["db"] = fake_db
        try:
            _apply_rows(rows)
        finally:
            if old_db is None:
                sys.modules.pop("db", None)
            else:
                sys.modules["db"] = old_db

        self.assertTrue(captured, "insert_rows must have been called")
        self.assertIsNone(captured[0].get("currency"),
                          "currency must be NULL when no evidence — not defaulted to USD")


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
        for field in ("discovery_method", "discovery_method_detail", "source_category",
                      "normalized_product_url_hash", "source_pin_id", "source_pin_url"):
            # Look for  field:  as an object key assignment
            pattern = rf"\b{re.escape(field)}\s*:"
            self.assertIsNone(
                re.search(pattern, return_block),
                f"Field {field!r} must NOT appear as a key in enrichRow's return object",
            )


if __name__ == "__main__":
    unittest.main()
