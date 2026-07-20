"""Tests for the PostgREST timestamp-filter encoding fix in tools/t2_harvest.py.

THE BUG: an ISO-8601 timestamp ends in '+00:00'. Interpolated raw into a URL query
string, the '+' decodes to a SPACE, so PostgREST received an invalid timestamp
('...88254 00:00') → HTTP 400. That 400 (a JSON error object, not a row list) then
crashed verify_written() with AttributeError, so the post-write red-line verification
never ran and the printed rollback window matched zero rows.

These tests pin the fix: enc_ts() percent-encodes the timestamp (esp. '+' → %2B) and
the same encoder is used for every timestamp that enters a PostgREST filter value.
"""
import importlib.util
import os
import sys
import unittest
from pathlib import Path

import httpx
from dotenv import dotenv_values

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
for p in (str(BACKEND), str(BACKEND / "db"), str(BACKEND / "tools")):
    if p not in sys.path:
        sys.path.insert(0, p)

# Import the tool module directly (it lives under tools/, not an importable package).
_spec = importlib.util.spec_from_file_location("t2_harvest", str(BACKEND / "tools" / "t2_harvest.py"))
t2 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(t2)

TIMESTAMPS = (
    "2026-07-18T12:34:56+00:00",
    "2026-07-18T12:34:56.123456+00:00",
)


class TestEncTs(unittest.TestCase):
    def test_plus_is_percent_encoded(self):
        for ts in TIMESTAMPS:
            enc = t2.enc_ts(ts)
            self.assertNotIn("+", enc, f"raw '+' survived encoding for {ts}: {enc}")
            self.assertIn("%2B", enc, f"'+' was not encoded to %2B for {ts}: {enc}")
            # colons in the time component are encoded too (safe='')
            self.assertNotIn(":", enc)

    def test_encoded_value_roundtrips_through_a_url(self):
        # Building a real query URL with the encoded value must decode back to the exact
        # instant — i.e. no '+'→space corruption of the UTC offset.
        for ts in TIMESTAMPS:
            url = httpx.URL(f"https://example.supabase.co/rest/v1/pin_products"
                            f"?created_at=gte.{t2.enc_ts(ts)}")
            # httpx.URL.params decodes the query; the offset must still be '+00:00'.
            val = url.params.get("created_at")
            self.assertEqual(val, f"gte.{ts}", f"round-trip corrupted {ts} -> {val}")

    def test_matches_httpx_params_encoding(self):
        # enc_ts must agree with what httpx params= produces, so string-interpolated
        # URLs and params=-built URLs delete/read the SAME rows.
        for ts in TIMESTAMPS:
            req = httpx.Request("GET", "https://x.co/y", params={"created_at": f"gte.{ts}"})
            from_params = str(req.url).split("created_at=", 1)[1]
            from_enc = f"gte.{t2.enc_ts(ts)}"
            self.assertEqual(from_params, from_enc,
                             f"enc_ts diverges from httpx params for {ts}")

    def test_raw_interpolation_would_have_corrupted_the_offset(self):
        # Documents the original bug: raw interpolation yields a literal '+', which a URL
        # parser reads as a space. enc_ts is exactly what prevents this.
        for ts in TIMESTAMPS:
            raw_url = httpx.URL(f"https://x.co/y?created_at=gte.{ts}")
            corrupted = raw_url.params.get("created_at")
            self.assertIn(" ", corrupted, "expected the raw '+' to decode to a space")
            self.assertNotEqual(corrupted, f"gte.{ts}")


class TestRequireListGuard(unittest.TestCase):
    def test_error_object_raises_not_attribute_errors(self):
        # A PostgREST 400 returns a dict; _require_list must raise a clear RuntimeError
        # instead of letting the dict flow into row-shaped code (the original crash).
        class _Resp:
            status_code = 400
            def json(self):
                return {"code": "22007", "message": "invalid input syntax for type timestamp"}
        with self.assertRaises(RuntimeError):
            t2._require_list(_Resp(), "unit")

    def test_list_passes_through(self):
        class _Resp:
            status_code = 200
            def json(self):
                return [{"id": 1}]
        self.assertEqual(t2._require_list(_Resp(), "unit"), [{"id": 1}])


@unittest.skipUnless(
    dotenv_values(ROOT / "web" / ".env.local").get("NEXT_PUBLIC_SUPABASE_URL")
    and dotenv_values(ROOT / "web" / ".env.local").get("SUPABASE_SERVICE_ROLE_KEY"),
    "live Supabase creds not available")
class TestPostgrestAcceptsEncodedTimestamp(unittest.TestCase):
    """Live round-trip: the encoded timestamp must be ACCEPTED by PostgREST (HTTP 200,
    JSON list), whereas the raw '+' form returns HTTP 400. Read-only; writes nothing."""

    @classmethod
    def setUpClass(cls):
        env = dotenv_values(ROOT / "web" / ".env.local")
        cls.url = env["NEXT_PUBLIC_SUPABASE_URL"]
        cls.key = env["SUPABASE_SERVICE_ROLE_KEY"]
        cls.H = {"apikey": cls.key, "Authorization": f"Bearer {cls.key}"}

    def test_encoded_timestamp_accepted(self):
        ts = "2026-07-18T12:34:56.123456+00:00"
        with httpx.Client(timeout=30) as c:
            r = c.get(f"{self.url}/rest/v1/pin_products"
                      f"?select=id&created_at=gte.{t2.enc_ts(ts)}&limit=1", headers=self.H)
            self.assertEqual(r.status_code, 200, r.text[:200])
            self.assertIsInstance(r.json(), list)

    def test_raw_plus_is_rejected(self):
        ts = "2026-07-18T12:34:56.123456+00:00"
        with httpx.Client(timeout=30) as c:
            # raw '+' interpolation (the bug) → PostgREST sees a space → 400
            r = c.get(f"{self.url}/rest/v1/pin_products"
                      f"?select=id&created_at=gte.{ts}&limit=1", headers=self.H)
            self.assertEqual(r.status_code, 400)
            body = r.json()
            self.assertIsInstance(body, dict)
            self.assertIn("22007", str(body.get("code", "")) + str(body))


if __name__ == "__main__":
    unittest.main()
