"""
t2_apply_batch.py — 数据侧任务书 v1.1 T2 bounded apply (首批 ≤100 行, insert-only).

Reads backend/tools/t2_batch1_candidates.json (produced by the T2 preparation step)
and INSERTs those Outbound-Link product rows into pin_products. This is the ONLY
script permitted to write the first Outbound-Link batch.

HARD CONSTRAINTS (decision-maker approved — enforced in code, not just prose):
  * ≤100 rows            — MAX_BATCH assert; refuses to run on a larger candidate file.
  * insert-only          — uses PostgREST POST with resolution=ignore-duplicates
                           (ON CONFLICT DO NOTHING). NEVER updates or deletes. Never
                           touches Shop-the-Look rows.
  * column whitelist     — every payload key must be in ALLOWED_COLUMNS; any stray key
                           aborts the run before any write.
  * discovery_method     — every row MUST be exactly 'outbound_link'.
  * dedup re-check       — BEFORE writing, re-queries pin_products live and drops any
                           row whose (parent_pin_id, normalized URL) or normalized URL
                           already exists in a NON-RETIRED row (the 398-net-new guarantee
                           can go stale between candidate build and apply).
                           LIFECYCLE: rows soft-retired by T10 (lifecycle_status='retired')
                           are EXCLUDED from the "already exists" sets — a retired row must
                           not permanently blacklist its source_url from re-collection.
                           Old retired row (source_url=A) and new active row (source_url=A)
                           coexist by design. See backend/product_lifecycle.py.
  * uniform time window  — rows are written in one pass; created_at is DB-default now()
                           for the whole batch, giving a single rollback window.
  * NO scoring is run.

USAGE
  # validate payload only, write nothing (safe, default-safe):
  py t2_apply_batch.py --dry-run
  # actually insert (BLOCKED until a human applies migrate_v45 + passes --confirm-write):
  py t2_apply_batch.py --apply --confirm-write

ROLLBACK (single SQL, prints the exact window after a real apply):
  DELETE FROM pin_products
   WHERE discovery_method = 'outbound_link'
     AND created_at BETWEEN '<lo>' AND '<hi>';
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]           # repo root
BACKEND = Path(__file__).resolve().parents[1]        # backend/
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
from product_lifecycle import (  # noqa: E402  (path bootstrap must run first)
    LIFECYCLE_STATUS_COLUMN,
    NOT_RETIRED_OR_EXPR,
    is_retired,
)

CANDIDATES = Path(__file__).resolve().parent / "t2_batch1_candidates.json"
ENV = dotenv_values(ROOT / "web" / ".env.local")

SUPABASE_URL = ENV.get("NEXT_PUBLIC_SUPABASE_URL", "")
SERVICE_KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")

MAX_BATCH = 100
DISCOVERY_METHOD = "outbound_link"

# The ONLY columns this script is permitted to send. Every one exists in the live
# pin_products schema (probed 2026-07-13). source_pin_image_url / source_pin_saves
# require migrate_v45 to be applied first.
ALLOWED_COLUMNS = {
    "parent_pin_id",            # source Pin id (traceability key; §3 parent_pin_id ← source pin_id)
    "source_pin_id",
    "source_pin_url",
    "source_pin_image_url",     # NEW (v45): image of the source Pin
    "source_pin_save_count",    # legacy source-Pin saves (kept in sync for old readers)
    "source_pin_saves",         # NEW (v45): §3-named source-Pin saves field
    "product_pin_id",           # NULL for outbound (no product pin)
    "product_name",             # product_title (NOT NULL in schema)
    "price",
    "currency",
    "source_url",               # product detail page URL (§3 product_url)
    "canonical_product_url",
    "product_url_hash",
    "normalized_product_url_hash",
    "domain",                   # merchant_domain (§3)
    "image_url",                # REAL product image (§3 product_image_url) — never source Pin img
    "source_category",          # §3 category (source Pin category; womens-fashion stays verbatim)
    "seed_keyword",
    "inspiration_only",
    "is_user_ownable",
    "is_seed",
    "discovery_method",
}

# ── URL normalization — TASK-SPEC (decision-maker approved dedup key) ─────────
# 归一化 = 去 ALL query（含 utm）/去 fragment/统一小写 host/去 www./去尾斜杠。
# NOTE: intentionally STRICTER than product_harvest.normalize_product_url (which
# keeps non-tracking query params). Both sides of every dedup comparison in this
# script use THIS normalization, matching the candidate builder and T1 §6 口径 —
# a candidate differing from an existing row only by query params counts as dup.
from urllib.parse import urlsplit, urlunsplit
import hashlib


def normalize_product_url(url: str) -> str:
    if not url:
        return ""
    try:
        s = urlsplit(url.strip())
        host = (s.netloc or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return urlunsplit(((s.scheme or "https").lower(), host,
                           s.path.rstrip("/"), "", ""))
    except Exception:
        return url.strip().lower()


def url_hash(n: str) -> str:
    return hashlib.sha1(n.encode("utf-8")).hexdigest()


# ── DB helpers (read + insert-only) ──────────────────────────────────────────

def _headers(extra: dict | None = None) -> dict:
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def _page_all(client: httpx.Client, table: str, select: str, filt: str, order: str) -> list[dict]:
    out: list[dict] = []
    off = 0
    while True:
        r = client.get(
            f"{SUPABASE_URL}/rest/v1/{table}?select={select}&{filt}&order={order}",
            headers=_headers({"Range-Unit": "items", "Range": f"{off}-{off+999}"}))
        chunk = r.json()
        if not isinstance(chunk, list):
            raise RuntimeError(f"select {table} failed: {chunk}")
        out += chunk
        if len(chunk) < 1000:
            break
        off += 1000
    return out


def _existing_dedup_sets(client: httpx.Client) -> tuple[set, set]:
    """Live (pin_id, normURL) and normURL-anywhere sets from the ACTIVE pin_products rows.

    LIFECYCLE FILTER (migrate_v46 / T10) — the point of this whole function:
    a soft-retired row (lifecycle_status='retired') must NOT count as "this URL already
    exists". If it did, the 798 T10-retired source_urls could never be re-collected and
    the soft retirement would silently become a permanent blacklist.

    The filter is `lifecycle_status IS DISTINCT FROM 'retired'`, expressed to PostgREST
    as the OR form `or=(lifecycle_status.is.null,lifecycle_status.neq.retired)`.
    A bare `lifecycle_status=neq.retired` would NOT match NULL rows — and every
    non-T10 row has lifecycle_status=NULL — so it would drop the entire ACTIVE corpus
    from the dedup sets and re-insert duplicates of live data. Do not "simplify" it.

    lifecycle_status is also SELECTed and re-asserted client-side, so that if the column
    is ever dropped / the filter silently stops applying, this hard-fails instead of
    quietly writing duplicates.
    """
    rows = _page_all(client, "pin_products",
                     f"parent_pin_id,source_pin_id,source_url,canonical_product_url,{LIFECYCLE_STATUS_COLUMN}",
                     f"or=({NOT_RETIRED_OR_EXPR})", "id.asc")
    norm_any: set = set()
    pin_norm: set = set()
    retired_leaked = 0
    for e in rows:
        # Belt-and-braces: the server-side filter should already have excluded these.
        if is_retired(e):
            retired_leaked += 1
            continue
        # Re-normalize with the task-spec scheme. Do NOT trust the stored
        # canonical_product_url here: legacy rows built it with the older
        # param-keeping normalization, which would miss query-param-only dups.
        n = normalize_product_url(e.get("source_url") or e.get("canonical_product_url") or "")
        if n:
            norm_any.add(n)
            for pid in (e.get("parent_pin_id"), e.get("source_pin_id")):
                if pid:
                    pin_norm.add((pid, n))
    if retired_leaked:
        raise RuntimeError(
            f"lifecycle filter did not apply server-side: {retired_leaked} retired rows "
            "came back from PostgREST. Refusing to build dedup sets.")
    print(f"dedup scope: {len(rows)} ACTIVE pin_products rows "
          f"(retired rows excluded — their URLs stay re-collectable)")
    return pin_norm, norm_any


# ── Payload validation ───────────────────────────────────────────────────────

def validate(rows: list[dict]) -> None:
    assert len(rows) <= MAX_BATCH, f"batch size {len(rows)} exceeds MAX_BATCH={MAX_BATCH}"
    for i, r in enumerate(rows):
        stray = set(r.keys()) - ALLOWED_COLUMNS
        assert not stray, f"row {i}: disallowed columns {stray}"
        assert r.get("discovery_method") == DISCOVERY_METHOD, \
            f"row {i}: discovery_method must be '{DISCOVERY_METHOD}'"
        assert r.get("product_pin_id") is None, f"row {i}: outbound rows must have product_pin_id=NULL"
        assert r.get("product_name"), f"row {i}: product_name (NOT NULL) missing"
        assert r.get("source_url"), f"row {i}: source_url missing"
        assert r.get("parent_pin_id"), f"row {i}: parent_pin_id (traceability) missing"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="validate + dedup-check, write nothing (default)")
    ap.add_argument("--apply", action="store_true", help="perform the insert (requires --confirm-write)")
    ap.add_argument("--confirm-write", action="store_true", help="explicit second gate for a real write")
    args = ap.parse_args()

    if not CANDIDATES.exists():
        print(f"ERROR: candidate file not found: {CANDIDATES}")
        return 2
    rows = json.loads(CANDIDATES.read_text(encoding="utf-8"))
    print(f"loaded {len(rows)} candidate rows from {CANDIDATES.name}")

    validate(rows)
    print("payload validation OK (size cap, column whitelist, discovery_method, product_pin NULL)")

    with httpx.Client(timeout=60) as client:
        pin_norm, norm_any = _existing_dedup_sets(client)
        print(f"live pin_products dedup sets: pin+norm={len(pin_norm)} norm={len(norm_any)}")

        fresh: list[dict] = []
        dropped = 0
        for r in rows:
            n = r.get("canonical_product_url") or normalize_product_url(r.get("source_url") or "")
            pid = r.get("parent_pin_id")
            if (pid, n) in pin_norm or n in norm_any:
                dropped += 1
                continue
            fresh.append(r)
        print(f"online dedup re-check: {dropped} already-existing dropped, {len(fresh)} remain")

        # payload previews
        for r in fresh[:3]:
            print("  PAYLOAD:", json.dumps({
                "parent_pin_id": r.get("parent_pin_id"), "product_name": r.get("product_name")[:50],
                "source_url": (r.get("source_url") or "")[:60], "domain": r.get("domain"),
                "price": r.get("price"), "discovery_method": r.get("discovery_method"),
            }, ensure_ascii=False))

        if not (args.apply and args.confirm_write):
            print("\nDRY-RUN: no write performed. "
                  "To write: apply migrate_v45 in SQL Editor, then run with --apply --confirm-write.")
            return 0

        # ── real write path (guarded) ───────────────────────────────────────
        assert len(fresh) <= MAX_BATCH, "post-dedup batch exceeds cap"
        lo = datetime.now(timezone.utc).isoformat()
        resp = client.post(
            f"{SUPABASE_URL}/rest/v1/pin_products",
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=representation"}),
            params={"on_conflict": "normalized_product_url_hash"},
            json=fresh)
        hi = datetime.now(timezone.utc).isoformat()
        if resp.status_code not in (200, 201):
            print(f"INSERT FAILED [{resp.status_code}]: {resp.text[:400]}")
            return 1
        inserted = resp.json()
        ids = [x.get("id") for x in inserted]
        print(f"\nINSERTED {len(inserted)} rows.")
        print("inserted ids:", ids)
        print(f"created_at window: {lo}  ..  {hi}")
        print("ROLLBACK SQL:")
        print(f"  DELETE FROM pin_products WHERE discovery_method='{DISCOVERY_METHOD}' "
              f"AND created_at BETWEEN '{lo}' AND '{hi}';")
        return 0


if __name__ == "__main__":
    sys.exit(main())
