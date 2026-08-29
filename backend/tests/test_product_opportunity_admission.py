import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone

import pytest

import product_opportunity_admission as admission


NOW = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)


def candidate(**overrides: object) -> dict:
    url = "https://shop.example/products/real-item"
    image = "https://shop.example/images/real-item.jpg"
    row = {
        "canonical_product_url": url,
        "external_product_url": url,
        "product_image_url": image,
        "product_image_source": "merchant_open_graph",
        "product_page_verified_at": NOW.isoformat(),
        "product_page_verification_method": "merchant_structured_data",
        "product_name": None,
        "merchant": "Example Shop",
        "category": "fashion",
        "product_family": "physical",
        "discovery_method": "outbound_link",
        "pinterest_pin_id": "123456789012345678",
        "pinterest_pin_url": "https://www.pinterest.com/pin/123456789012345678/",
        "evidence_type": "source_pin",
        "relationship_method": "direct_outbound_link",
        "provenance": {
            "pdp_gate_passed": True,
            "image_found_in_merchant_page": True,
            "merchant_page_url": url,
            "product_image_url": image,
            "merchant_page_sha256": hashlib.sha256(b"merchant html evidence").hexdigest(),
            "verified_by": "merchant-refetch-v1",
            "source_category": "fashion",
            "pinterest_pin_id": "123456789012345678",
            "pin_direct_outbound_url": url,
            "source_pin_direct_outbound_url": url,
            "source_pin_id": "123456789012345678",
            "merchant_field_evidence": ["merchant:og:site_name"],
            "merchant_found_in_page": True,
            "merchant_value": "Example Shop",
        },
    }
    row.update(overrides)
    return row


def stored_product(expected: dict, product_id: str) -> dict:
    return {
        "id": product_id,
        "canonical_product_url": expected["canonical_product_url"],
        "canonical_url_hash": expected["canonical_url_hash"],
        "external_product_url": expected["external_product_url"],
        "product_image_url": expected["product_image_url"],
        "product_image_source": expected["product_image_source"],
        "product_page_verified_at": expected["product_page_verified_at"],
        "product_page_verification_method": expected["product_page_verification_method"],
        "product_name": expected["product_name"],
        "merchant": expected["merchant"],
        "domain": expected["domain"],
        "category": expected["category"],
        "product_type": expected["product_type"],
        "product_family": expected["product_family"],
        "discovery_method": expected["discovery_method"],
        "provenance": expected["provenance"],
        "free_preview_rank": None,
        "lifecycle_status": "active",
    }


def stored_evidence(expected: dict, product_id: str) -> list[dict]:
    evidence = [
        {
            "product_opportunity_id": product_id,
            "pinterest_pin_id": expected["pinterest_pin_id"],
            "pinterest_pin_url": expected["pinterest_pin_url"],
            "evidence_type": expected["evidence_type"],
            "relationship_method": expected["relationship_method"],
            "external_product_url": expected["external_product_url"],
            "canonical_url_hash": expected["canonical_url_hash"],
            "provenance": expected["provenance"],
            "evidence_status": "active",
            "is_primary": True,
        }
    ]
    evidence.extend(
        {
            "product_opportunity_id": product_id,
            "pinterest_pin_id": additional["pinterest_pin_id"],
            "pinterest_pin_url": additional["pinterest_pin_url"],
            "evidence_type": additional["evidence_type"],
            "relationship_method": additional["relationship_method"],
            "external_product_url": expected["external_product_url"],
            "canonical_url_hash": expected["canonical_url_hash"],
            "provenance": additional["provenance"],
            "evidence_status": "active",
            "is_primary": False,
        }
        for additional in expected.get("additional_evidence", [])
    )
    return evidence


def test_apply_target_must_match_direct_supabase_project_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_ref = "jaxteelkecvlozdrdoog"
    monkeypatch.setenv("SUPABASE_URL", f"https://{project_ref}.supabase.co")
    assert admission.require_expected_project_ref(project_ref) == project_ref

    with pytest.raises(RuntimeError, match="expected Supabase project ref"):
        admission.require_expected_project_ref(None)
    with pytest.raises(RuntimeError, match="does not match"):
        admission.require_expected_project_ref("snulmwprsahzqvdbyenc")

    monkeypatch.setenv("SUPABASE_URL", "https://db-proxy.example.com")
    with pytest.raises(RuntimeError, match="direct Supabase project URL"):
        admission.require_expected_project_ref(project_ref)


@pytest.mark.parametrize(
    "unsafe_url",
    [
        "http://jaxteelkecvlozdrdoog.supabase.co",
        "https://user@jaxteelkecvlozdrdoog.supabase.co",
        "https://jaxteelkecvlozdrdoog.supabase.co:444",
        "https://jaxteelkecvlozdrdoog.supabase.co/rest/v1",
        "https://jaxteelkecvlozdrdoog.supabase.co?target=other",
    ],
)
def test_apply_target_rejects_non_exact_https_project_origins(
    monkeypatch: pytest.MonkeyPatch,
    unsafe_url: str,
) -> None:
    monkeypatch.setenv("SUPABASE_URL", unsafe_url)
    with pytest.raises(RuntimeError, match="exact HTTPS project origin"):
        admission.require_expected_project_ref("jaxteelkecvlozdrdoog")


def test_manual_confirmation_binds_project_and_exact_manifest_bytes() -> None:
    project_ref = "jaxteelkecvlozdrdoog"
    first = hashlib.sha256(b"[{}]\n").hexdigest()
    second = hashlib.sha256(b"[{}]").hexdigest()
    assert first != second
    assert admission.manual_apply_confirmation(project_ref, first) == (
        f"ADMIT:{project_ref}:{first}"
    )
    assert admission.manual_apply_confirmation(project_ref, first) != (
        admission.manual_apply_confirmation(project_ref, second)
    )


def test_valid_candidate_keeps_null_name_and_computes_sha256_identity() -> None:
    row = admission.validate_candidate(candidate(), now=NOW)
    assert row["product_name"] is None
    assert row["canonical_url_hash"] == hashlib.sha256(
        row["canonical_product_url"].encode("utf-8")
    ).hexdigest()
    assert row["source_category"] == "fashion"


def test_source_category_is_required_as_independent_provenance() -> None:
    missing = candidate()
    missing["provenance"] = dict(missing["provenance"])
    missing["provenance"].pop("source_category")
    with pytest.raises(ValueError, match="source_category"):
        admission.validate_candidate(missing, now=NOW)

    mismatch = candidate()
    mismatch["provenance"] = {
        **mismatch["provenance"],
        "source_category": "digital-products",
    }
    with pytest.raises(ValueError, match="source_category"):
        admission.validate_candidate(mismatch, now=NOW)

    separate = candidate()
    separate["provenance"] = {
        **separate["provenance"],
        "source_category": "womens-fashion",
    }
    validated = admission.validate_candidate(separate, now=NOW)
    assert validated["category"] == "fashion"
    assert validated["source_category"] == "womens-fashion"


@pytest.mark.parametrize(
    ("field", "limit", "evidence_prefix"),
    [
        ("product_name", admission.MAX_PRODUCT_NAME_CHARS, "name:"),
        ("merchant", admission.MAX_MERCHANT_CHARS, "merchant:"),
        ("product_type", admission.MAX_PRODUCT_TYPE_CHARS, "product_type:"),
    ],
)
def test_overlong_optional_display_fields_are_rejected(
    field: str, limit: int, evidence_prefix: str
) -> None:
    value = "x" * (limit + 1)
    provenance = dict(candidate()["provenance"])
    provenance["merchant_field_evidence"] = [
        "merchant:og:site_name",
        f"{evidence_prefix}test",
    ]
    if field == "product_name":
        provenance.update(product_name_found_in_page=True, product_name_value=value)
    elif field == "merchant":
        provenance.update(merchant_found_in_page=True, merchant_value=value)
    else:
        provenance.update(
            product_type_found_in_merchant_page=True,
            product_type_value=value,
        )
    with pytest.raises(ValueError, match=rf"{field} exceeds {limit} characters"):
        admission.validate_candidate(
            candidate(**{field: value, "provenance": provenance}), now=NOW
        )


@pytest.mark.parametrize(
    ("field", "limit", "evidence_prefix"),
    [
        ("product_name", admission.MAX_PRODUCT_NAME_CHARS, "name:"),
        ("merchant", admission.MAX_MERCHANT_CHARS, "merchant:"),
        ("product_type", admission.MAX_PRODUCT_TYPE_CHARS, "product_type:"),
    ],
)
def test_optional_display_field_exact_limit_is_preserved(
    field: str, limit: int, evidence_prefix: str
) -> None:
    value = "x" * limit
    provenance = dict(candidate()["provenance"])
    provenance["merchant_field_evidence"] = [
        "merchant:og:site_name",
        f"{evidence_prefix}test",
    ]
    if field == "product_name":
        provenance.update(product_name_found_in_page=True, product_name_value=value)
    elif field == "merchant":
        provenance.update(merchant_found_in_page=True, merchant_value=value)
    else:
        provenance.update(
            product_type_found_in_merchant_page=True,
            product_type_value=value,
        )
    row = admission.validate_candidate(
        candidate(**{field: value, "provenance": provenance}), now=NOW
    )
    assert row[field] == value


@pytest.mark.parametrize(
    ("category", "family"),
    [
        ("fashion", "digital"),
        ("digital-products", "physical"),
        ("beauty", "physical"),
        (None, "physical"),
    ],
)
def test_category_must_be_reviewed_and_match_product_family(
    category: str | None, family: str
) -> None:
    with pytest.raises(ValueError, match="reviewed business category"):
        admission.validate_candidate(
            candidate(category=category, product_family=family), now=NOW
        )

    digital_candidate = candidate(category="digital-products", product_family="digital")
    digital_candidate["provenance"] = {
        **digital_candidate["provenance"],
        "source_category": "digital-products",
    }
    digital = admission.validate_candidate(digital_candidate, now=NOW)
    assert digital["category"] == "digital-products"


@pytest.mark.parametrize(
    ("category", "family", "source_category"),
    [
        ("wedding-celebrations", "physical", "wedding"),
        ("wedding-celebrations", "digital", "wedding"),
        ("gifts", "physical", "gifts"),
        ("gifts", "digital", "gifts"),
        ("jewelry-accessories", "physical", "fashion"),
        ("jewelry-accessories", "physical", "jewelry"),
    ],
)
def test_launch_business_category_is_independent_from_acquisition_bucket(
    category: str, family: str, source_category: str
) -> None:
    row = candidate(category=category, product_family=family)
    row["provenance"] = {**row["provenance"], "source_category": source_category}
    validated = admission.validate_candidate(row, now=NOW)
    assert validated["category"] == category
    assert validated["source_category"] == source_category


def test_jewelry_category_cannot_be_relabelled_as_digital() -> None:
    row = candidate(category="jewelry-accessories", product_family="digital")
    row["provenance"] = {**row["provenance"], "source_category": "wedding"}
    with pytest.raises(ValueError, match="reviewed business category"):
        admission.validate_candidate(row, now=NOW)


def test_equivalent_external_url_is_persisted_as_the_canonical_identity() -> None:
    row = candidate(external_product_url="https://shop.example/products/real-item/")
    validated = admission.validate_candidate(row, now=NOW)
    assert validated["external_product_url"] == validated["canonical_product_url"]
    assert validated["provenance"]["pin_direct_outbound_url"] == validated["external_product_url"]


def test_present_product_name_requires_exact_merchant_page_provenance() -> None:
    missing = candidate(product_name="Merchant-proven item")
    with pytest.raises(ValueError, match="field provenance"):
        admission.validate_candidate(missing, now=NOW)

    valid = candidate(product_name="Merchant-proven item")
    valid["provenance"] = {
        **valid["provenance"],
        "merchant_field_evidence": [
            "name:og:title", "image:og:image", "merchant:og:site_name"
        ],
        "product_name_found_in_page": True,
        "product_name_value": "Merchant-proven item",
    }
    assert admission.validate_candidate(valid, now=NOW)["product_name"] == "Merchant-proven item"

    mismatch = candidate(product_name="Injected Pin title")
    mismatch["provenance"] = {
        **valid["provenance"],
        "product_name_value": "Merchant-proven item",
    }
    with pytest.raises(ValueError, match="does not match"):
        admission.validate_candidate(mismatch, now=NOW)


def test_product_type_is_optional_but_requires_exact_merchant_provenance() -> None:
    without_type = admission.validate_candidate(candidate(), now=NOW)
    assert without_type["product_type"] is None

    proven = candidate(product_type="Jewelry")
    proven["provenance"] = {
        **proven["provenance"],
        "merchant_field_evidence": [
            "product_type:schema.org/Product.category", "merchant:og:site_name"
        ],
        "product_type_found_in_merchant_page": True,
        "product_type_value": "Jewelry",
    }
    assert admission.validate_candidate(proven, now=NOW)["product_type"] == "Jewelry"

    forged = candidate(product_type="Shoes")
    with pytest.raises(ValueError, match="product_type requires merchant-page field provenance"):
        admission.validate_candidate(forged, now=NOW)


def test_present_merchant_requires_exact_merchant_page_provenance() -> None:
    missing = candidate()
    missing["provenance"] = {
        key: value
        for key, value in missing["provenance"].items()
        if key not in {"merchant_field_evidence", "merchant_found_in_page", "merchant_value"}
    }
    with pytest.raises(ValueError, match="merchant requires merchant-page field provenance"):
        admission.validate_candidate(missing, now=NOW)

    mismatch = candidate()
    mismatch["provenance"] = {**mismatch["provenance"], "merchant_value": "Other Shop"}
    with pytest.raises(ValueError, match="merchant provenance value does not match"):
        admission.validate_candidate(mismatch, now=NOW)

    no_merchant = candidate(merchant=None)
    no_merchant["provenance"] = {
        key: value
        for key, value in no_merchant["provenance"].items()
        if key not in {"merchant_field_evidence", "merchant_found_in_page", "merchant_value"}
    }
    assert admission.validate_candidate(no_merchant, now=NOW)["merchant"] is None


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"product_image_url": "https://i.pinimg.com/item.jpg"}, "non-Pinterest"),
        ({"product_image_url": None}, "absolute HTTP"),
        ({"provenance": {"pdp_gate_passed": True}}, "product image"),
        ({"evidence_type": "source_pin", "relationship_method": "shop_the_look"}, "direct product link"),
        ({"pinterest_pin_url": "https://www.pinterest.com/pin/1234567890123456789/"}, "does not match"),
        ({"pinterest_pin_url": "https://i.pinimg.com/pin/123456789012345678/"}, "page host"),
        ({"pinterest_pin_url": "https://pinterest.com.evil.example/pin/123456789012345678/"}, "page host"),
        ({"pinterest_pin_url": "https://pinterest.evil/pin/123456789012345678/"}, "page host"),
        ({"product_image_url": "https://i.pinimg.co.uk/item.jpg"}, "non-Pinterest"),
        ({"product_page_verified_at": (NOW - timedelta(days=2)).isoformat()}, "24 hours"),
        ({"product_page_verified_at": (NOW + timedelta(minutes=6)).isoformat()}, "24 hours"),
    ],
)
def test_truth_gates_fail_closed(overrides: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        admission.validate_candidate(candidate(**overrides), now=NOW)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("canonical_product_url", "http://127.0.0.1/products/item"),
        ("external_product_url", "http://127.0.0.1/products/item"),
        ("product_image_url", "http://169.254.169.254/latest/meta-data"),
        ("product_image_url", "http://metadata.internal/image.jpg"),
        ("product_image_url", "https://user:password@cdn.example/image.jpg"),
    ],
)
def test_product_and_image_urls_reject_non_public_or_credentialed_hosts(
    field: str, value: str
) -> None:
    row = candidate()
    if field in {"canonical_product_url", "external_product_url"}:
        row["canonical_product_url"] = value
        row["external_product_url"] = value
    else:
        row[field] = value
    with pytest.raises(ValueError, match="public|credentials"):
        admission.validate_candidate(row, now=NOW)


def test_source_pin_requires_direct_outbound_provenance_for_same_identity() -> None:
    row = candidate()
    row["provenance"] = {**row["provenance"], "source_pin_direct_outbound_url": "https://shop.example/products/other"}
    with pytest.raises(ValueError, match="does not match Pin direct provenance"):
        admission.validate_candidate(row, now=NOW)


def redirected_candidate() -> dict:
    original = "https://old-shop.example/products/real-item"
    final = "https://shop.example/products/real-item"
    chain = [{"status": 301, "from": original, "to": final}]
    row = candidate()
    row["provenance"] = {
        **row["provenance"],
        "pin_direct_outbound_url": original,
        "pin_direct_outbound_resolved_url": final,
        "pin_direct_outbound_resolution_method": "bounded_http_redirect_chain",
        "pin_redirect_chain": chain,
        "pin_redirect_chain_sha256": hashlib.sha256(
            json.dumps(
                chain, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
        ).hexdigest(),
        "source_pin_direct_outbound_url": original,
        "source_pin_direct_outbound_resolved_url": final,
    }
    return row


def test_bounded_redirect_provenance_is_normalized_without_rewriting_direct_url() -> None:
    row = admission.validate_candidate(redirected_candidate(), now=NOW)
    assert row["provenance"]["pin_direct_outbound_url"].startswith("https://old-shop.example/")
    assert row["provenance"]["pin_direct_outbound_resolved_url"] == row["canonical_product_url"]
    assert row["provenance"]["source_pin_direct_outbound_resolved_url"] == row["canonical_product_url"]


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda p: p.update(pin_redirect_chain_sha256="0" * 64), "hash"),
        (lambda p: p.update(pin_direct_outbound_resolution_method="browser_guess"), "resolution method"),
        (lambda p: p["pin_redirect_chain"][0].update(status=200), "unapproved status"),
        (lambda p: p["pin_redirect_chain"][0].update(status=301.5), "invalid status"),
        (
            lambda p: p["pin_redirect_chain"][0].update(
                {"from": "https://other.example/products/item"}
            ),
            "continuous chain",
        ),
        (lambda p: p.update(source_pin_direct_outbound_resolved_url="https://other.example/products/item"), "does not resolve"),
    ],
)
def test_redirect_provenance_fails_closed_on_tampering(mutate, message: str) -> None:
    row = redirected_candidate()
    mutate(row["provenance"])
    with pytest.raises(ValueError, match=message):
        admission.validate_candidate(row, now=NOW)


def test_additional_evidence_is_independently_validated_and_normalized() -> None:
    row = candidate()
    row["additional_evidence"] = [
        {
            "pinterest_pin_id": "223456789012345678",
            "pinterest_pin_url": "https://www.pinterest.com/pin/223456789012345678/",
            "evidence_type": "product_pin",
            "relationship_method": "direct_outbound_link",
            "provenance": {
                "verified_by": "pinterest-refetch-v1",
                "pinterest_pin_id": "223456789012345678",
                "pin_direct_outbound_url": row["canonical_product_url"],
            },
        },
        {
            "pinterest_pin_id": "323456789012345678",
            "pinterest_pin_url": "https://www.pinterest.com/pin/323456789012345678/",
            "evidence_type": "source_pin",
            "relationship_method": "direct_outbound_link",
            "provenance": {
                "verified_by": "pinterest-refetch-v1",
                "pinterest_pin_id": "323456789012345678",
                "pin_direct_outbound_url": row["canonical_product_url"],
                "source_pin_id": "323456789012345678",
                "source_pin_direct_outbound_url": row["canonical_product_url"],
            },
        },
    ]

    validated = admission.validate_candidate(row, now=NOW)
    assert [item["evidence_type"] for item in validated["additional_evidence"]] == [
        "product_pin",
        "source_pin",
    ]
    assert all(
        item["provenance"]["pin_direct_outbound_url"] == row["canonical_product_url"]
        for item in validated["additional_evidence"]
    )


def test_additional_evidence_fails_closed_on_duplicates_indirect_source_and_cap() -> None:
    duplicate = candidate()
    duplicate["additional_evidence"] = [
        {
            "pinterest_pin_id": duplicate["pinterest_pin_id"],
            "pinterest_pin_url": duplicate["pinterest_pin_url"],
            "evidence_type": "product_pin",
            "relationship_method": "direct_outbound_link",
            "provenance": {
                "verified_by": "pinterest-refetch-v1",
                "pinterest_pin_id": duplicate["pinterest_pin_id"],
                "pin_direct_outbound_url": duplicate["canonical_product_url"],
            },
        }
    ]
    with pytest.raises(ValueError, match="duplicate Pinterest Pin"):
        admission.validate_candidate(duplicate, now=NOW)

    indirect = candidate()
    indirect["additional_evidence"] = [
        {
            "pinterest_pin_id": "423456789012345678",
            "pinterest_pin_url": "https://www.pinterest.com/pin/423456789012345678/",
            "evidence_type": "source_pin",
            "relationship_method": "shop_the_look",
            "provenance": {
                "verified_by": "pinterest-refetch-v1",
                "pinterest_pin_id": "423456789012345678",
                "pin_direct_outbound_url": indirect["canonical_product_url"],
                "source_pin_id": "423456789012345678",
                "source_pin_direct_outbound_url": indirect["canonical_product_url"],
            },
        }
    ]
    with pytest.raises(ValueError, match="direct product link"):
        admission.validate_candidate(indirect, now=NOW)

    over_cap = candidate()
    over_cap["additional_evidence"] = [{}] * (admission.MAX_ADDITIONAL_EVIDENCE + 1)
    with pytest.raises(ValueError, match="MAX_ADDITIONAL_EVIDENCE=19"):
        admission.validate_candidate(over_cap, now=NOW)

    row = candidate()
    row["provenance"] = {**row["provenance"], "source_pin_id": "999999999999"}
    with pytest.raises(ValueError, match="source_pin_id"):
        admission.validate_candidate(row, now=NOW)


def test_manifest_hard_cap_and_duplicate_identity() -> None:
    with pytest.raises(ValueError, match="MAX_BATCH=20"):
        admission.validate_manifest([candidate()] * 21, now=NOW)
    accepted, rejected = admission.validate_manifest([candidate(), candidate()], now=NOW)
    assert len(accepted) == 1
    assert rejected == [{"index": 1, "reason": "duplicate product identity within manifest"}]


def test_apply_refuses_empty_or_over_cap_before_any_db_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    touched: list[str] = []
    monkeypatch.setattr(db, "_get_http", lambda: touched.append("http"))
    monkeypatch.setattr(db, "DB", lambda: touched.append("db"))

    with pytest.raises(RuntimeError, match="non-empty"):
        admission.apply_candidates([])
    with pytest.raises(RuntimeError, match="MAX_BATCH=20"):
        admission.apply_candidates([{}] * 21)
    assert touched == []


def test_apply_refuses_current_identity_before_rpc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    rpc_calls: list[str] = []

    class FakeDB:
        def select_many(self, table: str, **kwargs):
            assert table == "product_opportunities"
            assert expected["canonical_url_hash"] in kwargs["filters"]["canonical_url_hash"]
            return [{
                "id": "00000000-0000-0000-0000-000000000001",
                "canonical_url_hash": expected["canonical_url_hash"],
                "lifecycle_status": "active",
            }]

    monkeypatch.setattr(db, "DB", FakeDB)
    monkeypatch.setattr(db, "_get_http", lambda: rpc_calls.append("rpc"))
    with pytest.raises(RuntimeError, match="current Product identity"):
        admission.apply_candidates([expected])
    assert rpc_calls == []


def test_receipt_recovery_requires_the_active_state_accepted_by_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"

    class FakeDB:
        def select_many(self, _table: str, **_kwargs):
            return [{
                "id": product_id,
                "canonical_url_hash": expected["canonical_url_hash"],
                "lifecycle_status": "active",
            }]

    monkeypatch.setattr(db, "DB", FakeDB)
    assert admission.recover_candidate_ids([expected]) == [product_id]


@pytest.mark.parametrize(
    "receipt",
    [
        [],
        [{}],
        [{"product_opportunity_id": "not-a-uuid"}],
    ],
)
def test_invalid_http_200_receipt_recovers_and_rolls_back_exact_batch(
    monkeypatch: pytest.MonkeyPatch,
    receipt: list[dict],
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"
    calls: list[tuple[str, object]] = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return receipt

    class Http:
        def post(self, path: str, json: dict):
            calls.append(("post", path))
            assert json == {"p_candidates": [expected]}
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    monkeypatch.setattr(admission, "assert_no_current_identity_conflicts", lambda _rows: None)
    monkeypatch.setattr(
        admission,
        "recover_candidate_ids",
        lambda rows: calls.append(("recover", rows)) or [product_id],
    )
    monkeypatch.setattr(
        admission,
        "verify_candidates",
        lambda ids, rows: calls.append(("verify", (ids, rows))) or 1,
    )
    monkeypatch.setattr(
        admission,
        "rollback_candidates",
        lambda ids, reason: calls.append(("rollback", (ids, reason))) or 1,
    )
    monkeypatch.setattr(
        admission,
        "verify_rollback",
        lambda ids, rows: calls.append(("verify_rollback", (ids, rows))) or 1,
    )

    with pytest.raises(RuntimeError, match="history-preserving rollback retired 1"):
        admission.apply_candidates([expected])
    assert [name for name, _value in calls] == [
        "post",
        "recover",
        "verify",
        "rollback",
        "verify_rollback",
    ]


def test_valid_receipt_must_match_committed_canonical_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return [{"product_opportunity_id": product_id}]

    class Http:
        def post(self, path: str, json: dict):
            assert path == "rpc/admit_product_opportunity_batch"
            assert json == {"p_candidates": [expected]}
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    monkeypatch.setattr(admission, "assert_no_current_identity_conflicts", lambda _rows: None)
    monkeypatch.setattr(admission, "recover_candidate_ids", lambda _rows: [product_id])
    assert admission.apply_candidates([expected]) == [product_id]


def test_invalid_receipt_still_rolls_back_when_recovered_readback_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"
    rollback_calls: list[tuple[list[str], str]] = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return []

    class Http:
        def post(self, _path: str, json: dict):
            assert json == {"p_candidates": [expected]}
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    monkeypatch.setattr(admission, "assert_no_current_identity_conflicts", lambda _rows: None)
    monkeypatch.setattr(admission, "recover_candidate_ids", lambda _rows: [product_id])
    monkeypatch.setattr(
        admission,
        "verify_candidates",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("readback mismatch")),
    )
    monkeypatch.setattr(
        admission,
        "rollback_candidates",
        lambda ids, reason: rollback_calls.append((ids, reason)) or 1,
    )
    monkeypatch.setattr(admission, "verify_rollback", lambda _ids, _rows: 1)

    with pytest.raises(RuntimeError, match="recovered readback also failed: readback mismatch"):
        admission.apply_candidates([expected])
    assert rollback_calls == [([product_id], "invalid_admission_receipt")]


def test_wrong_but_valid_receipt_id_rolls_back_only_recovered_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    recovered_id = "00000000-0000-0000-0000-000000000001"
    unrelated_receipt_id = "00000000-0000-0000-0000-000000000002"
    rollback_calls: list[list[str]] = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return [{"product_opportunity_id": unrelated_receipt_id}]

    class Http:
        def post(self, _path: str, json: dict):
            assert json == {"p_candidates": [expected]}
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    monkeypatch.setattr(admission, "assert_no_current_identity_conflicts", lambda _rows: None)
    monkeypatch.setattr(admission, "recover_candidate_ids", lambda _rows: [recovered_id])
    monkeypatch.setattr(admission, "verify_candidates", lambda _ids, _rows: 1)
    monkeypatch.setattr(
        admission,
        "rollback_candidates",
        lambda ids, _reason: rollback_calls.append(ids) or 1,
    )
    monkeypatch.setattr(admission, "verify_rollback", lambda _ids, _rows: 1)

    with pytest.raises(RuntimeError, match="history-preserving rollback retired 1"):
        admission.apply_candidates([expected])
    assert rollback_calls == [[recovered_id]]
    assert unrelated_receipt_id not in rollback_calls[0]


def test_invalid_receipt_reports_unproven_rollback_without_claiming_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return []

    class Http:
        def post(self, _path: str, **_kwargs):
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    monkeypatch.setattr(admission, "assert_no_current_identity_conflicts", lambda _rows: None)
    monkeypatch.setattr(admission, "recover_candidate_ids", lambda _rows: [product_id])
    monkeypatch.setattr(admission, "verify_candidates", lambda _ids, _rows: 1)
    monkeypatch.setattr(
        admission,
        "rollback_candidates",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("rollback RPC failed")),
    )

    with pytest.raises(RuntimeError, match="exact rollback was not proven"):
        admission.apply_candidates([expected])


def test_post_write_readback_checks_product_and_primary_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    raw = candidate()
    raw["additional_evidence"] = [{
        "pinterest_pin_id": "223456789012345678",
        "pinterest_pin_url": "https://www.pinterest.com/pin/223456789012345678/",
        "evidence_type": "product_pin",
        "relationship_method": "direct_outbound_link",
        "provenance": {
            "verified_by": "pinterest-refetch-v1",
            "pinterest_pin_id": "223456789012345678",
            "pin_direct_outbound_url": raw["canonical_product_url"],
        },
    }]
    expected = admission.validate_candidate(raw, now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"
    product = stored_product(expected, product_id)

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            if table == "product_opportunities":
                return [product]
            if table == "product_opportunity_evidence":
                return stored_evidence(expected, product_id)
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    assert admission.verify_candidates([product_id], [expected]) == 1

    expected["product_image_url"] = "https://shop.example/images/other.jpg"
    with pytest.raises(RuntimeError, match="product_image_url"):
        admission.verify_candidates([product_id], [expected])


@pytest.mark.parametrize(
    ("target", "field", "bad_value", "message"),
    [
        ("product", "canonical_product_url", "https://other.example/p/1", "canonical_product_url"),
        ("product", "product_image_source", "pin_card", "product_image_source"),
        ("product", "product_page_verification_method", "unknown", "verification_method"),
        ("product", "merchant", "Other Shop", "merchant"),
        ("product", "domain", "other.example", "domain"),
        ("product", "category", "home-decor", "category"),
        ("product", "discovery_method", "pin_card", "discovery_method"),
        ("product", "provenance", {}, "provenance"),
        ("product", "free_preview_rank", 1, "Free preview rank"),
        ("evidence", "external_product_url", "https://other.example/p/1", "external_product_url"),
    ],
)
def test_post_write_readback_rejects_truth_field_drift(
    monkeypatch: pytest.MonkeyPatch,
    target: str,
    field: str,
    bad_value: object,
    message: str,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"
    product = stored_product(expected, product_id)
    evidence = stored_evidence(expected, product_id)
    if target == "product":
        product[field] = bad_value
    else:
        evidence[0][field] = bad_value

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            if table == "product_opportunities":
                return [product]
            if table == "product_opportunity_evidence":
                return evidence
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    with pytest.raises(RuntimeError, match=message):
        admission.verify_candidates([product_id], [expected])


def test_post_write_readback_rejects_naive_merchant_timestamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    expected = admission.validate_candidate(candidate(), now=NOW)
    product_id = "00000000-0000-0000-0000-000000000001"
    product = stored_product(expected, product_id)
    product["product_page_verified_at"] = "2026-08-25T12:00:00"

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            return [product] if table == "product_opportunities" else stored_evidence(expected, product_id)

    monkeypatch.setattr(db, "DB", FakeDB)
    with pytest.raises(RuntimeError, match="invalid merchant verification timestamp"):
        admission.verify_candidates([product_id], [expected])


def test_rollback_requires_an_exact_receipt(monkeypatch: pytest.MonkeyPatch) -> None:
    import db

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return [{"retired_count": 1}]

    class Http:
        def post(self, path: str, json: dict):
            assert path == "rpc/rollback_product_opportunity_admission_batch"
            assert json["p_ids"] == ["00000000-0000-0000-0000-000000000001"]
            assert json["p_reason"].startswith("post_write_verification")
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    assert admission.rollback_candidates(
        ["00000000-0000-0000-0000-000000000001"],
        "post_write_verification:RuntimeError",
    ) == 1


def test_rollback_readback_requires_retired_product_and_non_active_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            if table == "product_opportunities":
                return [{
                    "id": "00000000-0000-0000-0000-000000000001",
                    "lifecycle_status": "retired",
                    "lifecycle_reason": "admission_rollback:verification",
                    "retired_at": NOW.isoformat(),
                }]
            if table == "product_opportunity_evidence":
                return [{
                    "product_opportunity_id": "00000000-0000-0000-0000-000000000001",
                    "evidence_status": "retired",
                    "is_primary": False,
                }]
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    assert admission.verify_rollback(
        ["00000000-0000-0000-0000-000000000001"]
    ) == 1


def test_rollback_readback_requires_exact_expected_evidence_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    raw = candidate()
    raw["additional_evidence"] = [{
        "pinterest_pin_id": "223456789012345678",
        "pinterest_pin_url": "https://www.pinterest.com/pin/223456789012345678/",
        "evidence_type": "product_pin",
        "relationship_method": "direct_outbound_link",
        "provenance": {
            "verified_by": "pinterest-refetch-v1",
            "pinterest_pin_id": "223456789012345678",
            "pin_direct_outbound_url": raw["canonical_product_url"],
        },
    }]
    expected = admission.validate_candidate(raw, now=NOW)

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            if table == "product_opportunities":
                return [{
                    "id": "00000000-0000-0000-0000-000000000001",
                    "lifecycle_status": "retired",
                    "lifecycle_reason": "admission_rollback:verification",
                    "retired_at": NOW.isoformat(),
                }]
            if table == "product_opportunity_evidence":
                return [{
                    "product_opportunity_id": "00000000-0000-0000-0000-000000000001",
                    "evidence_status": "retired",
                    "is_primary": False,
                }]
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    with pytest.raises(RuntimeError, match="Evidence count mismatch"):
        admission.verify_rollback(
            ["00000000-0000-0000-0000-000000000001"], [expected]
        )


def test_main_automatically_rolls_back_a_failed_post_write_verification(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(candidate(product_page_verified_at=datetime.now(timezone.utc).isoformat())),
        encoding="utf-8",
    )
    # The manifest root must be an array.
    manifest.write_text(f"[{manifest.read_text(encoding='utf-8')}]", encoding="utf-8")
    product_id = "00000000-0000-0000-0000-000000000001"
    rolled_back: list[list[str]] = []
    monkeypatch.setattr(admission, "apply_candidates", lambda _rows: [product_id])
    monkeypatch.setattr(
        admission,
        "verify_candidates",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("mismatch")),
    )
    monkeypatch.setattr(
        admission,
        "rollback_candidates",
        lambda ids, _reason: rolled_back.append(ids) or len(ids),
    )
    monkeypatch.setattr(admission, "verify_rollback", lambda ids, _rows: len(ids))
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    project_ref = "jaxteelkecvlozdrdoog"
    monkeypatch.setenv("SUPABASE_URL", f"https://{project_ref}.supabase.co")
    manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()
    monkeypatch.setattr(sys, "argv", [
        "product_opportunity_admission.py",
        "--manifest",
        str(manifest),
        "--apply",
        "--expected-project-ref",
        project_ref,
        "--confirm",
        admission.manual_apply_confirmation(project_ref, manifest_sha256),
    ])

    assert admission.main() == 1
    assert rolled_back == [[product_id]]
    assert "history-preserving rollback retired 1 rows" in capsys.readouterr().err


def test_main_wrong_manifest_confirmation_fails_before_apply(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps([candidate(product_page_verified_at=datetime.now(timezone.utc).isoformat())]),
        encoding="utf-8",
    )
    project_ref = "jaxteelkecvlozdrdoog"
    monkeypatch.setenv("SUPABASE_URL", f"https://{project_ref}.supabase.co")
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    monkeypatch.setattr(
        admission,
        "apply_candidates",
        lambda _rows: pytest.fail("wrong confirmation must fail before apply"),
    )
    monkeypatch.setattr(sys, "argv", [
        "product_opportunity_admission.py",
        "--manifest",
        str(manifest),
        "--apply",
        "--expected-project-ref",
        project_ref,
        "--confirm",
        f"ADMIT:{project_ref}:{'0' * 64}",
    ])

    assert admission.main() == 1
    assert "does not bind the expected project and manifest SHA-256" in capsys.readouterr().err
