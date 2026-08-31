from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from scripts import payment_publish_preview_manifest as manifest


V71_APPLY = "backend/db/migrate_v71_generation_intent_idempotency.sql"
V71_ROLLBACK = "backend/db/rollback_v71_generation_intent_idempotency.sql"


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _git_bytes(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    return result.stdout


def _write(repo: Path, relative_path: str, payload: bytes) -> None:
    path = repo / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


@pytest.fixture
def synthetic_release_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, str]:
    repo = tmp_path / "release-repo"
    repo.mkdir()
    _git(repo, "init", "--quiet")
    _git(repo, "config", "user.email", "manifest-test@example.invalid")
    _git(repo, "config", "user.name", "Manifest Test")

    required_paths = set(manifest.REQUIRED_EVIDENCE)
    for step in manifest.MIGRATION_ORDER:
        required_paths.add(str(step["apply"]))
        if step["recovery"]:
            required_paths.add(str(step["recovery"]))
    for path in sorted(required_paths):
        _write(repo, path, f"fixture:{path}\n".encode())

    _write(repo, "app.txt", b"source\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "--quiet", "-m", "source")
    source = _git(repo, "rev-parse", "HEAD")

    _write(repo, "app.txt", b"runtime\n")
    _git(repo, "add", "app.txt")
    _git(repo, "commit", "--quiet", "-m", "runtime")
    runtime = _git(repo, "rev-parse", "HEAD")

    monkeypatch.setattr(manifest, "CENTRAL", source)
    monkeypatch.setattr(manifest, "MULTICHANNEL", source)
    monkeypatch.setattr(manifest, "USAGE", source)
    return repo, runtime


def _manifest_file(tmp_path: Path, payload: dict[str, object]) -> tuple[Path, str]:
    raw = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode()
    path = tmp_path / "manifest.json"
    path.write_bytes(raw)
    return path, hashlib.sha256(raw).hexdigest()


def test_migration_order_preserves_v63_through_v68_and_pairs_v71() -> None:
    assert manifest.MIGRATION_ORDER[:4] == [
        {
            "version": 63,
            "apply": "backend/db/migrate_v63_product_opportunities_v1.sql",
            "recovery": "backend/db/rollback_v63_product_opportunities_v1.sql",
            "recoveryMode": "sql_rollback",
        },
        {
            "version": 66,
            "apply": "backend/db/migrate_v66_creem_subscription_units.sql",
            "recovery": "backend/db/rollback_v66_creem_subscription_units.sql",
            "recoveryMode": "sql_rollback",
        },
        {
            "version": 67,
            "apply": "backend/db/migrate_v67_remove_connection_if_unscheduled.sql",
            "recovery": "backend/db/rollback_v67_remove_connection_if_unscheduled.sql",
            "recoveryMode": "sql_rollback",
        },
        {
            "version": 68,
            "apply": "backend/db/migrate_v68_scheduled_post_release.sql",
            "recovery": None,
            "recoveryMode": "retain_db_disable_feature_and_rollback_app",
            "reason": (
                "v68 replaces ledger functions without schema DDL. Once release events exist, "
                "restoring the v55 consume function would break re-charge semantics for those key families."
            ),
            "featureRecovery": [
                "USAGE_ENFORCE_SCHEDULED_POSTS=false",
                "USAGE_METERING_MODE=shadow_or_off",
                "rollback_application_only",
                "retain_v68_functions_and_ledger_events",
            ],
        },
    ]
    assert manifest.MIGRATION_ORDER[4] == {
        "version": 71,
        "apply": V71_APPLY,
        "recovery": V71_ROLLBACK,
        "recoveryMode": "sql_rollback",
    }


def test_build_binds_v71_pair_to_git_blob_hashes(
    synthetic_release_repo: tuple[Path, str],
) -> None:
    repo, runtime = synthetic_release_repo
    payload = manifest.build(repo, runtime)
    artifacts = {str(item["path"]): item for item in payload["artifacts"]}

    assert payload["migrationOrder"] == manifest.MIGRATION_ORDER
    for path in (V71_APPLY, V71_ROLLBACK):
        raw = _git_bytes(repo, "show", f"{runtime}:{path}")
        assert artifacts[path] == {
            "path": path,
            "gitBlobSha1": _git(repo, "rev-parse", f"{runtime}:{path}"),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        }


def test_build_rejects_runtime_missing_v71_rollback(
    synthetic_release_repo: tuple[Path, str],
) -> None:
    repo, _runtime = synthetic_release_repo
    _git(repo, "rm", V71_ROLLBACK)
    _git(repo, "commit", "--quiet", "-m", "remove rollback")
    runtime = _git(repo, "rev-parse", "HEAD")

    with pytest.raises(manifest.ManifestError, match="rollback_v71_generation_intent_idempotency"):
        manifest.build(repo, runtime)


def test_verifier_rejects_v71_hash_and_pair_tampering(
    synthetic_release_repo: tuple[Path, str],
    tmp_path: Path,
) -> None:
    repo, runtime = synthetic_release_repo
    payload = manifest.build(repo, runtime)

    path, digest = _manifest_file(tmp_path, payload)
    assert manifest.verify(repo, path, digest)["ok"] is True

    artifacts = payload["artifacts"]
    assert isinstance(artifacts, list)
    v71_apply = next(item for item in artifacts if item["path"] == V71_APPLY)
    v71_apply["sha256"] = "0" * 64
    path, digest = _manifest_file(tmp_path, payload)
    receipt = manifest.verify(repo, path, digest)
    assert receipt["ok"] is False
    assert f"artifact digest mismatch: {V71_APPLY}" in receipt["errors"]

    payload = json.loads(json.dumps(manifest.build(repo, runtime)))
    migration_order = payload["migrationOrder"]
    assert isinstance(migration_order, list)
    migration_order[-1] = {**migration_order[-1], "recovery": None}
    path, digest = _manifest_file(tmp_path, payload)
    receipt = manifest.verify(repo, path, digest)
    assert receipt["ok"] is False
    assert "migration/recovery contract mismatch" in receipt["errors"]
