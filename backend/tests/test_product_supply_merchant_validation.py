import copy
import json
import pathlib
import sys
import unittest

BACKEND = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = BACKEND / "scripts"
for p in (str(BACKEND), str(SCRIPTS)):
    if p not in sys.path:
        sys.path.insert(0, p)

import supply_core
import validate_product_supply_merchants as validator


SOURCE = {
    "pin_id": "123",
    "category": "home-decor",
    "save_count": 50,
    "seed_keyword": None,
    "source_keyword": "japandi lamp",
    "title": "Pinterest source title",
    "image_url": "https://i.pinimg.com/source.jpg",
}


def report_for(url="https://merchant.example/products/lamp"):
    return {
        "mode": "dry-run",
        "engine": "shop-the-look",
        "writes": {"pin_products": 0},
        "perPin": [{
            "sourcePinId": "123", "category": "home-decor", "saveCount": 50
        }],
        "acceptedProducts": [{
            "source_pin_id": "123",
            "product_url": url,
            "normalized_product_url_hash": supply_core.url_hash(
                supply_core.normalize_product_url(url)
            ),
        }],
        "rejectedProductDetails": [],
    }


class FakeWeb:
    def __init__(self, pages):
        self.pages = pages

    def get(self, url, **_kwargs):
        status, html = self.pages[url]
        return type("Response", (), {
            "status_code": status,
            "text": html,
            "url": url,
        })()


class TestMerchantValidation(unittest.TestCase):
    def test_enrichment_preserves_original_and_uses_real_keyword(self):
        original = report_for()
        before = copy.deepcopy(original)
        enriched = validator.enrich_frozen_report(
            original, {"123": SOURCE}, "abc123"
        )
        self.assertEqual(original, before)
        self.assertEqual(enriched["perPin"][0]["seedKeyword"], "japandi lamp")
        self.assertEqual(
            enriched["merchantValidationSourceEnrichment"]["derivedFromSha256"],
            "abc123",
        )
        self.assertEqual(
            enriched["merchantValidationSourceEnrichment"]["databaseWrites"], 0
        )

    def test_category_mismatch_fails_closed(self):
        bad = {**SOURCE, "category": "fashion"}
        with self.assertRaises(RuntimeError):
            validator.enrich_frozen_report(report_for(), {"123": bad}, "abc")

    def test_bare_card_rejection_is_still_sent_to_merchant(self):
        report = report_for()
        row = report["acceptedProducts"].pop()
        row["rejection_reason"] = "no_product_evidence"
        report["rejectedProductDetails"] = [row]
        pool = validator._candidate_pool(report, {"123": SOURCE})
        self.assertEqual(len(pool), 1)
        self.assertEqual(pool[0]["seed_keyword"], "japandi lamp")

    def test_merchant_page_projects_safe_row_without_writing(self):
        url = "https://merchant.example/products/lamp"
        html = """
        <html><head>
        <meta property="og:title" content="Japandi Table Lamp">
        <meta property="og:image" content="https://cdn.merchant.example/lamp.jpg">
        </head><body>Japandi Table Lamp</body></html>
        """
        result = validator.validate_merchants(
            report_for(url),
            {"123": SOURCE},
            web=FakeWeb({url: (200, html)}),
            preflight=lambda rows: {
                "checked": True,
                "projectedSkipExistingCount": 0,
                "insertCandidates": rows,
            },
        )
        self.assertEqual(result["merchantDiscovered"], 1)
        self.assertEqual(result["projectedSafeAdmissions"], 1)
        self.assertEqual(result["verifiedMerchantImages"], 1)
        self.assertEqual(result["pinterestHostedProductImages"], 0)
        self.assertEqual(result["databaseWrites"], 0)
        self.assertTrue(result["redLinesPass"])
        self.assertTrue(result["validationPass"])

    def test_missing_keyword_remains_a_visible_failure(self):
        source = {**SOURCE, "source_keyword": None}
        result = validator.validate_merchants(
            report_for(),
            {"123": source},
            web=FakeWeb({}),
            preflight=lambda rows: {
                "checked": True,
                "projectedSkipExistingCount": 0,
                "insertCandidates": rows,
            },
        )
        self.assertEqual(result["merchantDiscovered"], 0)
        self.assertEqual(result["failureReasons"], {"missing_seed_keyword": 1})
        self.assertEqual(result["databaseWrites"], 0)
        self.assertFalse(result["validationPass"])

    def test_unknown_duplicate_preflight_fails_closed(self):
        with self.assertRaises(RuntimeError):
            validator.validate_merchants(
                report_for(), {"123": SOURCE}, web=FakeWeb({}),
                preflight=lambda _rows: {"checked": False, "insertCandidates": []},
            )

    def test_script_has_no_database_mutation_calls(self):
        source = pathlib.Path(validator.__file__).read_text(encoding="utf-8")
        executable = "\n".join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#") and not line.startswith('"""')
        )
        for forbidden in ("apply_rows(", "insert_rows(", ".post(", "rollback("):
            self.assertNotIn(forbidden, executable)


if __name__ == "__main__":
    unittest.main()
