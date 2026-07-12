#!/usr/bin/env python3
"""
storage_gc.py — conservative garbage collector for orphaned Storage uploads.

Direct PostgreSQL TCP is blocked in this environment (Clash Fake-IP), so this
script talks ONLY over HTTPS: the Supabase Storage REST API (service role) to
list/delete objects, and the Supabase Management API to probe references in SQL.

╔══════════════════════════════════════════════════════════════════════════════╗
║  HARD SAFETY BOUNDARY                                                          ║
║  This tool ONLY ever lists / deletes objects under the `studio/uploads/`       ║
║  prefix of the `generated` bucket — the user-uploaded Pin source images.       ║
║  It NEVER touches any other prefix. Generated Pin artwork lives under other    ║
║  prefixes and may be referenced by the external URL of an already-published    ║
║  Pinterest pin, so deleting it could break live pins. Do not widen the prefix. ║
╚══════════════════════════════════════════════════════════════════════════════╝

An object is considered REFERENCED (kept, never deleted) when its filename appears
in the text of any pin_drafts.payload or user_store_docs.payload row. The filename
(not the full path) is used because references are stored in three forms — the raw
path, the public URL (`…/generated/studio/uploads/…`), and the in-app proxy URL
(`/api/storage-image?path=studio%2Fuploads%2F…`, slashes percent-encoded). The
filename (`<epoch>_<rand>.<ext>`) is globally unique and appears verbatim in ALL
three, so matching on it can never miss a reference regardless of URL encoding.

Credential loading (mirrors run_migration.py — strict isolation):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  ← backend/.env           (list/delete + probe)
  SUPABASE_MIGRATION_TOKEN                  ← backend/.env.migration (Management API SQL)

Usage:
  # Dry-run report (DEFAULT — never deletes):
  python scripts/storage_gc.py
  python scripts/storage_gc.py --min-age-days 14

  # Actually delete (each orphan is re-checked for references immediately before):
  python scripts/storage_gc.py --delete

Guardrails:
  - Default is dry-run; deletion requires the explicit --delete flag.
  - Only objects under studio/uploads/ are ever considered or removed.
  - Only objects older than --min-age-days (default 7) can be orphans.
  - A reference-probe error is treated as "referenced" (keep) — fail safe.
  - --delete re-probes every candidate again right before removing it (TOCTOU).
  - This is a MANUAL tool: no cron, no auto-run.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # backend/

BUCKET = "generated"
# HARD boundary — never change without re-reading the safety note above.
PREFIX = "studio/uploads/"
PLACEHOLDER = ".emptyFolderPlaceholder"


# ── Credential loading (strict: each file loads only what it should) ───────────

def _load_dotenv_file(path: Path, keys: list[str]) -> dict[str, str]:
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
    runtime = _load_dotenv_file(ROOT / ".env", ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
    migration = _load_dotenv_file(ROOT / ".env.migration", ["SUPABASE_MIGRATION_TOKEN"])
    return {**runtime, **migration}


def _project_ref(supabase_url: str) -> str:
    try:
        host = supabase_url.rstrip("/").split("//", 1)[1]
        return host.split(".")[0]
    except (IndexError, AttributeError):
        return ""


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# ── Storage REST API (service role, HTTPS) ────────────────────────────────────

def _storage_headers(service_key: str) -> dict[str, str]:
    return {"apikey": service_key, "Authorization": f"Bearer {service_key}"}


def _list_one_level(url: str, service_key: str, prefix: str, *, limit: int = 1000) -> list[dict]:
    """List a single prefix level (paged). Returns raw Storage list items."""
    import httpx
    items: list[dict] = []
    offset = 0
    while True:
        r = httpx.post(
            f"{url.rstrip('/')}/storage/v1/object/list/{BUCKET}",
            headers=_storage_headers(service_key),
            json={
                "prefix": prefix,
                "limit": limit,
                "offset": offset,
                "sortBy": {"column": "name", "order": "asc"},
            },
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not isinstance(batch, list) or not batch:
            break
        items.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return items


def _is_folder(item: dict) -> bool:
    # Supabase returns folders as entries with id == None and metadata == None.
    return item.get("id") is None and item.get("metadata") is None


def walk_objects(url: str, service_key: str, prefix: str) -> list[dict]:
    """Recursively list every real object under `prefix`. Returns
    [{path, size, created_at}]. Skips folder placeholders."""
    out: list[dict] = []
    for it in _list_one_level(url, service_key, prefix):
        name = it.get("name")
        if not name or name == PLACEHOLDER:
            continue
        child = prefix + name  # prefix always ends with '/'
        if _is_folder(it):
            out.extend(walk_objects(url, service_key, child + "/"))
            continue
        meta = it.get("metadata") or {}
        out.append({
            "path": child,
            "size": int(meta.get("size") or 0),
            "created_at": it.get("created_at"),
        })
    return out


def delete_object(url: str, service_key: str, path: str) -> tuple[bool, str]:
    """Delete a single object. Refuses anything outside the PREFIX boundary."""
    import httpx
    if not path.startswith(PREFIX):
        return False, f"REFUSED — path outside {PREFIX}: {path}"
    try:
        r = httpx.delete(
            f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{path}",
            headers=_storage_headers(service_key),
            timeout=30,
        )
        if r.status_code in (200, 204):
            return True, "deleted"
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


# ── Management API reference probe (HTTPS SQL) ────────────────────────────────

def _mgmt_query(sql: str, *, token: str, project_ref: str) -> tuple[int, str]:
    import httpx
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    try:
        r = httpx.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"query": sql},
            timeout=30,
        )
        return r.status_code, r.text
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def _like_escape(s: str) -> str:
    """Escape LIKE wildcards so the pattern matches the literal filename (ESCAPE '\\')."""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _sql_str(s: str) -> str:
    """Escape a value for a single-quoted SQL string literal."""
    return s.replace("'", "''")


# Per-table text expression to search for the object's filename. Most stores keep
# their image refs inside a jsonb `payload`; pin_generations instead stores them in
# ref_urls (text[]) and groups_json (jsonb, holds per-group refUrl), so those source
# images stay referenced by generation history. Missing pin_generations here would
# let --delete remove studio/uploads/ source images still cited by past generations.
_REFERENCE_PROBE_TABLES: dict[str, str] = {
    "pin_drafts":      "payload::text",
    "user_store_docs": "payload::text",
    "pin_generations": "(array_to_string(ref_urls, ',') || ' ' || groups_json::text)",
}


def is_referenced(path: str, *, token: str, project_ref: str) -> tuple[bool, str]:
    """True if the object's filename appears in any referencing table's text. On a
    probe error returns True (fail-safe: keep the object). Returns (referenced, reason)."""
    basename = path.rsplit("/", 1)[-1]
    pattern = _sql_str(_like_escape(basename))
    for table, expr in _REFERENCE_PROBE_TABLES.items():
        sql = (
            f"SELECT 1 FROM {table} "
            f"WHERE {expr} LIKE '%{pattern}%' ESCAPE '\\' LIMIT 1"
        )
        status, body = _mgmt_query(sql, token=token, project_ref=project_ref)
        if status not in (200, 201):
            return True, f"probe error on {table} (HTTP {status}) — kept to be safe"
        try:
            rows = json.loads(body)
        except Exception:
            return True, f"unparseable probe response on {table} — kept to be safe"
        if isinstance(rows, list) and len(rows) > 0:
            return True, f"referenced in {table}"
    return False, "no reference found"


# ── Age helper ────────────────────────────────────────────────────────────────

def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    v = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _human_bytes(n: int) -> str:
    f = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if f < 1024 or unit == "TiB":
            return f"{f:.1f} {unit}" if unit != "B" else f"{int(f)} B"
        f /= 1024
    return f"{n} B"


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Conservative GC for orphaned studio/uploads/ Storage objects (HTTPS only).",
        epilog=(
            "SAFETY: only objects under the studio/uploads/ prefix of the `generated` "
            "bucket are ever listed or deleted. Default is a dry-run report; pass "
            "--delete to actually remove orphans (each is re-probed for references "
            "immediately before deletion). This is a manual tool — no cron."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--min-age-days", type=int, default=7,
                    help="Only objects older than this many days can be orphans (default 7).")
    ap.add_argument("--delete", action="store_true",
                    help="Actually delete orphans (default: dry-run report only).")
    args = ap.parse_args()

    creds = load_credentials()
    url = creds.get("SUPABASE_URL", "")
    skey = creds.get("SUPABASE_SERVICE_ROLE_KEY", "")
    tok = creds.get("SUPABASE_MIGRATION_TOKEN", "")
    ref = _project_ref(url)

    if not url or not skey:
        _die("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in backend/.env.")
    if not tok or not ref:
        _die("SUPABASE_MIGRATION_TOKEN (backend/.env.migration) or project_ref missing — "
             "cannot probe references safely.")

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.min_age_days)

    print(f"\n{'='*70}")
    print("STORAGE GC — orphaned studio/uploads/ objects")
    print(f"{'='*70}")
    print(f"  bucket/prefix : {BUCKET}/{PREFIX}")
    print(f"  mode          : {'DELETE' if args.delete else 'DRY-RUN (no changes)'}")
    print(f"  min age       : {args.min_age_days} day(s)  (created before {cutoff.isoformat()})")
    print(f"  project_ref   : {ref}")

    try:
        objects = walk_objects(url, skey, PREFIX)
    except Exception as exc:
        _die(f"Storage list failed: {type(exc).__name__}: {exc}")

    print(f"\nListed {len(objects)} object(s) under {PREFIX}")

    # Partition: too-new (skip), then reference-probe the rest.
    aged: list[dict] = []
    too_new = 0
    for o in objects:
        ts = _parse_ts(o.get("created_at"))
        if ts is None or ts >= cutoff:
            too_new += 1
            continue
        aged.append(o)
    print(f"  {too_new} younger than {args.min_age_days}d (skipped)")
    print(f"  {len(aged)} old enough to consider")

    orphans: list[dict] = []
    referenced = 0
    for o in aged:
        ref_hit, reason = is_referenced(o["path"], token=tok, project_ref=ref)
        if ref_hit:
            referenced += 1
            continue
        o["reason"] = reason
        orphans.append(o)

    total_bytes = sum(o["size"] for o in orphans)
    print(f"  {referenced} referenced (kept)")
    print(f"\n{'─'*70}")
    print(f"ORPHANS: {len(orphans)} object(s), {_human_bytes(total_bytes)} ({total_bytes} bytes)")
    print(f"{'─'*70}")
    for o in orphans:
        print(f"  {_human_bytes(o['size']):>10}  {o.get('created_at','?'):<28}  {o['path']}")

    if not args.delete:
        print(f"\n{'='*70}")
        print("DRY-RUN — nothing deleted. Re-run with --delete to remove the above.")
        print(f"{'='*70}\n")
        return 0

    if not orphans:
        print("\nNothing to delete.\n")
        return 0

    print(f"\n{'─'*70}")
    print("DELETING (each re-probed for references first) …")
    print(f"{'─'*70}")
    deleted = 0
    freed = 0
    skipped = 0
    for o in orphans:
        # TOCTOU: re-probe immediately before deleting.
        ref_hit, reason = is_referenced(o["path"], token=tok, project_ref=ref)
        if ref_hit:
            skipped += 1
            print(f"  SKIP   {o['path']}  ({reason})")
            continue
        ok, msg = delete_object(url, skey, o["path"])
        if ok:
            deleted += 1
            freed += o["size"]
            print(f"  DELETE {o['path']}")
        else:
            skipped += 1
            print(f"  FAIL   {o['path']}  ({msg})")

    print(f"\n{'='*70}")
    print(f"Deleted {deleted} object(s), freed {_human_bytes(freed)}; {skipped} skipped.")
    print(f"{'='*70}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
