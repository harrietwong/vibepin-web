import hashlib
import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[1]
WRAPPER = (ROOT / "scripts" / "cloud_run_product_tracking.sh").read_text(encoding="utf-8")
SERVICE = (ROOT / "deploy" / "systemd" / "vibepin-product-tracking.service").read_text(encoding="utf-8")
TIMER = (ROOT / "deploy" / "systemd" / "vibepin-product-tracking.timer").read_text(encoding="utf-8")
SUPPLY_TIMER = (ROOT / "deploy" / "systemd" / "vibepin-product-supply.timer").read_text(encoding="utf-8")
ADMISSION_TIMER = (
    ROOT / "deploy" / "systemd" / "vibepin-product-opportunity-admission.timer"
).read_text(encoding="utf-8")
TRACKING = (ROOT / "product_opportunity_tracking.py").read_text(encoding="utf-8")
PIPELINE = (ROOT / "pipeline_tracking.py").read_text(encoding="utf-8")
RUNBOOK = (ROOT / "docs" / "product_opportunities_v37_rollout.md").read_text(encoding="utf-8")
COMPLETION_AUDIT = (
    ROOT / "docs" / "product_opportunities_v37_completion_audit_2026-08-26.md"
).read_text(encoding="utf-8")
CURRENT_MANIFEST_PATH = (
    ROOT / "docs" / "product_opportunities_v37_release_manifest_6839e76.json"
)
FIRST_AUTOMATIC_SUPPLY_AUDIT_PATH = (
    ROOT / "docs" / "product_supply_automatic_run_audit_20260828T003013+0800.json"
)
PRD = (
    ROOT.parent
    / "docs"
    / "prd"
    / "0825数据功能修改-VibePin_Product_Opportunities_PRD_v3.7_—_产品与技术执行版.md"
).read_text(encoding="utf-8")
VERCEL_CONFIG = json.loads((ROOT.parent / "web" / "vercel.json").read_text(encoding="utf-8"))
PLATFORM_PREFLIGHT = json.loads(
    (
        ROOT
        / "docs"
        / "product_opportunities_v37_platform_preflight_20260827T234511Z.json"
    ).read_text(encoding="utf-8")
)
STAGE0_DATA_QUALITY = json.loads(
    (
        ROOT
        / "docs"
        / "product_opportunities_v37_stage0_data_quality_20260828T000146Z.json"
    ).read_text(encoding="utf-8")
)
STAGE0_SCHEMA_PRESENCE = json.loads(
    (
        ROOT
        / "docs"
        / "product_opportunities_v37_schema_presence_audit_20260828T000833Z.json"
    ).read_text(encoding="utf-8")
)


def test_default_service_is_preflight_and_timer_file_does_not_enable_itself() -> None:
    assert "VIBEPIN_TRACKING_RUN_MODE=preflight" in SERVICE
    assert "systemctl enable" not in TIMER
    assert "Persistent=false" in TIMER
    for timer in (SUPPLY_TIMER, ADMISSION_TIMER, TIMER):
        assert "AccuracySec=1s" in timer
        assert "Persistent=false" in timer
    assert "keyword-trends (11:00) and crawl (12:00)" in SUPPLY_TIMER
    assert "14 minutes 59 seconds of margin" in ADMISSION_TIMER
    assert "9 minutes 59 seconds" in TIMER


def test_tracking_schedule_stays_within_one_utc_day_and_between_live_jobs() -> None:
    # Shanghai UTC-day boundary is 08:00 local. The reviewed live chain starts
    # Crawl at 12:00 (+600s jitter), then allows 7800s Crawl and 2700s Classify.
    crawl_latest_finish = 12 * 3600 + 600 + 7800 + 2700
    cooldown_after_crawl = crawl_latest_finish + 120 * 60
    tracking_earliest_start = 17 * 3600 + 15 * 60
    tracking_latest_finish = tracking_earliest_start + 300 + 7800
    supply_earliest_start = 23 * 3600

    assert cooldown_after_crawl < tracking_earliest_start
    assert 8 * 3600 < tracking_earliest_start < tracking_latest_finish < 32 * 3600
    assert tracking_latest_finish + 120 * 60 < supply_earliest_start
    assert "OnCalendar=*-*-* 17:15:00 Asia/Shanghai" in TIMER
    assert "stays wholly inside one UTC day" in TIMER


def test_current_product_only_release_pointer_and_manifest_are_exact() -> None:
    functional = "6839e7609ddff3f1fe288c48a42918e105a75fc9"
    launch_taxonomy = "c8f0d7753de01086b5a32d33bd8737b2c174d3f8"
    source_alias = "5b5f98c0c6d1511a9a24a1695eccfa839e3c7e62"
    core_functional = "351e47912ce44fc34728097041dbfdd95889081a"
    manifest_name = "product_opportunities_v37_release_manifest_6839e76.json"
    assert functional in RUNBOOK and functional in COMPLETION_AUDIT
    assert manifest_name in RUNBOOK and manifest_name in COMPLETION_AUDIT
    assert "generationModeration.ts" in RUNBOOK
    assert "898 tests" in RUNBOOK
    assert "59/59" in RUNBOOK
    assert "132/132" in RUNBOOK
    assert "generated 70/70" in RUNBOOK

    manifest = json.loads(CURRENT_MANIFEST_PATH.read_text(encoding="utf-8"))
    assert manifest["candidateCommit"] == functional
    assert manifest["classifyChainRepairCommit"] == (
        "58598b4d51504738bcf54cfa400bae2a296b7659"
    )
    assert manifest["launchTaxonomyCommit"] == launch_taxonomy
    assert manifest["sourceProvenanceAliasCommit"] == source_alias
    assert manifest["trackingScheduleHardeningCommit"] == (
        "01dcb539460bd282cb1542afa1ea4992f1f34659"
    )
    assert manifest["productionRemoteBase"] == "b22930ebe73847cf35bc44be789414902ae6b599"
    assert manifest["prequalifiedIntegrationBase"] == "b22930ebe73847cf35bc44be789414902ae6b599"
    paths = [item["path"] for item in manifest["artifacts"]]
    assert len(paths) == len(set(paths)) == manifest["artifactCount"] == 76
    assert manifest["liveProductTruthGateCommit"] == core_functional
    assert "web/src/app/api/generate/route.ts" in paths
    assert "web/src/lib/server/generationModeration.ts" in paths
    assert "backend/product_supply_receipt_contract.py" in paths
    assert "backend/deploy/systemd/vibepin-product-supply.timer" in paths
    assert "web/package.json" in paths
    assert "web/package-lock.json" in paths
    assert "web/vercel.json" in paths
    assert "web/scripts/test-product-live-truth-verifier.ts" in paths
    assert "web/scripts/verify-product-truth-url.ts" in paths

    assert subprocess.run(
        [
            "git", "merge-base", "--is-ancestor",
            manifest["productionRemoteBase"], manifest["candidateCommit"],
        ],
        cwd=ROOT.parent,
        check=False,
    ).returncode == 0


def test_current_release_documents_have_no_broken_json_evidence_paths() -> None:
    references = set(
        re.findall(
            r"backend/docs/[A-Za-z0-9_.-]+\.json",
            "\n".join((RUNBOOK, COMPLETION_AUDIT, PRD)),
        )
    )
    assert references
    missing = [path for path in sorted(references) if not (ROOT.parent / path).is_file()]
    assert missing == []


def test_first_complete_automatic_supply_attempt_is_not_misreported_as_pass() -> None:
    audit = json.loads(FIRST_AUTOMATIC_SUPPLY_AUDIT_PATH.read_text(encoding="utf-8"))

    assert audit["verdict"] == "BLOCK"
    assert audit["auditMode"] == "read_only"
    assert audit["scheduledOrigin"]["invocationId"] == (
        "b0f7bda39ad64aaf8f5e28f9da4c0e5d"
    )
    assert audit["scheduledOrigin"]["serviceResult"] == "success"
    assert audit["scheduledOrigin"]["serviceExecMainStatus"] == 0
    assert audit["report"]["selectedTotal"] == 100
    assert audit["report"]["renderFailureCount"] == 1
    assert audit["report"]["resultTrust"] == "partial:some_pins_failed_to_render"
    assert audit["report"]["writes"] == 0
    assert audit["report"]["insertedIds"] == []
    assert audit["databaseBeforeAndAfter"]["unchanged"] is True
    assert audit["runtimeCleanup"]["matchingProcesses"] == 0
    assert audit["runtimeCleanup"]["kernelOomHits"] == 0
    assert audit["strictAudit"]["exitCode"] == 1
    assert audit["launchImpact"]["qualifiesAsFirstSuccessfulAutomaticReceipt"] is False
    assert audit["launchImpact"]["eligibleForAutomaticAdmission"] is False
    assert FIRST_AUTOMATIC_SUPPLY_AUDIT_PATH.name in PRD
    assert FIRST_AUTOMATIC_SUPPLY_AUDIT_PATH.name in COMPLETION_AUDIT


def test_current_release_manifest_blob_hashes_and_sizes_are_exact() -> None:
    manifest = json.loads(CURRENT_MANIFEST_PATH.read_text(encoding="utf-8"))
    candidate = manifest["candidateCommit"]

    for artifact in manifest["artifacts"]:
        path = artifact["path"]
        blob = subprocess.check_output(
            ["git", "rev-parse", f"{candidate}:{path}"],
            cwd=ROOT.parent,
            text=True,
        ).strip()
        payload = subprocess.check_output(
            ["git", "cat-file", "blob", blob],
            cwd=ROOT.parent,
        )
        assert blob == artifact["gitBlobSha1"], path
        assert hashlib.sha256(payload).hexdigest() == artifact["sha256"], path
        assert len(payload) == artifact["bytes"], path


def test_current_release_manifest_has_no_unlisted_production_change() -> None:
    manifest = json.loads(CURRENT_MANIFEST_PATH.read_text(encoding="utf-8"))
    listed = {artifact["path"] for artifact in manifest["artifacts"]}
    changed = subprocess.check_output(
        [
            "git",
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-only",
            manifest["prequalifiedIntegrationBase"],
            manifest["candidateCommit"],
        ],
        cwd=ROOT.parent,
        text=True,
        encoding="utf-8",
    ).splitlines()

    def is_production_path(path: str) -> bool:
        return (
            (
                path.startswith("backend/")
                and not path.startswith(("backend/tests/", "backend/docs/"))
                and path != "backend/.gitignore"
            )
            or path.startswith("web/src/")
            or path
            in {
                "web/.env.example",
                "web/package.json",
                "web/package-lock.json",
                "web/tsconfig.product-opportunities.json",
            }
        )

    unlisted = [path for path in changed if is_production_path(path) and path not in listed]
    assert unlisted == []


def test_web_deploy_uses_the_reviewed_lockfile_without_reresolving() -> None:
    assert VERCEL_CONFIG["installCommand"] == "npm ci"
    assert VERCEL_CONFIG["buildCommand"] == "npm run build"
    assert "candidate build log must show `npm ci`" in RUNBOOK
    assert "Next.js 16.3.3" in RUNBOOK
    assert "current CLI-upload mode" in RUNBOOK
    assert "Root Directory `.`" in RUNBOOK
    assert "invalid `web/web` boundary" in RUNBOOK
    assert "The Preview evidence below supersedes that" in RUNBOOK
    assert "specific build-evidence gap" in RUNBOOK
    assert "it does not authorize production rollout" in RUNBOOK
    assert "Promotion remains `BLOCK`" not in RUNBOOK


def test_exact_platform_preflight_is_non_production_and_auditable() -> None:
    vps = PLATFORM_PREFLIGHT["vpsSystemd"]
    preview = PLATFORM_PREFLIGHT["vercelPreview"]
    production = PLATFORM_PREFLIGHT["productionAlias"]
    assert vps["unitCount"] == 6
    assert vps["unitSha256Match"] is True
    assert vps["isolatedAlternateRootVerify"]["exitCode"] == 0
    assert vps["cleanupVerified"] is True
    assert vps["installed"] is False
    assert vps["daemonReloaded"] is False
    assert vps["serviceStarted"] is False
    assert vps["timerChanged"] is False
    assert preview["deploymentId"] == "dpl_CAungjKNgdCrcHnxXtPuTeFbtQvV"
    assert preview["target"] == "preview"
    assert preview["readyState"] == "READY"
    assert preview["installCommand"] == "npm ci"
    assert preview["nextVersion"] == "16.3.3"
    assert preview["requiredProductRoutesPresent"] is True
    assert preview["deploymentProtection"]["authenticatedHtmlBrowserRender"] == "PASS"
    assert preview["promoted"] is False
    assert production["deploymentId"] == "dpl_GdtGTzX3FW9dGP1uE3UtgoWgApAn"
    assert production["unchanged"] is True


def test_latest_stage0_data_quality_does_not_claim_launch_ready_metrics() -> None:
    audit = STAGE0_DATA_QUALITY
    assert audit["total_pin_product_rows"] == 4115
    assert audit["legacy_snapshot_rows"] == 34073
    assert audit["migration_gate_pass_unique_products"] == 123
    assert audit["automatic_admission_scope_unique_products"] == 39
    assert audit["automatic_admission_scope_by_family"] == {
        "physical": 31,
        "digital": 8,
    }
    coverage = audit["automatic_admission_scope_snapshot_coverage"]
    assert coverage["today"] == 0
    assert coverage["anchor_7"] == 0
    assert coverage["anchor_14"] == 1
    assert coverage["anchor_30"] == 0
    assert coverage["full_metric"] == 0
    assert "trend intelligence remains not launch-ready" in RUNBOOK


def test_latest_stage0_openapi_check_does_not_overclaim_catalog_absence() -> None:
    audit = STAGE0_SCHEMA_PRESENCE
    assert audit["mutation"] is False
    assert audit["http_status"] == 200
    assert audit["legacy_control_paths"] == ["/pin_products", "/pin_save_snapshots"]
    assert audit["v63_matching_paths"] == []
    assert "cannot prove" in audit["coverage_limit"]
    assert "PostgreSQL catalog readback" in audit["coverage_limit"]
    assert "Query PostgreSQL catalogs" in RUNBOOK
    assert "not only PostgREST OpenAPI" in RUNBOOK


def test_release_manifest_keeps_create_pin_null_title_contract_together() -> None:
    required = {
        "web/src/lib/productTitle.ts",
        "web/src/lib/productIdeas.ts",
        "web/src/lib/supabase.ts",
        "web/src/components/products/ProductOpportunityPicker.tsx",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK


def test_release_manifest_keeps_runtime_preflight_and_lock_dependencies() -> None:
    required = {
        "backend/pipeline_tracking.py",
        "backend/scripts/audit_product_opportunity_v37.py",
        "backend/scripts/preflight_product_supply.py",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK


def test_release_manifest_keeps_persistent_create_pin_handoff_together() -> None:
    required = {
        "web/src/lib/createPinsPrefill.ts",
        "web/src/lib/supabaseBrowser.ts",
        "web/src/app/api/composer-drafts/route.ts",
        "web/src/app/api/composer-drafts/[id]/route.ts",
        "web/src/app/app/studio/page.tsx",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK
    assert "Saving remains a" in RUNBOOK
    assert "separate API and is never called by this handoff" in RUNBOOK


def test_release_manifest_keeps_v37_catalog_truth_boundary_atomic() -> None:
    required = {
        "backend/db/migrate_v63_product_opportunities_v1.sql",
        "backend/db/rollback_v63_product_opportunities_v1.sql",
        "web/src/lib/server/productOpportunities.ts",
        "web/src/lib/productOpportunitiesClient.ts",
        "web/src/app/api/product-opportunities/route.ts",
        "web/src/app/api/product-opportunities/[id]/route.ts",
        "web/src/app/api/saved-product-opportunities/route.ts",
        "web/src/components/products/ProductOpportunitiesV1.tsx",
        "web/src/app/app/products/page.tsx",
        "web/src/app/app/products/saved/page.tsx",
        "web/src/lib/createPinsPrefill.ts",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK
    assert "category-search aliases, user-facing category labels and Create Pins handoff labels" in RUNBOOK
    assert "must be deployed as one truth boundary" in RUNBOOK


def test_release_manifest_keeps_public_product_truth_surfaces_together() -> None:
    required = {
        "web/src/app/page.tsx",
        "web/src/components/landing/ExecutionSystem.tsx",
        "web/src/lib/landingAssets.ts",
        "web/src/lib/landing/conversionData.ts",
        "web/src/app/admin/data/page.tsx",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK
    assert "retired Product Opportunity score/competition" in RUNBOOK


def test_release_manifest_keeps_live_product_truth_gate_atomic() -> None:
    manifest = json.loads(CURRENT_MANIFEST_PATH.read_text(encoding="utf-8"))
    paths = {item["path"] for item in manifest["artifacts"]}
    required = {
        "web/package.json",
        "web/scripts/test-registry.ts",
        "web/scripts/test-product-live-truth-verifier.ts",
        "web/scripts/verify-product-truth-url.ts",
    }
    assert required <= paths
    assert "npm run verify:product-truth -- https://vibepin.co/" in RUNBOOK
    assert "d8cc0b869d871763ec8c2c549dd913494aa487b1" in RUNBOOK


def test_release_manifest_keeps_canary_proven_product_supply_runtime_together() -> None:
    required = {
        "backend/deploy/systemd/vibepin-product-supply.service",
        "backend/run_worker.py",
        "backend/shop_the_look_expand.py",
        "backend/scripts/cloud_run_product_supply.sh",
        "backend/scripts/run_bootstrap_product_supply.py",
        "backend/scripts/product_supply_cutover_v37.py",
        "backend/scripts/validate_product_supply_merchants.py",
        "backend/tools/t2_harvest.py",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK
    assert "100-source/50-run/20-atomic" in RUNBOOK
    assert "cooldown waiver" in RUNBOOK
    assert "audit --require-canary-write" in RUNBOOK
    assert "audit --require-scheduled-run" in RUNBOOK
    assert "The two flags are mutually exclusive" in RUNBOOK
    assert "Response parse errors are mandatory measured diagnostics" in RUNBOOK
    assert "do not independently fail" in RUNBOOK
    assert "zero failed rows/batches/render failures" in RUNBOOK


def test_runbook_distinguishes_deployed_supply_mix_from_digital_candidate() -> None:
    assert "currently deployed" in RUNBOOK
    assert "36 Fashion / 28 Women's Fashion / 36 Home Decor" in RUNBOOK
    assert "local candidate, not authorized for deployment" in RUNBOOK
    assert "29 Fashion / 22 Women's Fashion / 29 Home Decor / 20 Digital Products" in RUNBOOK


def test_prd_admission_contract_matches_the_reviewed_digital_candidate() -> None:
    assert (
        "Fashion 29 / Women's Fashion 22 / Home Decor 29 / Digital Products 20"
        in PRD
    )
    assert "Physical-only 36/28/36 报告不能作为该 Digital 首发自动准入链的输入" in PRD
    assert "旧 36/28/36 报告不得被自动准入当作 Digital 首发报告" in PRD


def test_release_manifest_keeps_full_web_route_build_fix_atomic() -> None:
    required = {
        "web/src/app/api/generate/route.ts",
        "web/src/lib/server/generationModeration.ts",
        "web/src/app/api/integrations/shopify/connect/route.ts",
        "web/src/app/api/integrations/shopify/launch/route.ts",
        "web/src/lib/server/shopify/connectPrep.ts",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK
    assert "does not change moderation decisions" in RUNBOOK
    assert "may be reviewed/cherry-picked independently" in RUNBOOK


def test_release_manifest_keeps_access_and_legacy_metric_retirement_together() -> None:
    required = {
        "web/src/lib/server/productOpportunityAccess.ts",
        "web/src/lib/server/planEntitlements.ts",
        "web/src/app/api/products/top/route.ts",
        "web/src/app/api/product/[id]/intelligence/route.ts",
        "web/src/lib/productImageEvidence.ts",
        "web/src/types/css-modules.d.ts",
    }
    for path in required:
        assert f"`{path}`" in RUNBOOK


def test_real_tracking_requires_all_three_explicit_gates() -> None:
    assert "VIBEPIN_TRACKING_RUN_MODE:-preflight" in WRAPPER
    assert "VIBEPIN_PRODUCT_TRACKING_MODE" in WRAPPER
    assert "VIBEPIN_PRODUCT_TRACKING_CONFIRM" in WRAPPER
    assert "TRACK_ACTIVE_PRODUCTS" in WRAPPER
    assert "--apply" in WRAPPER
    assert "cloud_preflight_gate SAFE_FOR_APPLY" in WRAPPER


def test_request_and_timeout_hierarchy_is_bounded() -> None:
    assert "MAX_UNIQUE_PINS_PER_RUN = 2_499" in TRACKING
    assert "MAX_PROVIDER_REQUESTS = 5_000" in TRACKING
    assert "len(representatives) * 2 > request_budget" in TRACKING
    assert "deduped_pins" in TRACKING
    assert "http_429" in TRACKING
    assert "http_5xx" in TRACKING
    assert "network_error" in TRACKING
    assert "timeout" in TRACKING
    assert "VIBEPIN_PRODUCT_TRACKING_TIMEOUT_SECONDS=7200" in SERVICE
    assert "TimeoutStartSec=7800" in SERVICE
    assert '"product-tracking": 9_000' in PIPELINE


def test_all_active_contract_fails_closed_before_network() -> None:
    assert "exceeds_run_budget" in TRACKING
    assert "missing_primary_evidence" in TRACKING
    assert "increase the reviewed budget or add deterministic shards" in TRACKING


def test_cross_job_lock_tree_kill_and_schedule_are_explicit() -> None:
    assert "cloud_network_flock" in WRAPPER
    assert "cloud_run_with_tree_timeout" in WRAPPER
    assert "verify_process_cleanup(report)" in TRACKING
    assert '"orphanCount": None' in TRACKING
    assert "tracking lock held; scheduled run did not execute" in TRACKING
    assert "KillMode=control-group" in SERVICE
    assert "OnCalendar=*-*-* 17:15:00 Asia/Shanghai" in TIMER
    assert "120min mandatory Pinterest cooldown" in TIMER
    assert "17:15 Asia/Shanghai schedule" in RUNBOOK
    assert "03:00 Asia/Shanghai schedule" not in RUNBOOK
