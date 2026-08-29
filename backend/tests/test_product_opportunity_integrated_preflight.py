import hashlib
import json
import subprocess
from copy import deepcopy
from pathlib import Path

from scripts import preflight_product_opportunity_integrated_release as preflight


REPO_ROOT = Path(__file__).parents[2]
MANIFEST_PATH = REPO_ROOT / preflight.MANIFEST_REL


def _head() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True
    ).strip()


def _manifest_sha256() -> str:
    return hashlib.sha256(MANIFEST_PATH.read_bytes()).hexdigest()


def test_integrated_preflight_audits_real_candidate_without_external_access() -> None:
    receipt, exit_code = preflight.audit_release(
        repo_root=REPO_ROOT,
        expected_head=_head(),
        expected_manifest_sha256=_manifest_sha256(),
        expected_branch="codex/product-v37-central-integrate-0829",
        # The implementation/test files are intentionally uncommitted while this
        # test is authored. CLI/main never disables the clean-worktree gate.
        require_clean=False,
    )

    assert exit_code == 0, receipt
    assert receipt == {
        "mode": "offline-read-only",
        "mutation": False,
        "networkAccess": False,
        "expectedHead": _head(),
        "expectedBranch": "codex/product-v37-central-integrate-0829",
        "runtimeCandidateCommit": preflight.EXPECTED_RUNTIME,
        "manifestSha256": _manifest_sha256(),
        "artifactCount": 39,
        "readyForPreviewHandoff": True,
        "readyForProduction": False,
        "errors": [],
        "verdict": "PASS_READY_FOR_PREVIEW_HANDOFF",
    }


def test_integrated_preflight_rejects_dirty_wrong_checkout_identity() -> None:
    errors = preflight._checkout_errors(
        actual_head="a" * 40,
        expected_head="b" * 40,
        actual_branch="wrong",
        expected_branch="expected",
        status=" M backend/file.py",
        require_clean=True,
    )
    assert errors == [
        "HEAD does not match --expected-head",
        "current branch does not match --expected-branch",
        "worktree/index is not clean",
    ]


def test_integrated_preflight_rejects_manifest_hash_before_git_or_artifact_work() -> None:
    receipt, exit_code = preflight.audit_release(
        repo_root=REPO_ROOT,
        expected_head=_head(),
        expected_manifest_sha256="0" * 64,
        expected_branch="codex/product-v37-central-integrate-0829",
        require_clean=False,
    )
    assert exit_code == 1
    assert receipt["verdict"] == "BLOCK"
    assert receipt["readyForPreviewHandoff"] is False
    assert receipt["readyForProduction"] is False
    assert receipt["errors"] == [
        "integrated manifest SHA-256 does not match expected bytes"
    ]


def test_integrated_preflight_manifest_contract_fails_closed() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assert preflight._manifest_contract_errors(
        manifest, "codex/product-v37-central-integrate-0829"
    ) == []

    changed = deepcopy(manifest)
    changed["externalGates"]["previewDeployed"] = True
    changed["runtimeCandidateCommit"] = preflight.STANDALONE_FUNCTIONAL
    changed["migrationOrder"] = list(reversed(changed["migrationOrder"]))
    errors = preflight._manifest_contract_errors(
        changed, "codex/product-v37-central-integrate-0829"
    )
    assert errors == [
        "manifest runtime candidate is not the frozen integrated runtime",
        "one or more external gates are not exactly false",
        "migration order or rollback pairing differs from v63/v66/v67",
    ]


def test_integrated_preflight_rejects_unsafe_artifact_paths() -> None:
    assert preflight._safe_relative_path("backend/file.py") == "backend/file.py"
    for unsafe in ("", "../secret", "/absolute", "backend\\file.py", None, 1):
        assert preflight._safe_relative_path(unsafe) is None
