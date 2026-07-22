#!/usr/bin/env python3
"""
run_migration.py — Supabase schema migration runner (HTTPS / Management API only).

Direct PostgreSQL TCP is blocked in this environment (Clash Fake-IP).
This script uses the Supabase Management API over HTTPS instead.

Credential loading (strict isolation — no cross-contamination):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  ← backend/.env   (runtime; read-only probing)
  SUPABASE_MIGRATION_TOKEN                  ← backend/.env.migration (apply; never logged)

Usage:
  # Read-only connectivity test (no SQL file needed)
  python scripts/run_migration.py --check

  # Read-only post-migration column probe
  python scripts/run_migration.py --check --sql db/migrate_v28_product_supply_expansion.sql

  # Apply a migration (requires explicit --apply flag)
  python scripts/run_migration.py --apply --sql db/migrate_v28_product_supply_expansion.sql

  # Apply to a NON-DEFAULT project (e.g. the isolated integration-test project).
  # Requires --project-ref; there is no way to reach a second project implicitly.
  python scripts/run_migration.py --apply --sql db/migrate_v53_ai_rate_limit_windows.sql \
      --project-ref snulmwprsahzqvdbyenc

Guardrails:
  - Token values are NEVER printed, logged, or included in error output.
  - --apply is refused when SUPABASE_MIGRATION_TOKEN is missing.
  - SQL file must exist and must not be empty.
  - Only the SQL in the named file is executed; nothing else.
  - No product rows are touched; no opportunity/backfill/crawl jobs run.

TARGET SELECTION (added for the integration-test channel):
  By DEFAULT the target project ref is derived from SUPABASE_URL in backend/.env,
  exactly as before — every existing production invocation is byte-for-byte unchanged.

  `--project-ref <ref>` (or SUPABASE_MIGRATION_PROJECT_REF in the environment)
  overrides that target. The override is ALWAYS printed, and when it points somewhere
  other than the .env-derived project, the PostgREST probes that use the .env
  SUPABASE_SERVICE_ROLE_KEY are SKIPPED — that key belongs to the default project and
  must never be aimed at another one.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # backend/

# ── Load credentials (strict: each file loads only what it should) ─────────────

def _load_dotenv_file(path: Path, keys: list[str]) -> dict[str, str]:
    """Parse a .env file and return only the requested keys that have non-empty values."""
    found: dict[str, str] = {}
    if not path.exists():
        return found
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, v = t.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k in keys and v:
            found[k] = v
    return found


def load_credentials() -> dict[str, str]:
    """Load runtime + migration credentials from the correct isolated files."""
    runtime = _load_dotenv_file(
        ROOT / ".env",
        ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    )
    migration = _load_dotenv_file(
        ROOT / ".env.migration",
        ["SUPABASE_MIGRATION_TOKEN"],
    )
    return {**runtime, **migration}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _project_ref(supabase_url: str) -> str:
    """Derive the Supabase project ref from the URL without making a network call."""
    try:
        host = supabase_url.rstrip("/").split("//", 1)[1]
        return host.split(".")[0]
    except (IndexError, AttributeError):
        return ""


def _resolve_target(creds: dict, override: str | None) -> tuple[str, bool]:
    """
    Decide which Supabase project this invocation targets.

    Returns (project_ref, is_default). `is_default` is True only when the ref came
    from SUPABASE_URL in backend/.env — i.e. the historical behaviour. When it is
    False the caller must not reuse the .env SUPABASE_SERVICE_ROLE_KEY, because that
    key authenticates against the DEFAULT project, not the overridden one.

    Precedence: --project-ref  >  SUPABASE_MIGRATION_PROJECT_REF  >  SUPABASE_URL.
    An override must be requested explicitly; nothing silently redirects a run.
    """
    default_ref = _project_ref(creds.get("SUPABASE_URL", ""))
    chosen = (override or os.environ.get("SUPABASE_MIGRATION_PROJECT_REF") or "").strip()
    if not chosen:
        return default_ref, True
    if not chosen.isalnum():
        _die(f"--project-ref must be a bare Supabase project ref (alphanumeric), got: {chosen!r}")
    return chosen, chosen == default_ref


def _mask(s: str) -> str:
    """Return first 8 chars + '…' — for display only; never called on tokens."""
    return s[:8] + "…" if len(s) > 8 else s[:4] + "…"


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# ── Management API calls (HTTPS only) ─────────────────────────────────────────

def _mgmt_query(sql: str, *, token: str, project_ref: str, label: str = "") -> tuple[int, str]:
    """POST a SQL query to the Supabase Management API. Returns (status, body)."""
    import httpx
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    try:
        r = httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={"query": sql},
            timeout=30,
        )
        return r.status_code, r.text
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}"


# ── PostgREST column-presence probe (read-only, uses service key) ──────────────

def _postgrest_column_exists(col: str, table: str, *, url: str, service_key: str) -> bool:
    """Returns True if the column exists in the given table (via PostgREST SELECT probe)."""
    import httpx
    try:
        r = httpx.get(
            f"{url.rstrip('/')}/rest/v1/{table}",
            params={"select": col, "limit": "1"},
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
            timeout=10,
        )
        return r.status_code == 200
    except Exception:
        return False


# ── Column extraction from SQL file ────────────────────────────────────────────

def _columns_from_sql(sql_text: str) -> list[str]:
    """Heuristic: extract ADD COLUMN IF NOT EXISTS <col> lines from migration SQL."""
    import re
    return re.findall(r"ADD COLUMN IF NOT EXISTS\s+(\w+)", sql_text, re.IGNORECASE)


# ── Subcommands ────────────────────────────────────────────────────────────────

def cmd_check(creds: dict, sql_path: Path | None, ref: str, is_default: bool) -> int:
    """Read-only connectivity test + optional post-migration column probe."""
    url  = creds.get("SUPABASE_URL", "")
    skey = creds.get("SUPABASE_SERVICE_ROLE_KEY", "")
    tok  = creds.get("SUPABASE_MIGRATION_TOKEN", "")
    # The .env service key authenticates against the DEFAULT project only. On an
    # overridden target it is the wrong credential for the wrong database, so every
    # probe that uses it is disabled rather than pointed somewhere it does not belong.
    probe_ok = is_default and bool(url) and bool(skey)

    print(f"\n{'='*60}")
    print("CONNECTIVITY CHECK (read-only — no schema changes)")
    print(f"{'='*60}")
    print(f"  SUPABASE_URL:            {'present (' + _mask(url) + ')' if url else 'MISSING'}")
    print(f"  SERVICE_ROLE_KEY:        {'present' if skey else 'MISSING'}")
    print(f"  MIGRATION_TOKEN:         {'present' if tok else 'MISSING (apply will fail)'}")
    print(f"  project_ref:             {ref or 'UNKNOWN'}"
          f"{'  (derived from SUPABASE_URL)' if is_default else '  ← OVERRIDDEN via --project-ref'}")
    if not is_default:
        print("  NOTE: non-default target — .env service-key probes are SKIPPED.")

    ok = True

    # Test A: Management API SELECT 1 (only if token present)
    print(f"\n{'─'*60}")
    print("Test A — Management API (HTTPS) SELECT 1")
    if tok and ref:
        print(f"  Endpoint: https://api.supabase.com/v1/projects/{ref}/database/query")
        status, body = _mgmt_query("SELECT 1 AS connectivity_ok", token=tok, project_ref=ref, label="SELECT 1")
        if status in (200, 201):   # Management API returns 201 for successful queries
            print(f"  ✅  HTTP {status}  result: {body[:200]}")
        else:
            print(f"  ❌  HTTP {status}  error: {body[:300]}")
            ok = False
    else:
        print("  ⚠️   SKIPPED — MIGRATION_TOKEN or project_ref missing")

    # Test A2: Management API pg_indexes
    print(f"\n{'─'*60}")
    print("Test A2 — Management API pg_indexes for pin_products")
    if tok and ref:
        q = "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='pin_products' ORDER BY indexname"
        status, body = _mgmt_query(q, token=tok, project_ref=ref)
        if status in (200, 201):
            print(f"  ✅  HTTP {status}")
            import json
            try:
                rows = json.loads(body)
                for row in (rows if isinstance(rows, list) else []):
                    print(f"     {row.get('indexname',''):<50} {(row.get('indexdef',''))[:60]}")
            except Exception:
                print(f"     raw: {body[:400]}")
        else:
            print(f"  ❌  HTTP {status}  {body[:300]}")
            ok = False
    else:
        print("  ⚠️   SKIPPED — MIGRATION_TOKEN or project_ref missing")

    # Test B: PostgREST connectivity (uses service key — always available)
    print(f"\n{'─'*60}")
    print("Test B — PostgREST read-only probe (HTTPS)")
    if not is_default:
        print("  ⚠️   SKIPPED — non-default --project-ref; .env service key targets another project")
    elif url and skey:
        import httpx
        try:
            r = httpx.get(
                f"{url.rstrip('/')}/rest/v1/pin_products",
                params={"select": "id", "limit": "1"},
                headers={"apikey": skey, "Authorization": f"Bearer {skey}"},
                timeout=10,
            )
            if r.status_code == 200:
                cnt = len(r.json()) if r.text.startswith("[") else "?"
                print(f"  ✅  HTTP {r.status_code}  returned {cnt} row(s) (IDs not shown)")
            else:
                print(f"  ❌  HTTP {r.status_code}  {r.text[:200]}")
                ok = False
        except Exception as exc:
            print(f"  ❌  {type(exc).__name__}: {exc}")
            ok = False
    else:
        print("  ⚠️   SKIPPED — SUPABASE_URL or SERVICE_ROLE_KEY missing")
        ok = False

    # Optional: v28 column-presence probe (service-key based → default target only)
    if sql_path and sql_path.exists() and probe_ok:
        print(f"\n{'─'*60}")
        print(f"Column probe — columns declared in {sql_path.name}")
        cols = _columns_from_sql(sql_path.read_text(encoding="utf-8"))
        for col in cols:
            exists = _postgrest_column_exists(col, "pin_products", url=url, service_key=skey)
            mark = "EXISTS  ✅" if exists else "MISSING ❌"
            print(f"  pin_products.{col:<40} {mark}")

    print(f"\n{'='*60}")
    print("No schema changes made. No product rows touched.")
    print(f"{'='*60}\n")
    return 0 if ok else 1


def cmd_apply(creds: dict, sql_path: Path, ref: str, is_default: bool) -> int:
    """Apply a migration SQL file via the Management API. Requires --apply flag."""
    tok = creds.get("SUPABASE_MIGRATION_TOKEN", "")
    url = creds.get("SUPABASE_URL", "")
    skey = creds.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not tok:
        _die("SUPABASE_MIGRATION_TOKEN missing in backend/.env.migration — cannot apply.")
    if not ref:
        _die("Cannot derive project_ref from SUPABASE_URL (and no --project-ref given).")
    if not sql_path.exists():
        _die(f"SQL file not found: {sql_path}")
    sql = sql_path.read_text(encoding="utf-8").strip()
    if not sql:
        _die(f"SQL file is empty: {sql_path}")

    print(f"\n{'='*60}")
    print(f"APPLYING MIGRATION: {sql_path.name}")
    print(f"Target project_ref: {ref}"
          f"{'  (default — derived from SUPABASE_URL)' if is_default else '  ← OVERRIDDEN via --project-ref'}")
    print(f"Endpoint: https://api.supabase.com/v1/projects/{ref}/database/query")
    print(f"{'='*60}")
    print(f"SQL preview (first 400 chars):\n{sql[:400]}{'...' if len(sql)>400 else ''}\n")

    status, body = _mgmt_query(sql, token=tok, project_ref=ref)
    if status in (200, 201):   # Management API returns 201 for successful DDL
        print(f"✅  Migration applied. HTTP {status}")
        print(f"   Response: {body[:300]}")
    else:
        print(f"❌  Migration FAILED. HTTP {status}")
        print(f"   Error: {body[:500]}")
        return 1

    # Re-probe columns. Service-key based, so default target only — on an overridden
    # target this key would authenticate against the wrong project entirely.
    if not is_default:
        print("\nPost-migration column probe SKIPPED — non-default --project-ref "
              "(.env service key belongs to the default project).")
    elif url and skey:
        print("\nPost-migration column probe:")
        cols = _columns_from_sql(sql)
        all_ok = True
        for col in cols:
            exists = _postgrest_column_exists(col, "pin_products", url=url, service_key=skey)
            mark = "EXISTS ✅" if exists else "MISSING ❌"
            print(f"  pin_products.{col:<40} {mark}")
            if not exists:
                all_ok = False
        if all_ok:
            print(f"\n✅  All {len(cols)} columns confirmed present.")
        else:
            print(f"\n❌  Some columns still missing after apply.")
            return 1

    print(f"\n{'='*60}")
    print("Done. No product rows touched.")
    print(f"{'='*60}\n")
    return 0


# ── CLI ────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Supabase schema migration runner (HTTPS / Management API)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--sql",   default=None,
                    help="Path to the .sql migration file (relative to backend/)")
    ap.add_argument("--check", action="store_true",
                    help="Read-only connectivity test + optional column probe (no changes)")
    ap.add_argument("--apply", action="store_true",
                    help="Apply the SQL migration (requires SUPABASE_MIGRATION_TOKEN)")
    ap.add_argument("--project-ref", default=None,
                    help="Target a NON-DEFAULT Supabase project (e.g. the integration-test "
                         "project). Omit for the historical behaviour: the ref derived from "
                         "SUPABASE_URL in backend/.env. Also settable via "
                         "SUPABASE_MIGRATION_PROJECT_REF.")

    args = ap.parse_args()

    if not args.check and not args.apply:
        ap.print_help()
        return 2

    creds = load_credentials()
    ref, is_default = _resolve_target(creds, args.project_ref)
    sql_path: Path | None = None
    if args.sql:
        p = Path(args.sql)
        sql_path = p if p.is_absolute() else ROOT / p
        if args.apply and not sql_path.exists():
            _die(f"SQL file not found: {sql_path}")

    if args.check:
        return cmd_check(creds, sql_path, ref, is_default)

    if args.apply:
        if not sql_path:
            _die("--apply requires --sql <path>")
        return cmd_apply(creds, sql_path, ref, is_default)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
