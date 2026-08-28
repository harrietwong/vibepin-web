from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


BACKEND = Path(__file__).parents[1]
SCRIPT = BACKEND / "tests" / "postgres_v37" / "replay_product_opportunity_postgres_v37.py"
SPEC = importlib.util.spec_from_file_location("local_postgres_replay_v37_under_test", SCRIPT)
assert SPEC and SPEC.loader
replay = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = replay
SPEC.loader.exec_module(replay)


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1"])
def test_local_replay_accepts_only_explicit_loopback_hosts(host: str) -> None:
    replay._assert_loopback(host)


@pytest.mark.parametrize(
    "host",
    ["0.0.0.0", "10.0.0.2", "localhost", "db.example.com", "jaxteelkecvlozdrdoog.supabase.co"],
)
def test_local_replay_rejects_remote_or_wildcard_hosts(host: str) -> None:
    with pytest.raises(ValueError, match="loopback"):
        replay._assert_loopback(host)


def test_local_confirmation_binds_literal_host_port_and_fixed_database() -> None:
    assert replay.confirmation_value("127.0.0.1", 55437, replay.LOCAL_DATABASE) == (
        "LOCAL-V37-ROLLBACK-ONLY:127.0.0.1:55437:vibepin_v37_replay"
    )


def test_local_error_normalizer_emits_exact_management_api_shape() -> None:
    status, body = replay._normalize_pg_error(
        "psql:<stdin>:4: ERROR:  55P03: canceling statement due to lock timeout\n"
        "LOCATION:  ProcessInterrupts, postgres.c:3416\n"
    )
    assert status == 400
    assert json.loads(body) == {
        "message": "Failed to run sql query: ERROR:  55P03: "
        "canceling statement due to lock timeout\n",
    }


@pytest.mark.parametrize(
    "stderr",
    [
        "no sqlstate",
        "ERROR:  55P03: lock timeout\nERROR:  P0001: duplicate\n",
        "ERROR:  55p03: lowercase code\n",
    ],
)
def test_local_error_normalizer_fails_closed_on_ambiguous_errors(stderr: str) -> None:
    status, body = replay._normalize_pg_error(stderr)
    assert status == 500
    assert json.loads(body)["message"] == "local psql error had no unique SQLSTATE line"


def test_local_replay_binds_exact_canonical_sql_hashes() -> None:
    assert replay._verify_hashes() == {
        "backend/db/migrate_v63_product_opportunities_v1.sql":
            "6de95674b286b71ce299eb298e28312a2a632e4e1d312cd3752e005ee6d8d3d1",
        "backend/db/rollback_v63_product_opportunities_v1.sql":
            "bba932a49e65b7f7f9cf2c38ebaa89a751eab7719c9e17a923abd853acdb9e3c",
        "backend/docs/product_opportunities_v37_catalog_query_v1.sql":
            "1d0ff2369649f4f01f42be2f55abb6a4b85d24e93c365afd05ebe2dbabb6f035",
        "backend/docs/product_opportunities_v37_stage1_post_apply_query_v1.sql":
            "2c482caca84b779dd60d94be8f0f7010162701fea5d0abfa3d773328d69c8b43",
    }


def test_fixture_auth_uid_reads_the_same_local_jwt_subject_guc_as_rls() -> None:
    assert "current_setting('request.jwt.claim.sub', true)" in replay.FIXTURE_SQL
    assert "GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role" in replay.FIXTURE_SQL
    assert "GRANT EXECUTE ON FUNCTION auth.uid()" in replay.FIXTURE_SQL


def test_cleanup_removes_only_the_isolated_replay_fixtures() -> None:
    assert "DROP TABLE product_opportunities" not in replay.CLEANUP_SQL
    assert "DROP TABLE pin_products" in replay.CLEANUP_SQL
    assert "DROP SCHEMA auth CASCADE" in replay.CLEANUP_SQL
    assert "DROP ROLE authenticated" in replay.CLEANUP_SQL
