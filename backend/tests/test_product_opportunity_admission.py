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
    stored_product = {
        "id": product_id,
        "canonical_url_hash": expected["canonical_url_hash"],
        "external_product_url": expected["external_product_url"],
        "product_image_url": expected["product_image_url"],
        "product_type": expected["product_type"],
        "product_family": expected["product_family"],
        "lifecycle_status": "active",
    }

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            if table == "product_opportunities":
                return [stored_product]
            if table == "product_opportunity_evidence":
                additional = expected["additional_evidence"][0]
                return [
                    {
                        "product_opportunity_id": product_id,
                        "pinterest_pin_id": expected["pinterest_pin_id"],
                        "pinterest_pin_url": expected["pinterest_pin_url"],
                        "evidence_type": expected["evidence_type"],
                        "relationship_method": expected["relationship_method"],
                        "canonical_url_hash": expected["canonical_url_hash"],
                        "provenance": expected["provenance"],
                        "evidence_status": "active",
                        "is_primary": True,
                    },
                    {
                        "product_opportunity_id": product_id,
                        "pinterest_pin_id": additional["pinterest_pin_id"],
                        "pinterest_pin_url": additional["pinterest_pin_url"],
                        "evidence_type": additional["evidence_type"],
                        "relationship_method": additional["relationship_method"],
                        "canonical_url_hash": expected["canonical_url_hash"],
                        "provenance": additional["provenance"],
                        "evidence_status": "active",
                        "is_primary": False,
                    },
                ]
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    assert admission.verify_candidates([product_id], [expected]) == 1

    expected["product_image_url"] = "https://shop.example/images/other.jpg"
    with pytest.raises(RuntimeError, match="product_image_url"):
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
            assert json["p_ids"] == ["product-1"]
            assert json["p_reason"].startswith("post_write_verification")
            return Response()

    monkeypatch.setattr(db, "_get_http", lambda: Http())
    assert admission.rollback_candidates(
        ["product-1"], "post_write_verification:RuntimeError"
    ) == 1


def test_rollback_readback_requires_retired_product_and_non_active_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import db

    class FakeDB:
        def select_many(self, table: str, **_kwargs):
            if table == "product_opportunities":
                return [{
                    "id": "product-1",
                    "lifecycle_status": "retired",
                    "lifecycle_reason": "admission_rollback:verification",
                    "retired_at": NOW.isoformat(),
                }]
            if table == "product_opportunity_evidence":
                return [{
                    "product_opportunity_id": "product-1",
                    "evidence_status": "retired",
                    "is_primary": False,
                }]
            raise AssertionError(table)

    monkeypatch.setattr(db, "DB", FakeDB)
    assert admission.verify_rollback(["product-1"]) == 1


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
    monkeypatch.setattr(admission, "verify_rollback", lambda ids: len(ids))
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_MODE", "production")
    monkeypatch.setenv("VIBEPIN_PRODUCT_ADMISSION_CONFIRM", admission.APPLY_CONFIRM)
    monkeypatch.setattr(sys, "argv", ["product_opportunity_admission.py", "--manifest", str(manifest), "--apply"])

    assert admission.main() == 1
    assert rolled_back == [[product_id]]
    assert "history-preserving rollback retired 1 rows" in capsys.readouterr().err
