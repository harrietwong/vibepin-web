#!/usr/bin/env python3
"""Build or verify the payment + publishing Preview release manifest.

Offline only: this script reads Git objects and writes a JSON manifest in build
mode. It never reads credentials, connects to a service, deploys, or migrates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


CENTRAL = "5fe929355c0531f47934aec84248898741be2f6a"
MULTICHANNEL = "f1beaa877a2367cec1c0d4f7eb164b805ded8e97"
USAGE = "af7eed8f2028a9eb5d32bd760c02339428fa44e8"
PRODUCTION_ANCHOR = "5bcc1a6a0068347c6397b463c713aba82e45a6d9"
BRANCH = "codex/payment-publish-handoff-0830"

MIGRATION_ORDER = [
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

REQUIRED_EVIDENCE = [
    "backend/docs/product_opportunities_v37_integrated_pre_stage_handoff_20260829.md",
    "backend/docs/product_opportunities_v37_rollout.md",
    "docs/交接/交接单-Codex接管收款与发布-统一候选-20260830.md",
]


class ManifestError(RuntimeError):
    pass


def git(repo: Path, *args: str, binary: bool = False) -> str | bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise ManifestError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout if binary else result.stdout.decode("utf-8").strip()


def require_full_sha(value: str, label: str) -> None:
    if len(value) != 40 or any(c not in "0123456789abcdef" for c in value):
        raise ManifestError(f"{label} must be a full lowercase Git SHA-1")


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def blob_record(repo: Path, commit: str, path: str) -> dict[str, object]:
    raw = git(repo, "show", f"{commit}:{path}", binary=True)
    assert isinstance(raw, bytes)
    blob = git(repo, "rev-parse", f"{commit}:{path}")
    assert isinstance(blob, str)
    return {
        "path": path,
        "gitBlobSha1": blob,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
    }


def artifact_paths(repo: Path, runtime: str) -> list[str]:
    changed = git(repo, "diff", "--name-only", "-z", CENTRAL, runtime, binary=True)
    assert isinstance(changed, bytes)
    paths = {
        path.decode("utf-8")
        for path in changed.split(b"\0")
        if path
    }
    paths.update(REQUIRED_EVIDENCE)
    for step in MIGRATION_ORDER:
        paths.add(str(step["apply"]))
        if step["recovery"]:
            paths.add(str(step["recovery"]))
    return sorted(paths)


def build(repo: Path, runtime: str) -> dict[str, object]:
    require_full_sha(runtime, "runtime commit")
    actual_runtime = git(repo, "rev-parse", runtime)
    assert isinstance(actual_runtime, str)
    if actual_runtime != runtime:
        raise ManifestError("runtime commit does not resolve exactly")
    for label, source in (("central", CENTRAL), ("multichannel", MULTICHANNEL), ("usage", USAGE)):
        if not is_ancestor(repo, source, runtime):
            raise ManifestError(f"{label} source is not an ancestor of runtime commit")

    commit_epoch = int(str(git(repo, "show", "-s", "--format=%ct", runtime)))
    generated = datetime.fromtimestamp(commit_epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    paths = artifact_paths(repo, runtime)
    artifacts = [blob_record(repo, runtime, path) for path in paths]
    runtime_tree = git(repo, "rev-parse", f"{runtime}^{{tree}}")
    assert isinstance(runtime_tree, str)
    return {
        "schemaVersion": 1,
        "generatedAtUtc": generated,
        "candidateBranch": BRANCH,
        "verdict": "READY_FOR_PREVIEW_VALIDATION_NOT_PRODUCTION",
        "productionAnchor": PRODUCTION_ANCHOR,
        "sourceCommits": {
            "central": CENTRAL,
            "multichannelFinal": MULTICHANNEL,
            "usagePhase1": USAGE,
        },
        "runtimeCandidateCommit": runtime,
        "runtimeTree": runtime_tree,
        "migrationOrder": MIGRATION_ORDER,
        "externalGates": {
            "branchPushed": False,
            "previewDeployed": False,
            "previewMigrationsVerified": False,
            "liveProductTruthVerified": False,
            "browserE2EWithoutMocks": False,
            "predeployGuardPassed": False,
            "shadowReviewPassed": False,
        },
        "artifactCount": len(artifacts),
        "artifacts": artifacts,
    }


def verify(repo: Path, manifest_path: Path, expected_sha256: str) -> dict[str, object]:
    raw = manifest_path.read_bytes()
    actual_sha = hashlib.sha256(raw).hexdigest()
    errors: list[str] = []
    if actual_sha != expected_sha256:
        errors.append("manifest SHA-256 does not match expected bytes")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ManifestError(f"manifest is not valid UTF-8 JSON: {exc}") from exc

    runtime = str(manifest.get("runtimeCandidateCommit", ""))
    try:
        require_full_sha(runtime, "runtimeCandidateCommit")
    except ManifestError as exc:
        errors.append(str(exc))
    if manifest.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if manifest.get("candidateBranch") != BRANCH:
        errors.append("candidateBranch mismatch")
    if manifest.get("verdict") != "READY_FOR_PREVIEW_VALIDATION_NOT_PRODUCTION":
        errors.append("verdict must remain Preview-only")
    if manifest.get("sourceCommits") != {
        "central": CENTRAL,
        "multichannelFinal": MULTICHANNEL,
        "usagePhase1": USAGE,
    }:
        errors.append("sourceCommits mismatch")
    if manifest.get("migrationOrder") != MIGRATION_ORDER:
        errors.append("migration/recovery contract mismatch")

    try:
        tree = git(repo, "rev-parse", f"{runtime}^{{tree}}")
        if manifest.get("runtimeTree") != tree:
            errors.append("runtimeTree mismatch")
        for source in (CENTRAL, MULTICHANNEL, USAGE):
            if not is_ancestor(repo, source, runtime):
                errors.append(f"source {source} is not an ancestor of runtime")
    except ManifestError as exc:
        errors.append(str(exc))

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or manifest.get("artifactCount") != len(artifacts):
        errors.append("artifactCount mismatch")
        artifacts = []
    seen: set[str] = set()
    for item in artifacts:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            errors.append("invalid artifact entry")
            continue
        path = item["path"]
        if path in seen:
            errors.append(f"duplicate artifact: {path}")
            continue
        seen.add(path)
        try:
            expected = blob_record(repo, runtime, path)
            if item != expected:
                errors.append(f"artifact digest mismatch: {path}")
        except ManifestError as exc:
            errors.append(f"artifact unreadable: {path}: {exc}")

    required = set(artifact_paths(repo, runtime))
    if seen != required:
        errors.append("artifact path set does not match runtime contract")
    return {
        "ok": not errors,
        "manifestSha256": actual_sha,
        "runtimeCandidateCommit": runtime,
        "artifactCount": len(artifacts),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--runtime-commit", required=True)
    build_parser.add_argument("--output", required=True)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--manifest", required=True)
    verify_parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    try:
        if args.command == "build":
            payload = build(repo, args.runtime_commit)
            output = Path(args.output).resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"ok": True, "output": str(output), "artifactCount": payload["artifactCount"]}))
            return 0
        receipt = verify(repo, Path(args.manifest).resolve(), args.expected_sha256)
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        return 0 if receipt["ok"] else 1
    except (ManifestError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
