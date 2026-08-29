from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = (
    REPO_ROOT
    / "backend"
    / "docs"
    / "product_opportunities_v37_integrated_release_manifest_60a540f1.json"
)


def _git(*args: str, binary: bool = False) -> str | bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=not binary,
    )
    if binary:
        return result.stdout
    return result.stdout.strip()


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_integrated_manifest_is_preview_only_and_complete() -> None:
    manifest = _manifest()

    assert manifest["schemaVersion"] == 2
    assert manifest["candidateBranch"] == "codex/product-v37-central-integrate-0829"
    assert manifest["verdict"] == "READY_FOR_PREVIEW_NOT_PRODUCTION"
    datetime.fromisoformat(str(manifest["generatedAtUtc"]).replace("Z", "+00:00"))

    external = manifest["externalGates"]
    assert isinstance(external, dict)
    assert external
    assert set(external.values()) == {False}

    artifacts = manifest["artifacts"]
    assert isinstance(artifacts, list)
    assert manifest["artifactCount"] == len(artifacts) == 41
    paths = [str(row["path"]) for row in artifacts]
    assert len(paths) == len(set(paths))


def test_integrated_manifest_binds_all_frozen_source_commits() -> None:
    manifest = _manifest()
    runtime_commit = str(manifest["runtimeCandidateCommit"])

    expected_sources = {
        "admin": "27c70f90ec69bed64511efb98eb6827b5a427b5f",
        "reference": "68eebbd242889baf3205f2bc3c14396f560a0620",
        "multichannel": "4320a4daf0956b026d5707907841104939aec337",
        "productOpportunitiesV37": "cd21adfe357b572b10eddcecac51d59952203993",
    }
    assert manifest["sourceCommits"] == expected_sources
    assert manifest["productionAnchor"] == "5bcc1a6a0068347c6397b463c713aba82e45a6d9"
    assert manifest["fourLineMergeCommit"] == "385b9e07456007593572466f537f0e44bb8c0264"
    assert manifest["gateFixCommit"] == "16b499796fc9cd2a6ee75b24b30d22a807b0f172"
    assert manifest["boundedTraceCommit"] == "b8037c96fc4a468dbcee7ced984c9db29cdaedc2"
    assert manifest["rollbackCommit"] == "60a540f1f3ead08e112d378f3df778000c189abb"
    assert runtime_commit == "60a540f1f3ead08e112d378f3df778000c189abb"
    assert manifest["runtimeTree"] == _git("rev-parse", f"{runtime_commit}^{{tree}}")

    for source_commit in [manifest["productionAnchor"], *expected_sources.values()]:
        result = subprocess.run(
            ["git", "merge-base", "--is-ancestor", str(source_commit), runtime_commit],
            cwd=REPO_ROOT,
            check=False,
        )
        assert result.returncode == 0, f"{source_commit} is not in the runtime candidate"

    evidence_commit = str(manifest["evidenceCommit"])
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", runtime_commit, evidence_commit],
        cwd=REPO_ROOT,
        check=False,
    )
    assert result.returncode == 0


def test_integrated_manifest_artifact_hashes_match_git_blobs() -> None:
    manifest = _manifest()
    for row in manifest["artifacts"]:
        commit = str(row["commit"])
        path = str(row["path"])
        blob_sha = str(_git("rev-parse", f"{commit}:{path}"))
        blob = _git("cat-file", "blob", blob_sha, binary=True)
        assert isinstance(blob, bytes)
        assert row["gitBlobSha1"] == blob_sha
        assert row["sha256"] == hashlib.sha256(blob).hexdigest()
        assert row["bytes"] == len(blob)


def test_integrated_manifest_migration_order_and_gate_receipts_are_exact() -> None:
    manifest = _manifest()
    assert manifest["migrationOrder"] == [
        {
            "forward": "backend/db/migrate_v63_product_opportunities_v1.sql",
            "rollback": "backend/db/rollback_v63_product_opportunities_v1.sql",
        },
        {
            "forward": "backend/db/migrate_v66_creem_subscription_units.sql",
            "rollback": "backend/db/rollback_v66_creem_subscription_units.sql",
        },
        {
            "forward": "backend/db/migrate_v67_remove_connection_if_unscheduled.sql",
            "rollback": "backend/db/rollback_v67_remove_connection_if_unscheduled.sql",
        },
    ]
    assert not any("v68" in str(step) for step in manifest["migrationOrder"])

    gates = manifest["gates"]
    assert gates == {
        "backend": "1132 passed, 2 skipped, 77 subtests",
        "automationContract": "35 passed",
        "webCoreStudioPlan": "203/203 passed",
        "productOpportunityWebContracts": "7/7 passed",
        "generationModerationGate": "106 passed",
        "integratedMigrationRollbackSource": "4 passed",
        "integratedMigrationRollbackPglite": (
            "PASS: v66 fail-closed+preserved, v67 forward+rollback, both idempotent"
        ),
        "testRegistry": "210 tracked, 203 run, 7 justified exclusions",
        "typecheck": "exit 0",
        "i18n": "2860 English keys, 18 locale catalogs",
        "productionBuild": "exit 0, 71/71 pages",
        "generateTraceBefore": "1299 files, 55719444 bytes",
        "generateTraceAfter": "106 files, 2065849 bytes",
    }
