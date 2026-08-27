"""Decision-A tests for the shared product-supply core (backend/supply_core.py) and the
Shop-the-Look automatic path's use of it.

Everything here is OFFLINE and writes NOTHING to any database:
  * merchant-page fetches are served by a fake httpx client;
  * PostgREST insert / read-back / rollback go through a fake DB client that records
    calls in memory.

The invariant under test is Decision A: a Pinterest product CARD contributes ONLY the
external URL. Every product detail (name/image/price/merchant/availability) is either
re-derived from the merchant page or left NULL — never inherited from the card. The
manual T2 harvester and the automatic Shop-the-Look path go through the SAME core.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
for p in (str(BACKEND), str(BACKEND / "db"), str(BACKEND / "tools")):
    if p not in sys.path:
        sys.path.insert(0, p)

import supply_core as core  # noqa: E402
import shop_the_look_expand as stl  # noqa: E402


# ── Fakes ────────────────────────────────────────────────────────────────────

class FakeResp:
    def __init__(self, status_code, body, url=""):
        self.status_code = status_code
        self.text = body if isinstance(body, str) else ""
        self._json = body if not isinstance(body, str) else None
        self.url = url or "https://merchant.example/x"

    def json(self):
        return self._json


class FakeWebClient:
    """Serves merchant pages by URL. Records which URLs were fetched (proves the core
    re-visits the merchant page rather than trusting card data)."""
    def __init__(self, pages: dict):
        self.pages = pages          # url -> (status, html)
        self.fetched: list[str] = []

    def get(self, url, headers=None, follow_redirects=True, timeout=10):
        self.fetched.append(url)
        status, html = self.pages.get(url, (404, ""))
        return FakeResp(status, html, url=url)


class FakeDBClient:
    """Minimal PostgREST double. Records POST payloads and DELETE calls; serves the
    read-back list. verify_result forces the four-red-line outcome for the read-back."""
    def __init__(self, *, insert_status=201, inserted_rows=None,
                 readback_rows=None, delete_status=200):
        self.insert_status = insert_status
        self.inserted_rows = inserted_rows if inserted_rows is not None else []
        self.readback_rows = readback_rows if readback_rows is not None else []
        self.delete_status = delete_status
        self.posts: list = []
        self.deletes: list = []
        self.gets: list = []

    def post(self, url, headers=None, json=None):
        self.posts.append(json)
        if self.insert_status not in (200, 201):
            return FakeResp(self.insert_status, {"code": "23505", "message": "duplicate key"})
        return FakeResp(self.insert_status, self.inserted_rows)

    def get(self, url, headers=None):
        self.gets.append(url)
        # coexistence read-back uses source_url=eq.<url>; verify read-back uses created_at.
        if "source_url=eq." in url:
            return FakeResp(200, [])
        if "id=in.(" in url:
            raw = url.split("id=in.(", 1)[1].split(")", 1)[0]
            wanted = set(raw.split(","))
            return FakeResp(200, [
                r for r in self.readback_rows if str(r.get("id")) in wanted
            ])
        return FakeResp(200, self.readback_rows)

    def request(self, method, url, headers=None, params=None):
        if method == "DELETE":
            self.deletes.append(params)
            if self.delete_status >= 300:
                return FakeResp(self.delete_status, [])
            requested = []
            raw_filter = (params or {}).get("id", "")
            if raw_filter.startswith("in.(") and raw_filter.endswith(")"):
                requested = raw_filter[4:-1].split(",")
            removed = [
                r for r in self.inserted_rows
                if not requested or str(r.get("id")) in requested
            ]
            removed_ids = {str(r.get("id")) for r in removed}
            self.readback_rows = [
                r for r in self.readback_rows
                if str(r.get("id")) not in removed_ids
            ]
            return FakeResp(self.delete_status, removed)
        return FakeResp(200, [])


# ── A merchant page carrying REAL structured product data ────────────────────

REAL_PAGE = """
<html><head>
<script type="application/ld+json">
{"@type":"Product","name":"Handwoven Boho Jute Rug 5x7",
 "image":"https://cdn.merchant.example/rug.jpg",
 "brand":"LoomAndLeaf",
 "offers":{"@type":"Offer","price":"129.00","priceCurrency":"USD",
           "availability":"https://schema.org/InStock"}}
</script>
<title>Handwoven Boho Jute Rug 5x7 | LoomAndLeaf</title>
</head><body>Handwoven Boho Jute Rug 5x7</body></html>
"""

# A page with NO usable product data at all (200 but nothing extractable). The <title>
# is <=3 chars so _clean_title yields nothing → no name → detail_fetch_status not_found.
EMPTY_200_PAGE = "<html><head><title>Lo</title></head><body>hi</body></html>"


def _card(url, **over):
    """A Shop-the-Look product-card dict as produced by _prepare_candidate, deliberately
    stuffed with FABRICATED card fields to prove they are discarded."""
    c = {
        "product_url": url,
        "source_pin_id": "PIN123",
        "source_pin_url": "https://www.pinterest.com/pin/PIN123/",
        "source_pin_image_url": "https://i.pinimg.com/originals/pinimg.jpg",
        "source_pin_title": "gorgeous boho rug inspo",
        "source_category": "home-decor",
        "source_pin_save_count": 4200,
        "seed_keyword": "boho rug",
        "domain": core.get_domain(url),
        # ── FABRICATED CARD ENRICHMENT — must NEVER reach the written row ──
        "product_title": "FAKE CARD TITLE THAT MUST BE DROPPED",
        "merchant": "FAKE CARD MERCHANT",
        "image_url": "https://i.pinimg.com/originals/pinimg.jpg",
        "price": "999.99",
        "currency": "EUR",
    }
    c.update(over)
    return c


class TestCardFabricationDiscarded(unittest.TestCase):
    def test_vps_backend_environment_is_a_supported_supabase_authority(self):
        url, key = core._resolve_supabase_config(
            {"SUPABASE_URL": "https://vps.example/", "SUPABASE_SERVICE_ROLE_KEY": "vps-key"},
            {"SUPABASE_URL": "https://backend-file.example", "SUPABASE_SERVICE_ROLE_KEY": "file-key"},
            {"NEXT_PUBLIC_SUPABASE_URL": "https://web.example", "SUPABASE_SERVICE_ROLE_KEY": "web-key"},
        )
        self.assertEqual(url, "https://vps.example")
        self.assertEqual(key, "vps-key")

    def test_backend_env_fallback_precedes_local_web_env(self):
        url, key = core._resolve_supabase_config(
            {},
            {"SUPABASE_URL": "https://backend.example", "SUPABASE_SERVICE_ROLE_KEY": "backend-key"},
            {"NEXT_PUBLIC_SUPABASE_URL": "https://web.example", "SUPABASE_SERVICE_ROLE_KEY": "web-key"},
        )
        self.assertEqual(url, "https://backend.example")
        self.assertEqual(key, "backend-key")

    def test_card_fields_are_dropped_url_kept_page_revisited(self):
        url = "https://loomandleaf.example/products/boho-jute-rug"
        cands = stl._stl_candidates([_card(url)])
        self.assertEqual(len(cands), 1)
        cand = cands[0]
        # The candidate 'pin' carries ONLY provenance — no card enrichment leaked in.
        self.assertEqual(cand["url"], url)
        self.assertEqual(cand["pin"]["seed_keyword"], "boho rug")
        self.assertEqual(cand["pin"]["category"], "home-decor")
        self.assertNotIn("product_title", cand["pin"])
        self.assertNotIn("price", cand["pin"])
        self.assertNotIn("merchant", cand["pin"])
        # The pin image is present only for the RED-LINE-2 equality check, labelled Pin data.
        self.assertEqual(cand["pin"]["image_url"], "https://i.pinimg.com/originals/pinimg.jpg")

        web = FakeWebClient({url: (200, REAL_PAGE)})
        rows, failures = core.discover(web, cands, want=core.MAX_BATCH)
        # The merchant page WAS re-visited (URL kept, page fetched).
        self.assertIn(url, web.fetched, "core must re-fetch the merchant page")
        self.assertEqual(len(rows), 1, failures)
        r = rows[0]["row"]
        # Enrichment came from the PAGE, not the card.
        self.assertEqual(r["product_name"], "Handwoven Boho Jute Rug 5x7")
        self.assertEqual(r["image_url"], "https://cdn.merchant.example/rug.jpg")
        self.assertEqual(r["price"], 129.0)
        self.assertEqual(r["currency"], "USD")
        # The FABRICATED card values are gone.
        self.assertNotEqual(r["product_name"], "FAKE CARD TITLE THAT MUST BE DROPPED")
        self.assertNotEqual(r["merchant"], "FAKE CARD MERCHANT")
        self.assertNotEqual(r["price"], "999.99")
        self.assertNotEqual(r["currency"], "EUR")
        # discovery_method is outbound_link (v47), never 'stl'.
        self.assertEqual(r["discovery_method"], "outbound_link")
        self.assertIsNone(r["product_pin_id"])
        ok, v = core.check_red_lines(rows)
        self.assertTrue(ok, v)

    def test_blocked_merchant_without_image_is_rejected(self):
        # Etsy-style WAF: URL is a valid PDP, but without a merchant-proven image
        # it is discovery evidence only and must not become a Product Opportunity.
        url = "https://www.etsy.com/listing/12345/handmade-thing"
        web = FakeWebClient({url: (403, "")})
        rows, failures = core.discover(web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH)
        self.assertEqual(rows, [])
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["admissionFailReason"],
                         "missing_verified_merchant_image")

    def test_200_but_no_structured_data_is_not_found_and_null(self):
        url = "https://loomandleaf.example/products/empty"
        web = FakeWebClient({url: (200, EMPTY_200_PAGE)})
        rows, failures = core.discover(web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH)
        self.assertEqual(rows, [])
        self.assertEqual(failures[0]["admissionFailReason"],
                         "missing_verified_merchant_image")

    def test_amazon_primary_image_is_page_proven_when_metadata_omits_image(self):
        url = "https://www.amazon.com/dp/B0CPSBDQBR"
        page = """
        <html><head><title>Handwoven Boho Rug : Home & Kitchen</title></head>
        <body>Handwoven Boho Rug
          <img id="landingImage" alt="Handwoven Boho Rug"
               data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/small.jpg&quot;:[320,320],&quot;https://m.media-amazon.com/images/I/large.jpg&quot;:[1200,1200]}"
               src="https://m.media-amazon.com/images/I/fallback.jpg">
        </body></html>
        """
        web = FakeWebClient({url: (200, page)})
        rows, failures = core.discover(
            web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH
        )
        self.assertEqual(failures, [])
        self.assertEqual(
            rows[0]["row"]["image_url"],
            "https://m.media-amazon.com/images/I/large.jpg",
        )
        self.assertIn(
            "image:amazon#landingimage.data-a-dynamic-image",
            rows[0]["rec"]["evidence"],
        )
        self.assertTrue(core.check_red_lines(rows)[0])

    def test_amazon_primary_image_rule_does_not_accept_other_domains(self):
        page = (
            '<html><head><title>Named Product Here</title></head><body>'
            '<img id="landingImage" src="https://cdn.example/product.jpg">'
            'Named Product Here</body></html>'
        )
        details = core.extract_details(page, "merchant.example")
        self.assertIsNone(details["image_url"])
        self.assertFalse(any(e.startswith("image:amazon#") for e in details["evidence"]))

    def test_amazon_primary_image_still_rejects_pinterest_host(self):
        page = (
            '<html><head><title>Named Product Here : Home & Kitchen</title></head><body>'
            '<img id="landingImage" src="https://i.pinimg.com/originals/fake.jpg">'
            'Named Product Here</body></html>'
        )
        details = core.extract_details(page, "amazon.com")
        self.assertIsNone(details["image_url"])
        self.assertIn("image:REJECTED_pinterest_hosted", details["evidence"])


class TestRedLineProvenance(unittest.TestCase):
    def test_name_not_found_in_page_is_red_lined(self):
        # THE ANCHOR CASE (raket.ph 4th 100-row batch): accept_link ACCEPTS the /products/
        # PDP, but the row carries a product_name that was NOT found in the fetched page
        # (nameFoundInPage=False). accept_link's PASS must NOT bypass the RL2 provenance
        # guard. Constructed directly (a page-sourced name is inherently in the bytes, so
        # the only way to model "not found" is the recorded rec, exactly as production sees it).
        url = "https://www.raket.ph/seller/products/polo-shirt-design-background"
        self.assertTrue(core.accept_link(url)[0], "precondition: accept_link accepts the PDP")
        n = core.normalize_product_url(url)
        row = {
            "parent_pin_id": "PIN123", "source_pin_id": "PIN123",
            "source_pin_url": "https://www.pinterest.com/pin/PIN123/",
            "source_pin_image_url": "https://i.pinimg.com/x.jpg",
            "source_pin_save_count": 100, "source_pin_saves": 100,
            "source_category": "home-decor", "seed_keyword": "polo",
            "source_url": url, "canonical_product_url": n,
            "product_url_hash": core.url_hash(n), "normalized_product_url_hash": core.url_hash(n),
            "domain": "raket.ph", "discovery_method": core.DISCOVERY_METHOD,
            "product_name": "Polo shirt design background by seller",
            "image_url": None, "price": None, "currency": None, "merchant": None,
            "availability": None, "detail_fetch_status": core.DETAIL_AVAILABLE,
            "product_pin_id": None, "inspiration_only": True,
            "is_user_ownable": False, "is_seed": False,
        }
        rec = {"evidence": ["name:og:title"], "nameFoundInPage": False,
               "detailFetchStatus": core.DETAIL_AVAILABLE}
        ok, v = core.check_red_lines([{"row": row, "rec": rec, "origin": "net_new"}])
        self.assertFalse(ok, "name not found in page must be red-lined")
        self.assertTrue(any("not found in the fetched merchant" in x for x in v), v)

    def test_pinterest_hosted_page_image_is_dropped(self):
        # A merchant page that (maliciously) returns a pinimg image → RED LINE 2 drops it.
        url = "https://loomandleaf.example/products/x"
        page = ('<html><head><meta property="og:title" content="Real Rug Name Here">'
                '<meta property="og:image" content="https://i.pinimg.com/originals/x.jpg">'
                '</head><body>Real Rug Name Here</body></html>')
        web = FakeWebClient({url: (200, page)})
        rows, failures = core.discover(web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH)
        self.assertEqual(rows, [])
        self.assertEqual(failures[0]["admissionFailReason"],
                         "missing_verified_merchant_image")

    def test_regional_pinterest_image_host_is_dropped(self):
        url = "https://loomandleaf.example/products/regional"
        page = ('<html><head><meta property="og:title" content="Real Rug Name Here">'
                '<meta property="og:image" content="https://i.pinimg.co/originals/x.jpg">'
                '</head><body>Real Rug Name Here</body></html>')
        web = FakeWebClient({url: (200, page)})
        rows, failures = core.discover(
            web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH
        )
        self.assertEqual(rows, [])
        self.assertEqual(failures[0]["admissionFailReason"], "missing_verified_merchant_image")

    def test_merchant_path_containing_pinimg_text_is_not_a_pinterest_host(self):
        url = "https://loomandleaf.example/products/path-text"
        image = "https://cdn.merchant.example/assets/pinimg.com-style/rug.jpg"
        page = (f'<html><head><meta property="og:title" content="Real Rug Name Here">'
                f'<meta property="og:image" content="{image}">'
                '</head><body>Real Rug Name Here</body></html>')
        web = FakeWebClient({url: (200, page)})
        rows, failures = core.discover(
            web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH
        )
        self.assertEqual(failures, [])
        self.assertEqual(rows[0]["row"]["image_url"], image)

    def test_merchant_image_equal_to_source_pin_image_is_dropped(self):
        url = "https://loomandleaf.example/products/y"
        same = "https://cdn.merchant.example/shared.jpg"
        page = (f'<html><head><meta property="og:title" content="Named Product Y">'
                f'<meta property="og:image" content="{same}">'
                f'</head><body>Named Product Y</body></html>')
        web = FakeWebClient({url: (200, page)})
        card = _card(url, source_pin_image_url=same)
        rows, failures = core.discover(web, stl._stl_candidates([card]), want=core.MAX_BATCH)
        self.assertEqual(rows, [])
        self.assertEqual(failures[0]["admissionFailReason"],
                         "missing_verified_merchant_image")


class TestEvidenceGate(unittest.TestCase):
    def test_missing_seed_keyword_fails_discovery(self):
        url = "https://loomandleaf.example/products/z"
        web = FakeWebClient({url: (200, REAL_PAGE)})
        card = _card(url, seed_keyword=None)
        rows, failures = core.discover(web, stl._stl_candidates([card]), want=core.MAX_BATCH)
        self.assertEqual(len(rows), 0)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["discoveryFailReason"], "missing_seed_keyword")

    def test_missing_category_fails_discovery(self):
        url = "https://loomandleaf.example/products/z2"
        web = FakeWebClient({url: (200, REAL_PAGE)})
        rows, failures = core.discover(web, stl._stl_candidates([_card(url, source_category=None)]),
                                       want=core.MAX_BATCH)
        self.assertEqual(len(rows), 0)
        self.assertEqual(failures[0]["discoveryFailReason"], "missing_category")

    def test_non_pdp_url_fails_discovery(self):
        # An Amazon search page is not a PDP → accept_link rejects → discovery fails.
        url = "https://www.amazon.com/s?k=boho+rug"
        web = FakeWebClient({url: (200, REAL_PAGE)})
        rows, failures = core.discover(web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH)
        self.assertEqual(len(rows), 0)
        self.assertTrue(failures[0]["discoveryFailReason"].startswith("not_a_product_detail_url"),
                        failures)

    def test_empty_and_null_url_produce_no_candidates(self):
        self.assertEqual(stl._stl_candidates([_card("")]), [])
        self.assertEqual(stl._stl_candidates([_card(None)]), [])

    def test_pinterest_internal_url_fails(self):
        url = "https://www.pinterest.com/pin/999/"
        web = FakeWebClient({url: (200, "")})
        rows, failures = core.discover(web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH)
        self.assertEqual(len(rows), 0)


class TestBatchCap(unittest.TestCase):
    def setUp(self):
        # Neutralise the polite-fetch pacing so a 20/50-URL batch does not sleep for
        # tens of seconds; the cap logic under test is independent of throttling.
        self._saved = core.MIN_INTERVAL
        core.MIN_INTERVAL = 0.0

    def tearDown(self):
        core.MIN_INTERVAL = self._saved

    def _many(self, n):
        cards = [_card(f"https://loomandleaf.example/products/p{i}") for i in range(n)]
        pages = {f"https://loomandleaf.example/products/p{i}": (200, REAL_PAGE) for i in range(n)}
        return cards, FakeWebClient(pages)

    def test_limit_20_passes(self):
        cards, web = self._many(20)
        rows, _ = core.discover(web, stl._stl_candidates(cards), want=20)
        self.assertLessEqual(len(rows), core.MAX_BATCH)
        self.assertEqual(len(rows), 20)

    def test_discover_never_exceeds_max_batch_even_with_more_candidates(self):
        cards, web = self._many(50)
        rows, _ = core.discover(web, stl._stl_candidates(cards), want=50)
        self.assertLessEqual(len(rows), core.MAX_BATCH,
                             "discover must never emit more than MAX_BATCH rows")


class TestWritePathViaFakeDB(unittest.TestCase):
    def _clean_rows(self):
        url = "https://www.etsy.com/listing/9999/thing"
        web = FakeWebClient({url: (200, REAL_PAGE)})
        rows, _ = core.discover(web, stl._stl_candidates([_card(url)]), want=core.MAX_BATCH)
        ok, v = core.check_red_lines(rows)
        assert ok, v
        return rows

    def test_plain_insert_and_successful_verify(self):
        rows = self._clean_rows()
        inserted = [{**rows[0]["row"], "id": "row1", "created_at": "2026-07-19T00:00:00+00:00"}]
        # read-back returns the same clean row → all red lines pass.
        db = FakeDBClient(inserted_rows=inserted, readback_rows=inserted)
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 1)
        self.assertEqual(len(db.posts), 1, "exactly one PLAIN INSERT")
        self.assertNotIn("rolledBack", out, "a clean batch must not roll back")
        self.assertTrue(out["postWriteVerification"]["allRedLinesPass"])
        # rollback command is scoped to the exact DB-returned primary key.
        self.assertIn("id IN ('row1')", out["rollback"])
        self.assertEqual(out["createdAtWindow"], [
            "2026-07-19T00:00:00+00:00", "2026-07-19T00:00:00+00:00",
        ])

    def test_postgrest_insert_error_surfaces_no_silent_swallow(self):
        rows = self._clean_rows()
        db = FakeDBClient(insert_status=409)   # 23505 duplicate
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 0)
        self.assertEqual(out["insertStatus"], 409)
        self.assertIn("insertError", out)
        self.assertEqual(len(db.deletes), 0, "a failed insert must not trigger a rollback")

    def test_post_write_red_line_failure_triggers_precise_rollback(self):
        rows = self._clean_rows()
        # read-back is CORRUPTED: a pinimg product image landed → RL2 fails → rollback.
        bad = [{**rows[0]["row"], "id": "row1", "created_at": "2026-07-19T00:00:00+00:00",
                "image_url": "https://i.pinimg.com/originals/bad.jpg",
                "detail_fetch_status": core.DETAIL_AVAILABLE}]
        db = FakeDBClient(inserted_rows=bad, readback_rows=bad)
        out = core.apply_rows(db, rows)
        self.assertTrue(out.get("rolledBack"), "a post-write red-line failure must roll back")
        self.assertTrue(out.get("rollbackComplete"))
        self.assertEqual(out["written"], 0,
                         "written means rows remaining after safety handling")
        self.assertEqual(len(db.deletes), 1, "exactly one precise rollback DELETE")
        params = db.deletes[0]
        self.assertEqual(params["discovery_method"], "eq.outbound_link")
        self.assertEqual(params["id"], "in.(row1)")
        self.assertNotIn("created_at", params)

    def test_one_late_duplicate_does_not_discard_other_reviewed_rows(self):
        url1 = "https://www.etsy.com/listing/9101/one"
        url2 = "https://www.etsy.com/listing/9102/two"
        web = FakeWebClient({url1: (200, REAL_PAGE), url2: (200, REAL_PAGE)})
        rows, _ = core.discover(
            web, stl._stl_candidates([_card(url1), _card(url2)]), want=2
        )

        class RaceDB(FakeDBClient):
            def __init__(self):
                super().__init__()
                self.calls = 0

            def post(self, url, headers=None, json=None):
                self.posts.append(json)
                self.calls += 1
                if self.calls in (1, 2):
                    return FakeResp(409, '{"code":"23505","message":"duplicate"}')
                landed = [{**json[0], "id": "row2",
                           "created_at": "2026-07-19T00:00:00+00:00"}]
                self.readback_rows = landed
                return FakeResp(201, landed)

        db = RaceDB()
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 1)
        self.assertEqual(out["duplicates"], 1)
        self.assertEqual(out["failed"], 0)
        self.assertEqual(len(db.posts), 3, "batch attempt plus two per-row retries")

    def test_incomplete_rollback_never_reports_zero_rows_remaining(self):
        rows = self._clean_rows()
        bad = [{**rows[0]["row"], "id": "row1",
                "created_at": "2026-07-19T00:00:00+00:00",
                "image_url": "https://i.pinimg.com/originals/bad.jpg",
                "detail_fetch_status": core.DETAIL_AVAILABLE}]
        db = FakeDBClient(inserted_rows=bad, readback_rows=bad, delete_status=500)
        out = core.apply_rows(db, rows)
        self.assertTrue(out["rolledBack"])
        self.assertFalse(out["rollbackComplete"])
        self.assertEqual(out["written"], 1,
                         "cannot claim removal when DELETE was not proven")
        self.assertIn("rollbackError", out)

    def test_failed_verification_rolls_back_exact_inserted_ids_and_reads_back_zero(self):
        rows = self._clean_rows()
        bad = [{**rows[0]["row"], "id": "row-exact-1",
                "created_at": "2026-07-19T00:00:00+00:00",
                "image_url": "https://i.pinimg.com/originals/bad.jpg",
                "detail_fetch_status": core.DETAIL_AVAILABLE}]
        db = FakeDBClient(inserted_rows=bad, readback_rows=list(bad))
        out = core.apply_rows(db, rows)
        self.assertTrue(out["rolledBack"])
        self.assertTrue(out["rollbackComplete"])
        self.assertEqual(out["written"], 0)
        self.assertEqual(db.deletes[0]["id"], "in.(row-exact-1)")
        self.assertNotIn("created_at", db.deletes[0])
        self.assertEqual(out["rollbackRemovedIds"], ["row-exact-1"])
        self.assertEqual(out["rollbackRemainingIds"], [])
        self.assertIn("id IN ('row-exact-1')", out["rollback"])

    def test_exact_id_rollback_does_not_delete_a_concurrent_row(self):
        target = {"id": "target", "created_at": "same-time"}
        concurrent = {"id": "concurrent", "created_at": "same-time"}
        db = FakeDBClient(
            inserted_rows=[target, concurrent],
            readback_rows=[target, concurrent],
        )
        res = core.rollback_ids(db, ["target"])
        self.assertTrue(res["complete"])
        self.assertEqual(res["removedIds"], ["target"])
        self.assertEqual([r["id"] for r in db.readback_rows], ["concurrent"])

    def test_rollback_window_is_scoped_to_outbound_link(self):
        db = FakeDBClient(delete_status=200)
        res = core.rollback_window(db, "2026-07-19T00:00:00+00:00", "2026-07-19T00:05:00+00:00")
        self.assertEqual(res["status"], 200)
        self.assertEqual(db.deletes[0]["discovery_method"], "eq.outbound_link")

    def test_dry_run_style_no_db_client_no_write(self):
        # Building candidates + discover + check_red_lines writes NOTHING: no DB client
        # is ever constructed here. This mirrors the dry-run path.
        rows = self._clean_rows()
        ok, _ = core.check_red_lines(rows)
        self.assertTrue(ok)
        # No FakeDBClient instantiated → provably zero writes.


class _CoexistDBClient(FakeDBClient):
    """A FakeDBClient whose coexistence read-back (source_url=eq.<url>) returns BOTH a
    retired and an active row on the URL, so a retired_reclaim batch can PASS RED LINE 4.
    Every other read-back (created_at window) still returns the clean readback_rows."""
    def __init__(self, coexist_url, **kw):
        super().__init__(**kw)
        self.coexist_url = coexist_url

    def get(self, url, headers=None):
        self.gets.append(url)
        if "source_url=eq." in url:
            return FakeResp(200, [
                {"id": "retired-1", "lifecycle_status": "retired",
                 "discovery_method": "outbound_link", "source_url": self.coexist_url},
                {"id": "active-1", "lifecycle_status": "active",
                 "discovery_method": "outbound_link", "source_url": self.coexist_url},
            ])
        return FakeResp(200, self.readback_rows)


class TestOriginFailClosed(unittest.TestCase):
    """Commit H — the origin fail-closed contract. Missing / None / empty / misspelled /
    unknown origin is refused BEFORE any write; RED LINE 4 applicability is decided by a
    KNOWN origin only, never by silently defaulting an unknown one to net_new."""

    ETSY = "https://www.etsy.com/listing/9999/thing"

    def _clean_rows(self, origin="net_new"):
        """One red-line-clean row (blocked-enrichment Etsy PDP) with the given origin."""
        web = FakeWebClient({self.ETSY: (200, REAL_PAGE)})
        rows, _ = core.discover(web, stl._stl_candidates([_card(self.ETSY)]), want=core.MAX_BATCH)
        assert rows, "precondition: discover produced a row"
        for item in rows:
            item["origin"] = origin
        return rows

    # ── ALLOWED_ORIGINS vocabulary ───────────────────────────────────────────
    def test_allowed_origins_exact_membership(self):
        self.assertEqual(core.ALLOWED_ORIGINS, {"net_new", "retired_reclaim"})
        self.assertTrue(core.is_allowed_origin("net_new"))
        self.assertTrue(core.is_allowed_origin("retired_reclaim"))
        for bad in (None, "", "   ", "netnew", "net-new", "NET_NEW", "reclaim",
                    "retired", 0, 1, [], {}):
            self.assertFalse(core.is_allowed_origin(bad), f"{bad!r} must be rejected")

    # ── net_new: legal, and RED LINE 4 is NOT applicable ─────────────────────
    def test_net_new_passes_and_rl4_not_applicable(self):
        rows = self._clean_rows("net_new")
        ok, v = core.check_red_lines(rows)
        self.assertTrue(ok, v)
        inserted = [{**rows[0]["row"], "id": "r1", "created_at": "2026-07-19T00:00:00+00:00"}]
        db = FakeDBClient(inserted_rows=inserted, readback_rows=inserted)
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 1)
        rl4 = out["postWriteVerification"]["redLine4_lifecycleCoexistence"]
        self.assertFalse(rl4["applicable"], "net_new → RL4 not applicable")
        self.assertTrue(rl4["pass"], "net_new → RL4 vacuously passes")
        self.assertNotIn("rolledBack", out)

    # ── retired_reclaim with coexistence proven → PASS ───────────────────────
    def test_retired_reclaim_coexistence_pass(self):
        rows = self._clean_rows("retired_reclaim")
        ok, v = core.check_red_lines(rows)
        self.assertTrue(ok, v)
        inserted = [{**rows[0]["row"], "id": "r1", "created_at": "2026-07-19T00:00:00+00:00"}]
        db = _CoexistDBClient(self.ETSY, inserted_rows=inserted, readback_rows=inserted)
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 1)
        rl4 = out["postWriteVerification"]["redLine4_lifecycleCoexistence"]
        self.assertTrue(rl4["applicable"], "retired_reclaim → RL4 applicable")
        self.assertTrue(rl4["pass"], "coexistence proven → RL4 passes")
        self.assertNotIn("rolledBack", out)

    # ── retired_reclaim with NO coexistence → post-write FAIL → rollback ──────
    def test_retired_reclaim_missing_coexistence_fails_and_rolls_back(self):
        rows = self._clean_rows("retired_reclaim")
        inserted = [{**rows[0]["row"], "id": "r1", "created_at": "2026-07-19T00:00:00+00:00"}]
        # default FakeDBClient returns [] for the source_url=eq. coexistence read-back →
        # neither retired nor active present → coexists=False → RL4 fails → rollback.
        db = FakeDBClient(inserted_rows=inserted, readback_rows=inserted)
        out = core.apply_rows(db, rows)
        rl4 = out["postWriteVerification"]["redLine4_lifecycleCoexistence"]
        self.assertTrue(rl4["applicable"])
        self.assertFalse(rl4["pass"], "no coexistence → RL4 must fail")
        self.assertTrue(out.get("rolledBack"), "RL4 failure must roll back")
        self.assertEqual(len(db.deletes), 1)

    # ── mixed batch: only the retired_reclaim row must prove coexistence ──────
    def test_mixed_batch_only_retired_reclaim_requires_coexistence(self):
        net = "https://www.etsy.com/listing/111/net-new-thing"
        ret = "https://www.etsy.com/listing/222/reclaimed-thing"
        web = FakeWebClient({net: (200, REAL_PAGE), ret: (200, REAL_PAGE)})
        cands = stl._stl_candidates([_card(net), _card(ret)])
        rows, _ = core.discover(web, cands, want=core.MAX_BATCH)
        self.assertEqual(len(rows), 2)
        # label the two rows by URL
        for item in rows:
            item["origin"] = "retired_reclaim" if item["row"]["source_url"] == ret else "net_new"
        ok, v = core.check_red_lines(rows)
        self.assertTrue(ok, v)
        inserted = [{**it["row"], "id": f"r{i}", "created_at": "2026-07-19T00:00:00+00:00"}
                    for i, it in enumerate(rows)]
        db = _CoexistDBClient(ret, inserted_rows=inserted, readback_rows=inserted)
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 2)
        rl4 = out["postWriteVerification"]["redLine4_lifecycleCoexistence"]
        self.assertTrue(rl4["applicable"])
        # exactly ONE pair checked (the retired_reclaim row); the net_new row is not.
        self.assertEqual(len(rl4["pairs"]), 1)
        self.assertEqual(rl4["pairs"][0]["url"], ret)
        self.assertTrue(rl4["pass"])

    # ── missing origin → check_red_lines violation + apply_rows refuses pre-write
    def test_missing_origin_is_red_lined_and_refused_pre_write(self):
        rows = self._clean_rows("net_new")
        del rows[0]["origin"]                      # origin entirely absent
        ok, v = core.check_red_lines(rows)
        self.assertFalse(ok, "missing origin must be a red-line violation")
        self.assertTrue(any("unknown origin" in x and "<missing>" in x for x in v), v)
        db = FakeDBClient()
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 0)
        self.assertIn("preWriteViolations", out)
        self.assertEqual(len(db.posts), 0, "MISSING origin: zero DB POSTs")
        self.assertEqual(len(db.deletes), 0, "no rollback for a pre-write refusal")
        self.assertNotIn("postWriteVerification", out)

    def test_none_and_empty_origin_refused_pre_write(self):
        for bad in (None, "", "   "):
            rows = self._clean_rows("net_new")
            rows[0]["origin"] = bad
            ok, v = core.check_red_lines(rows)
            self.assertFalse(ok, f"origin={bad!r} must be red-lined")
            db = FakeDBClient()
            out = core.apply_rows(db, rows)
            self.assertEqual(out["written"], 0)
            self.assertEqual(len(db.posts), 0, f"origin={bad!r}: zero DB POSTs")

    # ── unknown / misspelled origin → refused; FakeDB POST count == 0 ────────
    def test_unknown_origin_refused_and_zero_db_posts(self):
        for bad in ("net-new", "netnew", "NET_NEW", "reclaim", "retired", "garbage"):
            rows = self._clean_rows("net_new")
            rows[0]["origin"] = bad
            ok, v = core.check_red_lines(rows)
            self.assertFalse(ok, f"origin={bad!r} must be red-lined (not silently net_new)")
            self.assertTrue(any("unknown origin" in x for x in v), v)
            db = FakeDBClient()
            out = core.apply_rows(db, rows)
            self.assertEqual(out["written"], 0)
            self.assertEqual(len(db.posts), 0,
                             f"UNKNOWN origin {bad!r}: FakeDB POST count must be 0")
            self.assertEqual(len(db.deletes), 0)
            self.assertIn("preWriteViolations", out)

    # ── the bypass proof: apply_rows CANNOT be tricked past check_red_lines ──
    def test_apply_rows_self_gates_even_when_caller_skips_check(self):
        # Caller deliberately does NOT run check_red_lines and feeds an unknown origin.
        rows = self._clean_rows("net_new")
        rows[0]["origin"] = "totally_made_up"
        db = FakeDBClient()
        out = core.apply_rows(db, rows)               # no prior check_red_lines call
        self.assertEqual(out["written"], 0, "apply_rows must self-gate")
        self.assertEqual(len(db.posts), 0, "no POST reached the DB via the bypass path")
        self.assertIn("preWriteViolations", out)

    def test_apply_rows_self_gates_on_a_field_red_line_too(self):
        # A field red-line (fabricated product_name without a page) must ALSO stop
        # apply_rows pre-write, not only the origin gate.
        rows = self._clean_rows("net_new")
        rows[0]["row"]["product_name"] = "Invented Name Never On A Page"
        rows[0]["row"]["detail_fetch_status"] = core.DETAIL_NOT_FOUND
        db = FakeDBClient()
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 0)
        self.assertEqual(len(db.posts), 0, "field red-line must also block the POST")
        self.assertIn("preWriteViolations", out)

    def test_apply_rows_self_gates_missing_merchant_image(self):
        rows = self._clean_rows("net_new")
        rows[0]["row"]["image_url"] = None
        db = FakeDBClient()
        out = core.apply_rows(db, rows)
        self.assertEqual(out["written"], 0)
        self.assertEqual(len(db.posts), 0, "missing image must fail before DB POST")
        self.assertTrue(any(
            "merchant product image is required" in message
            for message in out.get("preWriteViolations", [])
        ))


class TestSameCoreSharedByBothCallers(unittest.TestCase):
    def test_t2_and_stl_share_the_identical_red_line_functions(self):
        spec = importlib.util.spec_from_file_location("t2_harvest", str(BACKEND / "tools" / "t2_harvest.py"))
        t2 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(t2)
        for name in ("check_red_lines", "discover", "assert_evidence", "verify_written",
                     "extract_details", "enc_ts"):
            self.assertIs(getattr(t2, name), getattr(core, name),
                          f"{name}: t2 must re-export the SAME core object")
        self.assertIs(stl.supply_core.check_red_lines, core.check_red_lines)
        self.assertIs(stl.supply_core.apply_rows, core.apply_rows)
        self.assertEqual(core.DISCOVERY_METHOD, "outbound_link")


if __name__ == "__main__":
    unittest.main()
