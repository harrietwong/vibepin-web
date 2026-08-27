import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import product_opportunity_admission_pipeline as pipeline


NOW = datetime(2026, 8, 26, 12, tzinfo=timezone.utc)


def batch_receipts(ids: list[str]) -> list[dict]:
    receipts = []
    for start in range(0, len(ids), 20):
        local_ids = ids[start : start + 20]
        receipts.append({
            "insertedIds": local_ids,
            "preWriteViolationSamples": [],
            "rolledBack": False,
            "rollbackRemainingIds": [],
            "createdAtWindow": [
                "2026-08-26T11:55:00+00:00",
                "2026-08-26T11:55:01+00:00",
            ],
            "rollback": "DELETE WHERE id IN (...) AND created_at BETWEEN ...",
            "postWriteVerification": {
                "rowsReadBack": len(local_ids),
                "exactWriteReadback": {
                    "expectedIds": local_ids,
                    "actualIds": local_ids,
                    "pass": True,
                },
                "allRedLinesPass": True,
            },
        })
    return receipts


def valid_scheduled_origin() -> dict:
    return {
        "timerUnitFileState": "enabled",
        "timerActiveState": "active",
        "timerLastTriggerAt": "2026-08-26T11:00:00+00:00",
        "timerNextTriggerAt": "2026-08-27T11:00:00+00:00",
        "serviceResult": "success",
        "serviceExecMainStatus": "0",
        "serviceStartAt": "2026-08-26T11:00:00+00:00",
        "serviceExitAt": "2026-08-26T11:56:00+00:00",
        "serviceInvocationId": "0123456789abcdef0123456789abcdef",
        "serviceTriggeredBy": pipeline.SUPPLY_TIMER,
        "reportGeneratedAt": "2026-08-26T11:55:00+00:00",
        "reportMtimeAt": "2026-08-26T11:55:01+00:00",
    }


def supply_report(ids: list[str], **overrides: object) -> dict:
    categories = (
        ["fashion"] * 29
        + ["womens-fashion"] * 22
        + ["home-decor"] * 29
        + ["digital-products"] * 20
    )
    unique_candidates = max(len(ids), 4)
    accepted_before_dedup = unique_candidates + 2
    payload = {
        "engine": "shop-the-look",
        "mode": "apply",
        "generatedAt": (NOW - timedelta(minutes=5)).isoformat(),
        "sourceSelection": {"selectedTotal": 100},
        "perPin": [
            {"sourcePinId": f"pin-{index}", "category": category}
            for index, category in enumerate(categories)
        ],
        "dataQuality": {
            "resultTrust": "trusted",
            "authenticatedRun": True,
        },
        "aggregate": {
            "sourcePinsScanned": 100,
            "rawProductCandidates": accepted_before_dedup + 4,
            "rejectedProducts": 4,
            "acceptedBeforeDedup": accepted_before_dedup,
            "duplicatesSkipped": 2,
            "uniqueAcceptedProducts": unique_candidates,
            "renderFailureCount": 0,
        },
        "incrementalWrite": {
            "failedBatches": [],
            "batchesFailed": 0,
            "runAdmissionCap": 50,
            "atomicWriteBatchCap": 20,
            "pinsFlushed": 100,
            "rowsInserted": len(ids),
            "rowsSkippedAlreadyInDb": 0,
            "rowsSkippedCrossBatchDuplicate": 0,
            "rowsSkippedRunAdmissionCap": 0,
        },
        "writes": {"pin_products": len(ids)},
        "writeOutcome": {
            "inserted": len(ids),
            "insertedIds": ids,
            "failed": 0,
            "errors": [],
            "preWriteViolationSamples": [],
            "coreCandidates": len(ids) + 2,
            "merchantDiscovered": len(ids),
            "merchantDiscoveryFailures": 2,
            "duplicates": 0,
            "batchReceipts": batch_receipts(ids),
        },
    }
    payload.update(overrides)
    return payload


def write_report(path: Path, ids: list[str], **overrides: object) -> Path:
    path.write_text(json.dumps(supply_report(ids, **overrides)), encoding="utf-8")
    return path


def receipt(
    tmp_path: Path,
    count: int,
    *,
    scheduled: bool = False,
) -> pipeline.SupplyReceipt:
    ids = [f"legacy-{index}" for index in range(count)]
    path = write_report(tmp_path / "supply.json", ids)
    origin = valid_scheduled_origin() if scheduled else None
    if origin is not None:
        origin["reportSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return pipeline.load_supply_receipt(
        path,
        now=NOW,
        scheduled_origin=origin,
        require_scheduled_origin=scheduled,
    )


class FakeDB:
    def __init__(self, rows: list[dict]):
        self.rows = {row["id"]: row for row in rows}
        self.calls: list[list[str]] = []

    def select_many(self, table, *, columns, filters, limit):
        assert table == "pin_products"
        raw = filters["id"]
        ids = raw.removeprefix("in.(").removesuffix(")").split(",")
        self.calls.append(ids)
        return [self.rows[item] for item in ids if item in self.rows][:limit]


def legacy_rows(count: int) -> list[dict]:
    return [
        {
            "id": f"legacy-{index}",
            "canonical_product_url": f"https://shop.example/products/{index}",
        }
        for index in range(count)
    ]


def test_receipt_requires_apply_100_pin_exact_ids_and_fresh_timestamp(tmp_path: Path) -> None:
    valid = write_report(tmp_path / "valid.json", ["legacy-1"])
    loaded = pipeline.load_supply_receipt(valid, now=NOW)
    assert loaded.selected_total == 100
    assert loaded.inserted_ids == ("legacy-1",)
    assert loaded.quality_funnel["merchantVerified"] == 1

    dry = write_report(tmp_path / "dry.json", [], mode="dry-run")
    with pytest.raises(ValueError, match="apply report"):
        pipeline.load_supply_receipt(dry, now=NOW)

    stale = write_report(
        tmp_path / "stale.json",
        [],
        generatedAt=(NOW - timedelta(hours=7)).isoformat(),
    )
    with pytest.raises(ValueError, match="stale"):
        pipeline.load_supply_receipt(stale, now=NOW)

    wrong_count = write_report(
        tmp_path / "wrong-count.json",
        ["legacy-1"],
        writes={"pin_products": 0},
    )
    with pytest.raises(ValueError, match="write counts"):
        pipeline.load_supply_receipt(wrong_count, now=NOW)


def test_receipt_refuses_failed_batches_duplicates_and_more_than_fifty(tmp_path: Path) -> None:
    failed = write_report(
        tmp_path / "failed.json",
        [],
        incrementalWrite={"failedBatches": [{"batch": 1}]},
    )
    with pytest.raises(ValueError, match="failed"):
        pipeline.load_supply_receipt(failed, now=NOW)

    duplicate = write_report(tmp_path / "duplicate.json", ["same", "same"])
    with pytest.raises(ValueError, match="duplicate"):
        pipeline.load_supply_receipt(duplicate, now=NOW)

    over = write_report(tmp_path / "over.json", [f"id-{index}" for index in range(51)])
    with pytest.raises(ValueError, match="50-row"):
        pipeline.load_supply_receipt(over, now=NOW)


def test_receipt_refuses_partial_scan_wrong_mix_and_partial_row_failures(tmp_path: Path) -> None:
    partial = supply_report([])
    partial["perPin"] = partial["perPin"][:-1]
    partial_path = tmp_path / "partial.json"
    partial_path.write_text(json.dumps(partial), encoding="utf-8")
    with pytest.raises(ValueError, match="all 100"):
        pipeline.load_supply_receipt(partial_path, now=NOW)

    wrong_mix = supply_report([])
    wrong_mix["perPin"][0]["category"] = "beauty"
    wrong_mix_path = tmp_path / "wrong-mix.json"
    wrong_mix_path.write_text(json.dumps(wrong_mix), encoding="utf-8")
    with pytest.raises(ValueError, match="reviewed launch mix"):
        pipeline.load_supply_receipt(wrong_mix_path, now=NOW)

    failed_row = supply_report([])
    failed_row["writeOutcome"]["failed"] = 1
    failed_row["writeOutcome"]["errors"] = ["merchant readback failed"]
    failed_path = tmp_path / "failed-row.json"
    failed_path.write_text(json.dumps(failed_row), encoding="utf-8")
    with pytest.raises(ValueError, match="failed Product Supply rows"):
        pipeline.load_supply_receipt(failed_path, now=NOW)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda report: report["dataQuality"].update(authenticatedRun=False), "trusted authenticated"),
        (lambda report: report["aggregate"].update(renderFailureCount=1), "rendered-page"),
        (lambda report: report["writeOutcome"].update(batchReceipts=[]), "batch receipts"),
        (
            lambda report: report["writeOutcome"]["batchReceipts"][0]
            ["postWriteVerification"].update(rowsReadBack=0),
            "batch receipts",
        ),
        (lambda report: report["aggregate"].update(rawProductCandidates=999), "funnel arithmetic"),
        (lambda report: report["writeOutcome"].update(merchantDiscoveryFailures=3), "funnel arithmetic"),
    ],
)
def test_receipt_refuses_untrusted_or_unclosed_supply_quality(
    tmp_path: Path,
    mutation,
    message: str,
) -> None:
    report = supply_report(["legacy-1"])
    mutation(report)
    path = tmp_path / f"invalid-{message.replace(' ', '-')}.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        pipeline.load_supply_receipt(path, now=NOW)


def test_receipt_refuses_a_single_atomic_receipt_over_twenty(tmp_path: Path) -> None:
    ids = [f"legacy-{index}" for index in range(21)]
    report = supply_report(ids)
    oversized = report["writeOutcome"]["batchReceipts"][0]
    oversized["insertedIds"] = ids
    oversized["postWriteVerification"]["rowsReadBack"] = len(ids)
    oversized["postWriteVerification"]["exactWriteReadback"].update({
        "expectedIds": ids,
        "actualIds": ids,
    })
    report["writeOutcome"]["batchReceipts"] = [oversized]
    path = tmp_path / "oversized-atomic-receipt.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError, match="batch receipts"):
        pipeline.load_supply_receipt(path, now=NOW)


def test_automatic_receipt_requires_exact_permanent_timer_origin(tmp_path: Path) -> None:
    path = write_report(tmp_path / "scheduled.json", ["legacy-1"])
    with pytest.raises(ValueError, match="requires permanent timer-origin"):
        pipeline.load_supply_receipt(
            path,
            now=NOW,
            require_scheduled_origin=True,
        )

    manual = valid_scheduled_origin()
    manual["serviceStartAt"] = "2026-08-26T11:10:00+00:00"
    with pytest.raises(ValueError, match="exact last trigger"):
        pipeline.load_supply_receipt(
            path,
            now=NOW,
            scheduled_origin=manual,
            require_scheduled_origin=True,
        )

    origin = valid_scheduled_origin()
    origin["reportSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    loaded = pipeline.load_supply_receipt(
        path,
        now=NOW,
        scheduled_origin=origin,
        require_scheduled_origin=True,
    )
    assert loaded.scheduled_origin_verified is True


def test_scheduled_origin_is_bound_to_exact_report_bytes(tmp_path: Path) -> None:
    path = write_report(tmp_path / "scheduled.json", ["legacy-1"])
    origin = valid_scheduled_origin()
    origin["reportSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    replacement = supply_report(["legacy-2"])
    path.write_text(json.dumps(replacement), encoding="utf-8")

    with pytest.raises(ValueError, match="exact source report bytes"):
        pipeline.load_supply_receipt(
            path,
            now=NOW,
            scheduled_origin=origin,
            require_scheduled_origin=True,
        )


def test_exact_readback_preserves_receipt_order_and_fails_on_missing(tmp_path: Path) -> None:
    loaded = receipt(tmp_path, 3)
    db = FakeDB(list(reversed(legacy_rows(3))))
    rows = pipeline.load_exact_legacy_rows(loaded, db=db)
    assert [row["id"] for row in rows] == ["legacy-0", "legacy-1", "legacy-2"]
    assert db.calls == [["legacy-0", "legacy-1", "legacy-2"]]

    missing_db = FakeDB(legacy_rows(2))
    with pytest.raises(RuntimeError, match="missing"):
        pipeline.load_exact_legacy_rows(loaded, db=missing_db)


def test_dry_run_chunks_fifty_rows_at_twenty_and_never_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 50)
    db = FakeDB(legacy_rows(50))
    calls: list[int] = []

    async def fake_build(chunk, *, limit, now, existing_url_hashes):
        assert limit == len(chunk) <= 20
        calls.append(len(chunk))
        return ([{"canonical_product_url": row["canonical_product_url"]} for row in chunk], [])

    monkeypatch.setattr(pipeline.manifest_builder, "_run_live", fake_build)
    monkeypatch.setattr(pipeline.manifest_builder, "load_current_identity_hashes", lambda: set())
    monkeypatch.setattr(
        pipeline.admission,
        "validate_manifest",
        lambda rows, *, now: (rows, []),
    )
    monkeypatch.setattr(
        pipeline.admission,
        "apply_candidates",
        lambda _rows: pytest.fail("dry-run must never call apply_candidates"),
    )

    artifacts = asyncio.run(
        pipeline.run_pipeline(loaded, apply=False, now=NOW, db=db)
    )
    assert calls == [20, 20, 10]
    assert artifacts.report["status"] == "dry_run_complete"
    assert artifacts.report["candidateRowsEvaluated"] == 50
    assert artifacts.report["providerCandidateUpperBound"] == 50
    assert artifacts.report["providerRequestUpperBound"] == 200
    assert artifacts.report["supplyQualityFunnel"] == loaded.quality_funnel
    assert artifacts.report["eligibleRows"] == 50
    assert artifacts.report["written"] == 0
    assert artifacts.report["databaseWrites"] == 0


def test_apply_uses_separate_verified_atomic_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 41, scheduled=True)
    db = FakeDB(legacy_rows(41))
    applied: list[int] = []

    async def fake_build(chunk, *, limit, now, existing_url_hashes):
        return ([{"canonical_product_url": row["canonical_product_url"]} for row in chunk], [])

    def fake_apply(rows):
        applied.append(len(rows))
        return [f"product-{len(applied)}-{index}" for index in range(len(rows))]

    monkeypatch.setattr(pipeline.manifest_builder, "_run_live", fake_build)
    monkeypatch.setattr(pipeline.manifest_builder, "load_current_identity_hashes", lambda: set())
    monkeypatch.setattr(pipeline.admission, "validate_manifest", lambda rows, *, now: (rows, []))
    monkeypatch.setattr(pipeline.admission, "apply_candidates", fake_apply)
    monkeypatch.setattr(pipeline.admission, "verify_candidates", lambda ids, rows: len(ids))
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_CONFIRM", pipeline.admission.APPLY_CONFIRM)

    artifacts = asyncio.run(
        pipeline.run_pipeline(loaded, apply=True, now=NOW, db=db)
    )
    assert applied == [20, 20, 1]
    assert artifacts.report["status"] == "apply_complete"
    assert artifacts.report["written"] == 41
    assert artifacts.report["databaseWrites"] == 41
    assert artifacts.report["sourceScheduledOriginVerified"] is True
    assert all(batch["written"] == batch["verified"] for batch in artifacts.report["batches"])


def test_verification_failure_rolls_back_only_exact_returned_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 1, scheduled=True)
    db = FakeDB(legacy_rows(1))
    rolled_back: list[list[str]] = []

    async def fake_build(chunk, *, limit, now, existing_url_hashes):
        return ([{"canonical_product_url": chunk[0]["canonical_product_url"]}], [])

    monkeypatch.setattr(pipeline.manifest_builder, "_run_live", fake_build)
    monkeypatch.setattr(pipeline.manifest_builder, "load_current_identity_hashes", lambda: set())
    monkeypatch.setattr(pipeline.admission, "validate_manifest", lambda rows, *, now: (rows, []))
    monkeypatch.setattr(pipeline.admission, "apply_candidates", lambda _rows: ["product-1"])
    monkeypatch.setattr(
        pipeline.admission,
        "verify_candidates",
        lambda _ids, _rows: (_ for _ in ()).throw(RuntimeError("readback mismatch")),
    )
    monkeypatch.setattr(
        pipeline.admission,
        "rollback_candidates",
        lambda ids, reason: rolled_back.append(list(ids)) or len(ids),
    )
    monkeypatch.setattr(pipeline.admission, "verify_rollback", lambda ids: len(ids))
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_CONFIRM", pipeline.admission.APPLY_CONFIRM)

    with pytest.raises(pipeline.PipelineExecutionError, match="readback mismatch") as exc:
        asyncio.run(pipeline.run_pipeline(loaded, apply=True, now=NOW, db=db))
    assert rolled_back == [["product-1"]]
    assert exc.value.artifacts.report["status"] == "failed"
    assert exc.value.artifacts.report["batches"][0]["rolledBack"] == 1


def test_zero_insert_receipt_is_honest_natural_zero_without_provider_or_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 0)
    monkeypatch.setattr(
        pipeline.manifest_builder,
        "_run_live",
        lambda *args, **kwargs: pytest.fail("zero receipt must not reach providers"),
    )
    artifacts = asyncio.run(pipeline.run_pipeline(loaded, apply=False, now=NOW))
    assert artifacts.report["status"] == "natural_zero_new_legacy_rows"
    assert artifacts.report["databaseWrites"] == 0


def test_direct_apply_call_without_authority_fails_before_db_or_providers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 1)
    monkeypatch.delenv("VIBEPIN_PRODUCT_ADMISSION_MODE", raising=False)
    monkeypatch.delenv("VIBEPIN_PRODUCT_ADMISSION_CONFIRM", raising=False)
    monkeypatch.setattr(
        pipeline,
        "load_exact_legacy_rows",
        lambda *_args, **_kwargs: pytest.fail("unauthorized apply must not read DB"),
    )
    monkeypatch.setattr(
        pipeline.manifest_builder,
        "_run_live",
        lambda *_args, **_kwargs: pytest.fail("unauthorized apply must not reach providers"),
    )
    with pytest.raises(pipeline.PipelineExecutionError, match="must equal production"):
        asyncio.run(pipeline.run_pipeline(loaded, apply=True, now=NOW))


def test_authorized_apply_without_timer_origin_fails_before_db_or_providers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 1)
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_CONFIRM", pipeline.admission.APPLY_CONFIRM)
    monkeypatch.setattr(
        pipeline,
        "load_exact_legacy_rows",
        lambda *_args, **_kwargs: pytest.fail("origin-less apply must not read DB"),
    )
    monkeypatch.setattr(
        pipeline.manifest_builder,
        "_run_live",
        lambda *_args, **_kwargs: pytest.fail("origin-less apply must not reach providers"),
    )
    with pytest.raises(pipeline.PipelineExecutionError, match="timer-origin evidence"):
        asyncio.run(pipeline.run_pipeline(loaded, apply=True, now=NOW))


def test_forged_verified_origin_is_revalidated_before_db_or_providers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded = receipt(tmp_path, 1, scheduled=True)
    forged = pipeline.SupplyReceipt(
        **{
            **loaded.__dict__,
            "scheduled_origin": {**(loaded.scheduled_origin or {}), "serviceResult": "failed"},
        }
    )
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_CONFIRM", pipeline.admission.APPLY_CONFIRM)
    monkeypatch.setattr(
        pipeline,
        "load_exact_legacy_rows",
        lambda *_args, **_kwargs: pytest.fail("forged origin must not read DB"),
    )
    monkeypatch.setattr(
        pipeline.manifest_builder,
        "_run_live",
        lambda *_args, **_kwargs: pytest.fail("forged origin must not reach providers"),
    )

    with pytest.raises(pipeline.PipelineExecutionError, match="invalid Product Supply timer-origin"):
        asyncio.run(pipeline.run_pipeline(forged, apply=True, now=NOW))


def test_systemd_and_wrapper_contract_is_disabled_bounded_and_cooldown_safe() -> None:
    root = Path(__file__).parents[1]
    wrapper = (root / "scripts" / "cloud_run_product_opportunity_admission.sh").read_text()
    service = (root / "deploy" / "systemd" / "vibepin-product-opportunity-admission.service").read_text()
    timer = (root / "deploy" / "systemd" / "vibepin-product-opportunity-admission.timer").read_text()
    tracking_timer = (root / "deploy" / "systemd" / "vibepin-product-tracking.timer").read_text()

    assert "VIBEPIN_PRODUCT_ADMISSION_RUN_MODE=preflight" in service
    assert "TimeoutStartSec=2700" in service
    assert "KillMode=control-group" in service
    assert "systemctl enable" not in timer
    assert "Persistent=false" in timer
    assert "OnCalendar=*-*-* 03:15:00 Asia/Shanghai" in timer
    assert "OnCalendar=*-*-* 17:15:00 Asia/Shanghai" in tracking_timer
    assert "cloud_preflight_gate SAFE_FOR_APPLY" in wrapper
    assert "cloud_network_flock" in wrapper
    assert "cloud_run_with_tree_timeout" in wrapper
    assert "VIBEPIN_PRODUCT_ADMISSION_MODE" in wrapper
    assert "VIBEPIN_PRODUCT_ADMISSION_CONFIRM" in wrapper
    assert "ADMIT_REVIEWED_PRODUCTS" in wrapper
