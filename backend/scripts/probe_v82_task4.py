#!/usr/bin/env python
"""probe_v82_task4.py — test-DB verification for task 4's v82 changes.

Re-checks M1/M4/M7 after the section-G body was filled in, and probes the new
`publish_intent_confirm_prepare_v82` implementation: delegation, the
confirmed_absent proof gate, receipt-shape validation, and the replay guard.

TEST DATABASE ONLY. The target ref is asserted against production before any
statement is sent; a mismatch aborts before the first network call.
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROD_REF = "jaxteelkecvlozdrdoog"
TEST_REF = "snulmwprsahzqvdbyenc"


def load_env(path: Path, keys):
    out = {}
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


TOKEN = load_env(ROOT / ".env.migration", ["SUPABASE_MIGRATION_TOKEN"]).get("SUPABASE_MIGRATION_TOKEN", "")
if not TOKEN:
    sys.exit("SUPABASE_MIGRATION_TOKEN missing")

print("=" * 66)
print(f"TARGET project_ref : {TEST_REF}")
print(f"PRODUCTION ref     : {PROD_REF}")
assert TEST_REF != PROD_REF, "ABORT: target is production"
print("ASSERTION OK: target != production. Proceeding.")
print("=" * 66)


def q(sql, label=""):
    """Run one statement on the TEST project. Returns (status, parsed_body)."""
    url = f"https://api.supabase.com/v1/projects/{TEST_REF}/database/query"
    req = urllib.request.Request(
        url,
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "[]")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}" + (f"\n        {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  FAIL  {name}\n        {detail}")


# ── M1: the v82 objects exist after the re-apply ────────────────────────────
s, b = q("""
select
  (select count(*) from pg_class where relname='scheduled_publish_attempts') as t1,
  (select count(*) from pg_class where relname='publish_reconcile_checks') as t2,
  (select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid
    where c.relname='pin_drafts' and a.attname='publish_next_attempt_at'
      and not a.attisdropped) as col,
  (select count(*) from pg_proc where proname='publish_intent_confirm_prepare_v82') as f1,
  (select count(*) from pg_proc where proname='publish_reconcile_record_v82') as f2,
  (select count(*) from pg_proc where proname='scheduled_publish_attempt_record_v82') as f3
""")
check("M1 v82 objects present after re-apply", s == 201 and all(
    b[0][k] == 1 for k in ("t1", "t2", "col", "f1", "f2", "f3")), f"{s} {b}")

# ── The G body is really implemented (no placeholder left) ──────────────────
s, b = q("""select prosrc like '%v82_unknown_retry_not_implemented%' as stub,
                  prosrc like '%retry_of_destination_id=v_parent_destination.id%' as binds,
                  prosrc like '%attempt=v_parent_destination.attempt+1%' as inherits
             from pg_proc where proname='publish_intent_confirm_prepare_v82'""")
check("G body implemented (placeholder gone, lineage + attempt inheritance present)",
      s == 201 and b[0]["stub"] is False and b[0]["binds"] and b[0]["inherits"], f"{s} {b}")

# ── M4: attempt cap still enforced ──────────────────────────────────────────
s, b = q("""do $$
declare v_err text;
begin
  begin
    perform public.scheduled_publish_attempt_record_v82(
      '00000000-0000-4000-8000-000000000001'::uuid,'probe_v82_t4',
      now(),'pinterest','c1',6,'retryable');
    raise exception 'NO_ERROR_RAISED';
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err <> 'v82_attempt_cap_exceeded' then
    raise exception 'unexpected: %', v_err;
  end if;
end $$;""")
check("M4 attempt=6 rejected with v82_attempt_cap_exceeded", s == 201, f"{s} {b}")

s, b = q("""select count(*) from pg_constraint
  where conname in ('publish_intent_destinations_v82_attempt_cap',
                    'provider_publish_attempts_v82_attempt_cap')""")
check("M4 both v82 attempt-cap constraints installed", s == 201 and b[0]["count"] == 2, f"{s} {b}")

# ── M7: RLS / grants unchanged ──────────────────────────────────────────────
s, b = q("""select
  has_table_privilege('authenticated','public.scheduled_publish_attempts','INSERT') as a_ins,
  has_table_privilege('authenticated','public.publish_reconcile_checks','INSERT') as c_ins,
  has_table_privilege('anon','public.publish_reconcile_checks','SELECT') as anon_sel,
  has_table_privilege('service_role','public.publish_reconcile_checks','SELECT') as sr_sel,
  has_table_privilege('service_role','public.publish_reconcile_checks','INSERT') as sr_ins,
  has_function_privilege('authenticated',
    'public.publish_intent_confirm_prepare_v82(uuid,jsonb,text,uuid)','EXECUTE') as auth_exec,
  has_function_privilege('service_role',
    'public.publish_intent_confirm_prepare_v82(uuid,jsonb,text,uuid)','EXECUTE') as sr_exec
""")
ok = s == 201 and b[0] == {"a_ins": False, "c_ins": False, "anon_sel": False,
                           "sr_sel": True, "sr_ins": False,
                           "auth_exec": False, "sr_exec": True}
check("M7 RLS/grants: clients denied, service_role SELECT-only + RPC execute",
      ok, f"{s} {b}")

# ── G1: no reconcile id ⇒ pure v78 delegation (unchanged behaviour) ─────────
# A malformed fingerprint is v78's own first check; seeing ITS error message
# proves the call really reached v78 rather than being handled here.
s, b = q("""do $$
declare v_err text;
begin
  begin
    perform public.publish_intent_confirm_prepare_v82(
      '00000000-0000-4000-8000-000000000001'::uuid, '{}'::jsonb, 'not-a-fingerprint');
    raise exception 'NO_ERROR_RAISED';
  exception when others then v_err := sqlerrm;
  end;
  if v_err <> 'invalid_source_identity_fingerprint' then
    raise exception 'unexpected: %', v_err;
  end if;
end $$;""")
check("G1 p_reconcile_check_id NULL delegates to v78 (v78's own error surfaces)",
      s == 201, f"{s} {b}")

# ── G2: an unknown / non-existent reconcile id is refused ───────────────────
FP = "a" * 64
s, b = q(f"""do $$
declare v_err text;
begin
  begin
    perform public.publish_intent_confirm_prepare_v82(
      '00000000-0000-4000-8000-000000000001'::uuid, '{{}}'::jsonb, '{FP}',
      '00000000-0000-4000-8000-0000000000ff'::uuid);
    raise exception 'NO_ERROR_RAISED';
  exception when others then v_err := sqlerrm;
  end;
  if v_err <> 'reconcile_absent_proof_required' then
    raise exception 'unexpected: %', v_err;
  end if;
end $$;""")
check("G2 unknown reconcile id ⇒ reconcile_absent_proof_required (no blind retry)",
      s == 201, f"{s} {b}")

# ── G3: a still_unknown / confirmed_published check is refused ──────────────
# The core anti-duplicate guarantee: only 'confirmed_absent' may open a child.
for outcome, extra in (("still_unknown", ""), ("confirmed_published", ", 'remote-1'")):
    s, b = q(f"""do $$
declare v_id uuid; v_err text;
begin
  insert into public.publish_reconcile_checks(
    owner_user_id, draft_id, scheduled_at, provider, attempt, outcome, remote_id)
  values ('00000000-0000-4000-8000-00000000000a'::uuid,'probe_v82_t4',
          now(),'pinterest',1,'{outcome}'{extra or ', null'})
  returning id into v_id;
  begin
    perform public.publish_intent_confirm_prepare_v82(
      '00000000-0000-4000-8000-00000000000a'::uuid, '{{}}'::jsonb, '{FP}', v_id);
    raise exception 'NO_ERROR_RAISED';
  exception when others then v_err := sqlerrm;
  end;
  delete from public.publish_reconcile_checks where id = v_id;
  if v_err <> 'reconcile_absent_proof_required' then
    raise exception 'unexpected for {outcome}: %', v_err;
  end if;
end $$;""")
    check(f"G3 outcome={outcome} refused ⇒ reconcile_absent_proof_required", s == 201, f"{s} {b}")

# ── G4: confirmed_absent alone is NOT enough — receipt shape is validated ───
s, b = q(f"""do $$
declare v_id uuid; v_err text;
begin
  insert into public.publish_reconcile_checks(
    owner_user_id, draft_id, scheduled_at, provider, attempt, outcome, destination_id)
  values ('00000000-0000-4000-8000-00000000000b'::uuid,'probe_v82_t4',
          now(),'pinterest',1,'confirmed_absent','pinterest:conn-1')
  returning id into v_id;
  begin
    -- valid proof, but the receipt names no prior intent
    perform public.publish_intent_confirm_prepare_v82(
      '00000000-0000-4000-8000-00000000000b'::uuid,
      '{{"intentId":"publish:c1:x","mode":{{"kind":"now"}},"onlyPending":true}}'::jsonb,
      '{FP}', v_id);
    raise exception 'NO_ERROR_RAISED';
  exception when others then v_err := sqlerrm;
  end;
  delete from public.publish_reconcile_checks where id = v_id;
  if v_err <> 'retry_not_allowed' then
    raise exception 'unexpected: %', v_err;
  end if;
end $$;""")
check("G4 confirmed_absent + malformed receipt ⇒ retry_not_allowed (shape validated)",
      s == 201, f"{s} {b}")

# ── G5: dispatch set must be exactly the check's own destination ────────────
s, b = q(f"""do $$
declare v_id uuid; v_err text;
begin
  insert into public.publish_reconcile_checks(
    owner_user_id, draft_id, scheduled_at, provider, attempt, outcome, destination_id)
  values ('00000000-0000-4000-8000-00000000000c'::uuid,'probe_v82_t4',
          now(),'pinterest',1,'confirmed_absent','pinterest:conn-1')
  returning id into v_id;
  begin
    perform public.publish_intent_confirm_prepare_v82(
      '00000000-0000-4000-8000-00000000000c'::uuid,
      jsonb_build_object(
        'intentId','publish:c1:child','priorIntentId','publish:c1:parent',
        'draftId','d1','contentId','c1',
        'mode', jsonb_build_object('kind','now'), 'onlyPending', true,
        'publishableDestinations', jsonb_build_array(
          jsonb_build_object('id','pinterest:conn-OTHER','provider','pinterest')),
        'dispatchDestinationIds', jsonb_build_array('pinterest:conn-OTHER')),
      '{FP}', v_id);
    raise exception 'NO_ERROR_RAISED';
  exception when others then v_err := sqlerrm;
  end;
  delete from public.publish_reconcile_checks where id = v_id;
  if v_err <> 'retry_not_allowed' then
    raise exception 'unexpected: %', v_err;
  end if;
end $$;""")
check("G5 dispatch set ≠ the proof's destination ⇒ retry_not_allowed",
      s == 201, f"{s} {b}")

# ── G6: the replay guard excludes the receipt's OWN child ───────────────────
# Source-level check: the single-redemption predicate must exclude both the
# parent's own id AND this receipt's intentId, or a crash-replay of our own
# child is refused forever and the destination is stranded.
s, b = q("""select prosrc like '%child.intent_id <> v_intent_id%' as excludes_self
             from pg_proc where proname='publish_intent_confirm_prepare_v82'""")
check("G6 single-redemption guard excludes this receipt's own child (replay-safe)",
      s == 201 and b[0]["excludes_self"], f"{s} {b}")

# ── Leftovers ───────────────────────────────────────────────────────────────
s, b = q("""select
  (select count(*) from public.publish_reconcile_checks where draft_id='probe_v82_t4') as checks,
  (select count(*) from public.scheduled_publish_attempts where draft_id='probe_v82_t4') as attempts""")
check("probe left no rows behind", s == 201 and b[0]["checks"] == 0 and b[0]["attempts"] == 0, f"{s} {b}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
