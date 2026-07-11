"""
run_sql_migration.py — Check and apply add_competition_columns.sql via Supabase REST.

Since direct PostgreSQL (port 5432) is blocked in this environment, this script:
  1. Reads column presence via Supabase PostgREST (probe each column).
  2. For missing columns, attempts to apply DDL via the Supabase Management API
     (requires SUPABASE_MIGRATION_TOKEN in .env).
  3. If no token, prints the SQL to run manually in Supabase SQL Editor.

Usage:
    py run_sql_migration.py              # check + apply (needs token) or print SQL
    py run_sql_migration.py --check      # only check which columns exist
"""

import argparse
import os
import sys
from dotenv import load_dotenv
import httpx

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
MIGRATION_TOKEN = os.environ.get("SUPABASE_MIGRATION_TOKEN", "")  # optional Supabase PAT

PROJECT_REF = SUPABASE_URL.split("//")[1].split(".")[0] if SUPABASE_URL else ""

COLUMNS = [
    "interest_index_estimate",
    "competition_sample_count",
    "competition_index",
    "competition_level",
    "competition_source",
    "competition_confidence",
    "last_competition_enriched_at",
]

MIGRATION_SQL = """\
ALTER TABLE trend_keywords
  ADD COLUMN IF NOT EXISTS interest_index_estimate      numeric,
  ADD COLUMN IF NOT EXISTS competition_sample_count     integer,
  ADD COLUMN IF NOT EXISTS competition_index            numeric,
  ADD COLUMN IF NOT EXISTS competition_source           text,
  ADD COLUMN IF NOT EXISTS competition_confidence       text,
  ADD COLUMN IF NOT EXISTS last_competition_enriched_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_trend_keywords_competition_level
  ON trend_keywords (competition_level)
  WHERE competition_level IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trend_keywords_enriched_at
  ON trend_keywords (last_competition_enriched_at DESC)
  WHERE last_competition_enriched_at IS NOT NULL;
"""

G = "\033[92m"; Y = "\033[93m"; R = "\033[91m"; X = "\033[0m"


# ── Column probing via PostgREST ──────────────────────────────────────────────

def probe_columns() -> dict[str, bool]:
    """Check each column by doing a lightweight SELECT. Returns {col: exists}."""
    client = httpx.Client(
        base_url=f"{SUPABASE_URL}/rest/v1/",
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
        timeout=15,
    )
    results = {}
    for col in COLUMNS:
        r = client.get("trend_keywords", params={"select": col, "limit": "1"})
        results[col] = r.status_code == 200
    return results


def print_column_status(present: dict[str, bool]) -> None:
    existing = [c for c, ok in present.items() if ok]
    missing  = [c for c, ok in present.items() if not ok]
    print(f"\n  Present ({len(existing)}/7):")
    for col in COLUMNS:
        mark = f"{G}OK{X}     " if present[col] else f"{R}MISSING{X}"
        print(f"    {mark}  {col}")
    if missing:
        print(f"\n  {Y}Missing: {', '.join(missing)}{X}")


# ── Apply via Management API (needs PAT) ──────────────────────────────────────

def apply_via_management_api(sql: str) -> bool:
    if not MIGRATION_TOKEN:
        return False
    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
    r = httpx.post(
        url,
        headers={"Authorization": f"Bearer {MIGRATION_TOKEN}", "Content-Type": "application/json"},
        json={"query": sql},
        timeout=30,
    )
    if r.status_code == 200:
        print(f"{G}  Migration applied via Management API.{X}")
        return True
    print(f"{R}  Management API failed: {r.status_code} {r.text[:200]}{X}")
    return False


# ── Print manual instructions ────────────────────────────────────────────────

def print_manual_instructions(missing_cols: list[str]) -> None:
    bar = "=" * 66
    print(f"""
{Y}{bar}
  MANUAL MIGRATION REQUIRED
  Port 5432 blocked. Set SUPABASE_MIGRATION_TOKEN for auto-apply.
{bar}{X}

  {Y}Step 1:{X} Open Supabase SQL Editor:
  https://supabase.com/dashboard/project/{PROJECT_REF}/sql/new

  {Y}Step 2:{X} Paste and run the following SQL:

{'-'*66}
{MIGRATION_SQL}
{'-'*66}

  {Y}Step 3:{X} Re-run this script to verify:
  py run_sql_migration.py --check

  {Y}Alternative:{X} Add SUPABASE_MIGRATION_TOKEN to backend/.env
  (Personal Access Token from https://supabase.com/dashboard/account/tokens)
  then re-run this script without --check.
""")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="Check column status only")
    args = ap.parse_args()

    if not SUPABASE_URL or not SERVICE_KEY:
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in .env")
        sys.exit(1)

    print("── Probing column status via Supabase REST …")
    present = probe_columns()
    print_column_status(present)

    missing = [c for c, ok in present.items() if not ok]

    if not missing:
        print(f"\n{G}All 7 columns present — migration already applied.{X}")
        sys.exit(0)

    if args.check:
        print(f"\n{Y}{len(missing)} column(s) missing. Run without --check to apply.{X}")
        sys.exit(1)

    print(f"\n── Attempting to apply migration for {len(missing)} missing column(s) …")

    # Try Management API first
    if MIGRATION_TOKEN:
        if apply_via_management_api(MIGRATION_SQL):
            # Re-probe
            present2 = probe_columns()
            print_column_status(present2)
            still_missing = [c for c, ok in present2.items() if not ok]
            if not still_missing:
                print(f"{G}Migration complete.{X}")
                sys.exit(0)
            else:
                print(f"{R}Still missing: {still_missing}{X}")
                sys.exit(1)
        # Management API failed — fall through to manual instructions

    # No token or failed — print instructions
    print_manual_instructions(missing)
    sys.exit(1)


if __name__ == "__main__":
    main()
