import hashlib
import asyncio
from datetime import datetime, timezone

import pytest

import product_opportunity_manifest as bridge
from scraper_v2 import extract_direct_outbound_link, extract_outbound_link


NOW = datetime(2026, 8, 25, 12, tzinfo=timezone.utc)
PIN_ID = "123456789012345678"
PDP = "https://shop.example/products/real-item"


def legacy(**overrides: object) -> dict:
    row = {
        "id": "legacy-1",
        "canonical_product_url": PDP,
        "parent_pin_id": PIN_ID,
        "product_pin_id": None,
        "product_type": "physical",
        "source_category": "fashion",
        "discovery_method": "outbound_link",
        "lifecycle_status": "active",
    }
    row.update(overrides)
    return row


def merchant(
    html: str,
    *,
    status: int = 200,
    url: str = PDP,
    redirect_chain: tuple[dict, ...] = (),
) -> bridge.MerchantResponse:
    return bridge.MerchantResponse(status, html.encode(), url, redirect_chain=redirect_chain)


async def run_one(row: dict, pin: dict | None, response: bridge.MerchantResponse):
    calls = {"pin": 0, "merchant": 0}

    async def fetch_pin(_pin_id: str):
        calls["pin"] += 1
        return pin

    async def fetch_merchant(_url: str):
        calls["merchant"] += 1
        return response

    result = await bridge.build_manifest(
        [row], fetch_pin=fetch_pin, fetch_merchant=fetch_merchant, now=NOW
    )
    return result, calls


def test_direct_extractor_never_turns_a_domain_hint_into_evidence() -> None:
    pin = {"domain": "shop.example"}
    assert extract_direct_outbound_link(pin) is None
    assert extract_outbound_link(pin) == "https://shop.example"
    assert extract_direct_outbound_link({"link": "https://www.pinterest.co.uk/pin/123/"}) is None
    assert extract_direct_outbound_link({"link": "https://i.pinimg.com/item.jpg"}) is None
    assert extract_direct_outbound_link({"link": "https://pinterest.com:443/products/fake"}) is None


def test_direct_source_pin_and_merchant_image_build_valid_null_name_manifest() -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    (manifest, rejected), calls = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert rejected == []
    assert calls == {"pin": 1, "merchant": 1}
    assert len(manifest) == 1
    row = manifest[0]
    assert row["product_name"] is None
    assert row["evidence_type"] == "source_pin"
    assert row["relationship_method"] == "direct_outbound_link"
    assert row["product_image_source"] == "merchant_open_graph"
    assert row["source_category"] == "fashion"
    assert row["provenance"]["source_category"] == "fashion"
    assert row["provenance"]["merchant_page_sha256"] == hashlib.sha256(html.encode()).hexdigest()


def test_overlong_optional_labels_are_omitted_without_losing_valid_product() -> None:
    long_name = "N" * (bridge.MAX_PRODUCT_NAME_CHARS + 1)
    long_merchant = "M" * (bridge.MAX_MERCHANT_CHARS + 1)
    long_type = "T" * (bridge.MAX_PRODUCT_TYPE_CHARS + 1)
    html = (
        '<meta property="og:image" content="https://shop.example/images/item.jpg">'
        f'<meta property="og:title" content="{long_name}">'
        f'<meta property="og:site_name" content="{long_merchant}">'
        '<script type="application/ld+json">'
        f'{{"@type":"Product","category":"{long_type}"}}'
        '</script>'
    )
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert rejected == []
    assert len(manifest) == 1
    assert manifest[0]["product_name"] is None
    assert manifest[0]["merchant"] is None
    assert manifest[0]["product_type"] is None
    assert "product_name_value" not in manifest[0]["provenance"]
    assert "merchant_value" not in manifest[0]["provenance"]
    assert "product_type_value" not in manifest[0]["provenance"]


@pytest.mark.parametrize(
    "image_url",
    [
        "http://127.0.0.1/private.jpg",
        "http://169.254.169.254/latest/meta-data",
        "http://asset.internal/private.jpg",
    ],
)
def test_merchant_page_cannot_turn_a_non_public_image_into_product_evidence(
    image_url: str,
) -> None:
    html = f'<meta property="og:image" content="{image_url}">'
    (manifest, rejected), calls = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert manifest == []
    assert "public" in rejected[0]["reason"]
    assert calls == {"pin": 1, "merchant": 1}


def test_reviewed_source_category_supplies_missing_broad_product_family() -> None:
    physical = bridge._legacy_hint(legacy(product_type=None, source_category="fashion"))
    digital = bridge._legacy_hint(legacy(product_type=None, source_category="digital-products"))
    assert physical["family"] == "physical"
    assert digital["family"] == "digital"


def test_source_category_family_mapping_rejects_conflict_or_unknown_bucket() -> None:
    with pytest.raises(ValueError, match="conflicts"):
        bridge._legacy_hint(legacy(product_type="physical", source_category="digital-products"))
    with pytest.raises(ValueError, match="unreviewed source category"):
        bridge._legacy_hint(legacy(product_type=None, source_category="beauty"))


def test_mixed_wedding_source_requires_declared_family_and_keeps_source_provenance() -> None:
    physical = bridge._legacy_hint(legacy(product_type="physical", source_category="wedding"))
    digital = bridge._legacy_hint(legacy(product_type="digital", source_category="wedding"))
    assert physical["family"] == "physical"
    assert digital["family"] == "digital"
    assert physical["category"] == digital["category"] == "wedding-celebrations"
    assert physical["source_category"] == digital["source_category"] == "wedding"
    with pytest.raises(ValueError, match="no physical/digital family"):
        bridge._legacy_hint(legacy(product_type=None, source_category="wedding"))


def test_womens_fashion_is_source_provenance_not_a_second_business_category() -> None:
    hint = bridge._legacy_hint(legacy(source_category="womens-fashion"))
    assert hint["source_category"] == "womens-fashion"
    assert hint["category"] == "fashion"


def test_jewelry_source_bucket_maps_to_jewelry_business_category() -> None:
    hint = bridge._legacy_hint(legacy(source_category="jewelry", product_type="physical"))
    assert hint["source_category"] == "jewelry"
    assert hint["category"] == "jewelry-accessories"


def test_html_entity_unicode_and_whitespace_normalization_proves_merchant_name() -> None:
    html = (
        '<meta property="og:title" content="Polo &amp; Shirt   –  Example Shop">'
        '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    )
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert rejected == []
    assert manifest[0]["product_name"] == "Polo & Shirt"
    assert manifest[0]["provenance"]["product_name_found_in_page"] is True
    assert manifest[0]["provenance"]["product_name_value"] == "Polo & Shirt"
    assert manifest[0]["provenance"]["product_name_normalization"] == bridge.NAME_PROOF_NORMALIZATION


def test_jsonld_product_category_becomes_proven_optional_product_type() -> None:
    html = """
    <script type="application/ld+json">
    {"@type":"Product","category":"Apparel &amp; Accessories > Jewelry",
     "image":"https://shop.example/images/item.jpg"}
    </script>
    """
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert rejected == []
    row = manifest[0]
    assert row["product_type"] == "Apparel & Accessories > Jewelry"
    assert row["provenance"]["product_type_found_in_merchant_page"] is True
    assert row["provenance"]["product_type_value"] == row["product_type"]
    assert "product_type:schema.org/Product.category" in row["provenance"]["merchant_field_evidence"]
    assert row["category"] == "jewelry-accessories"
    assert row["source_category"] == "fashion"


def test_merchant_name_is_kept_only_with_page_provenance() -> None:
    html = (
        '<meta property="og:site_name" content="Example Shop">'
        '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    )
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert rejected == []
    row = manifest[0]
    assert row["merchant"] == "Example Shop"
    assert row["provenance"]["merchant_found_in_page"] is True
    assert row["provenance"]["merchant_value"] == "Example Shop"
    assert "merchant:og:site_name" in row["provenance"]["merchant_field_evidence"]


def test_unproved_extracted_name_is_dropped_without_rejecting_real_product(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    monkeypatch.setattr(
        bridge,
        "extract_details",
        lambda *_args: {
            "product_name": "Pin-derived injected title",
            "image_url": "https://shop.example/images/item.jpg",
            "merchant": None,
            "evidence": ["name:og:title", "image:og:image"],
        },
    )
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, merchant(html))
    )
    assert rejected == []
    assert manifest[0]["product_name"] is None
    assert "product_name_found_in_page" not in manifest[0]["provenance"]


def test_product_pin_remains_distinct_from_source_pin_evidence() -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    (manifest, rejected), _ = asyncio.run(
        run_one(
            legacy(product_pin_id=PIN_ID, parent_pin_id="999999999999999999"),
            {"id": PIN_ID, "product_url": PDP},
            merchant(html),
        )
    )
    assert rejected == []
    assert manifest[0]["evidence_type"] == "product_pin"


def test_same_product_identity_groups_independently_refetched_verified_pins() -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    rows = [
        legacy(id="source", parent_pin_id=PIN_ID),
        legacy(id="source-2", parent_pin_id="223456789012345678"),
    ]
    calls = {"pin": 0, "merchant": 0}

    async def fetch_pin(pin_id: str):
        calls["pin"] += 1
        return {"id": pin_id, "link": PDP}

    async def fetch_merchant(_url: str):
        calls["merchant"] += 1
        return merchant(html)

    manifest, rejected = asyncio.run(
        bridge.build_manifest(rows, fetch_pin=fetch_pin, fetch_merchant=fetch_merchant, now=NOW)
    )

    assert rejected == []
    assert calls == {"pin": 2, "merchant": 2}
    assert len(manifest) == 1
    assert manifest[0]["pinterest_pin_id"] == PIN_ID
    assert [item["pinterest_pin_id"] for item in manifest[0]["additional_evidence"]] == [
        "223456789012345678"
    ]


def test_bounded_merchant_domain_redirect_preserves_direct_pin_proof() -> None:
    final = "https://new-shop.example/products/real-item"
    html = '<meta property="og:image" content="https://new-shop.example/images/item.jpg">'
    chain = ({"status": 301, "from": PDP, "to": final},)
    (manifest, rejected), calls = asyncio.run(
        run_one(
            legacy(),
            {"id": PIN_ID, "link": PDP},
            merchant(html, url=final, redirect_chain=chain),
        )
    )

    assert rejected == []
    assert calls == {"pin": 1, "merchant": 1}
    row = manifest[0]
    assert row["canonical_product_url"] == final
    assert row["external_product_url"] == final
    assert row["provenance"]["pin_direct_outbound_url"] == PDP
    assert row["provenance"]["pin_direct_outbound_resolved_url"] == final
    assert row["provenance"]["source_pin_direct_outbound_url"] == PDP
    assert row["provenance"]["source_pin_direct_outbound_resolved_url"] == final
    assert row["provenance"]["pin_redirect_chain"] == list(chain)
    assert row["provenance"]["pin_redirect_chain_sha256"] == hashlib.sha256(
        b'[{"from":"https://shop.example/products/real-item","status":301,"to":"https://new-shop.example/products/real-item"}]'
    ).hexdigest()


def test_vitalismo_domain_migration_anchor_remains_admissible_without_guessing() -> None:
    old = (
        "https://vitalismoartificialplants.com/products/"
        "5-6-7-8ftartistic-artificial-olive-treewith-cream-planter"
        "?utm_source=pinterest"
    )
    direct = bridge.normalize_product_url(old)
    final = (
        "https://vitalismo.com/products/"
        "5-6-7-8ftartistic-artificial-olive-treewith-cream-planter"
    )
    image = "https://vitalismo.com/cdn/shop/files/8_olive_tree.jpg"
    html = f'<meta property="og:image" content="{image}">'
    (manifest, rejected), _ = asyncio.run(
        run_one(
            legacy(canonical_product_url=old),
            {"id": PIN_ID, "link": old},
            merchant(
                html,
                url=final,
                redirect_chain=({"status": 301, "from": direct, "to": final},),
            ),
        )
    )
    assert rejected == []
    assert manifest[0]["canonical_product_url"] == final
    assert manifest[0]["product_image_url"] == image
    assert manifest[0]["product_name"] is None
    assert manifest[0]["provenance"]["pin_direct_outbound_url"] == direct


@pytest.mark.parametrize(
    ("chain", "reason"),
    [
        ((), "complete bounded redirect proof"),
        (({"status": 200, "from": PDP, "to": "https://new-shop.example/products/real-item"},), "unapproved status"),
        (({"status": 301, "from": "https://other.example/products/item", "to": "https://new-shop.example/products/real-item"},), "continuous chain"),
        (({"status": 301, "from": PDP, "to": "https://different.example/products/item"},), "final PDP"),
    ],
)
def test_changed_merchant_identity_requires_complete_bounded_redirect_proof(
    chain: tuple[dict, ...], reason: str
) -> None:
    final = "https://new-shop.example/products/real-item"
    html = '<meta property="og:image" content="https://new-shop.example/images/item.jpg">'
    (manifest, rejected), _ = asyncio.run(
        run_one(
            legacy(),
            {"id": PIN_ID, "link": PDP},
            merchant(html, url=final, redirect_chain=chain),
        )
    )
    assert manifest == []
    assert reason in rejected[0]["reason"]


def test_same_product_identity_rejects_conflicting_product_family() -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    rows = [
        legacy(id="physical", parent_pin_id=PIN_ID, product_type="physical"),
        legacy(
            id="digital",
            parent_pin_id="223456789012345678",
            product_type="digital",
            source_category="digital-products",
        ),
    ]

    async def fetch_pin(pin_id: str):
        return {"id": pin_id, "product_url": PDP}

    manifest, rejected = asyncio.run(
        bridge.build_manifest(
            rows,
            fetch_pin=fetch_pin,
            fetch_merchant=lambda _url: asyncio.sleep(0, result=merchant(html)),
            now=NOW,
        )
    )

    assert len(manifest) == 1
    assert manifest[0]["product_family"] == "physical"
    assert manifest[0]["additional_evidence"] == []
    assert len(rejected) == 1
    assert rejected[0]["legacyId"] == "digital"
    assert "conflicting physical/digital families" in rejected[0]["reason"]


def test_later_product_pin_becomes_primary_and_preserves_source_as_additional() -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    product_pin_id = "323456789012345678"
    rows = [
        legacy(id="source", parent_pin_id=PIN_ID),
        legacy(id="product", parent_pin_id="999999999999999999", product_pin_id=product_pin_id),
    ]

    async def fetch_pin(pin_id: str):
        return {"id": pin_id, "product_url": PDP}

    async def fetch_merchant(_url: str):
        return merchant(html)

    manifest, rejected = asyncio.run(
        bridge.build_manifest(rows, fetch_pin=fetch_pin, fetch_merchant=fetch_merchant, now=NOW)
    )

    assert rejected == []
    assert len(manifest) == 1
    row = manifest[0]
    assert row["evidence_type"] == "product_pin"
    assert row["pinterest_pin_id"] == product_pin_id
    assert row["provenance"]["pinterest_pin_id"] == product_pin_id
    assert "source_pin_id" not in row["provenance"]
    assert row["additional_evidence"] == [
        {
            "pinterest_pin_id": PIN_ID,
            "pinterest_pin_url": f"https://www.pinterest.com/pin/{PIN_ID}/",
            "evidence_type": "source_pin",
            "relationship_method": "direct_outbound_link",
            "provenance": {
                "pdp_gate_passed": True,
                "image_found_in_merchant_page": True,
                "merchant_page_url": PDP,
                "product_image_url": "https://shop.example/images/item.jpg",
                "merchant_page_sha256": hashlib.sha256(html.encode()).hexdigest(),
                "verified_by": bridge.VERIFIER_VERSION,
                "legacy_pin_product_id": "source",
                "source_category": "fashion",
                "merchant_field_evidence": ["image:og:image"],
                "pinterest_pin_id": PIN_ID,
                "pin_direct_outbound_url": PDP,
                "source_pin_direct_outbound_url": PDP,
                "source_pin_id": PIN_ID,
            },
        }
    ]


def test_shop_the_look_hint_is_rejected_when_source_pin_does_not_directly_link_to_pdp() -> None:
    html = '<meta property="og:image" content="https://shop.example/images/item.jpg">'
    (manifest, rejected), calls = asyncio.run(
        run_one(
            legacy(discovery_method="shop_the_look"),
            {"id": PIN_ID, "link": "https://shop.example/products/outfit"},
            merchant(html),
        )
    )
    assert manifest == []
    assert "does not directly link" in rejected[0]["reason"]
    assert calls == {"pin": 1, "merchant": 0}


@pytest.mark.parametrize(
    ("html", "reason"),
    [
        ("<html><title>Real item</title></html>", "usable product image"),
        ('<meta property="og:image" content="https://i.pinimg.com/item.jpg">', "usable product image"),
    ],
)
def test_missing_or_pinterest_hosted_merchant_image_is_rejected(html: str, reason: str) -> None:
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "outbound_link": PDP}, merchant(html))
    )
    assert manifest == []
    assert reason in rejected[0]["reason"]


def test_pin_failure_does_not_fetch_merchant() -> None:
    (manifest, rejected), calls = asyncio.run(run_one(legacy(), None, merchant("unused")))
    assert manifest == []
    assert "could not be verified" in rejected[0]["reason"]
    assert calls == {"pin": 1, "merchant": 0}


def test_limit_is_a_provider_attempt_cap_and_invalid_local_rows_cost_no_request() -> None:
    rows = [legacy(id="bad", product_type="unknown", source_category="beauty")]
    rows += [legacy(id=f"ok-{i}", canonical_product_url=f"https://shop.example/products/{i}") for i in range(25)]
    calls = {"pin": 0, "merchant": 0}

    async def fetch_pin(_pin_id: str):
        calls["pin"] += 1
        return None

    async def fetch_merchant(_url: str):
        calls["merchant"] += 1
        raise AssertionError("merchant fetch must not follow a failed Pin proof")

    manifest, rejected = asyncio.run(
        bridge.build_manifest(
            rows, fetch_pin=fetch_pin, fetch_merchant=fetch_merchant, now=NOW, limit=20
        )
    )
    assert manifest == []
    assert len(rejected) == 21
    assert calls == {"pin": 20, "merchant": 0}


def test_limit_above_twenty_is_refused_before_any_request() -> None:
    calls = 0

    async def fetch_pin(_pin_id: str):
        nonlocal calls
        calls += 1
        return None

    async def fetch_merchant(_url: str):
        raise AssertionError

    with pytest.raises(ValueError, match="MAX_BATCH=20"):
        asyncio.run(
            bridge.build_manifest(
                [legacy()], fetch_pin=fetch_pin, fetch_merchant=fetch_merchant, now=NOW, limit=21
            )
        )
    assert calls == 0


def test_existing_current_identity_is_skipped_before_any_provider_request() -> None:
    calls = 0

    async def fetch_pin(_pin_id: str):
        nonlocal calls
        calls += 1
        return None

    async def fetch_merchant(_url: str):
        raise AssertionError

    existing = {hashlib.sha256(PDP.encode()).hexdigest()}
    manifest, rejected = asyncio.run(
        bridge.build_manifest(
            [legacy()],
            fetch_pin=fetch_pin,
            fetch_merchant=fetch_merchant,
            now=NOW,
            existing_url_hashes=existing,
        )
    )
    assert manifest == []
    assert "already exists" in rejected[0]["reason"]
    assert calls == 0


def test_oversized_merchant_response_is_rejected_without_hashing_a_truncation() -> None:
    response = bridge.MerchantResponse(200, b"x" * (bridge.MAX_MERCHANT_BYTES + 1), PDP)
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, response)
    )
    assert manifest == []
    assert "response-size" in rejected[0]["reason"]


def test_non_html_merchant_response_is_rejected() -> None:
    response = bridge.MerchantResponse(
        200,
        b'<meta property="og:image" content="https://shop.example/images/item.jpg">',
        PDP,
        "image/jpeg",
    )
    (manifest, rejected), _ = asyncio.run(
        run_one(legacy(), {"id": PIN_ID, "link": PDP}, response)
    )
    assert manifest == []
    assert "not an HTML" in rejected[0]["reason"]


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/products/item",
        "http://[::1]/products/item",
        "http://metadata.internal/products/item",
        "http://shop.local/products/item",
    ],
)
def test_local_or_internal_merchant_targets_fail_before_provider_requests(url: str) -> None:
    calls = 0

    async def fetch_pin(_pin_id: str):
        nonlocal calls
        calls += 1
        return None

    async def fetch_merchant(_url: str):
        raise AssertionError

    manifest, rejected = asyncio.run(
        bridge.build_manifest(
            [legacy(canonical_product_url=url)],
            fetch_pin=fetch_pin,
            fetch_merchant=fetch_merchant,
            now=NOW,
        )
    )
    assert manifest == []
    assert "public" in rejected[0]["reason"] or "non-public" in rejected[0]["reason"]
    assert calls == 0
