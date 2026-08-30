from __future__ import annotations

import datetime as dt
import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "product_supply_cutover_v37.py"
SPEC = importlib.util.spec_from_file_location("product_supply_cutover_v37", SCRIPT)
assert SPEC and SPEC.loader
cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cutover)


def valid_summary() -> dict:
    return {
        "mode": "apply",
        "selectedTotal": 100,
        "categoryMix": {"fashion": 36, "womens-fashion": 28, "home-decor": 36},
        "writes": 1,
        "written": 1,
        "failedWrites": 0,
        "writeErrors": [],
        "insertedIds": ["safe-id"],
        "readbackCount": 1,
        "readbackSafe": True,
        "sourcePinCount": 1,
        "sourceReadbackCount": 1,
        "sourceProvenanceSafe": True,
        "insertedSourceCategoryCounts": {"fashion": 1},
        "batchReceiptsSafe": True,
        "batchReceiptCount": 1,
        "receiptInsertedIdCount": 1,
        "failedBatches": [],
        "batchesFailed": 0,
        "runAdmissionCap": 1,
        "atomicWriteBatchCap": 20,
        "merchantDiscoveryCandidateCap": 100,
        "resultTrust": "trusted",
        "authenticatedRun": True,
        "renderFailureCount": 0,
        "timeoutCount": 0,
        "productJsonResponses": 120,
        "pinsWithZeroProductJson": 4,
        "responseErrorCount": 0,
        "responseErrorSamples": [],
        "supplyFunnel": {
            "sourcePinsScanned": 100,
            "rawProductCandidates": 10,
            "rejectedProductCandidates": 4,
            "acceptedBeforeDedup": 6,
            "duplicatesSkippedWithinRun": 2,
            "uniqueAcceptedCandidates": 4,
            "alreadyInDatabase": 0,
            "crossBatchDuplicates": 0,
            "skippedByRunAdmissionCap": 0,
            "merchantDiscoveryAttempts": 3,
            "merchantVerified": 1,
            "merchantVerificationFailures": 2,
            "writeDuplicates": 0,
            "safeLegacyRowsWritten": 1,
            "productNamesPresent": 0,
            "productNamesMissing": 1,
        },
    }


def valid_scheduled_origin() -> dict:
    return {
        "timerUnitFileState": "enabled",
        "timerActiveState": "active",
        "timerLastTriggerAt": "2026-08-27T15:03:44+00:00",
        "timerNextTriggerAt": "2026-08-28T15:02:11+00:00",
        "serviceResult": "success",
        "serviceExecMainStatus": "0",
        "serviceStartAt": "2026-08-27T15:03:44+00:00",
        "serviceExitAt": "2026-08-27T16:02:00+00:00",
        "serviceInvocationId": "0123456789abcdef0123456789abcdef",
        "serviceTriggeredBy": cutover.TIMER,
        "reportGeneratedAt": "2026-08-27T16:01:57+00:00",
        "reportMtimeAt": "2026-08-27T16:01:58+00:00",
    }


def test_complete_canary_contract_passes() -> None:
    cutover._validate_audit_summary(valid_summary(), require_canary_write=True)


def test_canary_remains_strictly_one_row_after_scheduled_audit_is_added() -> None:
    summary = valid_summary()
    summary.update({
        "writes": 2,
        "written": 2,
        "insertedIds": ["safe-1", "safe-2"],
        "readbackCount": 2,
        "sourcePinCount": 2,
        "sourceReadbackCount": 2,
        "insertedSourceCategoryCounts": {"fashion": 2},
        "receiptInsertedIdCount": 2,
    })
    summary["supplyFunnel"].update({
        "merchantDiscoveryAttempts": 4,
        "merchantVerified": 2,
        "safeLegacyRowsWritten": 2,
        "productNamesMissing": 2,
    })
    with pytest.raises(RuntimeError, match="exactly one safe production write"):
        cutover._validate_audit_summary(summary, require_canary_write=True)


def test_audit_contracts_are_mutually_exclusive() -> None:
    with pytest.raises(RuntimeError, match="either canary or scheduled-run"):
        cutover._validate_audit_summary(
            valid_summary(),
            require_canary_write=True,
            require_scheduled_run=True,
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("mode", "dry-run", "apply-mode"),
        ("selectedTotal", None, "100-Pin scan"),
        ("selectedTotal", 99, "100-Pin scan"),
        ("runAdmissionCap", 50, "one-row run cap"),
        ("merchantDiscoveryCandidateCap", None, "merchant discovery request cap"),
        ("merchantDiscoveryCandidateCap", 101, "merchant discovery request cap"),
        ("atomicWriteBatchCap", 21, "atomic write cap"),
        ("insertedIds", [], "write accounting"),
        ("writes", 0, "write accounting"),
        ("written", 0, "write accounting"),
        ("readbackCount", 0, "write accounting"),
    ],
)
def test_canary_contract_fails_closed(field: str, value: object, message: str) -> None:
    summary = valid_summary()
    summary[field] = value
    with pytest.raises(RuntimeError, match=message):
        cutover._validate_audit_summary(summary, require_canary_write=True)


def test_canary_rejects_unsafe_readback_and_failed_batches() -> None:
    unsafe = valid_summary()
    unsafe["readbackSafe"] = False
    with pytest.raises(RuntimeError, match="readback"):
        cutover._validate_audit_summary(unsafe, require_canary_write=True)

    failed = valid_summary()
    failed["failedBatches"] = [{"batch": 1}]
    with pytest.raises(RuntimeError, match="batch failure"):
        cutover._validate_audit_summary(failed, require_canary_write=True)


def scheduled_summary(*, writes: int = 12) -> dict:
    summary = valid_summary()
    summary.update({
        "writes": writes,
        "written": writes,
        "insertedIds": [f"safe-{index}" for index in range(writes)],
        "readbackCount": writes,
        "sourcePinCount": writes,
        "sourceReadbackCount": writes,
        "insertedSourceCategoryCounts": {"fashion": writes} if writes else {},
        "batchReceiptCount": 0 if writes == 0 else 1,
        "receiptInsertedIdCount": writes,
        "runAdmissionCap": 50,
        "scheduledOrigin": valid_scheduled_origin(),
    })
    summary["supplyFunnel"].update({
        "merchantDiscoveryAttempts": writes + 2,
        "merchantVerified": writes,
        "safeLegacyRowsWritten": writes,
        "productNamesPresent": 0,
        "productNamesMissing": writes,
    })
    return summary


def launch_scheduled_summary(*, writes: int = 12) -> dict:
    summary = scheduled_summary(writes=writes)
    summary["categoryMix"] = {
        "fashion": 29,
        "womens-fashion": 22,
        "home-decor": 29,
        "digital-products": 20,
    }
    return summary


def test_complete_scheduled_run_contract_accepts_zero_to_fifty_writes() -> None:
    cutover._validate_audit_summary(
        scheduled_summary(writes=0),
        require_canary_write=False,
        require_scheduled_run=True,
    )
    cutover._validate_audit_summary(
        scheduled_summary(writes=50),
        require_canary_write=False,
        require_scheduled_run=True,
    )


def test_scheduled_run_rejects_any_pin_timeout() -> None:
    summary = scheduled_summary(writes=1)
    summary["timeoutCount"] = 1
    with pytest.raises(RuntimeError, match="Pin timeouts"):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_launch_scheduled_profile_accepts_only_exact_v37_mix() -> None:
    cutover._validate_audit_summary(
        launch_scheduled_summary(),
        require_canary_write=False,
        require_scheduled_run=True,
        scheduled_profile="launch-v37",
    )
    with pytest.raises(RuntimeError, match="launch-v37 category mix"):
        cutover._validate_audit_summary(
            scheduled_summary(),
            require_canary_write=False,
            require_scheduled_run=True,
            scheduled_profile="launch-v37",
        )
    with pytest.raises(RuntimeError, match="physical-legacy category mix"):
        cutover._validate_audit_summary(
            launch_scheduled_summary(),
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_unknown_scheduled_profile_fails_closed() -> None:
    with pytest.raises(RuntimeError, match="unknown scheduled audit profile"):
        cutover._validate_audit_summary(
            scheduled_summary(),
            require_canary_write=False,
            require_scheduled_run=True,
            scheduled_profile="future-unreviewed",
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("sourcePinsScanned", 99, "arithmetic does not close"),
        ("rawProductCandidates", 9, "arithmetic does not close"),
        ("acceptedBeforeDedup", 5, "arithmetic does not close"),
        ("merchantDiscoveryAttempts", 13, "arithmetic does not close"),
        ("merchantVerified", 11, "arithmetic does not close"),
        ("safeLegacyRowsWritten", 11, "arithmetic does not close"),
        ("productNamesMissing", 11, "arithmetic does not close"),
        ("crossBatchDuplicates", True, "missing or invalid"),
    ],
)
def test_scheduled_run_requires_closed_supply_funnel(
    field: str,
    value: object,
    message: str,
) -> None:
    summary = scheduled_summary()
    summary["supplyFunnel"][field] = value
    with pytest.raises(RuntimeError, match=message):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_production_write_audit_rejects_missing_supply_funnel() -> None:
    summary = valid_summary()
    summary.pop("supplyFunnel")
    with pytest.raises(RuntimeError, match="funnel accounting is missing"):
        cutover._validate_audit_summary(summary, require_canary_write=True)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("timerUnitFileState", "disabled", "not enabled and active"),
        ("timerActiveState", "inactive", "not enabled and active"),
        ("serviceResult", "exit-code", "did not complete successfully"),
        ("serviceExecMainStatus", "10", "did not complete successfully"),
        ("serviceTriggeredBy", "", "did not complete successfully"),
        ("serviceInvocationId", "", "invocation identity"),
        ("serviceStartAt", "2026-08-27T15:10:00+00:00", "exact last trigger"),
        ("serviceExitAt", "2026-08-27T17:00:00+00:00", "systemd bound"),
        ("reportGeneratedAt", "2026-08-26T16:01:57+00:00", "does not belong"),
        ("reportMtimeAt", "2026-08-27T16:01:40+00:00", "does not belong"),
        ("timerNextTriggerAt", "2026-08-27T15:59:00+00:00", "no future trigger"),
    ],
)
def test_scheduled_run_rejects_broken_timer_origin_chain(
    field: str,
    value: object,
    message: str,
) -> None:
    summary = scheduled_summary()
    summary["scheduledOrigin"][field] = value
    with pytest.raises(RuntimeError, match=message):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_scheduled_run_rejects_missing_or_naive_origin_timestamps() -> None:
    missing = scheduled_summary()
    missing["scheduledOrigin"] = None
    with pytest.raises(RuntimeError, match="origin evidence is missing"):
        cutover._validate_audit_summary(
            missing,
            require_canary_write=False,
            require_scheduled_run=True,
        )

    naive = scheduled_summary()
    naive["scheduledOrigin"]["serviceStartAt"] = "2026-08-27T15:03:44"
    with pytest.raises(RuntimeError, match="has no timezone"):
        cutover._validate_audit_summary(
            naive,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_zero_write_scheduled_run_still_requires_consistent_batch_receipts() -> None:
    summary = scheduled_summary(writes=0)
    summary["batchReceiptsSafe"] = False
    with pytest.raises(RuntimeError, match="batch receipt"):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("batchReceiptCount", -1),
        ("batchReceiptCount", True),
        ("receiptInsertedIdCount", 11),
    ],
)
def test_scheduled_run_rejects_invalid_receipt_accounting(
    field: str, value: object,
) -> None:
    summary = scheduled_summary(writes=12)
    summary[field] = value
    with pytest.raises(RuntimeError, match="receipt accounting"):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def receipt(ids: list[str]) -> dict:
    return {
        "insertedIds": ids,
        "preWriteViolationSamples": [],
        "rolledBack": False,
        "rollbackRemainingIds": [],
        "createdAtWindow": ["2026-08-26T00:00:00+00:00", "2026-08-26T00:00:01+00:00"] if ids else None,
        "rollback": "DELETE WHERE id IN (...)" if ids else None,
        "postWriteVerification": {
            "rowsReadBack": len(ids),
            "exactWriteReadback": {
                "expectedIds": ids,
                "actualIds": ids,
                "pass": True,
            },
            "allRedLinesPass": True,
        } if ids else None,
    }


def test_atomic_receipt_structure_and_exact_readback_are_closed() -> None:
    assert cutover._batch_receipts_are_safe([receipt(["one"])], ["one"])
    assert cutover._batch_receipts_are_safe([], [])

    malformed_zero = receipt([])
    malformed_zero["postWriteVerification"] = {"allRedLinesPass": False}
    assert not cutover._batch_receipts_are_safe([malformed_zero], [])

    wrong_readback = receipt(["one"])
    wrong_readback["postWriteVerification"]["rowsReadBack"] = 0
    assert not cutover._batch_receipts_are_safe([wrong_readback], ["one"])

    missing_rollback = receipt(["one"])
    missing_rollback["rollback"] = None
    assert not cutover._batch_receipts_are_safe([missing_rollback], ["one"])

    assert not cutover._batch_receipts_are_safe([receipt(["hidden"])], [])


def test_remote_readback_uses_complete_pinterest_host_authority() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "not _is_pinterest_hosted_url(row[\"image_url\"])" in source
    assert "inspect.getsource(_is_pinterest_hosted_url)" in source
    assert '"pinimg.com" not in row["image_url"].lower()' not in source


def test_remote_readback_binds_inserted_rows_to_exact_source_pins() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "select=id,source_url,parent_pin_id,source_pin_id,source_pin_url,source_category,seed_keyword" in source
    assert "select=pin_id,category,seed_keyword,source_keyword" in source
    assert "inspect.getsource(_source_provenance_is_safe)" in source

    product = {
        "parent_pin_id": "123",
        "source_pin_id": "123",
        "source_pin_url": "https://www.pinterest.com/pin/123/",
        "source_category": "fashion",
        "seed_keyword": "linen dress",
    }
    source_pin = {
        "pin_id": "123",
        "category": "fashion",
        "seed_keyword": "linen dress",
    }
    assert cutover._source_provenance_is_safe([product], [source_pin], {"fashion"})
    for field, value in [
        ("parent_pin_id", "999"),
        ("source_pin_url", "https://www.pinterest.com/pin/999/"),
        ("source_category", "home-decor"),
        ("seed_keyword", "other keyword"),
    ]:
        tampered = {**product, field: value}
        assert not cutover._source_provenance_is_safe([tampered], [source_pin], {"fashion"})
    assert not cutover._source_provenance_is_safe([product], [], {"fashion"})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sourceProvenanceSafe", False),
        ("sourceReadbackCount", 0),
        ("sourcePinCount", 0),
        ("insertedSourceCategoryCounts", {"fashion": 11}),
        ("insertedSourceCategoryCounts", {"digital-products": 12}),
    ],
)
def test_scheduled_run_rejects_source_provenance_mismatch(field: str, value: object) -> None:
    summary = scheduled_summary()
    summary[field] = value
    with pytest.raises(RuntimeError, match="Source Pin/category provenance"):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


@pytest.mark.parametrize(
    "url",
    [
        "https://i.pinimg.com/image.jpg",
        "https://i.pinimg.co/image.jpg",
        "https://assets.pinimg.co.uk/image.jpg",
        "https://www.pinterest.co.uk/image.jpg",
    ],
)
def test_complete_pinterest_image_host_family_is_rejected(url: str) -> None:
    assert cutover._is_pinterest_hosted_url(url) is True


def test_pinimg_text_in_a_real_merchant_path_is_not_rejected() -> None:
    assert cutover._is_pinterest_hosted_url(
        "https://cdn.merchant.example/assets/pinimg.com-style/image.jpg"
    ) is False


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("mode", "dry-run", "apply-mode"),
        ("selectedTotal", 99, "100-Pin scan"),
        ("categoryMix", {"fashion": 100}, "physical-legacy category mix"),
        ("runAdmissionCap", 1, "50-row run cap"),
        ("merchantDiscoveryCandidateCap", 101, "merchant discovery request cap"),
        ("atomicWriteBatchCap", 21, "atomic write cap"),
        ("resultTrust", "partial:some_pins_failed_to_render", "trusted authenticated"),
        ("authenticatedRun", False, "trusted authenticated"),
        ("renderFailureCount", 1, "render failures"),
    ],
)
def test_scheduled_run_contract_fails_closed(
    field: str, value: object, message: str,
) -> None:
    summary = scheduled_summary()
    summary[field] = value
    with pytest.raises(RuntimeError, match=message):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_scheduled_run_rejects_over_cap_and_accounting_or_receipt_mismatch() -> None:
    with pytest.raises(RuntimeError, match="50-row write cap"):
        cutover._validate_audit_summary(
            scheduled_summary(writes=51),
            require_canary_write=False,
            require_scheduled_run=True,
        )
    mismatched = scheduled_summary()
    mismatched["readbackCount"] -= 1
    with pytest.raises(RuntimeError, match="write accounting"):
        cutover._validate_audit_summary(
            mismatched,
            require_canary_write=False,
            require_scheduled_run=True,
        )
    unsafe_receipt = scheduled_summary()
    unsafe_receipt["batchReceiptsSafe"] = False
    with pytest.raises(RuntimeError, match="batch receipt"):
        cutover._validate_audit_summary(
            unsafe_receipt,
            require_canary_write=False,
            require_scheduled_run=True,
        )
    failed_row = scheduled_summary()
    failed_row["failedWrites"] = 1
    with pytest.raises(RuntimeError, match="failed rows"):
        cutover._validate_audit_summary(
            failed_row,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_scheduled_response_parse_errors_are_measured_diagnostics() -> None:
    summary = scheduled_summary()
    summary.update({
        "responseErrorCount": 32,
        "responseErrorSamples": [
            "Error:Response.json: Protocol error: response body released",
            "JSONDecodeError:Expecting value",
        ],
        "productJsonResponses": 4569,
        "pinsWithZeroProductJson": 16,
    })
    cutover._validate_audit_summary(
        summary,
        require_canary_write=False,
        require_scheduled_run=True,
    )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("responseErrorCount", -1, "response-error accounting"),
        ("responseErrorCount", True, "response-error accounting"),
        ("responseErrorSamples", "not-a-list", "response-error accounting"),
        ("productJsonResponses", None, "product-response diagnostics"),
        ("productJsonResponses", -1, "product-response diagnostics"),
        ("pinsWithZeroProductJson", 101, "product-response diagnostics"),
    ],
)
def test_scheduled_run_rejects_invalid_response_diagnostics(
    field: str, value: object, message: str,
) -> None:
    summary = scheduled_summary()
    summary[field] = value
    with pytest.raises(RuntimeError, match=message):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def test_scheduled_run_requires_samples_when_response_errors_exist() -> None:
    summary = scheduled_summary()
    summary["responseErrorCount"] = 1
    with pytest.raises(RuntimeError, match="response-error accounting"):
        cutover._validate_audit_summary(
            summary,
            require_canary_write=False,
            require_scheduled_run=True,
        )


def cooldown(last_activity: str | None = "2026-08-26T13:43:03+00:00") -> dict:
    return {
        "known": last_activity is not None,
        "lastActivityAt": last_activity,
        "requiredMinutes": 120,
    }


def epoch(value: str) -> int:
    return int(dt.datetime.fromisoformat(value).timestamp())


def test_timer_enable_rejects_the_observed_91_minute_window() -> None:
    with pytest.raises(RuntimeError, match=r"projected 91\.17min, requires 120min"):
        cutover._validate_next_timer_cooldown(
            cooldown(),
            epoch("2026-08-26T15:14:13+00:00"),
        )


def test_timer_enable_accepts_exact_boundary_and_next_day() -> None:
    boundary = cutover._validate_next_timer_cooldown(
        cooldown(),
        epoch("2026-08-26T15:43:03+00:00"),
    )
    assert boundary["projectedCooldownMinutes"] == 120.0

    next_day = cutover._validate_next_timer_cooldown(
        cooldown(),
        epoch("2026-08-27T15:00:00+00:00"),
    )
    assert next_day["projectedCooldownMinutes"] == 1516.95


@pytest.mark.parametrize(
    "bad",
    [
        cooldown(None),
        {"known": True, "lastActivityAt": "not-a-date", "requiredMinutes": 120},
        {"known": True, "lastActivityAt": "2026-08-26T13:43:03", "requiredMinutes": 120},
        {"known": True, "lastActivityAt": "2026-08-26T13:43:03+00:00", "requiredMinutes": 0},
    ],
)
def test_timer_enable_fails_closed_on_invalid_cooldown_evidence(bad: dict) -> None:
    with pytest.raises(RuntimeError):
        cutover._validate_next_timer_cooldown(bad, epoch("2026-08-27T15:00:00+00:00"))


def test_timer_readiness_forces_utc_for_ambiguous_cst(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[str] = []

    def fake_run(_client: object, command: str, **_kwargs: object) -> tuple[int, str, str]:
        commands.append(command)
        if "preflight_product_supply.py" in command:
            return 0, '{"cooldown":{"known":true,"lastActivityAt":"2026-08-26T13:43:03+00:00","requiredMinutes":120}}', ""
        return 0, str(epoch("2026-08-27T15:00:00+00:00")), ""

    monkeypatch.setattr(cutover, "run", fake_run)
    readiness = cutover._timer_enable_readiness(object())
    assert readiness["projectedCooldownMinutes"] == 1516.95
    assert "TZ=UTC systemctl show" in commands[1]


def test_transient_supply_run_uses_reviewed_digital_launch_mix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[str] = []
    monkeypatch.setattr(cutover, "assert_free", lambda _client: None)
    monkeypatch.setattr(cutover.time, "strftime", lambda *_args, **_kwargs: "20260827000000")

    def fake_run(_client: object, command: str, **_kwargs: object) -> tuple[int, str, str]:
        commands.append(command)
        return 0, "", ""

    monkeypatch.setattr(cutover, "run", fake_run)
    cutover.transient_run(object(), "dry-run")
    launch = commands[0]
    assert "VIBEPIN_SUPPLY_LIMIT=100" in launch
    assert "VIBEPIN_CATEGORY_MIX=fashion:29,womens-fashion:22,home-decor:29,digital-products:20" in launch
    assert "VIBEPIN_STL_ALLOW_EXCLUDED=digital-products" in launch
    assert "VIBEPIN_STL_ALLOW_EXCLUDED=beauty" not in launch


def test_cutover_atomically_installs_and_reboot_safes_the_supply_timer() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "deploy/systemd/vibepin-product-supply.timer" in cutover.MANIFEST
    assert 'systemctl disable --now {TIMER}' in source
    assert 'systemctl stop {TIMER}' not in source
    assert "systemd-analyze verify " in source
    assert "service_unit" in source and "timer_unit" in source
    assert "/etc/systemd/system/{SERVICE} /etc/systemd/system/{TIMER}" in source


def test_partial_backup_state_does_not_mask_the_original_cutover_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_rel, first_dest = next(iter(cutover.MANIFEST.items()))
    commands: list[str] = []

    def fake_run(_client: object, command: str, **_kwargs: object) -> tuple[int, str, str]:
        commands.append(command)
        return 0, "", ""

    monkeypatch.setattr(cutover, "run", fake_run)
    cutover._restore(object(), "/safe-backup", {first_rel: True})

    assert commands == [
        f"cp -a /safe-backup/{first_rel.replace('/', '__')} {first_dest}",
        "systemctl daemon-reload",
    ]


def test_existing_entry_is_recorded_only_after_backup_copy_succeeds() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    backup_loop = source[source.index("for rel, dest in MANIFEST.items():", source.index("def activate")) :]
    copy_index = backup_loop.index("run(client, f\"cp -a")
    recorded_index = backup_loop.index("existed[rel] = True")
    assert copy_index < recorded_index


def test_cutover_rejects_unknown_or_changed_vps_host_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "client.load_system_host_keys()" in source
    assert "paramiko.RejectPolicy()" in source
    assert "AutoAddPolicy" not in source

    class FakeClient:
        def __init__(self) -> None:
            self.loaded = False
            self.policy: object | None = None
            self.connected: dict[str, object] | None = None

        def load_system_host_keys(self) -> None:
            self.loaded = True

        def set_missing_host_key_policy(self, policy: object) -> None:
            self.policy = policy

        def connect(self, host: str, **kwargs: object) -> None:
            self.connected = {"host": host, **kwargs}

        def get_transport(self) -> None:
            return None

    client = FakeClient()
    monkeypatch.setattr(cutover.paramiko, "SSHClient", lambda: client)
    result = cutover.connect({
        "VPS_HOST": "reviewed-vps",
        "VPS_PORT": "2222",
        "VPS_USER": "deploy",
        "VPS_PASSWORD": "not-a-real-secret",
    })

    assert result is client
    assert client.loaded is True
    assert isinstance(client.policy, cutover.paramiko.RejectPolicy)
    assert client.connected == {
        "host": "reviewed-vps",
        "port": 2222,
        "username": "deploy",
        "password": "not-a-real-secret",
        "timeout": 30,
    }
