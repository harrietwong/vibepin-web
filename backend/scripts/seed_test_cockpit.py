#!/usr/bin/env python3
"""
seed_test_cockpit.py — synthetic users + rows for admin operator console E2E.

=========================== ABSOLUTE SAFETY RED LINE ===========================
Every write (auth user creation, PostgREST insert, Management API SQL) is
hard-locked to the TEST project and asserted immediately before the call.

  TEST       ref = snulmwprsahzqvdbyenc   (writes allowed)
  PRODUCTION ref = jaxteelkecvlozdrdoog   (NEVER — abort on sight)

Credentials come ONLY from web/.env.test.local (+ backend/.env.migration for the
Management API token). backend/.env and web/.env.local (production) are never read.
The synthetic-user password comes from COCKPIT_E2E_PASSWORD when supplied;
otherwise a fresh random password is generated and printed after seeding.
================================================================================

WHAT IT SEEDS (predicates transcribed from web/src/lib/server/adminActionCenter.ts)
  WINDOW_HOURS                 = 24
  SIGNUP_NOT_CONNECTED_HOURS   = 48
  CONNECTED_NOT_CREATING_HOURS = 72   (existence check is ALL-TIME, not 30d)
  SCAN_WINDOW_HOURS            = 24*30

Cases (email prefix e2e-cockpit-):
  1  signup-not-connected     signup 96h ago, no connection row
  2  connected-not-creating   connection 120h ago, ZERO gens/drafts ever
  3  generation-failures      3 failed pin_generations in last 24h, no later success
  4  pinterest-disconnected   connection with needs_reconnect=true
  5a publish-failure-exact    pinterest_publish_failed event <24h, no later success
  5b publish-failure-inferred draft payload.publishError, no publish events
  6  negative-control         connection 120h ago BUT a generation+draft ~45d ago
                              -> must NOT be connected_not_creating
  7a paid-blocker             app_metadata.plan=pro + a blocker (sorts first)
  7b free-blocker-older       no plan + an OLDER blocker (sorts after the paid one)
  8  fakepaid-blocker         user_metadata.plan=pro only -> must NOT sort as paid
  9  funnel-*                 milestone ladder coverage for the 5-stage funnel
  10 admin-super / ordinary   permission-testing accounts

IDEMPOTENCY
  --reset deletes every auth user whose email starts with the e2e-cockpit- prefix
  and every row this script owns (identified by that user id set), then reseeds.
  It NEVER touches rows belonging to other users.

USAGE
  py -3 backend/scripts/seed_test_cockpit.py --seed
  py -3 backend/scripts/seed_test_cockpit.py --reset --seed
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent

TEST_REF = "snulmwprsahzqvdbyenc"
PROD_REF = "jaxteelkecvlozdrdoog"
EMAIL_PREFIX = "e2e-cockpit-"
EMAIL_DOMAIN = "example.test"
SEED_PASSWORD = os.environ.get("COCKPIT_E2E_PASSWORD") or secrets.token_urlsafe(24)


# ── env / guard plumbing ──────────────────────────────────────────────────────

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
    if ref == PROD_REF:
        _die(f"{what} targets the PRODUCTION project ({PROD_REF}). Refusing.")
    if ref != TEST_REF:
        _die(f"{what} targets ref '{ref}', expected TEST '{TEST_REF}'. Refusing.")


def load_creds() -> dict[str, str]:
    env = _load_dotenv(
        REPO / "web" / ".env.test.local",
        ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    )
    url = env.get("NEXT_PUBLIC_SUPABASE_URL", "")
    svc = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not svc:
        _die("web/.env.test.local must contain NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    ref = project_ref_of(url)
    assert_test_ref(ref, "credential load (web/.env.test.local)")
    tok = os.environ.get("SUPABASE_MIGRATION_TOKEN") or _load_dotenv(
        ROOT / ".env.migration", ["SUPABASE_MIGRATION_TOKEN"]
    ).get("SUPABASE_MIGRATION_TOKEN", "")
    if not tok:
        _die("SUPABASE_MIGRATION_TOKEN is missing from the environment and backend/.env.migration.")
    return {"url": url.rstrip("/"), "ref": ref, "service": svc, "token": tok}


C: dict[str, str] = {}


def _retrying(fn, label: str, attempts: int = 4):
    """Local HTTPS is proxied and drops TLS intermittently; retry transport errors only."""
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < attempts:
                print(f"      [transport retry {attempt}] {label}: {type(exc).__name__}")
                time.sleep(1.5 * attempt)
    raise last  # type: ignore[misc]


def mgmt_sql(sql: str, label: str) -> list[dict]:
    """Management API SQL. Used only for things PostgREST/Auth cannot do (backdating auth.users)."""
    import httpx
    assert_test_ref(C["ref"], f"mgmt_sql[{label}]")
    url = f"https://api.supabase.com/v1/projects/{C['ref']}/database/query"

    def go():
        return httpx.post(
            url,
            headers={"Authorization": f"Bearer {C['token']}", "Content-Type": "application/json"},
            json={"query": sql},
            timeout=60,
        )

    r = _retrying(go, f"mgmt_sql[{label}]")
    if r.status_code not in (200, 201):
        _die(f"mgmt_sql[{label}] HTTP {r.status_code}: {r.text[:400]}")
    try:
        return json.loads(r.text)
    except json.JSONDecodeError:
        return []


def _svc_headers() -> dict[str, str]:
    return {
        "apikey": C["service"],
        "Authorization": f"Bearer {C['service']}",
        "Content-Type": "application/json",
    }


def rest_insert(table: str, rows: list[dict], label: str) -> None:
    import httpx
    if not rows:
        return
    assert_test_ref(project_ref_of(C["url"]), f"rest_insert[{table}:{label}]")

    def go():
        return httpx.post(
            f"{C['url']}/rest/v1/{table}",
            headers={**_svc_headers(), "Prefer": "return=minimal"},
            json=rows,
            timeout=60,
        )

    r = _retrying(go, f"rest_insert[{table}]")
    if r.status_code not in (200, 201, 204):
        _die(f"insert into {table} failed HTTP {r.status_code}: {r.text[:500]}")


def auth_create_user(email: str, app_metadata: dict, user_metadata: dict) -> str:
    import httpx
    assert_test_ref(project_ref_of(C["url"]), f"auth_create_user[{email}]")
    body = {
        "email": email,
        "password": SEED_PASSWORD,
        "email_confirm": True,
        "app_metadata": app_metadata,
        "user_metadata": user_metadata,
    }

    def go():
        return httpx.post(f"{C['url']}/auth/v1/admin/users", headers=_svc_headers(), json=body, timeout=60)

    r = _retrying(go, f"auth_create_user[{email}]")
    if r.status_code not in (200, 201):
        _die(f"auth user creation failed for {email}: HTTP {r.status_code} {r.text[:400]}")
    return r.json()["id"]


def auth_list_seed_users() -> list[dict]:
    """List all auth users, filtered to our e2e-cockpit- prefix."""
    import httpx
    assert_test_ref(project_ref_of(C["url"]), "auth_list_seed_users")
    out: list[dict] = []
    for page in range(1, 21):
        def go(p=page):
            return httpx.get(
                f"{C['url']}/auth/v1/admin/users",
                headers=_svc_headers(),
                params={"page": p, "per_page": 200},
                timeout=60,
            )
        r = _retrying(go, "auth_list_seed_users")
        if r.status_code != 200:
            _die(f"listUsers failed HTTP {r.status_code}: {r.text[:300]}")
        users = r.json().get("users", [])
        out.extend(u for u in users if (u.get("email") or "").startswith(EMAIL_PREFIX))
        if len(users) < 200:
            break
    return out


def auth_delete_user(uid: str) -> None:
    import httpx
    assert_test_ref(project_ref_of(C["url"]), f"auth_delete_user[{uid}]")

    def go():
        return httpx.delete(f"{C['url']}/auth/v1/admin/users/{uid}", headers=_svc_headers(), timeout=60)

    r = _retrying(go, "auth_delete_user")
    if r.status_code not in (200, 204):
        print(f"  warn: delete user {uid} -> HTTP {r.status_code} {r.text[:200]}")


# ── time helpers ──────────────────────────────────────────────────────────────

NOW = datetime.now(timezone.utc)


def ago(hours: float = 0, days: float = 0) -> str:
    return (NOW - timedelta(hours=hours, days=days)).isoformat().replace("+00:00", "Z")


def ahead(hours: float = 0) -> str:
    return (NOW + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


# ── seed plan ─────────────────────────────────────────────────────────────────
#
# Each case: (slug, expected blocker(s), app_metadata, user_metadata, signup_hours_ago)

CASES: list[dict] = [
    dict(slug="signup-not-connected", signup_h=96,  app={}, usr={},
         expect=["signup_not_connected"]),
    dict(slug="connected-not-creating", signup_h=200, app={}, usr={},
         expect=["connected_not_creating"]),
    dict(slug="generation-failures", signup_h=200, app={}, usr={},
         expect=["generation_failures"]),
    dict(slug="pinterest-disconnected", signup_h=200, app={}, usr={},
         expect=["pinterest_disconnected"]),
    dict(slug="publish-failure-exact", signup_h=200, app={}, usr={},
         expect=["publish_failure(exact)"]),
    dict(slug="publish-failure-inferred", signup_h=200, app={}, usr={},
         expect=["publish_failure(inferred)"]),
    dict(slug="negative-control-45d", signup_h=200, app={}, usr={},
         expect=["NONE (must not be connected_not_creating)"]),
    dict(slug="paid-blocker", signup_h=100, app={"plan": "pro"}, usr={},
         expect=["signup_not_connected", "sorts FIRST (paid)"]),
    dict(slug="free-blocker-older", signup_h=400, app={}, usr={},
         expect=["signup_not_connected", "older but sorts AFTER paid"]),
    dict(slug="fakepaid-blocker", signup_h=300, app={}, usr={"plan": "pro"},
         expect=["signup_not_connected", "must NOT sort as paid"]),
    # funnel ladder (all inside the 30d cohort window)
    dict(slug="funnel-signup-only", signup_h=200, app={}, usr={}, expect=["stage: signup"]),
    dict(slug="funnel-connected", signup_h=200, app={}, usr={}, expect=["stage: pinterestConnected"]),
    dict(slug="funnel-generated", signup_h=200, app={}, usr={}, expect=["stage: firstGeneration"]),
    dict(slug="funnel-published", signup_h=200, app={}, usr={}, expect=["stage: firstPublish (inferred)"]),
    dict(slug="funnel-repeat", signup_h=200, app={}, usr={}, expect=["stage: repeatPublish (exact)"]),
    # permission-testing accounts
    dict(slug="admin-super", signup_h=200, app={"role": "super_admin"}, usr={},
         expect=["super admin (app_metadata.role)"]),
    dict(slug="ordinary-user", signup_h=200, app={}, usr={}, expect=["no admin access"]),
]


def email_for(slug: str) -> str:
    return f"{EMAIL_PREFIX}{slug}@{EMAIL_DOMAIN}"


def draft_payload(**over) -> dict:
    p = {
        "id": over.get("draft_id", "d"),
        "keyword": "e2e",
        "category": "e2e",
        "title": "E2E seeded pin",
        "description": "synthetic",
        "altText": "",
        "destinationUrl": "",
        "boardId": "",
        "boardName": "",
        "weeklyPlanItemId": "",
        "generationSessionId": "",
        "scheduledDate": "",
        "status": "ready",
        "imageUrl": over.get("imageUrl"),
        "createdAt": over.get("createdAt"),
        "updatedAt": over.get("updatedAt"),
    }
    p.update({k: v for k, v in over.items() if k not in ("draft_id",)})
    return {k: v for k, v in p.items() if v is not None}


# ── reset ─────────────────────────────────────────────────────────────────────

def cmd_reset() -> None:
    print("\n=== RESET (delete prior e2e-cockpit- seed) ===")
    assert_test_ref(C["ref"], "cmd_reset")
    users = auth_list_seed_users()
    ids = [u["id"] for u in users]
    print(f"  found {len(ids)} prior seed user(s)")
    if ids:
        id_list = ",".join(f"'{i}'" for i in ids)
        # Delete owned rows FIRST (pin_drafts / analytics_events / pinterest_connections /
        # social_connections have no FK cascade to auth.users).
        for table, col in [
            ("pin_drafts", "vibepin_user_id"),
            ("analytics_events", "user_id"),
            ("pinterest_connections", "vibepin_user_id"),
            ("social_connections", "vibepin_user_id"),
            ("pin_generations", "user_id"),
            ("weekly_plans", "user_id"),
        ]:
            mgmt_sql(f"delete from public.{table} where {col} in ({id_list})", f"reset-{table}")
            print(f"  cleared {table}")
    for uid in ids:
        auth_delete_user(uid)
    print(f"  deleted {len(ids)} auth user(s)")


# ── seed ──────────────────────────────────────────────────────────────────────

def cmd_seed() -> None:
    print("\n=== SEED ===")
    assert_test_ref(C["ref"], "cmd_seed")

    ids: dict[str, str] = {}
    for case in CASES:
        slug = case["slug"]
        uid = auth_create_user(email_for(slug), case["app"], case["usr"])
        ids[slug] = uid
        print(f"  created {email_for(slug):<52} {uid}")

    # Backdate auth.users.created_at — the Auth admin API cannot set it, so this
    # goes through the Management API (still hard-locked to the TEST ref).
    backdate = ", ".join(
        f"('{ids[c['slug']]}'::uuid, '{ago(hours=c['signup_h'])}'::timestamptz)" for c in CASES
    )
    mgmt_sql(
        f"update auth.users u set created_at = v.ts, updated_at = v.ts, "
        f"last_sign_in_at = greatest(v.ts, now() - interval '3 days') "
        f"from (values {backdate}) as v(id, ts) where u.id = v.id",
        "backdate-signups",
    )
    print(f"  backdated created_at for {len(CASES)} users")

    conns: list[dict] = []
    gens: list[dict] = []
    drafts: list[dict] = []
    events: list[dict] = []

    def conn(slug: str, created_hours: float, *, needs_reconnect=False, disconnected_at=None):
        conns.append({
            "vibepin_user_id": ids[slug],
            "provider": "pinterest",
            "pinterest_user_id": f"pt_{slug}",
            "pinterest_username": slug,
            "scopes": ["pins:read", "pins:write", "boards:read"],
            "needs_reconnect": needs_reconnect,
            "disconnected_at": disconnected_at,
            "created_at": ago(hours=created_hours),
            "updated_at": ago(hours=created_hours),
        })

    def gen(slug: str, created: str, status: str, *, urls=None, req_id=None):
        gens.append({
            "id": str(uuid.uuid4()),
            "user_id": ids[slug],
            "created_at": created,
            "status": status,
            "keyword": "e2e",
            "category": "e2e",
            "source": "workspace",
            "pin_urls": urls or [],
            "groups_json": [{"refUrl": None, "images": urls or []}],
            "generation_request_id": req_id,
            "total_pins": len(urls or []),
        })

    def draft(slug: str, draft_id: str, updated: str, payload: dict, *, scheduled_at=None, deleted_at=None):
        # pin_drafts.payload is consumed as a complete PinDraft by the account
        # sync layer. Keep the synthetic fixture structurally valid so a test
        # login cannot crash Create Pins before the admin route is exercised.
        payload = {**payload}
        payload.setdefault("createdAt", updated)
        payload.setdefault("updatedAt", updated)
        drafts.append({
            "vibepin_user_id": ids[slug],
            "draft_id": draft_id,
            "payload": payload,
            "status": payload.get("status"),
            "updated_at": updated,
            "created_at": updated,
            "scheduled_at": scheduled_at,
            "deleted_at": deleted_at,
        })

    def event(slug: str, name: str, created: str, *, draft_id=None, payload=None):
        events.append({
            "id": str(uuid.uuid4()),
            "workspace_id": ids[slug],
            "user_id": ids[slug],
            "draft_id": draft_id,
            "event_name": name,
            "payload": payload or {},
            "created_at": created,
        })

    # 1 signup_not_connected — NO connection row at all. (signup 96h ago > 48h)

    # 2 connected_not_creating — connection 120h ago (>72h), zero gens/drafts ever.
    conn("connected-not-creating", 120)

    # 3 generation_failures — 3 failures inside the 24h window, no later success.
    conn("generation-failures", 300)
    gen("generation-failures", ago(hours=20), "failed")
    gen("generation-failures", ago(hours=10), "failed")
    gen("generation-failures", ago(hours=4),  "failed")
    # an OLDER success (before the failures) must NOT clear the block
    gen("generation-failures", ago(hours=23), "completed", urls=["https://img.test/genfail-ok.png"])

    # 4 pinterest_disconnected — needs_reconnect=true (disconnected_at stays null so
    #   the reason code is needs_reconnect, not disconnected).
    conn("pinterest-disconnected", 300, needs_reconnect=True)
    #   give it a draft so connected_not_creating does not also fire
    draft("pinterest-disconnected", "pd_disc_1", ago(hours=30),
          draft_payload(draft_id="pd_disc_1", status="ready", imageUrl="https://img.test/disc.png"))

    # 5a publish_failure EXACT — failed event <24h, a SUCCESS that is OLDER (must not clear).
    conn("publish-failure-exact", 300)
    draft("publish-failure-exact", "pd_pfx_1", ago(hours=6),
          draft_payload(draft_id="pd_pfx_1", status="ready", imageUrl="https://img.test/pfx.png"))
    event("publish-failure-exact", "pinterest_publish_succeeded", ago(hours=18), draft_id="pd_pfx_1")
    event("publish-failure-exact", "pinterest_publish_failed", ago(hours=5), draft_id="pd_pfx_1",
          payload={"errorCode": "PINTEREST_403"})

    # 5b publish_failure INFERRED — draft payload.publishError, NO publish events.
    conn("publish-failure-inferred", 300)
    draft("publish-failure-inferred", "pd_pfi_1", ago(hours=7),
          draft_payload(draft_id="pd_pfi_1", status="ready", imageUrl="https://img.test/pfi.png",
                        publishError="Pinterest rejected the pin",
                        publishErrorCode="PINTEREST_IMAGE_REJECTED"))

    # 6 negative control — connected 120h ago BUT created content ~45 days ago and
    #   nothing since. All-time existence must suppress connected_not_creating.
    conn("negative-control-45d", 120)
    gen("negative-control-45d", ago(days=45), "completed", urls=["https://img.test/nc45.png"])
    draft("negative-control-45d", "pd_nc_1", ago(days=45),
          draft_payload(draft_id="pd_nc_1", status="ready", imageUrl="https://img.test/nc45.png"))

    # 7a paid-blocker — app_metadata.plan=pro, signup_not_connected (100h, no conn).
    # 7b free-blocker-older — no plan, OLDER blocker (400h) → must still sort AFTER paid.
    # 8  fakepaid-blocker — user_metadata.plan=pro only (300h) → NOT paid.
    #    (all three deliberately have no connection row)

    # 9 funnel ladder
    #   funnel-signup-only: nothing
    conn("funnel-connected", 100)
    conn("funnel-generated", 100)
    gen("funnel-generated", ago(hours=90), "completed", urls=["https://img.test/fg.png"],
        req_id="genreq-funnel-generated")
    conn("funnel-published", 100)
    gen("funnel-published", ago(hours=90), "completed", urls=["https://img.test/fp.png"],
        req_id="genreq-funnel-published")
    #   inferred first publish via payload.postedAt
    draft("funnel-published", "pd_fpub_1", ago(hours=80),
          draft_payload(draft_id="pd_fpub_1", status="posted", imageUrl="https://img.test/fp.png",
                        postedAt=ago(hours=80), sourceGenerationId="genreq-funnel-published"))
    conn("funnel-repeat", 100)
    gen("funnel-repeat", ago(hours=95), "completed", urls=["https://img.test/fr1.png"],
        req_id="genreq-funnel-repeat")
    draft("funnel-repeat", "pd_frep_1", ago(hours=85),
          draft_payload(draft_id="pd_frep_1", status="posted", imageUrl="https://img.test/fr1.png",
                        postedAt=ago(hours=85), sourceGenerationId="genreq-funnel-repeat"))
    #   EXACT publishes (two succeeded events within 7d) → repeatPublish exact
    event("funnel-repeat", "pinterest_publish_succeeded", ago(hours=85), draft_id="pd_frep_1")
    event("funnel-repeat", "pinterest_publish_succeeded", ago(hours=60), draft_id="pd_frep_1")

    # 10 permission accounts — give them healthy state so they add no noise.
    conn("admin-super", 300)
    #   admin-super doubles as the AI-adoption INFERRED-link case: a completed
    #   generation whose output URL is referenced by a PUBLISHED draft that carries
    #   NO sourceGenerationId → adoption must link them via the URL index, so
    #   linkSplit.inferred is non-zero (the exact path is covered by funnel-*).
    gen("admin-super", ago(hours=26), "completed", urls=["https://img.test/adm.png"])
    draft("admin-super", "pd_admin_1", ago(hours=20),
          draft_payload(draft_id="pd_admin_1", status="posted", imageUrl="https://img.test/adm.png",
                        postedAt=ago(hours=20)))
    conn("ordinary-user", 300)
    draft("ordinary-user", "pd_ord_1", ago(hours=20),
          draft_payload(draft_id="pd_ord_1", status="posted", imageUrl="https://img.test/ord.png",
                        postedAt=ago(hours=20)))

    rest_insert("pinterest_connections", conns, "connections")
    rest_insert("pin_generations", gens, "generations")
    rest_insert("pin_drafts", drafts, "drafts")
    rest_insert("analytics_events", events, "events")

    print(f"\n  rows: pinterest_connections={len(conns)} pin_generations={len(gens)} "
          f"pin_drafts={len(drafts)} analytics_events={len(events)}")

    # ── manifest ──
    print("\n" + "=" * 96)
    print("SEED MANIFEST")
    print("=" * 96)
    per_user_rows: dict[str, list[str]] = {s: [] for s in ids}
    for r in conns:
        for s, u in ids.items():
            if u == r["vibepin_user_id"]:
                per_user_rows[s].append(
                    f"conn(created={r['created_at'][:19]},needs_reconnect={r['needs_reconnect']},disc={r['disconnected_at']})")
    for r in gens:
        for s, u in ids.items():
            if u == r["user_id"]:
                per_user_rows[s].append(f"gen({r['status']}@{r['created_at'][:19]})")
    for r in drafts:
        for s, u in ids.items():
            if u == r["vibepin_user_id"]:
                extra = []
                if r["payload"].get("postedAt"):
                    extra.append("postedAt")
                if r["payload"].get("publishError"):
                    extra.append("publishError")
                per_user_rows[s].append(f"draft({r['draft_id']}{'/' + '+'.join(extra) if extra else ''}@{r['updated_at'][:19]})")
    for r in events:
        for s, u in ids.items():
            if u == r["user_id"]:
                per_user_rows[s].append(f"event({r['event_name']}@{r['created_at'][:19]})")

    for case in CASES:
        slug = case["slug"]
        print(f"\n  {email_for(slug)}")
        print(f"    id       : {ids[slug]}")
        print(f"    signup   : {ago(hours=case['signup_h'])} ({case['signup_h']}h ago)")
        print(f"    app_meta : {case['app'] or '{}'}   user_meta: {case['usr'] or '{}'}")
        print(f"    expect   : {', '.join(case['expect'])}")
        rows = per_user_rows[slug]
        print(f"    rows     : {'; '.join(rows) if rows else '(none)'}")
    print("\n" + "=" * 96)
    print(f"Seed password for all accounts: {SEED_PASSWORD}")
    print("=" * 96 + "\n")


def main() -> int:
    global C
    ap = argparse.ArgumentParser(description="Seed synthetic operator-console data into the TEST project.")
    ap.add_argument("--reset", action="store_true", help="delete prior e2e-cockpit- users + their rows first")
    ap.add_argument("--seed", action="store_true", help="create users + rows")
    args = ap.parse_args()
    if not (args.reset or args.seed):
        ap.print_help()
        return 2

    C = load_creds()
    print(f"\nTEST project ref confirmed: {C['ref']}  (production {PROD_REF} is NOT this)")

    if args.reset:
        cmd_reset()
    if args.seed:
        cmd_seed()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
