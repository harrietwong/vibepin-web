from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (ROOT / "backend/db/migrate_v74_security_invoker_rls.sql").read_text(
    encoding="utf-8"
).lower()
ROLLBACK = (ROOT / "backend/db/rollback_v74_security_invoker_rls.sql").read_text(
    encoding="utf-8"
).lower()
LEGACY_SCHEMA = (ROOT / "api/supabase_schema.sql").read_text(encoding="utf-8").lower()
TASK_ROUTES = (ROOT / "api/app/api/routes/tasks.py").read_text(encoding="utf-8")
AUTH_HELPER = (ROOT / "api/app/core/auth.py").read_text(encoding="utf-8")
APP_MAIN = (ROOT / "api/app/main.py").read_text(encoding="utf-8")


def test_v74_is_missing_object_compatible_and_unknown_shape_fail_closed() -> None:
    for name in ("tasks", "user_settings", "audit_log", "trend_opportunities_view"):
        assert f"public.{name}" in MIGRATION
    assert MIGRATION.count("to_regclass(") >= 7
    assert "exists without user_id" in MIGRATION
    assert "exists but is not a normal view" in MIGRATION


def test_v74_enables_owner_rls_and_invoker_view_without_broad_grants() -> None:
    assert "alter table public.%i enable row level security" in MIGRATION
    assert "alter table public.%i force row level security" in MIGRATION
    assert "alter table public.audit_log enable row level security" in MIGRATION
    assert "alter table public.audit_log force row level security" in MIGRATION
    assert "as restrictive for all to authenticated" in MIGRATION
    assert "as restrictive for select to authenticated" in MIGRATION
    assert "as restrictive for insert to authenticated" in MIGRATION
    assert "as restrictive for update to authenticated" in MIGRATION
    assert "as restrictive for delete to authenticated" in MIGRATION
    assert "as permissive for all to authenticated" in MIGRATION
    assert "user_id::text = (select auth.uid())::text" in MIGRATION
    assert "security_invoker = true" in MIGRATION
    assert "grant " not in MIGRATION
    assert "unexpected existing policies" in MIGRATION
    assert "already exists without the v74 marker" in MIGRATION


def test_audit_log_is_append_and_owner_read_only() -> None:
    assert "for select to authenticated" in MIGRATION
    assert "for insert to authenticated" in MIGRATION
    assert "for update to authenticated\n      using (false) with check (false)" in MIGRATION
    assert "for delete to authenticated\n      using (false)" in MIGRATION


def test_v74_and_rollback_never_delete_protected_data_or_disable_security() -> None:
    for sql in (MIGRATION, ROLLBACK):
        assert "drop table" not in sql
        assert "truncate " not in sql
        assert "delete from" not in sql
        assert "disable row level security" not in sql
    assert "obj_description(p.oid, 'pg_policy')" in ROLLBACK
    assert "marker is unexpected" in ROLLBACK
    assert "retaining security_invoker=true" in ROLLBACK
    assert "reset (security_invoker)" not in ROLLBACK


def test_fresh_legacy_schema_is_secure_by_default() -> None:
    for table in ("tasks", "user_settings", "audit_log"):
        assert f"alter table {table} enable row level security" in LEGACY_SCHEMA
        assert f"alter table {table} force row level security" in LEGACY_SCHEMA
    for marker in (
        "vibepin:v74:owner-access",
        "vibepin:v74:owner-boundary",
        "vibepin:v74:audit-owner-select",
        "vibepin:v74:audit-owner-insert",
        "vibepin:v74:audit-deny-update",
        "vibepin:v74:audit-deny-delete",
    ):
        assert marker in LEGACY_SCHEMA


def test_legacy_task_http_surface_verifies_user_and_scopes_service_role_queries() -> None:
    assert ".auth.get_user(token.strip())" in AUTH_HELPER
    assert "token prefix" not in TASK_ROUTES.lower()
    assert '"user_id": user_id' in TASK_ROUTES
    assert TASK_ROUTES.count('.eq("user_id", user_id)') >= 7
    assert '.table("user_settings")' in TASK_ROUTES
    assert '.eq("user_id", user_id)' in TASK_ROUTES
    assert '.select("*").limit(1)' not in TASK_ROUTES


def test_unsafe_legacy_oauth_router_is_not_exposed() -> None:
    assert "from app.api.routes import tasks, auth" not in APP_MAIN
    assert "include_router(auth.router)" not in APP_MAIN
