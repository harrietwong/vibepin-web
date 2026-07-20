"""Red-line boundary tests for tools/t2_harvest.check_red_lines().

CRITICAL INVARIANT (Commit C): accept_link() is the single AUTHORITY for one question
only — "is this URL an admissible product-detail page?". Its PASS must NOT bypass any
other red line. product-name provenance, fabricated-enrichment protection, lifecycle,
active-duplicate protection, source/provenance requirements, and the v47 constraints
each stay INDEPENDENTLY in force.

The anchor case is the 4th 100-row batch: raket.ph/.../products/polo-shirt... — a URL
accept_link ACCEPTS (valid /products/<handle> PDP) that nevertheless carries a
product_name which was NOT found in the fetched merchant page (nameFoundInPage=False).
It must STILL be red-lined by the provenance guard.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
for p in (str(BACKEND), str(BACKEND / "db"), str(BACKEND / "tools")):
    if p not in sys.path:
        sys.path.insert(0, p)

_spec = importlib.util.spec_from_file_location("t2_harvest", str(BACKEND / "tools" / "t2_harvest.py"))
t2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(t2)


def _valid_row(**over):
    """A fully compliant outbound row (all required evidence, no enrichment)."""
    url = over.pop("source_url", "https://www.etsy.com/listing/12345/thing")
    row = {
        "parent_pin_id": "pin1", "source_pin_id": "pin1",
        "source_pin_url": "https://www.pinterest.com/pin/pin1/",
        "source_pin_image_url": "https://i.pinimg.com/x.jpg",
        "source_pin_save_count": 100, "source_pin_saves": 100,
        "source_category": "home-decor", "seed_keyword": "boho rug",
        "source_url": url, "canonical_product_url": url,
        "product_url_hash": "h", "normalized_product_url_hash": "h",
        "domain": t2.get_domain(url), "discovery_method": t2.DISCOVERY_METHOD,
        "product_name": None, "image_url": None, "price": None, "currency": None,
        "merchant": None, "availability": None,
        "detail_fetch_status": t2.DETAIL_BLOCKED,
        "product_pin_id": None, "inspiration_only": True,
        "is_user_ownable": False, "is_seed": False,
    }
    row.update(over)
    return row


def _item(row, rec=None):
    return {"row": row, "rec": rec or {"evidence": [], "nameFoundInPage": False,
                                       "detailFetchStatus": row.get("detail_fetch_status")},
            "origin": "net_new"}


class TestAcceptLinkDoesNotBypassRedLines(unittest.TestCase):
    def test_clean_blocked_row_passes(self):
        ok, v = t2.check_red_lines([_item(_valid_row())])
        self.assertTrue(ok, f"a clean blocked row should pass, got: {v}")

    def test_retailer_pdp_accepted_but_provenance_still_enforced(self):
        # accept_link ACCEPTS this anthropologie retailer PDP (RL1 passes)...
        url = "https://www.anthropologie.com/shop/the-love-knot-slouchy-bag"
        self.assertTrue(t2.accept_link(url)[0])
        ok_clean, _ = t2.check_red_lines([_item(_valid_row(source_url=url,
                                                           domain="anthropologie.com"))])
        self.assertTrue(ok_clean, "retailer PDP with no name should pass all red lines")

    def test_name_without_page_provenance_is_blocked_even_though_url_is_accepted(self):
        # THE ANCHOR CASE: accept_link ACCEPTS the URL, but the row carries a
        # product_name that was NOT found in the fetched page (nameFoundInPage=False).
        # accept_link's PASS must NOT let this through — RL2 provenance must fire.
        url = "https://www.raket.ph/johnceazarnoora0/products/polo-shirt-shirt-design-background"
        self.assertTrue(t2.accept_link(url)[0], "precondition: accept_link accepts the /products/ PDP")
        row = _valid_row(
            source_url=url, domain="raket.ph",
            product_name="Polo shirt, shirt design background by johnceazarnoora0",
            detail_fetch_status=t2.DETAIL_AVAILABLE)
        rec = {"evidence": ["name:og:title"], "nameFoundInPage": False,
               "detailFetchStatus": t2.DETAIL_AVAILABLE}
        ok, v = t2.check_red_lines([_item(row, rec)])
        self.assertFalse(ok, "a name not found in the fetched page must be red-lined")
        self.assertTrue(any("not found in the fetched merchant" in x for x in v),
                        f"expected the RL2 provenance violation, got: {v}")

    def test_pinterest_hosted_image_still_blocked(self):
        row = _valid_row(image_url="https://i.pinimg.com/originals/aa.jpg",
                         detail_fetch_status=t2.DETAIL_AVAILABLE)
        rec = {"evidence": ["image:og:image"], "nameFoundInPage": True,
               "detailFetchStatus": t2.DETAIL_AVAILABLE}
        ok, v = t2.check_red_lines([_item(row, rec)])
        self.assertFalse(ok)
        self.assertTrue(any("Pinterest-hosted" in x for x in v), v)

    def test_fabricated_enrichment_without_fetch_still_blocked(self):
        # price present but detail_fetch_status != available → RL3 guessed-value fires.
        row = _valid_row(price=9.99, detail_fetch_status=t2.DETAIL_BLOCKED)
        ok, v = t2.check_red_lines([_item(row)])
        self.assertFalse(ok)
        self.assertTrue(any("without a successful" in x for x in v), v)

    def test_product_pin_id_present_still_blocked(self):
        row = _valid_row(product_pin_id="pp1")
        ok, v = t2.check_red_lines([_item(row)])
        self.assertFalse(ok)
        self.assertTrue(any("product_pin_id must be NULL" in x for x in v), v)

    def test_missing_required_evidence_still_blocked(self):
        row = _valid_row(seed_keyword=None)
        ok, v = t2.check_red_lines([_item(row)])
        self.assertFalse(ok)
        self.assertTrue(any("seed_keyword" in x for x in v), v)

    def test_internal_pinterest_source_url_blocked_by_accept_link_path(self):
        # A pinterest.com source_url must be rejected (RL1); accept_link is the authority.
        row = _valid_row(source_url="https://www.pinterest.com/pin/999/", domain="pinterest.com")
        ok, v = t2.check_red_lines([_item(row)])
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
