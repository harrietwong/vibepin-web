"""t10_retire_apply.py — 数据侧任务书 v1.1 T10 阶段 2: soft-retire the 798-row
historical outbound_link_bootstrap dirty batch.

The ONLY script permitted to perform the T10 retirement write.

HARD CONSTRAINTS (decision-maker approved — enforced in code, not just prose):
  * id-list-keyed ONLY  — the UPDATE targets exactly the 798 ids captured in
                          t10_retire_snapshot.json. NEVER a broad predicate
                          (no `WHERE discovery_method=...`, no time window):
                          created_at spans 2026-06-01 → 2026-07-09 with no clean
                          boundary, so the id list is the only safe key.
  * NO hard delete      — soft retirement only.
  * NO field overwrite  — these five stay byte-for-byte identical, verified by a
                          full before/after diff of ALL 798 rows:
                            discovery_method, parent_pin_id, source_url,
                            source_pin_save_count, created_at
  * writes ONLY         — lifecycle_status / retired_at / retirement_reason /
                          retirement_batch_id
  * NULL-HASH GUARDRAIL — refuses to retire ANY row whose normalized_product_url_hash
                          is NOT NULL. See below. Aborts the whole run; never partial.
  * no crawling, no scoring, no paid model calls.

THE NULL-HASH GUARDRAIL (why retiring a hash-bearing row would lose real products)
---------------------------------------------------------------------------------
idx_pin_products_normalized_product_url_hash (v29) is a FULL-TABLE UNIQUE index:

    CREATE UNIQUE INDEX idx_pin_products_normalized_product_url_hash
      ON public.pin_products USING btree (normalized_product_url_hash);

It has NO partial WHERE clause, so a soft-retired row still OCCUPIES its hash slot —
retirement is invisible to the index. Consequences:

  * Postgres treats NULLs as mutually non-conflicting, so many rows may hold
    hash = NULL simultaneously. The T10 batch is entirely hash = NULL (798/798,
    verified live), which is exactly why retiring it was safe: a later re-harvest of
    the same product URL inserts a NEW active row with a real hash and no conflict.

  * But retiring a row whose hash is NOT NULL would leave that hash claimed forever.
    A future re-harvest of the same product URL would collide on the unique index —
    and because the harvester inserts with PostgREST `resolution=ignore-duplicates`
    (ON CONFLICT DO NOTHING, see t2_apply_batch.py), the collision is NOT an error:
    the new, GOOD row is SILENTLY DROPPED. The product becomes permanently
    un-reharvestable, with no failure anywhere to notice. That is real product loss.

So: retiring a hash-bearing row is only safe once that index is made partial
(e.g. ... WHERE lifecycle_status IS DISTINCT FROM 'retired') or the harvester stops
ignoring duplicates. Until then this tool hard-refuses such rows.

The guardrail does NOT apply to --rollback: rolling back only CLEARS retirement
flags, it never creates a new retired row, so it cannot claim a hash slot.

USAGE
  py t10_retire_apply.py --dry-run                 # verify only, write nothing (default)
  py t10_retire_apply.py --apply --confirm-write   # perform the retirement
  py t10_retire_apply.py --rollback --confirm-write  # un-retire the batch

ROLLBACK SQL (id-exact, also emitted after a real apply):
  UPDATE pin_products
     SET lifecycle_status=NULL, retired_at=NULL,
         retirement_reason=NULL, retirement_batch_id=NULL
   WHERE id IN (<the 798 ids in t10_retire_snapshot.json meta.id_list>);
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND / "scripts"))
from run_migration import load_credentials, _mgmt_query, _project_ref  # noqa: E402

SNAPSHOT = Path(__file__).resolve().parent / "t10_retire_snapshot.json"
EXPECTED_ROWS = 798
BATCH_ID = "T10"
REASON = "t10_low_salvage_rate_and_unrecoverable_product_fields"

# These must be byte-for-byte identical before and after. Never written.
PROTECTED = ["discovery_method", "parent_pin_id", "source_url",
             "source_pin_save_count", "created_at"]

_c = load_credentials()
_REF = _project_ref(_c["SUPABASE_URL"])
_TOK = _c["SUPABASE_MIGRATION_TOKEN"]


def q(sql: str):
    s, b = _mgmt_query(sql, token=_TOK, project_ref=_REF)
    if s not in (200, 201):
        raise SystemExit(f"QUERY FAILED {s}: {b[:600]}")
    return json.loads(b)


def id_sql_list(ids: list[str]) -> str:
    return ", ".join(f"'{i}'::uuid" for i in ids)


def fetch_protected(ids: list[str]) -> dict[str, dict]:
    """Fetch the five protected fields for the given ids, keyed by id."""
    out: dict[str, dict] = {}
    PAGE = 200
    cols = ", ".join(["id"] + PROTECTED)
    for i in range(0, len(ids), PAGE):
        batch = ids[i:i + PAGE]
        rows = q(f"SELECT {cols} FROM pin_products WHERE id IN ({id_sql_list(batch)})")
        for r in rows:
            out[str(r["id"])] = {k: r[k] for k in PROTECTED}
    return out


def assert_all_hashes_null(ids: list[str]) -> list[dict]:
    """NULL-HASH GUARDRAIL — see the module docstring for the full rationale.

    Refuses to retire any row with a non-NULL normalized_product_url_hash, because the
    v29 unique index is FULL-TABLE: a retired row keeps its hash slot, so a later
    re-harvest of the same product URL collides and — under the harvester's
    ignore-duplicates insert — is SILENTLY DROPPED. That is real product loss.

    Read-only. Returns the offending rows; the caller aborts BEFORE any write, so the
    operation is never partially applied.
    """
    offenders: list[dict] = []
    PAGE = 200
    for i in range(0, len(ids), PAGE):
        batch = ids[i:i + PAGE]
        offenders += q(
            "SELECT id, discovery_method, normalized_product_url_hash, source_url "
            f"FROM pin_products WHERE id IN ({id_sql_list(batch)}) "
            "AND normalized_product_url_hash IS NOT NULL"
        )
    return offenders


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="verify only, write nothing (default)")
    ap.add_argument("--apply", action="store_true", help="perform the retirement UPDATE")
    ap.add_argument("--rollback", action="store_true", help="un-retire the T10 batch")
    ap.add_argument("--confirm-write", action="store_true", help="explicit second gate for a real write")
    ap.add_argument("--extra-id", action="append", default=[], metavar="UUID",
                    help="Append an extra id to the retirement target set. DRY-RUN ONLY "
                         "(refused with --apply) — exists so the NULL-hash guardrail can be "
                         "exercised against a hash-bearing row without ever retiring it.")
    args = ap.parse_args()

    if args.extra_id and (args.apply or args.rollback):
        print("STOP: --extra-id is a dry-run-only test affordance; it must never widen a "
              "real write. Re-run without --apply/--rollback.")
        return 2

    if not SNAPSHOT.exists():
        print(f"ERROR: snapshot not found: {SNAPSHOT}")
        return 2
    doc = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    ids: list[str] = doc["meta"]["id_list"]
    print(f"snapshot: {SNAPSHOT.name}  ids={len(ids)}  sha256(rows)={doc['meta']['rows_sha256'][:16]}…")

    if len(ids) != EXPECTED_ROWS or len(set(ids)) != EXPECTED_ROWS:
        print(f"STOP: expected {EXPECTED_ROWS} unique ids, got {len(ids)} ({len(set(ids))} unique)")
        return 1

    # Test-only widening of the target set (dry-run only, gated above).
    if args.extra_id:
        ids = ids + [i for i in args.extra_id if i not in set(ids)]
        print(f"--extra-id: target set widened to {len(ids)} ids (DRY-RUN ONLY, no write possible)")

    # ── NULL-HASH GUARDRAIL — runs BEFORE any write, on every non-rollback path ──
    # A retired row keeps its slot in the FULL-TABLE unique index on
    # normalized_product_url_hash (v29). Retiring a hash-bearing row would therefore
    # block any future re-harvest of that product URL — and the harvester inserts with
    # ignore-duplicates, so the good new row is SILENTLY DROPPED. Abort, never partial.
    if not args.rollback:
        offenders = assert_all_hashes_null(ids)
        if offenders:
            print("\n" + "=" * 74)
            print("ABORT — NULL-HASH GUARDRAIL TRIPPED. Nothing was written.")
            print("=" * 74)
            print(f"{len(offenders)} of the {len(ids)} targeted row(s) have a NON-NULL "
                  "normalized_product_url_hash.")
            print("\nWHY THIS IS REFUSED:")
            print("  idx_pin_products_normalized_product_url_hash (v29) is a FULL-TABLE UNIQUE")
            print("  index — it has no partial WHERE clause, so a soft-retired row STILL OCCUPIES")
            print("  its hash slot. Retiring a hash-bearing row would make any future re-harvest of")
            print("  that same product URL collide on the unique index; because the harvester inserts")
            print("  with resolution=ignore-duplicates (ON CONFLICT DO NOTHING), the collision raises")
            print("  NO error — the good, new row is SILENTLY DROPPED. The product becomes")
            print("  permanently un-reharvestable and the loss is invisible. That is real data loss.")
            print("\nCONFLICTING IDS:")
            for o in offenders:
                print(f"  {o['id']}  dm={o.get('discovery_method')!r}  "
                      f"hash={(o.get('normalized_product_url_hash') or '')[:24]}…")
                print(f"      source_url={(o.get('source_url') or '')[:80]}")
            print("\nTO PROCEED SAFELY, one of these must happen FIRST:")
            print("  (a) make the unique index partial, e.g.")
            print("      CREATE UNIQUE INDEX ... ON pin_products (normalized_product_url_hash)")
            print("        WHERE lifecycle_status IS DISTINCT FROM 'retired';")
            print("  (b) or stop the harvester from swallowing duplicate-key conflicts.")
            print("=" * 74)
            return 1
        print(f"NULL-hash guardrail: PASS — all {len(ids)} targeted rows have "
              "normalized_product_url_hash IS NULL (safe to retire; no hash slot is claimed)")

    # ── BEFORE: snapshot the five protected fields live ──────────────────────
    before = fetch_protected(ids)
    if len(before) != EXPECTED_ROWS:
        print(f"STOP: only {len(before)}/{EXPECTED_ROWS} ids found live")
        return 1
    print(f"before-state captured for {len(before)} rows (5 protected fields)")

    # Guard: every targeted row really is the dirty batch.
    wrong = [i for i, v in before.items() if v["discovery_method"] != "outbound_link_bootstrap"]
    if wrong:
        print(f"STOP: {len(wrong)} targeted rows are NOT outbound_link_bootstrap")
        return 1

    # Guard: never touch anything outside the batch.
    total_batch = q("SELECT count(*)::int AS n FROM pin_products "
                    "WHERE discovery_method='outbound_link_bootstrap'")[0]["n"]
    if total_batch != EXPECTED_ROWS:
        print(f"STOP: live outbound_link_bootstrap count is {total_batch}, expected {EXPECTED_ROWS}")
        return 1
    other_rows_before = q("SELECT count(*)::int AS n FROM pin_products "
                          "WHERE discovery_method <> 'outbound_link_bootstrap'")[0]["n"]
    print(f"guard: batch={total_batch}  other rows (must stay untouched)={other_rows_before}")

    if args.rollback:
        if not args.confirm_write:
            print("\nDRY-RUN (rollback): pass --confirm-write to actually un-retire.")
            return 0
        PAGE = 200
        for i in range(0, len(ids), PAGE):
            q("UPDATE pin_products SET lifecycle_status=NULL, retired_at=NULL, "
              "retirement_reason=NULL, retirement_batch_id=NULL "
              f"WHERE id IN ({id_sql_list(ids[i:i + PAGE])})")
        n = q("SELECT count(*)::int AS n FROM pin_products WHERE retirement_batch_id='T10'")[0]["n"]
        print(f"ROLLED BACK. rows still tagged batch T10: {n} (expect 0)")
        return 0 if n == 0 else 1

    if not (args.apply and args.confirm_write):
        print("\nDRY-RUN: no write performed. To retire: --apply --confirm-write")
        return 0

    # ── APPLY: id-keyed UPDATE, paged ────────────────────────────────────────
    PAGE = 200
    for i in range(0, len(ids), PAGE):
        batch = ids[i:i + PAGE]
        q("UPDATE pin_products SET "
          "lifecycle_status='retired', "
          "retired_at=now(), "
          f"retirement_reason='{REASON}', "
          f"retirement_batch_id='{BATCH_ID}' "
          f"WHERE id IN ({id_sql_list(batch)})")
        print(f"  updated rows {i + 1}..{i + len(batch)}")

    # ── VERIFY ────────────────────────────────────────────────────────────────
    retired = q("SELECT count(*)::int AS n FROM pin_products "
                f"WHERE retirement_batch_id='{BATCH_ID}' AND lifecycle_status='retired'")[0]["n"]
    still_active = q("SELECT count(*)::int AS n FROM pin_products "
                     "WHERE discovery_method='outbound_link_bootstrap' "
                     "AND lifecycle_status IS DISTINCT FROM 'retired'")[0]["n"]
    collateral = q("SELECT count(*)::int AS n FROM pin_products "
                   "WHERE lifecycle_status='retired' "
                   "AND discovery_method <> 'outbound_link_bootstrap'")[0]["n"]
    other_rows_after = q("SELECT count(*)::int AS n FROM pin_products "
                         "WHERE discovery_method <> 'outbound_link_bootstrap'")[0]["n"]
    saves_kept = q("SELECT count(*)::int AS n FROM pin_products "
                   f"WHERE retirement_batch_id='{BATCH_ID}' AND source_pin_save_count IS NOT NULL")[0]["n"]

    # Full before/after diff of the five protected fields across ALL 798 rows.
    after = fetch_protected(ids)
    diffs = []
    for i in ids:
        for k in PROTECTED:
            if before[i][k] != after[i][k]:
                diffs.append((i, k, before[i][k], after[i][k]))

    print("\n=== T10 RETIREMENT RESULT ===")
    print(f"  retired (batch T10):                 {retired}   (expect 798)")
    print(f"  T10 rows still active:               {still_active}   (expect 0)")
    print(f"  collateral retired (non-T10 rows):   {collateral}   (expect 0)")
    print(f"  other rows count before/after:       {other_rows_before} / {other_rows_after}   (must match)")
    print(f"  source_pin_save_count preserved:     {saves_kept}   (expect 798)")
    print(f"  protected-field diffs across 798x5:  {len(diffs)}   (expect 0)")
    if diffs:
        for d in diffs[:10]:
            print("    DIFF", d)

    print("\n  10-row sample, protected fields, before == after:")
    for i in ids[:10]:
        same = all(before[i][k] == after[i][k] for k in PROTECTED)
        print(f"    {i}  identical={same}  dm={after[i]['discovery_method']} "
              f"ppid={after[i]['parent_pin_id']} spsc={after[i]['source_pin_save_count']} "
              f"created_at={after[i]['created_at']}")
        print(f"       source_url={after[i]['source_url']}")

    print("\nROLLBACK SQL (id-exact):")
    print("  UPDATE pin_products SET lifecycle_status=NULL, retired_at=NULL, "
          "retirement_reason=NULL, retirement_batch_id=NULL")
    print(f"   WHERE id IN (<the {EXPECTED_ROWS} ids in {SNAPSHOT.name} meta.id_list>);")
    print("  -- equivalently: WHERE retirement_batch_id='T10';")

    ok = (retired == EXPECTED_ROWS and still_active == 0 and collateral == 0
          and other_rows_before == other_rows_after
          and saves_kept == EXPECTED_ROWS and not diffs)
    print("\nSTATUS:", "PASS" if ok else "FAIL — investigate before proceeding")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
