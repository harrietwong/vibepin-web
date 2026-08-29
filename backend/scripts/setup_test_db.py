#!/usr/bin/env python3
"""
setup_test_db.py — build the admin-operator-console schema in the ISOLATED TEST project.

=========================== ABSOLUTE SAFETY RED LINE ===========================
This script writes DDL. It is HARD-LOCKED to the TEST project ref below and
refuses to run against anything else — most importantly the production project.

  TEST       ref = snulmwprsahzqvdbyenc   (writes allowed)
  PRODUCTION ref = jaxteelkecvlozdrdoog   (NEVER — abort on sight)

The Supabase Management API token in backend/.env.migration is ACCOUNT-level and
works on BOTH projects, so the ref is asserted on every single call site here.
================================================================================

WHY NOT REPLAY ALL 52 MIGRATIONS
  backend/db/migrate_v*.sql is not a linear, self-contained chain: v22 alone
  references trend_keywords / pin_samples / pin_products / opportunities and
  several later files ALTER tables created by schema.sql. Replaying them into an
  empty project fails on unrelated dependencies. The operator console reads a
  small, well-defined table set, so this script creates exactly that set with the
  columns the console's server helpers select, transcribed from the authoritative
  migration files (cited per table below).

TABLES CREATED (and their source-of-truth migration)
  pin_generations        migrate_v17 + v19 + v21 + v52_pin_generations_context_columns
  pin_drafts             migrate_v38_pin_drafts + v41 + v42/v50_scheduled_publish
  pinterest_connections  api/migrations/001_pinterest_connections.sql + v49
  analytics_events       migrate_v41_creative_intelligence.sql (section 2)
  weekly_plans           migrate_v13.sql          (customer360.ts reads it)
  social_connections     migrate_v32_social_connections.sql (customer360.ts reads it)

Everything is CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so the
script is idempotent and safe to re-run.

USAGE
  python backend/scripts/setup_test_db.py --check    # connectivity + ref assertion only
  python backend/scripts/setup_test_db.py --apply    # create/patch the schema
  python backend/scripts/setup_test_db.py --verify   # per-table column verification
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # backend/
REPO = ROOT.parent                                     # repo root

# ── RED LINE constants ────────────────────────────────────────────────────────
TEST_REF = "snulmwprsahzqvdbyenc"
PROD_REF = "jaxteelkecvlozdrdoog"


def _die(msg: str) -> None:
    print(f"\n!!! ABORT: {msg}\n", file=sys.stderr)
    sys.exit(1)


def _load_dotenv(path: Path, keys: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, v = t.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k in keys and v:
            out[k] = v
    return out


def project_ref_of(url: str) -> str:
    try:
        return url.rstrip("/").split("//", 1)[1].split(".")[0]
    except (IndexError, AttributeError):
        return ""


def assert_test_ref(ref: str, what: str) -> None:
    """RED LINE: every write target must be the test project. Called before EVERY write."""
    print(f"  [ref-guard] {what}: target project ref = {ref}")
    if ref == PROD_REF:
        _die(f"{what} targets the PRODUCTION project ({PROD_REF}). Refusing.")
    if ref != TEST_REF:
        _die(f"{what} targets ref '{ref}', expected the TEST project '{TEST_REF}'. Refusing.")


def load_test_creds() -> dict[str, str]:
    """TEST credentials come ONLY from web/.env.test.local. backend/.env (production) is never read."""
    env = _load_dotenv(
        REPO / "web" / ".env.test.local",
        ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    )
    url = env.get("NEXT_PUBLIC_SUPABASE_URL", "")
    if not url:
        _die("web/.env.test.local is missing NEXT_PUBLIC_SUPABASE_URL.")
    ref = project_ref_of(url)
    assert_test_ref(ref, "credential load (web/.env.test.local)")
    tok = os.environ.get("SUPABASE_MIGRATION_TOKEN") or _load_dotenv(
        ROOT / ".env.migration", ["SUPABASE_MIGRATION_TOKEN"]
    ).get("SUPABASE_MIGRATION_TOKEN", "")
    if not tok:
        _die("SUPABASE_MIGRATION_TOKEN is missing from the environment and backend/.env.migration.")
    return {
        "url": url,
        "ref": ref,
        "anon": env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", ""),
        "service": env.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        "token": tok,
    }


def mgmt_query(sql: str, *, token: str, ref: str, label: str, attempts: int = 4) -> tuple[int, str]:
    """
    Run SQL via the Supabase Management API. Re-asserts the ref immediately before
    the call. The local HTTPS path is proxied and intermittently drops the TLS
    connection ("UNEXPECTED_EOF_WHILE_READING") — that is a TRANSPORT failure, not
    a SQL failure, so it is retried. Every DDL block is idempotent, so a retry after
    a dropped response can never double-apply anything destructive.
    """
    import time
    import httpx
    assert_test_ref(ref, f"mgmt_query[{label}]")
    url = f"https://api.supabase.com/v1/projects/{ref}/database/query"
    last = (0, "no attempt made")
    for attempt in range(1, attempts + 1):
        try:
            r = httpx.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"query": sql},
                timeout=60,
            )
            return r.status_code, r.text
        except Exception as exc:  # noqa: BLE001  (transport-level only)
            last = (0, f"{type(exc).__name__}: {exc}")
            if attempt < attempts:
                print(f"      [transport retry {attempt}/{attempts - 1}] {label}: {type(exc).__name__}")
                time.sleep(1.5 * attempt)
    return last


# ── DDL blocks ────────────────────────────────────────────────────────────────
# Each entry: (label, sql). Applied in order; all idempotent.

DDL_BLOCKS: list[tuple[str, str]] = [
    ("extensions", """
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
"""),

    # source: migrate_v17 (+ v19 session_id, v21 prompt_full/setup_snapshot,
    #         v52_pin_generations_context_columns status/generation_request_id/…)
    ("pin_generations", """
CREATE TABLE IF NOT EXISTS pin_generations (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    keyword       text        NOT NULL DEFAULT '',
    category      text        NOT NULL DEFAULT '',
    source        text        NOT NULL DEFAULT 'workspace',
    ref_urls      text[]      NOT NULL DEFAULT '{}',
    pin_urls      text[]      NOT NULL DEFAULT '{}',
    groups_json   jsonb       NOT NULL DEFAULT '[]',
    ref_count     integer     NOT NULL DEFAULT 1,
    product_count integer     NOT NULL DEFAULT 0,
    total_pins    integer     NOT NULL DEFAULT 0
);
ALTER TABLE pin_generations
    ADD COLUMN IF NOT EXISTS session_id            text,
    ADD COLUMN IF NOT EXISTS status                text,
    ADD COLUMN IF NOT EXISTS expected_total        integer,
    ADD COLUMN IF NOT EXISTS mode                  text,
    ADD COLUMN IF NOT EXISTS opportunity           text,
    ADD COLUMN IF NOT EXISTS images_per_ref        integer,
    ADD COLUMN IF NOT EXISTS product_names         text[],
    ADD COLUMN IF NOT EXISTS product_ids           text[],
    ADD COLUMN IF NOT EXISTS prompt_excerpt        text,
    ADD COLUMN IF NOT EXISTS prompt_full           text,
    ADD COLUMN IF NOT EXISTS setup_snapshot        jsonb,
    ADD COLUMN IF NOT EXISTS category_audit        jsonb,
    ADD COLUMN IF NOT EXISTS error_type            text,
    ADD COLUMN IF NOT EXISTS error_message         text,
    ADD COLUMN IF NOT EXISTS generation_request_id text;
CREATE INDEX IF NOT EXISTS idx_pin_generations_user_created
    ON pin_generations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pin_generations_request_id
    ON pin_generations (generation_request_id) WHERE generation_request_id IS NOT NULL;
ALTER TABLE pin_generations ENABLE ROW LEVEL SECURITY;
"""),

    # source: migrate_v38_pin_drafts (+ v41 creative cols, v42/v50 scheduled_publish)
    ("pin_drafts", """
CREATE TABLE IF NOT EXISTS pin_drafts (
  vibepin_user_id uuid        NOT NULL,
  draft_id        text        NOT NULL,
  payload         jsonb       NOT NULL,
  status          text,
  updated_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  deleted_at      timestamptz,
  PRIMARY KEY (vibepin_user_id, draft_id)
);
ALTER TABLE pin_drafts
  ADD COLUMN IF NOT EXISTS creative_keywords    jsonb,
  ADD COLUMN IF NOT EXISTS recommended_keywords jsonb,
  ADD COLUMN IF NOT EXISTS creative_selections  jsonb,
  ADD COLUMN IF NOT EXISTS scheduled_at         timestamptz,
  ADD COLUMN IF NOT EXISTS publish_claimed_at   timestamptz;
CREATE INDEX IF NOT EXISTS pin_drafts_user_updated ON pin_drafts (vibepin_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS pin_drafts_user_live    ON pin_drafts (vibepin_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pin_drafts_scheduled_at_due
  ON pin_drafts (scheduled_at) WHERE scheduled_at IS NOT NULL AND deleted_at IS NULL;
ALTER TABLE pin_drafts ENABLE ROW LEVEL SECURITY;
"""),

    # source: api/migrations/001_pinterest_connections.sql (+ v49 token_version)
    ("pinterest_connections", """
CREATE TABLE IF NOT EXISTS pinterest_connections (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vibepin_user_id           uuid NOT NULL,
  provider                  text NOT NULL DEFAULT 'pinterest',
  pinterest_user_id         text,
  pinterest_username        text,
  pinterest_account_type    text,
  access_token_encrypted    text,
  refresh_token_encrypted   text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scopes                    text[] NOT NULL DEFAULT '{}',
  needs_reconnect           boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  disconnected_at           timestamptz
);
ALTER TABLE pinterest_connections
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS pinterest_connections_user_unique
  ON pinterest_connections (vibepin_user_id);
CREATE INDEX IF NOT EXISTS pinterest_connections_active
  ON pinterest_connections (vibepin_user_id) WHERE disconnected_at IS NULL;
ALTER TABLE pinterest_connections ENABLE ROW LEVEL SECURITY;
"""),

    # source: migrate_v41_creative_intelligence.sql section 2
    ("analytics_events", """
CREATE TABLE IF NOT EXISTS analytics_events (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid,
  user_id      uuid,
  draft_id     text,
  event_name   text        NOT NULL,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_name_created ON analytics_events (event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_user_created ON analytics_events (user_id, created_at DESC);
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
"""),

    # source: migrate_v13.sql — customer360.ts reads weekly_plans
    ("weekly_plans", """
CREATE TABLE IF NOT EXISTS weekly_plans (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     text    NOT NULL,
  week_start   date    NOT NULL,
  target_count integer NOT NULL DEFAULT 7,
  status       text    NOT NULL DEFAULT 'planning',
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (user_id, category, week_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_plans_user ON weekly_plans (user_id, week_start DESC);
ALTER TABLE weekly_plans ENABLE ROW LEVEL SECURITY;
"""),

    # source: migrate_v32_social_connections.sql — customer360.ts reads social_connections
    ("social_connections", """
CREATE TABLE IF NOT EXISTS social_connections (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vibepin_user_id          uuid NOT NULL,
  platform                 text NOT NULL,
  external_account_id      text,
  external_username        text,
  external_account_type    text,
  access_token_encrypted   text,
  refresh_token_encrypted  text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scopes                   text[] NOT NULL DEFAULT '{}',
  needs_reconnect          boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  disconnected_at          timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS social_connections_user_platform_unique
  ON social_connections (vibepin_user_id, platform);
ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;
"""),
]


# ── Column verification contract: what the console helpers actually select ─────
REQUIRED_COLUMNS: dict[str, list[str]] = {
    "pin_generations": [
        "id", "user_id", "created_at", "status", "generation_request_id",
        "pin_urls", "groups_json",
    ],
    "pin_drafts": [
        "vibepin_user_id", "draft_id", "payload", "updated_at",
        "scheduled_at", "deleted_at",
    ],
    "pinterest_connections": [
        "vibepin_user_id", "needs_reconnect", "disconnected_at", "created_at",
    ],
    "analytics_events": [
        "user_id", "workspace_id", "draft_id", "event_name", "payload", "created_at",
    ],
    "weekly_plans": ["user_id", "status", "week_start", "created_at"],
    "social_connections": ["vibepin_user_id", "platform", "needs_reconnect", "disconnected_at", "created_at"],
}


def cmd_check(c: dict[str, str]) -> int:
    print("\n=== CONNECTIVITY CHECK (read-only) ===")
    status, body = mgmt_query("select current_database() as db, 1 as ok", token=c["token"], ref=c["ref"], label="check")
    print(f"  Management API -> HTTP {status}: {body[:200]}")
    return 0 if status in (200, 201) else 1


def cmd_apply(c: dict[str, str]) -> int:
    print("\n=== APPLYING CONSOLE SCHEMA TO TEST PROJECT ===")
    assert_test_ref(c["ref"], "cmd_apply (pre-flight)")
    failures = 0
    for label, sql in DDL_BLOCKS:
        status, body = mgmt_query(sql, token=c["token"], ref=c["ref"], label=label)
        if status in (200, 201):
            print(f"  OK   {label}")
        else:
            print(f"  FAIL {label}: HTTP {status} {body[:400]}")
            failures += 1
    return 1 if failures else cmd_verify(c)


def cmd_verify(c: dict[str, str]) -> int:
    print("\n=== COLUMN VERIFICATION (console contract) ===")
    tables = list(REQUIRED_COLUMNS.keys())
    in_list = ",".join(f"'{t}'" for t in tables)
    sql = (
        "select table_name, column_name, data_type from information_schema.columns "
        f"where table_schema='public' and table_name in ({in_list}) order by table_name, column_name"
    )
    status, body = mgmt_query(sql, token=c["token"], ref=c["ref"], label="verify")
    if status not in (200, 201):
        print(f"  verification query failed: HTTP {status} {body[:300]}")
        return 1
    rows = json.loads(body)
    present: dict[str, dict[str, str]] = {}
    for r in rows:
        present.setdefault(r["table_name"], {})[r["column_name"]] = r["data_type"]

    missing_total = 0
    for table, cols in REQUIRED_COLUMNS.items():
        got = present.get(table)
        if got is None:
            print(f"  {table}: TABLE MISSING")
            missing_total += len(cols)
            continue
        parts = []
        for col in cols:
            if col in got:
                parts.append(f"{col}:{got[col]} OK")
            else:
                parts.append(f"{col} MISSING")
                missing_total += 1
        print(f"  {table}:")
        for p in parts:
            print(f"      {p}")
    print(f"\n  {'ALL REQUIRED COLUMNS PRESENT' if missing_total == 0 else f'{missing_total} COLUMN(S) MISSING'}")
    return 0 if missing_total == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the admin-console schema in the ISOLATED TEST project.")
    ap.add_argument("--check", action="store_true", help="connectivity + ref assertion only")
    ap.add_argument("--apply", action="store_true", help="create/patch the console schema")
    ap.add_argument("--verify", action="store_true", help="per-table column verification")
    args = ap.parse_args()
    if not (args.check or args.apply or args.verify):
        ap.print_help()
        return 2

    creds = load_test_creds()
    print(f"\nTEST project ref confirmed: {creds['ref']}  (production {PROD_REF} is NOT this)")

    if args.check:
        return cmd_check(creds)
    if args.apply:
        return cmd_apply(creds)
    return cmd_verify(creds)


if __name__ == "__main__":
    raise SystemExit(main())
