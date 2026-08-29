#!/usr/bin/env python3
"""Offline fail-closed preflight for the integrated Product v3.7 release.

This command performs Git/object and manifest checks only. It never reads
credentials, opens a network connection, writes a receipt, deploys, migrates or
changes a service/timer. The JSON receipt is written to stdout for the caller to
capture explicitly if desired.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any


EXPECTED_RUNTIME = "60a540f1f3ead08e112d378f3df778000c189abb"
STANDALONE_FUNCTIONAL = "d2c13dd6a4d1e79d0d247fa6cd09d68c04a15b5d"
DEFAULT_BRANCH = "codex/product-v37-central-integrate-0829"
MANIFEST_REL = Path(
    "backend/docs/product_opportunities_v37_integrated_release_manifest_60a540f1.json"
)
RUNBOOK_PATH = "backend/docs/product_opportunities_v37_rollout.md"
CURRENT_HANDOFF_PATH = (
    "backend/docs/product_opportunities_v37_integrated_pre_stage_handoff_20260829.md"
)
SUPERSEDED_HANDOFF_PATH = (
    "backend/docs/product_opportunities_v37_pre_stage_handoff_20260829T075822Z.md"
)
SELF_PATH = "backend/scripts/preflight_product_opportunity_integrated_release.py"
SELF_TEST_PATH = "backend/tests/test_product_opportunity_integrated_preflight.py"
EXPECTED_MIGRATIONS = [
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
EXPECTED_EXTERNAL_GATES = {
    "pushed": False,
    "migrationsApplied": False,
    "previewDeployed": False,
    "liveProductTruthVerified": False,
    "browserQaPassed": False,
    "productionPromoted": False,
    "vpsOrTimersChanged": False,
}
SHA1_RE = re.compile(r"[0-9a-f]{40}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def _git_bytes(repo_root: Path, *args: str) -> bytes:
    return subprocess.check_output(
        ["git", "-C", str(repo_root), *args],
        stderr=subprocess.STDOUT,
    )


def _git_text(repo_root: Path, *args: str) -> str:
    return _git_bytes(repo_root, *args).decode("utf-8", errors="strict").strip()


def _is_ancestor(repo_root: Path, ancestor: str, descendant: str) -> bool:
    return (
        subprocess.run(
            ["git", "-C", str(repo_root), "merge-base", "--is-ancestor", ancestor, descendant],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0
    )


def _checkout_errors(
    *,
    actual_head: str,
    expected_head: str,
    actual_branch: str,
    expected_branch: str,
    status: str,
    require_clean: bool,
) -> list[str]:
    errors: list[str] = []
    if actual_head != expected_head:
        errors.append("HEAD does not match --expected-head")
    if actual_branch != expected_branch:
        errors.append("current branch does not match --expected-branch")
    if require_clean and status:
        errors.append("worktree/index is not clean")
    return errors


def _manifest_contract_errors(manifest: dict[str, Any], expected_branch: str) -> list[str]:
    errors: list[str] = []
    if manifest.get("schemaVersion") != 2:
        errors.append("manifest schemaVersion is not 2")
    if manifest.get("candidateBranch") != expected_branch:
        errors.append("manifest candidateBranch does not match expected branch")
    if manifest.get("runtimeCandidateCommit") != EXPECTED_RUNTIME:
        errors.append("manifest runtime candidate is not the frozen integrated runtime")
    if manifest.get("rollbackCommit") != EXPECTED_RUNTIME:
        errors.append("manifest rollback boundary does not match the runtime candidate")
    if manifest.get("verdict") != "READY_FOR_PREVIEW_NOT_PRODUCTION":
        errors.append("manifest verdict is not preview-only")
    if manifest.get("externalGates") != EXPECTED_EXTERNAL_GATES:
        errors.append("one or more external gates are not exactly false")
    if manifest.get("migrationOrder") != EXPECTED_MIGRATIONS:
        errors.append("migration order or rollback pairing differs from v63/v66/v67")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        errors.append("manifest artifacts is not a list")
    elif manifest.get("artifactCount") != len(artifacts):
        errors.append("manifest artifactCount does not match the artifact list")
    return errors


def _safe_relative_path(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value:
        return None
    return value


def audit_release(
    *,
    repo_root: Path,
    expected_head: str,
    expected_manifest_sha256: str,
    expected_branch: str,
    require_clean: bool = True,
) -> tuple[dict[str, Any], int]:
    errors: list[str] = []
    if not SHA1_RE.fullmatch(expected_head):
        errors.append("--expected-head must be a full lowercase Git SHA-1")
    if not SHA256_RE.fullmatch(expected_manifest_sha256):
        errors.append("--expected-manifest-sha256 must be 64 lowercase hex characters")
    if not expected_branch or expected_branch.strip() != expected_branch:
        errors.append("--expected-branch must be a non-empty exact branch name")
    if errors:
        return _receipt(expected_head, expected_branch, "", 0, errors), 1

    repo_root = repo_root.resolve()
    manifest_path = (repo_root / MANIFEST_REL).resolve()
    try:
        manifest_path.relative_to(repo_root)
        raw_manifest = manifest_path.read_bytes()
    except (OSError, ValueError) as exc:
        errors.append(f"cannot read integrated manifest: {exc}")
        return _receipt(expected_head, expected_branch, "", 0, errors), 1

    actual_manifest_sha256 = hashlib.sha256(raw_manifest).hexdigest()
    if actual_manifest_sha256 != expected_manifest_sha256:
        errors.append("integrated manifest SHA-256 does not match expected bytes")
        return _receipt(expected_head, expected_branch, actual_manifest_sha256, 0, errors), 1

    try:
        manifest = json.loads(raw_manifest.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"integrated manifest is not valid UTF-8 JSON: {exc}")
        return _receipt(expected_head, expected_branch, actual_manifest_sha256, 0, errors), 1
    if not isinstance(manifest, dict):
        errors.append("integrated manifest root is not an object")
        return _receipt(expected_head, expected_branch, actual_manifest_sha256, 0, errors), 1

    try:
        actual_head = _git_text(repo_root, "rev-parse", "HEAD")
        actual_branch = _git_text(repo_root, "branch", "--show-current")
        status = _git_text(repo_root, "status", "--porcelain=v1", "--untracked-files=all")
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError) as exc:
        errors.append(f"cannot inspect Git checkout: {exc}")
        return _receipt(expected_head, expected_branch, actual_manifest_sha256, 0, errors), 1

    errors.extend(
        _checkout_errors(
            actual_head=actual_head,
            expected_head=expected_head,
            actual_branch=actual_branch,
            expected_branch=expected_branch,
            status=status,
            require_clean=require_clean,
        )
    )
    errors.extend(_manifest_contract_errors(manifest, expected_branch))

    commits: list[object] = [
        manifest.get("productionAnchor"),
        *(manifest.get("sourceCommits", {}) or {}).values(),
        manifest.get("fourLineMergeCommit"),
        manifest.get("gateFixCommit"),
        manifest.get("boundedTraceCommit"),
        manifest.get("rollbackCommit"),
        manifest.get("runtimeCandidateCommit"),
        manifest.get("evidenceCommit"),
    ]
    for commit in dict.fromkeys(commits):
        if not isinstance(commit, str) or not SHA1_RE.fullmatch(commit):
            errors.append(f"manifest contains an invalid commit identity: {commit!r}")
        elif not _is_ancestor(repo_root, commit, expected_head):
            errors.append(f"required commit is not an ancestor of expected HEAD: {commit}")

    try:
        runtime_tree = _git_text(repo_root, "rev-parse", f"{EXPECTED_RUNTIME}^{{tree}}")
        if manifest.get("runtimeTree") != runtime_tree:
            errors.append("manifest runtimeTree does not match the frozen runtime commit")
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError) as exc:
        errors.append(f"cannot resolve runtime tree: {exc}")

    artifacts = manifest.get("artifacts")
    artifact_paths: list[str] = []
    if isinstance(artifacts, list):
        seen: set[str] = set()
        for index, artifact in enumerate(artifacts):
            if not isinstance(artifact, dict):
                errors.append(f"artifact {index} is not an object")
                continue
            path = _safe_relative_path(artifact.get("path"))
            commit = artifact.get("commit")
            if path is None:
                errors.append(f"artifact {index} has an unsafe path")
                continue
            artifact_paths.append(path)
            if path in seen:
                errors.append(f"duplicate artifact path: {path}")
            seen.add(path)
            if not isinstance(commit, str) or not SHA1_RE.fullmatch(commit):
                errors.append(f"artifact has invalid commit: {path}")
                continue
            if not _is_ancestor(repo_root, commit, expected_head):
                errors.append(f"artifact commit is not an ancestor of expected HEAD: {path}")
                continue
            try:
                blob = _git_text(repo_root, "rev-parse", f"{commit}:{path}")
                payload = _git_bytes(repo_root, "cat-file", "blob", blob)
                head_blob = _git_text(repo_root, "rev-parse", f"{expected_head}:{path}")
            except (OSError, subprocess.CalledProcessError, UnicodeDecodeError) as exc:
                errors.append(f"cannot resolve artifact {path}: {exc}")
                continue
            if artifact.get("gitBlobSha1") != blob:
                errors.append(f"artifact Git blob SHA-1 mismatch: {path}")
            if artifact.get("sha256") != hashlib.sha256(payload).hexdigest():
                errors.append(f"artifact SHA-256 mismatch: {path}")
            if artifact.get("bytes") != len(payload):
                errors.append(f"artifact byte length mismatch: {path}")
            if head_blob != blob:
                errors.append(f"artifact differs at expected HEAD: {path}")

    for required_path in (
        RUNBOOK_PATH,
        CURRENT_HANDOFF_PATH,
        SUPERSEDED_HANDOFF_PATH,
        SELF_PATH,
        SELF_TEST_PATH,
    ):
        if required_path not in artifact_paths:
            errors.append(f"operational artifact is not manifest-bound: {required_path}")

    try:
        runbook = _git_bytes(repo_root, "show", f"{expected_head}:{RUNBOOK_PATH}").decode("utf-8")
        handoff = _git_bytes(repo_root, "show", f"{expected_head}:{CURRENT_HANDOFF_PATH}").decode(
            "utf-8"
        )
        old_handoff = _git_bytes(
            repo_root, "show", f"{expected_head}:{SUPERSEDED_HANDOFF_PATH}"
        ).decode("utf-8")
        runtime_binding = f"--candidate-sha {EXPECTED_RUNTIME}"
        if runbook.count(runtime_binding) != 2:
            errors.append("runbook does not bind exactly two schema receipts to runtime candidate")
        if f"--candidate-sha {STANDALONE_FUNCTIONAL}" in runbook:
            errors.append("runbook still binds a schema receipt to standalone candidate")
        if runtime_binding not in handoff:
            errors.append("current integrated handoff does not bind the runtime candidate")
        if "SUPERSEDED" not in old_handoff or "DO NOT EXECUTE" not in old_handoff:
            errors.append("historical handoff is not unmistakably superseded")
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError) as exc:
        errors.append(f"cannot inspect operational handoff files: {exc}")

    artifact_count = len(artifacts) if isinstance(artifacts, list) else 0
    receipt = _receipt(
        expected_head,
        expected_branch,
        actual_manifest_sha256,
        artifact_count,
        errors,
    )
    return receipt, 0 if not errors else 1


def _receipt(
    expected_head: str,
    expected_branch: str,
    manifest_sha256: str,
    artifact_count: int,
    errors: list[str],
) -> dict[str, Any]:
    return {
        "mode": "offline-read-only",
        "mutation": False,
        "networkAccess": False,
        "expectedHead": expected_head,
        "expectedBranch": expected_branch,
        "runtimeCandidateCommit": EXPECTED_RUNTIME,
        "manifestSha256": manifest_sha256,
        "artifactCount": artifact_count,
        "readyForPreviewHandoff": not errors,
        "readyForProduction": False,
        "errors": errors,
        "verdict": "PASS_READY_FOR_PREVIEW_HANDOFF" if not errors else "BLOCK",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).parents[2])
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--expected-manifest-sha256", required=True)
    parser.add_argument("--expected-branch", default=DEFAULT_BRANCH)
    args = parser.parse_args()

    receipt, exit_code = audit_release(
        repo_root=args.repo_root,
        expected_head=args.expected_head,
        expected_manifest_sha256=args.expected_manifest_sha256,
        expected_branch=args.expected_branch,
        require_clean=True,
    )
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
