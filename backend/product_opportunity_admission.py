"""Validate and atomically admit reviewed Product Opportunities.

This is deliberately not a scraper. A separate merchant-page refetch/review
must produce the evidence manifest. Default invocation is read-only; at most 20
reviewed rows can be admitted in one all-or-nothing database transaction.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "db"))

from product_harvest import normalize_product_url


MAX_BATCH = 20
MAX_ADDITIONAL_EVIDENCE = 19
MAX_VERIFICATION_AGE = timedelta(hours=24)
APPLY_CONFIRM = "ADMIT_REVIEWED_PRODUCTS"
IMAGE_SOURCES = {"merchant_page", "merchant_json_ld", "merchant_open_graph", "merchant_feed"}
PAGE_METHODS = {"merchant_html", "merchant_structured_data", "retailer_pdp_rule"}
DISCOVERY_METHODS = {"outbound_link", "shop_the_look", "merchant_product_reference", "reviewed_migration"}
# User-facing catalog taxonomy and immutable acquisition provenance are
# intentionally separate. A mixed acquisition bucket such as Wedding can
# contain both a physical dress and a digital invitation; it must not decide the
# metric family by itself.
BUSINESS_CATEGORY_FAMILIES = {
    "home-decor": frozenset({"physical"}),
    "wedding-celebrations": frozenset({"physical", "digital"}),
    "gifts": frozenset({"physical", "digital"}),
    "jewelry-accessories": frozenset({"physical"}),
    "fashion": frozenset({"physical"}),
    "digital-products": frozenset({"digital"}),
}
SOURCE_CATEGORY_FAMILIES = {
    "fashion": frozenset({"physical"}),
    "womens-fashion": frozenset({"physical"}),
    "home-decor": frozenset({"physical"}),
    "digital-products": frozenset({"digital"}),
    "wedding": frozenset({"physical", "digital"}),
    "wedding-celebrations": frozenset({"physical", "digital"}),
    "gifts": frozenset({"physical", "digital"}),
    "jewelry-accessories": frozenset({"physical"}),
}
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
MAX_REDIRECT_HOPS = 2
MAX_PRODUCT_NAME_CHARS = 500
MAX_MERCHANT_CHARS = 200
MAX_PRODUCT_TYPE_CHARS = 160


def _host(value: str) -> str:
    try:
        return (urlparse(value).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _optional_display_text(raw: object, field: str, max_chars: int) -> str | None:
    value = str(raw or "").strip() or None
    if value is not None and len(value) > max_chars:
        raise ValueError(f"{field} exceeds {max_chars} characters")
    return value


def _is_pinterest_host(host: str) -> bool:
    return (
        host == "pinterest.com"
        or host.endswith(".pinterest.com")
        or host.startswith("pinterest.")
        or ".pinterest." in host
        or host == "pinimg.com"
        or host.endswith(".pinimg.com")
        or host.startswith("pinimg.")
        or ".pinimg." in host
    )


def _is_pinterest_page_host(host: str) -> bool:
    # v3.7 Evidence URLs are canonicalized to pinterest.com from the exact Pin
    # id. Do not accept pinterest.com.attacker.example or pinterest.evil merely
    # because a hostname contains the brand token.
    return host == "pinterest.com" or host.endswith(".pinterest.com")


def assert_public_url_literal(value: str, field: str) -> None:
    parsed = urlparse(value)
    host = _host(value)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{field} must not contain URL credentials")
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError(f"{field} must use a public host")
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return
    if not address.is_global:
        raise ValueError(f"{field} must use a public address")


def _http_url(value: object, field: str, *, pinterest: bool = False) -> str:
    text = str(value or "").strip()
    parsed = urlparse(text)
    host = _host(text)
    if parsed.scheme not in ("http", "https") or not host:
        raise ValueError(f"{field} must be an absolute HTTP URL")
    assert_public_url_literal(text, field)
    if pinterest:
        if not _is_pinterest_page_host(host):
            raise ValueError(f"{field} must use a Pinterest page host")
    elif _is_pinterest_host(host):
        raise ValueError(f"{field} must use a non-Pinterest host")
    return text


def _timestamp(value: object, now: datetime) -> str:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("product_page_verified_at must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError("product_page_verified_at must include a timezone")
    parsed = parsed.astimezone(timezone.utc)
    if parsed > now + timedelta(minutes=5) or now - parsed > MAX_VERIFICATION_AGE:
        raise ValueError("merchant-page verification must be no more than 24 hours old")
    return parsed.isoformat()


def _normalize_redirect_hop(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("redirect provenance contains a non-object hop")
    status = raw.get("status")
    if not isinstance(status, int) or isinstance(status, bool):
        raise ValueError("redirect provenance contains an invalid status")
    if status not in REDIRECT_STATUSES:
        raise ValueError("redirect provenance contains an unapproved status")
    direct = normalize_product_url(
        _http_url(raw.get("from"), "redirect provenance from")
    )
    target = normalize_product_url(
        _http_url(raw.get("to"), "redirect provenance to")
    )
    if set(raw) != {"status", "from", "to"}:
        raise ValueError("redirect provenance hop contains unexpected fields")
    return {"status": status, "from": direct, "to": target}


def _validate_direct_provenance(
    provenance: dict, canonical: str, *, source_pin: bool
) -> dict:
    direct = normalize_product_url(
        _http_url(
            provenance.get("pin_direct_outbound_url"),
            "provenance pin_direct_outbound_url",
        )
    )
    normalized = dict(provenance)
    normalized["pin_direct_outbound_url"] = direct
    redirect_keys = {
        "pin_direct_outbound_resolved_url",
        "pin_direct_outbound_resolution_method",
        "pin_redirect_chain",
        "pin_redirect_chain_sha256",
    }

    if direct == canonical:
        if any(key in provenance for key in redirect_keys):
            raise ValueError("direct-PDP provenance must not contain redirect proof")
    else:
        resolved = normalize_product_url(
            _http_url(
                provenance.get("pin_direct_outbound_resolved_url"),
                "provenance pin_direct_outbound_resolved_url",
            )
        )
        if resolved != canonical:
            raise ValueError("redirect provenance does not resolve to this product")
        if provenance.get("pin_direct_outbound_resolution_method") != "bounded_http_redirect_chain":
            raise ValueError("redirect provenance uses an unapproved resolution method")
        raw_chain = provenance.get("pin_redirect_chain")
        if not isinstance(raw_chain, list) or not 1 <= len(raw_chain) <= MAX_REDIRECT_HOPS:
            raise ValueError("redirect provenance must contain one or two bounded hops")
        chain = [_normalize_redirect_hop(item) for item in raw_chain]
        current = direct
        for hop in chain:
            if hop["from"] != current:
                raise ValueError("redirect provenance is not a continuous chain")
            current = hop["to"]
        if current != canonical:
            raise ValueError("redirect provenance does not end at this product")
        expected_hash = hashlib.sha256(
            json.dumps(
                chain, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
        ).hexdigest()
        if str(provenance.get("pin_redirect_chain_sha256") or "").lower() != expected_hash:
            raise ValueError("redirect provenance hash does not match the chain")
        normalized.update({
            "pin_direct_outbound_resolved_url": canonical,
            "pin_direct_outbound_resolution_method": "bounded_http_redirect_chain",
            "pin_redirect_chain": chain,
            "pin_redirect_chain_sha256": expected_hash,
        })

    if source_pin:
        source_direct = normalize_product_url(
            _http_url(
                provenance.get("source_pin_direct_outbound_url"),
                "provenance source_pin_direct_outbound_url",
            )
        )
        if source_direct != direct:
            raise ValueError("Source Pin direct URL does not match Pin direct provenance")
        normalized["source_pin_direct_outbound_url"] = direct
        if direct == canonical:
            if "source_pin_direct_outbound_resolved_url" in provenance:
                raise ValueError("direct Source Pin provenance must not contain a resolved URL")
        else:
            source_resolved = normalize_product_url(
                _http_url(
                    provenance.get("source_pin_direct_outbound_resolved_url"),
                    "provenance source_pin_direct_outbound_resolved_url",
                )
            )
            if source_resolved != canonical:
                raise ValueError("Source Pin redirect provenance does not resolve to this product")
            normalized["source_pin_direct_outbound_resolved_url"] = canonical
    return normalized


def _validate_evidence(raw: object, canonical: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Pinterest Evidence must be an object")
    evidence_type = str(raw.get("evidence_type") or "")
    relationship = str(raw.get("relationship_method") or "")
    if evidence_type not in ("product_pin", "source_pin"):
        raise ValueError("evidence_type must be product_pin or source_pin")
    if relationship not in (
        "direct_outbound_link",
        "shop_the_look",
        "merchant_product_reference",
    ):
        raise ValueError("relationship_method is not approved")
    # Every admitted Source Pin is eligible to become Primary later, so it must
    # independently prove the direct PDP relationship at admission time.
    if evidence_type == "source_pin" and relationship != "direct_outbound_link":
        raise ValueError("a Source Pin Evidence requires a direct product link")
    pin_id = str(raw.get("pinterest_pin_id") or "").strip()
    if not pin_id.isdigit() or len(pin_id) <= 10:
        raise ValueError("pinterest_pin_id is invalid")
    pin_url = _http_url(raw.get("pinterest_pin_url"), "pinterest_pin_url", pinterest=True)
    if not re.fullmatch(rf"/pin/{re.escape(pin_id)}/?", urlparse(pin_url).path):
        raise ValueError("pinterest_pin_url does not match pinterest_pin_id")
    provenance = raw.get("provenance")
    if not isinstance(provenance, dict) or not provenance:
        raise ValueError("Evidence provenance must be a non-empty object")
    if not str(provenance.get("verified_by") or "").strip():
        raise ValueError("Evidence provenance must identify the verifier")
    if str(provenance.get("pinterest_pin_id") or "").strip() != pin_id:
        raise ValueError("Evidence provenance pinterest_pin_id does not match")
    normalized_provenance = _validate_direct_provenance(
        provenance, canonical, source_pin=evidence_type == "source_pin"
    )
    normalized_provenance["pinterest_pin_id"] = pin_id
    if evidence_type == "source_pin":
        if str(provenance.get("source_pin_id") or "").strip() != pin_id:
            raise ValueError("provenance source_pin_id does not match Pinterest evidence")
        normalized_provenance["source_pin_id"] = pin_id
    return {
        "pinterest_pin_id": pin_id,
        "pinterest_pin_url": pin_url,
        "evidence_type": evidence_type,
        "relationship_method": relationship,
        "provenance": normalized_provenance,
    }


def validate_candidate(raw: object, *, now: datetime) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("candidate must be an object")
    external = normalize_product_url(
        _http_url(raw.get("external_product_url"), "external_product_url")
    )
    canonical = normalize_product_url(
        _http_url(raw.get("canonical_product_url") or external, "canonical_product_url")
    )
    if not canonical or external != canonical:
        raise ValueError("external_product_url and canonical_product_url must resolve to one identity")
    image = _http_url(raw.get("product_image_url"), "product_image_url")
    image_source = str(raw.get("product_image_source") or "")
    if image_source not in IMAGE_SOURCES:
        raise ValueError("product_image_source is not an approved merchant source")
    page_method = str(raw.get("product_page_verification_method") or "")
    if page_method not in PAGE_METHODS:
        raise ValueError("product_page_verification_method is not approved")
    family = str(raw.get("product_family") or "")
    if family not in ("physical", "digital"):
        raise ValueError("product_family must be physical or digital")
    category = str(raw.get("category") or "").strip()
    if family not in BUSINESS_CATEGORY_FAMILIES.get(category, frozenset()):
        raise ValueError("category must be a reviewed business category matching product_family")
    discovery = str(raw.get("discovery_method") or "")
    if discovery not in DISCOVERY_METHODS:
        raise ValueError("discovery_method is not approved")
    provenance = raw.get("provenance")
    if not isinstance(provenance, dict) or not provenance:
        raise ValueError("provenance must be a non-empty object")
    if provenance.get("pdp_gate_passed") is not True:
        raise ValueError("provenance must prove the PDP gate passed")
    if provenance.get("image_found_in_merchant_page") is not True:
        raise ValueError("provenance must prove the product image came from the merchant page")
    if normalize_product_url(str(provenance.get("merchant_page_url") or "")) != canonical:
        raise ValueError("provenance merchant_page_url does not match the product identity")
    if str(provenance.get("product_image_url") or "").strip() != image:
        raise ValueError("provenance product_image_url does not match")
    source_category = str(provenance.get("source_category") or "").strip()
    if family not in SOURCE_CATEGORY_FAMILIES.get(source_category, frozenset()):
        raise ValueError(
            "provenance source_category must be a reviewed acquisition bucket "
            "compatible with product_family"
        )
    page_hash = str(provenance.get("merchant_page_sha256") or "").lower()
    if len(page_hash) != 64 or any(char not in "0123456789abcdef" for char in page_hash):
        raise ValueError("provenance must include merchant_page_sha256")
    merchant = _optional_display_text(
        raw.get("merchant"), "merchant", MAX_MERCHANT_CHARS
    )
    if merchant:
        field_evidence = provenance.get("merchant_field_evidence")
        if not isinstance(field_evidence, list) or not any(
            isinstance(item, str) and item.startswith("merchant:")
            for item in field_evidence
        ):
            raise ValueError("merchant requires merchant-page field provenance")
        if provenance.get("merchant_found_in_page") is not True:
            raise ValueError("merchant must be proven in the fetched merchant page")
        if str(provenance.get("merchant_value") or "").strip() != merchant:
            raise ValueError("merchant provenance value does not match")
    product_name = _optional_display_text(
        raw.get("product_name"), "product_name", MAX_PRODUCT_NAME_CHARS
    )
    if product_name:
        field_evidence = provenance.get("merchant_field_evidence")
        if not isinstance(field_evidence, list) or not any(
            isinstance(item, str) and item.startswith("name:")
            for item in field_evidence
        ):
            raise ValueError("product_name requires merchant-page field provenance")
        if provenance.get("product_name_found_in_page") is not True:
            raise ValueError("product_name must be proven in the fetched merchant page")
        if str(provenance.get("product_name_value") or "").strip() != product_name:
            raise ValueError("product_name provenance value does not match")
    product_type = _optional_display_text(
        raw.get("product_type"), "product_type", MAX_PRODUCT_TYPE_CHARS
    )
    if product_type:
        field_evidence = provenance.get("merchant_field_evidence")
        if not isinstance(field_evidence, list) or not any(
            isinstance(item, str) and item.startswith("product_type:")
            for item in field_evidence
        ):
            raise ValueError("product_type requires merchant-page field provenance")
        if provenance.get("product_type_found_in_merchant_page") is not True:
            raise ValueError("product_type must be proven in the fetched merchant page")
        if str(provenance.get("product_type_value") or "").strip() != product_type:
            raise ValueError("product_type provenance value does not match")
    normalized_provenance = dict(provenance)
    normalized_provenance["merchant_page_url"] = canonical
    normalized_provenance["product_image_url"] = image
    primary_evidence = _validate_evidence(
        {**raw, "provenance": normalized_provenance}, canonical
    )
    normalized_provenance = primary_evidence["provenance"]

    raw_additional = raw.get("additional_evidence", [])
    if not isinstance(raw_additional, list):
        raise ValueError("additional_evidence must be an array")
    if len(raw_additional) > MAX_ADDITIONAL_EVIDENCE:
        raise ValueError(
            f"additional_evidence exceeds MAX_ADDITIONAL_EVIDENCE={MAX_ADDITIONAL_EVIDENCE}"
        )
    additional_evidence = [
        _validate_evidence(item, canonical) for item in raw_additional
    ]
    pin_ids = [
        primary_evidence["pinterest_pin_id"],
        *(item["pinterest_pin_id"] for item in additional_evidence),
    ]
    if len(pin_ids) != len(set(pin_ids)):
        raise ValueError("duplicate Pinterest Pin within Product Opportunity Evidence")

    return {
        "canonical_product_url": canonical,
        "canonical_url_hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "external_product_url": external,
        "product_image_url": image,
        "product_image_source": image_source,
        "product_page_verified_at": _timestamp(raw.get("product_page_verified_at"), now),
        "product_page_verification_method": page_method,
        "product_name": product_name,
        "merchant": merchant,
        "domain": _host(external),
        "category": category,
        "source_category": source_category,
        "product_type": product_type,
        "product_family": family,
        "discovery_method": discovery,
        "provenance": normalized_provenance,
        "pinterest_pin_id": primary_evidence["pinterest_pin_id"],
        "pinterest_pin_url": primary_evidence["pinterest_pin_url"],
        "evidence_type": primary_evidence["evidence_type"],
        "relationship_method": primary_evidence["relationship_method"],
        "additional_evidence": additional_evidence,
    }


def validate_manifest(payload: object, *, now: datetime) -> tuple[list[dict], list[dict]]:
    if not isinstance(payload, list):
        raise ValueError("manifest root must be an array")
    if len(payload) > MAX_BATCH:
        raise ValueError(f"manifest exceeds MAX_BATCH={MAX_BATCH}")
    accepted: list[dict] = []
    rejected: list[dict] = []
    seen: set[str] = set()
    for index, raw in enumerate(payload):
        try:
            row = validate_candidate(raw, now=now)
            if row["canonical_url_hash"] in seen:
                raise ValueError("duplicate product identity within manifest")
            seen.add(row["canonical_url_hash"])
            accepted.append(row)
        except (TypeError, ValueError) as exc:
            rejected.append({"index": index, "reason": str(exc)})
    return accepted, rejected


def apply_candidates(rows: list[dict]) -> list[str]:
    from db import _get_http  # type: ignore

    response = _get_http().post(
        "rpc/admit_product_opportunity_batch",
        json={"p_candidates": rows},
    )
    if response.status_code != 200:
        raise RuntimeError(f"admission RPC failed [{response.status_code}]: {response.text[:300]}")
    receipt = response.json()
    if not isinstance(receipt, list) or len(receipt) != len(rows):
        raise RuntimeError("admission receipt count does not match the reviewed manifest")
    return [str(item["product_opportunity_id"]) for item in receipt]


def verify_candidates(product_ids: list[str], rows: list[dict]) -> int:
    """Read back the exact admission receipt and its active Primary Evidence."""
    from db import DB  # type: ignore

    if len(product_ids) != len(rows) or len(set(product_ids)) != len(product_ids):
        raise RuntimeError("admission receipt ids are missing or duplicated")
    if not product_ids:
        return 0
    db = DB()
    encoded_ids = f"in.({','.join(product_ids)})"
    products = db.select_many(
        "product_opportunities",
        columns=(
            "id,canonical_url_hash,external_product_url,product_image_url,"
            "product_type,product_family,lifecycle_status"
        ),
        filters={"id": encoded_ids},
    )
    evidence = db.select_many(
        "product_opportunity_evidence",
        columns=(
            "product_opportunity_id,pinterest_pin_id,pinterest_pin_url,"
            "evidence_type,relationship_method,canonical_url_hash,provenance,"
            "evidence_status,is_primary"
        ),
        filters={
            "product_opportunity_id": encoded_ids,
            "evidence_status": "active",
        },
    )
    product_by_id = {str(item["id"]): item for item in products}
    evidence_by_id: dict[str, list[dict]] = {}
    for item in evidence:
        evidence_by_id.setdefault(str(item["product_opportunity_id"]), []).append(item)
    for product_id, expected in zip(product_ids, rows, strict=True):
        product = product_by_id.get(product_id)
        evidence_rows = evidence_by_id.get(product_id, [])
        primary_rows = [row for row in evidence_rows if row.get("is_primary") is True]
        primary = primary_rows[0] if len(primary_rows) == 1 else None
        if not product or product.get("lifecycle_status") != "active":
            raise RuntimeError(f"admission readback missing active product {product_id}")
        for field in (
            "canonical_url_hash",
            "external_product_url",
            "product_image_url",
            "product_type",
            "product_family",
        ):
            if product.get(field) != expected.get(field):
                raise RuntimeError(f"admission readback product mismatch: {product_id}/{field}")
        if not primary or primary.get("is_primary") is not True:
            raise RuntimeError(f"admission readback missing Primary Evidence {product_id}")
        expected_evidence = [
            {
                "pinterest_pin_id": expected["pinterest_pin_id"],
                "pinterest_pin_url": expected["pinterest_pin_url"],
                "evidence_type": expected["evidence_type"],
                "relationship_method": expected["relationship_method"],
                "provenance": expected["provenance"],
                "is_primary": True,
            },
            *[
                {**additional, "is_primary": False}
                for additional in expected.get("additional_evidence", [])
            ],
        ]
        actual_by_pin = {str(row["pinterest_pin_id"]): row for row in evidence_rows}
        if len(actual_by_pin) != len(expected_evidence):
            raise RuntimeError(f"admission readback Evidence count mismatch: {product_id}")
        for expected_row in expected_evidence:
            actual = actual_by_pin.get(expected_row["pinterest_pin_id"])
            if actual is None:
                raise RuntimeError(
                    f"admission readback missing Evidence {product_id}/"
                    f"{expected_row['pinterest_pin_id']}"
                )
            for field in (
                "pinterest_pin_url",
                "evidence_type",
                "relationship_method",
                "provenance",
                "is_primary",
            ):
                if actual.get(field) != expected_row.get(field):
                    raise RuntimeError(
                        f"admission readback evidence mismatch: {product_id}/"
                        f"{expected_row['pinterest_pin_id']}/{field}"
                    )
            if actual.get("canonical_url_hash") != expected.get("canonical_url_hash"):
                raise RuntimeError(
                    f"admission readback evidence identity mismatch: {product_id}/"
                    f"{expected_row['pinterest_pin_id']}"
                )
    if len(product_by_id) != len(rows) or len(evidence_by_id) != len(rows):
        raise RuntimeError("admission readback count mismatch")
    return len(rows)


def rollback_candidates(product_ids: list[str], reason: str) -> int:
    from db import _get_http  # type: ignore

    if not product_ids:
        return 0
    response = _get_http().post(
        "rpc/rollback_product_opportunity_admission_batch",
        json={"p_ids": product_ids, "p_reason": reason},
    )
    if response.status_code != 200:
        raise RuntimeError(f"admission rollback failed [{response.status_code}]: {response.text[:300]}")
    receipt = response.json()
    if not isinstance(receipt, list) or len(receipt) != 1:
        raise RuntimeError("admission rollback returned an invalid receipt")
    retired = int(receipt[0].get("retired_count") or 0)
    if retired != len(product_ids):
        raise RuntimeError("admission rollback count does not match the admission receipt")
    return retired


def verify_rollback(product_ids: list[str]) -> int:
    from db import DB  # type: ignore

    if not product_ids:
        return 0
    db = DB()
    encoded_ids = f"in.({','.join(product_ids)})"
    products = db.select_many(
        "product_opportunities",
        columns="id,lifecycle_status,lifecycle_reason,retired_at",
        filters={"id": encoded_ids},
    )
    evidence = db.select_many(
        "product_opportunity_evidence",
        columns="product_opportunity_id,evidence_status,is_primary",
        filters={"product_opportunity_id": encoded_ids},
    )
    by_id = {str(row["id"]): row for row in products}
    if set(by_id) != set(product_ids):
        raise RuntimeError("admission rollback readback count mismatch")
    for product_id in product_ids:
        row = by_id[product_id]
        if (
            row.get("lifecycle_status") != "retired"
            or not str(row.get("lifecycle_reason") or "").startswith("admission_rollback:")
            or not row.get("retired_at")
        ):
            raise RuntimeError(f"admission rollback not proven for product {product_id}")
    if any(
        row.get("evidence_status") == "active" or row.get("is_primary") is True
        for row in evidence
    ):
        raise RuntimeError("admission rollback left active or Primary Evidence")
    return len(product_ids)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        payload = json.loads(args.manifest.read_text(encoding="utf-8"))
        accepted, rejected = validate_manifest(payload, now=datetime.now(timezone.utc))
        report: dict = {
            "mode": "apply" if args.apply else "dry-run",
            "inputRows": len(payload) if isinstance(payload, list) else None,
            "eligibleRows": len(accepted),
            "rejectedRows": len(rejected),
            "rejections": rejected,
            "maxBatch": MAX_BATCH,
            "written": 0,
        }
        if args.apply:
            if rejected:
                raise RuntimeError("apply refused: every manifest row must pass all evidence gates")
            if os.environ.get("VIBEPIN_PRODUCT_ADMISSION_MODE") != "production":
                raise RuntimeError("apply refused: VIBEPIN_PRODUCT_ADMISSION_MODE must equal production")
            if os.environ.get("VIBEPIN_PRODUCT_ADMISSION_CONFIRM") != APPLY_CONFIRM:
                raise RuntimeError(f"apply refused: VIBEPIN_PRODUCT_ADMISSION_CONFIRM must equal {APPLY_CONFIRM}")
            report["productOpportunityIds"] = apply_candidates(accepted)
            report["written"] = len(accepted)
            try:
                report["verified"] = verify_candidates(
                    report["productOpportunityIds"], accepted
                )
            except Exception as verification_error:
                reason = f"post_write_verification:{type(verification_error).__name__}"
                try:
                    rolled_back = rollback_candidates(
                        report["productOpportunityIds"], reason
                    )
                    verify_rollback(report["productOpportunityIds"])
                except Exception as rollback_error:
                    raise RuntimeError(
                        "post-write verification failed and automatic rollback was not proven: "
                        f"{verification_error}; rollback={rollback_error}"
                    ) from rollback_error
                raise RuntimeError(
                    f"post-write verification failed; history-preserving rollback retired "
                    f"{rolled_back} rows: {verification_error}"
                ) from verification_error
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"product admission failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
