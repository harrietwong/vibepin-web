from datetime import date, timedelta

from scripts.audit_product_opportunity_v37 import product_gate_reasons, summarize


def product(**overrides: object) -> dict:
    row = {
        "id": "row-1",
        "source_url": "https://shop.example/products/real-item",
        "canonical_product_url": "https://shop.example/products/real-item",
        "normalized_product_url_hash": "hash-1",
        "image_url": "https://cdn.shop.example/item.jpg",
        "product_name": None,
        "product_type": "physical",
        "parent_pin_id": "123456789012345678",
        "product_pin_id": None,
        "lifecycle_status": None,
    }
    row.update(overrides)
    return row


def test_name_is_not_an_eligibility_gate() -> None:
    assert product_gate_reasons(product(product_name=None)) == []


def test_pinterest_image_and_missing_product_page_are_rejected() -> None:
    reasons = product_gate_reasons(
        product(
            source_url="https://www.pinterest.com/pin/123/",
            canonical_product_url="https://www.pinterest.com/pin/123/",
            image_url="https://i.pinimg.com/a.jpg",
        )
    )
    assert "no_real_product_url" in reasons
    assert "pinterest_hosted_image" in reasons


def test_ordinary_source_pin_is_accepted_as_evidence() -> None:
    assert product_gate_reasons(product(product_pin_id=None)) == []


def test_summary_deduplicates_stable_product_identity_and_measures_full_coverage() -> None:
    products = [
        product(),
        product(id="row-2", parent_pin_id="223456789012345678"),
        product(
            id="digital-1",
            normalized_product_url_hash="hash-2",
            source_url="https://digital.example/template/1",
            canonical_product_url="https://digital.example/template/1",
            image_url="https://digital.example/template.jpg",
            product_type="digital",
            parent_pin_id="323456789012345678",
            product_name="Template",
        ),
    ]
    today = date(2026, 8, 25)
    snapshots = [
        {
            "pin_id": "123456789012345678",
            "captured_on": (today - timedelta(days=days)).isoformat(),
            "save_count": 100 + (30 - days),
        }
        for days in range(30, -1, -1)
    ]
    result = summarize(products, snapshots, today=today)

    assert result["migration_gate_pass_rows"] == 3
    assert result["migration_gate_pass_unique_products"] == 2
    assert result["duplicate_eligible_rows"] == 1
    assert result["eligible_primary_evidence_kind"] == {"source_pin": 3}
    assert result["eligible_snapshot_coverage"]["full_metric"] == 1
    assert result["eligible_snapshot_coverage_by_family"]["digital"] == {
        "today": 0,
        "anchor_7": 0,
        "anchor_14": 0,
        "anchor_30": 0,
        "full_metric": 0,
        "counter_regression": 0,
    }


def test_zero_coverage_is_explicit_not_omitted() -> None:
    result = summarize(
        [product(product_type="physical")],
        [],
        today=date(2026, 8, 26),
    )

    assert result["eligible_snapshot_coverage"] == {
        "today": 0,
        "anchor_7": 0,
        "anchor_14": 0,
        "anchor_30": 0,
        "full_metric": 0,
        "counter_regression": 0,
    }
    assert result["observation_day_distribution"] == {
        "0": 1,
        "1-9": 0,
        "10-19": 0,
        "20-29": 0,
        "30+": 0,
    }
    assert result["maximum_gap_distribution"] == {
        "0-1": 1,
        "2-3": 0,
        "4-7": 0,
        "8+": 0,
    }


def test_automatic_admission_scope_is_not_inflated_by_unreviewed_categories() -> None:
    products = [
        product(id="home", source_category="home-decor", product_type="physical"),
        product(
            id="digital",
            normalized_product_url_hash="hash-digital",
            parent_pin_id="223456789012345678",
            source_category="digital-products",
            product_type="digital",
        ),
        product(
            id="beauty",
            normalized_product_url_hash="hash-beauty",
            parent_pin_id="323456789012345678",
            source_category="beauty",
            product_type="physical",
        ),
        product(
            id="mismatch",
            normalized_product_url_hash="hash-mismatch",
            parent_pin_id="423456789012345678",
            source_category="digital-products",
            product_type="physical",
        ),
        product(
            id="wedding-physical",
            normalized_product_url_hash="hash-wedding-physical",
            parent_pin_id="523456789012345678",
            source_category="wedding",
            product_type="physical",
        ),
        product(
            id="wedding-digital",
            normalized_product_url_hash="hash-wedding-digital",
            parent_pin_id="623456789012345678",
            source_category="wedding",
            product_type="digital",
        ),
    ]

    result = summarize(products, [], today=date(2026, 8, 27))

    assert result["migration_gate_pass_rows"] == 6
    assert result["automatic_admission_scope_rows"] == 4
    assert result["automatic_admission_scope_unique_products"] == 4
    assert result["automatic_admission_scope_by_family"] == {"physical": 2, "digital": 2}
    assert result["automatic_admission_scope_by_category"] == {
        "home-decor": 1,
        "digital-products": 1,
        "wedding": 2,
    }
    assert result["automatic_admission_scope_exclusions"] == {
        "source_category_not_reviewed": 1,
        "category_family_mismatch": 1,
    }
    assert result["migration_gate_by_source_category_family"] == {
        "beauty": {"physical": 1},
        "digital-products": {"digital": 1, "physical": 1},
        "home-decor": {"physical": 1},
        "wedding": {"digital": 1, "physical": 1},
    }
    assert result["automatic_admission_scope_exclusions_by_category"] == {
        "category_family_mismatch": {"digital-products": 1},
        "source_category_not_reviewed": {"beauty": 1},
    }
    assert result["automatic_admission_scope_snapshot_coverage"] == {
        "today": 0,
        "anchor_7": 0,
        "anchor_14": 0,
        "anchor_30": 0,
        "full_metric": 0,
        "counter_regression": 0,
    }
