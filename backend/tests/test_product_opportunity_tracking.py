import asyncio
from dataclasses import replace
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

import product_opportunity_tracking as tracking


TARGET = tracking.TrackingTarget("product-1", "evidence-1", "123456789012345678")
INVENTORY = tracking.TrackingInventory([TARGET], 1, 0, False, 0, 1, 1)
TEST_PROJECT_REF = "testproductv37"


@pytest.fixture(autouse=True)
def _verified_test_project(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SUPABASE_URL", f"https://{TEST_PROJECT_REF}.supabase.co")
    monkeypatch.setenv(tracking.EXPECTED_PROJECT_REF_ENV, TEST_PROJECT_REF)


class FakeResponse:
    def __init__(self, status_code: int, payload: object) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def test_valid_pin_resource_extracts_real_save_count() -> None:
    result = tracking.classify_pin_resource(
        TARGET,
        {"resource_response": {"data": {"id": TARGET.pinterest_pin_id, "save_count": 42}}},
    )
    assert result.status == "valid"
    assert result.save_count == 42


def test_explicit_zero_is_valid_but_missing_save_field_is_unknown() -> None:
    explicit_zero = tracking.classify_pin_resource(
        TARGET,
        {"resource_response": {"data": {"id": TARGET.pinterest_pin_id, "save_count": 0}}},
    )
    missing = tracking.classify_pin_resource(
        TARGET,
        {"resource_response": {"data": {"id": TARGET.pinterest_pin_id}}},
    )
    assert explicit_zero.status == "valid"
    assert explicit_zero.save_count == 0
    assert missing.status == "provider_error"
    assert missing.save_count is None


def test_nested_aggregated_save_evidence_remains_supported() -> None:
    result = tracking.classify_pin_resource(
        TARGET,
        {
            "resource_response": {
                "data": {
                    "id": TARGET.pinterest_pin_id,
                    "aggregated_pin_data": {"aggregated_stats": {"saves": 17}},
                }
            }
        },
    )
    assert result.status == "valid"
    assert result.save_count == 17


@pytest.mark.parametrize(
    "bad",
    ["unknown", True, -1, 1.5, float("inf"), str(2**63)],
)
def test_malformed_or_impossible_save_values_never_become_zero(bad: object) -> None:
    result = tracking.classify_pin_resource(
        TARGET,
        {"resource_response": {"data": {"id": TARGET.pinterest_pin_id, "save_count": bad}}},
    )
    assert result.status == "provider_error"
    assert result.save_count is None


def test_confirmed_null_data_is_not_found() -> None:
    result = tracking.classify_pin_resource(TARGET, {"resource_response": {"data": None}})
    assert result.status == "not_found"
    assert result.save_count is None


@pytest.mark.parametrize("payload", [{}, None, {"resource_response": {"error": "rate"}}])
def test_ambiguous_provider_failure_never_counts_as_not_found(payload: object) -> None:
    assert tracking.classify_pin_resource(TARGET, payload).status == "provider_error"


@pytest.mark.parametrize(
    "payload",
    [
        {"resource_response": {"error": {"status": 404}}},
        {"resource_response": {"error": {"status": 429}}},
        {"resource_response": {"error": {"status": 503}}},
    ],
)
def test_http_errors_never_become_confirmed_not_found(payload: object) -> None:
    assert tracking.classify_pin_resource(TARGET, payload).status == "provider_error"


def test_fetch_is_bounded_to_supplied_targets() -> None:
    class FakeSession:
        calls = 0
        _timeout = 30.0

        async def _request(self, *_args, **_kwargs):
            self.calls += 1
            return FakeResponse(
                200,
                {"resource_response": {"data": {"id": TARGET.pinterest_pin_id, "save_count": 5}}},
            )

    session = FakeSession()
    result = asyncio.run(tracking.fetch_observations(session, [TARGET], concurrency=50, delay=0))
    assert session.calls == 1
    assert len(result.observations) == 1
    assert result.provider_requests_attempted == 1


def test_provider_timeout_is_isolated_and_retried_without_fake_not_found() -> None:
    class TimeoutSession:
        _timeout = 30.0

        async def _request(self, *_args, **_kwargs):
            raise TimeoutError("provider timed out")

    result = asyncio.run(
        tracking.fetch_observations(TimeoutSession(), [TARGET], concurrency=1, delay=0)
    )
    assert result.observations[0].status == "provider_error"
    assert result.observations[0].failure_kind == "timeout"
    assert result.provider_requests_attempted == 2
    assert result.retries == 1


def test_shared_pin_is_fetched_once_and_fanned_out_to_each_evidence() -> None:
    second = tracking.TrackingTarget("product-2", "evidence-2", TARGET.pinterest_pin_id)

    class FakeSession:
        calls = 0
        _timeout = 30.0

        async def _request(self, *_args, **_kwargs):
            self.calls += 1
            return FakeResponse(
                200,
                {"resource_response": {"data": {"id": TARGET.pinterest_pin_id, "save_count": 8}}},
            )

    session = FakeSession()
    result = asyncio.run(
        tracking.fetch_observations(session, [TARGET, second], concurrency=5, delay=0)
    )
    assert session.calls == 1
    assert result.unique_pins == 1
    assert result.deduped_pins == 1
    assert {row.target.evidence_id for row in result.observations} == {"evidence-1", "evidence-2"}


def test_inventory_budget_counts_unique_due_pins_not_product_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    product_count = 3_000
    unique_pin_count = 2_000
    products = [{"id": f"product-{index}"} for index in range(product_count)]
    evidence = [
        {
            "id": f"evidence-{index}",
            "product_opportunity_id": f"product-{index}",
            "pinterest_pin_id": f"pin-{index % unique_pin_count}",
        }
        for index in range(product_count)
    ]

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            if table == "product_opportunities":
                assert kwargs.get("limit") is None
                assert kwargs.get("filters") == {"lifecycle_status": "active"}
                return products
            if table == "product_opportunity_evidence":
                encoded = kwargs["filters"]["product_opportunity_id"]
                ids = set(encoded.removeprefix("in.(").removesuffix(")").split(","))
                return [row for row in evidence if row["product_opportunity_id"] in ids]
            if table == "product_evidence_snapshots":
                return []
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    inventory = tracking.load_targets(2_499)
    assert inventory.active_products_read == product_count
    assert len(inventory.targets) == product_count
    assert inventory.eligible_unique_pins == unique_pin_count
    assert inventory.due_unique_pins == unique_pin_count
    assert inventory.exceeds_run_budget is False


def test_one_canonical_pin_day_marks_every_shared_evidence_observed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    products = [{"id": "product-1"}, {"id": "product-2"}]
    evidence = [
        {"id": "evidence-1", "product_opportunity_id": "product-1", "pinterest_pin_id": "pin-shared"},
        {"id": "evidence-2", "product_opportunity_id": "product-2", "pinterest_pin_id": "pin-shared"},
    ]

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            if table == "product_opportunities":
                return products
            if table == "product_opportunity_evidence":
                return evidence
            if table == "product_evidence_snapshots":
                assert kwargs["filters"]["pinterest_pin_id"] == "in.(pin-shared)"
                return [{"pinterest_pin_id": "pin-shared"}]
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    inventory = tracking.load_targets(2_499, captured_on=date(2026, 8, 26))
    assert inventory.targets == []
    assert inventory.eligible_unique_pins == 1
    assert inventory.due_unique_pins == 0
    assert inventory.already_observed_today == 2


def test_three_day_missing_primary_uses_bounded_verified_switch_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    primary = {
        "id": "primary-1",
        "product_opportunity_id": "product-1",
        "pinterest_pin_id": "pin-old",
        "consecutive_not_found_days": 3,
    }
    alternatives = [
        {
            "id": "source-direct",
            "product_opportunity_id": "product-1",
            "pinterest_pin_id": "pin-source",
            "evidence_type": "source_pin",
            "relationship_method": "direct_outbound_link",
            "consecutive_not_found_days": 0,
            "last_valid_observed_at": "2026-08-20T00:00:00+00:00",
            "created_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": "product-pin",
            "product_opportunity_id": "product-1",
            "pinterest_pin_id": "pin-product",
            "evidence_type": "product_pin",
            "relationship_method": "merchant_product_reference",
            "consecutive_not_found_days": 0,
            "last_valid_observed_at": None,
            "created_at": "2026-08-02T00:00:00+00:00",
        },
    ]

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            if table == "product_opportunities":
                return [{"id": "product-1"}]
            if table == "product_opportunity_evidence":
                return primary and [primary] if kwargs["filters"]["is_primary"] == "true" else alternatives
            if table == "product_evidence_snapshots":
                return []
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    inventory = tracking.load_targets(2_499, captured_on=date(2026, 8, 26))
    assert inventory.targets == [
        tracking.TrackingTarget("product-1", "primary-1", "pin-old"),
        tracking.TrackingTarget("product-1", "product-pin", "pin-product")
    ]
    assert inventory.eligible_unique_pins == 1
    assert inventory.due_unique_pins == 1
    assert inventory.switch_candidate_pins_due == 1
    assert inventory.total_due_request_pins == 2
    assert inventory.pending_primary_switches == [
        tracking.PendingPrimarySwitch(
            "product-1", "primary-1", "product-pin", "pin-product"
        )
    ]
    constrained = tracking.load_targets(1, captured_on=date(2026, 8, 26))
    assert constrained.eligible_unique_pins == 1
    assert constrained.total_due_request_pins == 2
    assert constrained.exceeds_run_budget is True


def test_non_direct_source_pin_cannot_become_primary_switch_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    primary = {
        "id": "primary-1",
        "product_opportunity_id": "product-1",
        "pinterest_pin_id": "pin-old",
        "consecutive_not_found_days": 3,
    }

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            if table == "product_opportunities":
                return [{"id": "product-1"}]
            if table == "product_opportunity_evidence":
                if kwargs["filters"]["is_primary"] == "true":
                    return [primary]
                return [{
                    "id": "source-stl",
                    "product_opportunity_id": "product-1",
                    "pinterest_pin_id": "pin-stl",
                    "evidence_type": "source_pin",
                    "relationship_method": "shop_the_look",
                    "consecutive_not_found_days": 0,
                }]
            if table == "product_evidence_snapshots":
                return []
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    inventory = tracking.load_targets(2_499, captured_on=date(2026, 8, 26))
    assert inventory.targets == [
        tracking.TrackingTarget("product-1", "primary-1", "pin-old")
    ]
    assert inventory.pending_primary_switches == []


def test_valid_switch_candidate_fact_never_suppresses_current_primary_tracking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    primary = {
        "id": "primary-1",
        "product_opportunity_id": "product-1",
        "pinterest_pin_id": "pin-old",
        "consecutive_not_found_days": 3,
    }
    alternative = {
        "id": "candidate-1",
        "product_opportunity_id": "product-1",
        "pinterest_pin_id": "pin-candidate",
        "evidence_type": "product_pin",
        "relationship_method": "direct_outbound_link",
        "consecutive_not_found_days": 0,
    }

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            if table == "product_opportunities":
                return [{"id": "product-1"}]
            if table == "product_opportunity_evidence":
                return [primary] if kwargs["filters"]["is_primary"] == "true" else [alternative]
            if table == "product_evidence_snapshots":
                return [{"pinterest_pin_id": "pin-candidate"}]
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    inventory = tracking.load_targets(2_499, captured_on=date(2026, 8, 26))
    assert inventory.targets == [
        tracking.TrackingTarget("product-1", "primary-1", "pin-old")
    ]
    assert inventory.already_valid_switch_pin_ids == ("pin-candidate",)
    assert inventory.switch_candidates_already_valid_today == 1
    assert inventory.due_unique_pins == 1
    assert inventory.total_due_request_pins == 1


def test_primary_switch_requires_a_valid_observation_today(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    posts: list[tuple[str, dict]] = []

    class Response:
        status_code = 204
        text = ""

    class Http:
        def post(self, path: str, json: dict):
            posts.append((path, json))
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    pending = [
        tracking.PendingPrimarySwitch(
            "product-1", "primary-1", "candidate-1", "pin-candidate"
        )
    ]
    failed = tracking.TrackingObservation(
        tracking.TrackingTarget("product-1", "candidate-1", "pin-candidate"),
        "provider_error",
        None,
        "timeout",
        captured_at=datetime(2026, 8, 26, tzinfo=timezone.utc),
    )
    assert tracking.switch_validated_primary_evidence(pending, [failed]) == (0, 1)
    assert posts == []

    valid = tracking.TrackingObservation(
        failed.target,
        "valid",
        12,
        captured_at=datetime(2026, 8, 26, tzinfo=timezone.utc),
    )
    assert tracking.switch_validated_primary_evidence(pending, [valid]) == (1, 0)
    assert posts == [(
        "rpc/switch_product_primary_evidence",
        {
            "p_product_opportunity_id": "product-1",
            "p_new_evidence_id": "candidate-1",
            "p_reason": "primary_not_found_three_natural_days",
        },
    )]


def test_recovered_primary_cancels_candidate_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    posts: list[tuple[str, dict]] = []

    class Response:
        status_code = 204
        text = ""

    class Http:
        def post(self, path: str, json: dict):
            posts.append((path, json))
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    pending = [
        tracking.PendingPrimarySwitch(
            "product-1", "primary-1", "candidate-1", "pin-candidate"
        )
    ]
    captured_at = datetime(2026, 8, 26, tzinfo=timezone.utc)
    observations = [
        tracking.TrackingObservation(
            tracking.TrackingTarget("product-1", "primary-1", "pin-old"),
            "valid",
            120,
            captured_at=captured_at,
        ),
        tracking.TrackingObservation(
            tracking.TrackingTarget("product-1", "candidate-1", "pin-candidate"),
            "valid",
            80,
            captured_at=captured_at,
        ),
    ]

    assert tracking.switch_validated_primary_evidence(pending, observations) == (0, 0)
    assert posts == []


def test_existing_valid_canonical_pin_fact_can_authorize_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    calls = 0

    class Response:
        status_code = 204
        text = ""

    class Http:
        def post(self, _path: str, json: dict):
            nonlocal calls
            calls += 1
            assert json["p_new_evidence_id"] == "candidate-1"
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    pending = [
        tracking.PendingPrimarySwitch(
            "product-1", "primary-1", "candidate-1", "pin-candidate"
        )
    ]
    assert tracking.switch_validated_primary_evidence(
        pending,
        [],
        already_valid_pin_ids={"pin-candidate"},
    ) == (1, 0)
    assert calls == 1


def test_inventory_refuses_more_than_reviewed_unique_due_pin_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    products = [{"id": f"product-{index}"} for index in range(2_500)]
    evidence = [
        {
            "id": f"evidence-{index}",
            "product_opportunity_id": f"product-{index}",
            "pinterest_pin_id": f"pin-{index}",
        }
        for index in range(2_500)
    ]

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            if table == "product_opportunities":
                return products
            if table == "product_opportunity_evidence":
                encoded = kwargs["filters"]["product_opportunity_id"]
                ids = set(encoded.removeprefix("in.(").removesuffix(")").split(","))
                return [row for row in evidence if row["product_opportunity_id"] in ids]
            if table == "product_evidence_snapshots":
                return []
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    inventory = tracking.load_targets(2_499)
    assert len(inventory.targets) == 2_500
    assert inventory.due_unique_pins == 2_500
    assert inventory.exceeds_run_budget is True


def test_429_gets_one_bounded_retry_and_is_reported() -> None:
    class RateLimitedThenOk:
        calls = 0
        _timeout = 30.0

        async def _request(self, *_args, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                return FakeResponse(429, {})
            return FakeResponse(
                200,
                {"resource_response": {"data": {"id": TARGET.pinterest_pin_id, "save_count": 9}}},
            )

    result = asyncio.run(
        tracking.fetch_observations(RateLimitedThenOk(), [TARGET], concurrency=1, delay=0)
    )
    assert result.observations[0].status == "valid"
    assert result.retries == 1
    assert result.attempt_failures["http_429"] == 1


def test_budget_must_cover_one_retry_for_every_unique_pin() -> None:
    with pytest.raises(RuntimeError, match="cannot guarantee"):
        asyncio.run(
            tracking.fetch_observations(object(), [TARGET], delay=0, request_budget=1)
        )


@pytest.mark.parametrize(("status_code", "attempts", "kind"), [(404, 1, "http_404"), (503, 2, "http_5xx")])
def test_http_failures_are_counted_and_never_become_not_found(
    status_code: int, attempts: int, kind: str
) -> None:
    class FailedSession:
        _timeout = 30.0

        async def _request(self, *_args, **_kwargs):
            return FakeResponse(status_code, {})

    result = asyncio.run(
        tracking.fetch_observations(FailedSession(), [TARGET], concurrency=1, delay=0)
    )
    assert result.observations[0].status == "provider_error"
    assert result.observations[0].failure_kind == kind
    assert result.provider_requests_attempted == attempts


def test_observation_writes_are_batched_and_require_real_capture_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    posts: list[list[dict]] = []

    class Response:
        status_code = 200
        text = ""

        def __init__(self, count: int) -> None:
            self.count = count

        def json(self):
            return [{"written": self.count, "counter_regressions": 0}]

    class Http:
        def post(self, path: str, json: dict):
            assert path == "rpc/record_product_evidence_observation_batch"
            posts.append(json["p_observations"])
            return Response(len(json["p_observations"]))

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    captured = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
    rows = [
        tracking.TrackingObservation(
            tracking.TrackingTarget(f"p-{index}", f"e-{index}", str(index)),
            "valid",
            index,
            captured_at=captured,
        )
        for index in range(205)
    ]
    assert tracking.record_observations(rows) == (205, 0)
    assert [len(chunk) for chunk in posts] == [100, 100, 5]
    with pytest.raises(RuntimeError, match="real capture timestamp"):
        tracking.record_observations([tracking.TrackingObservation(TARGET, "valid", 1)])


def test_provider_failures_are_reported_but_never_written_as_snapshots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    posts: list[list[dict]] = []

    class Response:
        status_code = 200
        text = ""

        def __init__(self, count: int) -> None:
            self.count = count

        def json(self):
            return [{"written": self.count, "counter_regressions": 0}]

    class Http:
        def post(self, _path: str, json: dict):
            posts.append(json["p_observations"])
            return Response(len(json["p_observations"]))

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    captured = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
    observations = [
        tracking.TrackingObservation(TARGET, "provider_error", None, "timeout", captured_at=captured),
        tracking.TrackingObservation(TARGET, "rate_limited", None, "http_429", captured_at=captured),
        tracking.TrackingObservation(TARGET, "not_found", None, captured_at=captured),
    ]
    assert tracking.record_observations(observations) == (1, 0)
    assert len(posts) == 1
    assert [row["observation_status"] for row in posts[0]] == ["not_found"]


def test_dry_run_never_fetches_or_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracking, "load_targets", lambda _limit, **_kwargs: INVENTORY)
    monkeypatch.setattr(
        tracking,
        "record_observations",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("write called")),
    )
    report = asyncio.run(
        tracking.run(SimpleNamespace(apply=False, limit=5000, concurrency=5, delay=0.0))
    )
    assert report["activeTargets"] == 1
    assert report["written"] == 0


def test_apply_fails_before_network_without_both_environment_gates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tracking, "load_targets", lambda _limit, **_kwargs: INVENTORY)
    monkeypatch.delenv("VIBEPIN_PRODUCT_TRACKING_MODE", raising=False)
    monkeypatch.delenv("VIBEPIN_PRODUCT_TRACKING_CONFIRM", raising=False)
    with pytest.raises(RuntimeError, match="MODE"):
        asyncio.run(tracking.run(SimpleNamespace(apply=True, limit=1, concurrency=1, delay=0.0)))


def test_apply_refuses_missing_project_binding_before_database_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_CONFIRM", tracking.APPLY_CONFIRM)
    monkeypatch.delenv(tracking.EXPECTED_PROJECT_REF_ENV)
    monkeypatch.setattr(
        tracking,
        "load_targets",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("database read attempted")),
    )
    with pytest.raises(RuntimeError, match="project ref"):
        asyncio.run(
            tracking.run(SimpleNamespace(apply=True, limit=1, concurrency=1, delay=0.0))
        )


def test_metric_refresh_is_not_called_by_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracking, "load_targets", lambda _limit, **_kwargs: INVENTORY)
    monkeypatch.setattr(
        tracking,
        "refresh_metrics_after_tracking",
        lambda *_args: (_ for _ in ()).throw(AssertionError("metric write called")),
    )
    report = asyncio.run(
        tracking.run(SimpleNamespace(apply=False, limit=10, concurrency=1, delay=0.0))
    )
    assert report["written"] == 0
    assert report["orphanCount"] == 0


def test_process_cleanup_is_measured_and_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report = {"orphanCount": None}
    monkeypatch.setattr(tracking, "count_live_descendants", lambda **_kwargs: 0)
    tracking.verify_process_cleanup(report, grace_seconds=0)
    assert report["orphanCount"] == 0

    monkeypatch.setattr(tracking, "count_live_descendants", lambda **_kwargs: 2)
    with pytest.raises(RuntimeError, match="2 live descendant"):
        tracking.verify_process_cleanup(report, grace_seconds=0)
    assert report["orphanCount"] == 2


def test_tracking_metric_refresh_covers_all_active_products(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import product_opportunity_metric_refresh as metric_refresh

    seen_limits: list[int | None] = []

    def fake_load_inputs(limit: int | None):
        seen_limits.append(limit)
        return [], [], {"snapshots": [], "calibrations": {}}

    monkeypatch.setattr(metric_refresh, "load_inputs", fake_load_inputs)
    assert tracking.refresh_metrics_after_tracking(
        datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
    ) == (0, 0, 0, 0)
    assert seen_limits == [None]


@pytest.mark.parametrize(
    ("inventory", "message"),
    [
        (tracking.TrackingInventory([TARGET], 1, 0, True, 0, 1, 1), "run budget"),
        (tracking.TrackingInventory([], 1, 1, False), "lack Primary Evidence"),
    ],
)
def test_apply_fails_before_network_when_catalog_cannot_be_fully_tracked(
    monkeypatch: pytest.MonkeyPatch,
    inventory: tracking.TrackingInventory,
    message: str,
) -> None:
    monkeypatch.setattr(tracking, "load_targets", lambda _limit, **_kwargs: inventory)
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_CONFIRM", tracking.APPLY_CONFIRM)
    monkeypatch.setattr(
        tracking,
        "fetch_observations",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("network called")),
    )
    with pytest.raises(RuntimeError, match=message):
        asyncio.run(tracking.run(SimpleNamespace(apply=True, limit=1, concurrency=1, delay=0.0)))


def test_apply_lock_contention_is_a_failed_run_not_false_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import contextmanager
    import pipeline_tracking

    @contextmanager
    def locked_job(*_args, **_kwargs):
        yield {"skipped": True, "run_id": "run-locked", "job_type": "product-tracking"}

    monkeypatch.setattr(
        tracking,
        "load_targets",
        lambda _limit, **_kwargs: tracking.TrackingInventory([], 0, 0, False),
    )
    monkeypatch.setattr(pipeline_tracking, "pipeline_job", locked_job)
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_CONFIRM", tracking.APPLY_CONFIRM)
    with pytest.raises(RuntimeError, match="lock held"):
        asyncio.run(
            tracking.run(SimpleNamespace(apply=True, limit=1, concurrency=1, delay=0.0))
        )


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], "no_due_pins"),
        (["valid", "not_found"], "complete"),
        (["valid", "provider_error"], "degraded_partial_observations"),
        (["rate_limited", "provider_error"], "failed_no_confirmed_observation"),
    ],
)
def test_provider_run_outcome_never_calls_a_total_outage_success(
    statuses: list[str],
    expected: str,
) -> None:
    observations = [
        tracking.TrackingObservation(
            tracking.TrackingTarget(f"product-{index}", f"evidence-{index}", f"pin-{index}"),
            status,
            1 if status == "valid" else None,
            captured_at=datetime(2026, 8, 27, 6, tzinfo=timezone.utc),
        )
        for index, status in enumerate(statuses)
    ]
    assert tracking.provider_run_outcome(observations) == expected


def test_utc_day_guard_rejects_cross_day_before_any_write() -> None:
    run_started = datetime(2026, 8, 27, 23, 59, tzinfo=timezone.utc)
    next_day = datetime(2026, 8, 28, 0, 1, tzinfo=timezone.utc)
    observations = [
        tracking.TrackingObservation(
            TARGET,
            "valid",
            12,
            captured_at=next_day,
        )
    ]
    with pytest.raises(RuntimeError, match="crossed a UTC day boundary"):
        tracking.require_single_utc_tracking_day(
            run_started,
            observations,
            checked_at=next_day,
        )


def test_utc_day_guard_accepts_one_utc_day_and_rejects_naive_time() -> None:
    run_started = datetime(2026, 8, 27, 1, tzinfo=timezone.utc)
    observation = tracking.TrackingObservation(
        TARGET,
        "not_found",
        None,
        captured_at=datetime(2026, 8, 27, 23, 59, tzinfo=timezone.utc),
    )
    tracking.require_single_utc_tracking_day(
        run_started,
        [observation],
        checked_at=datetime(2026, 8, 27, 23, 59, 59, tzinfo=timezone.utc),
    )
    with pytest.raises(RuntimeError, match="timezone-aware"):
        tracking.require_single_utc_tracking_day(
            run_started.replace(tzinfo=None),
            [],
            checked_at=run_started,
        )


def test_apply_crossing_utc_day_aborts_before_snapshot_switch_or_metric_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import contextmanager
    import pipeline_tracking
    import scraper_v2

    run_started = datetime(2026, 8, 27, 23, 59, tzinfo=timezone.utc)
    next_day = datetime(2026, 8, 28, 0, 1, tzinfo=timezone.utc)
    observation = tracking.TrackingObservation(
        TARGET,
        "valid",
        12,
        captured_at=next_day,
    )
    batch = tracking.TrackingFetchBatch(
        observations=[observation],
        pin_observations=[observation],
        unique_pins=1,
        deduped_pins=0,
        provider_requests_attempted=1,
        retries=0,
        attempt_failures={},
    )

    @contextmanager
    def unlocked_job(*_args, **_kwargs):
        yield {}

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    async def fake_fetch(*_args, **_kwargs):
        return batch

    now_values = iter((run_started, next_day))
    monkeypatch.setattr(tracking, "_utc_now", lambda: next(now_values))
    monkeypatch.setattr(tracking, "load_targets", lambda *_args, **_kwargs: INVENTORY)
    monkeypatch.setattr(tracking, "fetch_observations", fake_fetch)
    monkeypatch.setattr(scraper_v2, "PinterestSession", lambda **_kwargs: FakeSession())
    monkeypatch.setattr(pipeline_tracking, "pipeline_job", unlocked_job)
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_CONFIRM", tracking.APPLY_CONFIRM)
    for name in (
        "record_observations",
        "switch_validated_primary_evidence",
        "refresh_metrics_after_tracking",
    ):
        monkeypatch.setattr(
            tracking,
            name,
            lambda *_args, _name=name, **_kwargs: (_ for _ in ()).throw(
                AssertionError(f"{_name} must not write after a UTC-day crossing")
            ),
        )

    with pytest.raises(RuntimeError, match="crossed a UTC day boundary"):
        asyncio.run(
            tracking.run(SimpleNamespace(apply=True, limit=1, concurrency=1, delay=0.0))
        )


def test_apply_propagates_total_provider_outage_with_unique_pin_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import contextmanager
    import pipeline_tracking
    import scraper_v2

    second_target = tracking.TrackingTarget("product-2", "evidence-2", TARGET.pinterest_pin_id)
    captured = datetime(2026, 8, 27, 6, tzinfo=timezone.utc)
    final_pin_failure = tracking.TrackingObservation(
        TARGET,
        "rate_limited",
        None,
        "http_429",
        attempts=2,
        captured_at=captured,
    )
    batch = tracking.TrackingFetchBatch(
        observations=[final_pin_failure, replace(final_pin_failure, target=second_target)],
        pin_observations=[final_pin_failure],
        unique_pins=1,
        deduped_pins=1,
        provider_requests_attempted=2,
        retries=1,
        attempt_failures={"http_429": 2},
    )
    job_state: dict = {}

    @contextmanager
    def unlocked_job(*_args, **_kwargs):
        yield job_state

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    async def fake_fetch(*_args, **_kwargs):
        return batch

    monkeypatch.setattr(
        tracking,
        "load_targets",
        lambda _limit, **_kwargs: tracking.TrackingInventory(
            targets=[TARGET, second_target],
            active_products_read=2,
            missing_primary_evidence=0,
            exceeds_run_budget=False,
            eligible_unique_pins=1,
            due_unique_pins=1,
            total_due_request_pins=1,
        ),
    )
    monkeypatch.setattr(tracking, "fetch_observations", fake_fetch)
    monkeypatch.setattr(tracking, "verify_process_cleanup", lambda report: report.update(orphanCount=0))
    monkeypatch.setattr(
        tracking,
        "record_observations",
        lambda _rows: (_ for _ in ()).throw(AssertionError("failure facts were written")),
    )
    monkeypatch.setattr(scraper_v2, "PinterestSession", lambda **_kwargs: FakeSession())
    monkeypatch.setattr(pipeline_tracking, "pipeline_job", unlocked_job)
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_TRACKING_CONFIRM", tracking.APPLY_CONFIRM)

    with pytest.raises(RuntimeError, match="no confirmed valid or not-found"):
        asyncio.run(
            tracking.run(SimpleNamespace(apply=True, limit=1, concurrency=1, delay=0.0))
        )

    assert job_state["stats"]["providerRunOutcome"] == "failed_no_confirmed_observation"
    assert job_state["stats"]["providerErrors"] == 1
    assert job_state["stats"]["providerRequestsAttempted"] == 2
    assert job_state["stats"]["written"] == 0
