"""Build a reviewed Product Opportunity admission manifest without writing data.

Legacy ``pin_products`` rows are discovery hints only.  A row is emitted only
after a fresh PinResource response proves that the exact Pin directly links to
the same PDP and a fresh merchant-page response supplies a real, non-Pinterest
product image.  The output can then be reviewed and passed to
``product_opportunity_admission.py``; this module has no database write path.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import html as html_lib
import json
import os
import re
import socket
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urljoin, urlparse

import httpx

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "db"))

from product_harvest import accept_link, normalize_product_url
from product_opportunity_admission import (
    SOURCE_CATEGORY_FAMILIES,
    MAX_MERCHANT_CHARS,
    MAX_PRODUCT_NAME_CHARS,
    MAX_PRODUCT_TYPE_CHARS,
    assert_public_url_literal,
    validate_candidate,
)
from scraper_v2 import PinterestSession, extract_direct_outbound_link
from supply_core import BROWSER_HEADERS, extract_details


MAX_BATCH = 20
MAX_SCAN_ROWS = 200
MAX_MERCHANT_BYTES = 2_000_000
MAX_MERCHANT_REQUESTS = 3
VERIFIER_VERSION = "product-opportunity-manifest-v1"
NAME_PROOF_NORMALIZATION = "html-unescape+nfkc+whitespace+casefold-v1"
FAMILY_BY_SOURCE_CATEGORY = {
    category: next(iter(families))
    for category, families in SOURCE_CATEGORY_FAMILIES.items()
    if len(families) == 1
}


def _business_category(source_category: str, family: str, product_type: str | None) -> str:
    """Derive catalog taxonomy without rewriting acquisition provenance."""
    normalized_type = (product_type or "").casefold()
    if family == "physical" and any(
        token in normalized_type for token in ("jewelry", "jewellery", "accessor")
    ):
        return "jewelry-accessories"
    if any(token in normalized_type for token in ("wedding", "bridal", "bride")):
        return "wedding-celebrations"
    if "gift" in normalized_type:
        return "gifts"
    if source_category in ("wedding", "wedding-celebrations"):
        return "wedding-celebrations"
    if source_category == "gifts":
        return "gifts"
    if source_category == "jewelry-accessories":
        return "jewelry-accessories"
    if source_category in ("fashion", "womens-fashion"):
        return "fashion"
    if source_category == "home-decor":
        return "home-decor"
    if source_category == "digital-products":
        return "digital-products"
    raise ValueError("legacy candidate has no reviewed business category")


@dataclass(frozen=True)
class MerchantResponse:
    status_code: int
    content: bytes
    final_url: str
    content_type: str = "text/html"
    redirect_chain: tuple[dict, ...] = ()


PinFetcher = Callable[[str], Awaitable[dict | None]]
MerchantFetcher = Callable[[str], Awaitable[MerchantResponse]]


def _host(value: str) -> str:
    try:
        return (urlparse(value).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _optional_display_text(value: object, max_chars: int) -> str | None:
    cleaned = str(value or "").strip() or None
    return cleaned if cleaned is not None and len(cleaned) <= max_chars else None


def _assert_not_local_address(value: str) -> None:
    assert_public_url_literal(value, "merchant URL")


async def _assert_public_resolution(value: str) -> None:
    _assert_not_local_address(value)
    host = _host(value)
    port = urlparse(value).port or (443 if urlparse(value).scheme == "https" else 80)
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("merchant host could not be resolved") from exc
    addresses = {item[4][0] for item in records if item[4]}
    if not addresses or any(not ipaddress.ip_address(item).is_global for item in addresses):
        raise ValueError("merchant host did not resolve exclusively to public addresses")


def _image_source(evidence: list[str]) -> tuple[str, str] | None:
    for item in evidence:
        if item == "image:schema.org/Product.image":
            return "merchant_json_ld", "merchant_structured_data"
        if item.startswith("image:og:image"):
            return "merchant_open_graph", "merchant_structured_data"
        if item.startswith("image:twitter:image"):
            return "merchant_page", "merchant_html"
    return None


def _legacy_hint(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("legacy candidate must be an object")
    if str(raw.get("lifecycle_status") or "") == "retired":
        raise ValueError("legacy candidate is retired")
    product_url = normalize_product_url(
        str(raw.get("canonical_product_url") or raw.get("source_url") or "")
    )
    _assert_not_local_address(product_url)
    ok, reason = accept_link(product_url)
    if not ok:
        raise ValueError(f"legacy candidate is not a PDP: {reason}")
    source_category = str(raw.get("source_category") or raw.get("category") or "").strip()
    declared_family = str(raw.get("product_type") or "").strip()
    source_families = SOURCE_CATEGORY_FAMILIES.get(source_category, frozenset())
    category_family = FAMILY_BY_SOURCE_CATEGORY.get(source_category)
    if not source_families:
        raise ValueError("legacy candidate has an unreviewed source category")
    if declared_family in ("physical", "digital"):
        if declared_family not in source_families:
            raise ValueError("legacy candidate family conflicts with its reviewed source category")
        family = declared_family
    elif category_family:
        # Product Supply deliberately writes only merchant-proven product details;
        # it does not guess the legacy physical/digital field. The reviewed source
        # bucket is still deterministic pipeline provenance, so it may supply the
        # broad metric family without inventing a finer Product Type.
        family = category_family
    else:
        raise ValueError("legacy candidate has no physical/digital family")
    product_pin_id = str(raw.get("product_pin_id") or "").strip()
    source_pin_id = str(raw.get("parent_pin_id") or raw.get("source_pin_id") or "").strip()
    pin_id = product_pin_id or source_pin_id
    if not pin_id.isdigit() or len(pin_id) <= 10:
        raise ValueError("legacy candidate has no auditable Pinterest Pin")
    return {
        "legacy_id": str(raw.get("id") or ""),
        "product_url": product_url,
        "pin_id": pin_id,
        "evidence_type": "product_pin" if product_pin_id else "source_pin",
        "family": family,
        "source_category": source_category,
        "category": _business_category(source_category, family, None),
        "discovery_method": (
            str(raw.get("discovery_method") or "")
            if str(raw.get("discovery_method") or "")
            in {"outbound_link", "shop_the_look", "merchant_product_reference", "reviewed_migration"}
            else "reviewed_migration"
        ),
    }


def _raw_manifest_row(
    hint: dict,
    pin: dict,
    merchant: MerchantResponse,
    *,
    verified_at: datetime,
) -> dict:
    _verify_pin_direct(hint, pin)
    if merchant.status_code != 200 or not merchant.content:
        raise ValueError(f"merchant page fetch did not return usable HTTP 200 content ({merchant.status_code})")
    if not merchant.content_type.lower().split(";", 1)[0].strip() in {
        "text/html",
        "application/xhtml+xml",
    }:
        raise ValueError("merchant response is not an HTML product page")
    final_url = normalize_product_url(merchant.final_url)
    ok, reason = accept_link(final_url)
    if not ok:
        raise ValueError(f"merchant final URL is not a PDP: {reason}")
    redirect_chain = _validated_redirect_chain(
        hint["product_url"], final_url, merchant.redirect_chain
    )

    if len(merchant.content) > MAX_MERCHANT_BYTES:
        raise ValueError("merchant page exceeds the bounded response-size limit")
    # The extractor is intentionally bounded, while the provenance hash covers
    # the complete accepted response bytes (never a silently truncated body).
    page = merchant.content[:500_000].decode("utf-8", errors="replace")
    details = extract_details(page, _host(final_url))
    image = str(details.get("image_url") or "").strip()
    source = _image_source(list(details.get("evidence") or []))
    if not image or not source:
        raise ValueError("merchant page did not prove a usable product image")
    image_source, page_method = source
    pin_url = f"https://www.pinterest.com/pin/{hint['pin_id']}/"
    pin_provenance = _pin_evidence_provenance(
        hint, canonical_url=final_url, redirect_chain=redirect_chain
    )
    # Optional labels are never required for admission. Preserve a proven value
    # exactly when it is suitable for a user-facing field; omit pathological
    # merchant payloads instead of truncating them into a different claim.
    product_name = _optional_display_text(
        details.get("product_name"), MAX_PRODUCT_NAME_CHARS
    )
    merchant_name = _optional_display_text(
        details.get("merchant"), MAX_MERCHANT_CHARS
    )
    product_type = _optional_display_text(
        details.get("product_type"), MAX_PRODUCT_TYPE_CHARS
    )
    field_evidence = list(details.get("evidence") or [])
    name_found_in_page = bool(
        product_name
        and any(str(item).startswith("name:") for item in field_evidence)
        and _normalize_name_proof(product_name) in _normalize_name_proof(page)
    )
    # A Product remains useful without a title. If the merchant bytes do not
    # independently prove the extracted name after conservative normalization,
    # drop only the name rather than importing a possible Pin-derived value.
    if product_name and not name_found_in_page:
        product_name = None
    row = {
        "canonical_product_url": final_url,
        "external_product_url": final_url,
        "product_image_url": image,
        "product_image_source": image_source,
        "product_page_verified_at": verified_at.astimezone(timezone.utc).isoformat(),
        "product_page_verification_method": page_method,
        "product_name": product_name,
        "merchant": merchant_name,
        "category": _business_category(
            hint["source_category"], hint["family"], product_type
        ),
        "source_category": hint["source_category"],
        "product_type": product_type,
        "product_family": hint["family"],
        "discovery_method": hint["discovery_method"],
        "pinterest_pin_id": hint["pin_id"],
        "pinterest_pin_url": pin_url,
        "evidence_type": hint["evidence_type"],
        "relationship_method": "direct_outbound_link",
        "additional_evidence": [],
        "provenance": {
            "pdp_gate_passed": True,
            "image_found_in_merchant_page": True,
            "merchant_page_url": final_url,
            "product_image_url": image,
            "merchant_page_sha256": hashlib.sha256(merchant.content).hexdigest(),
            "verified_by": VERIFIER_VERSION,
            "legacy_pin_product_id": hint["legacy_id"] or None,
            # Acquisition provenance is not a user-facing business category.
            # Persist it independently so future category taxonomy changes do
            # not erase where the Product was actually discovered.
            "source_category": hint["source_category"],
            "merchant_field_evidence": field_evidence,
            **pin_provenance,
        },
    }
    if product_name:
        row["provenance"].update({
            "product_name_found_in_page": True,
            "product_name_value": product_name,
            "product_name_normalization": NAME_PROOF_NORMALIZATION,
        })
    if merchant_name:
        row["provenance"].update({
            "merchant_found_in_page": True,
            "merchant_value": merchant_name,
        })
    if product_type:
        row["provenance"].update({
            "product_type_found_in_merchant_page": True,
            "product_type_value": product_type,
        })
    # Final authority is the exact admission validator used immediately before writes.
    validate_candidate(row, now=verified_at)
    return row


def _normalize_name_proof(value: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        unicodedata.normalize("NFKC", html_lib.unescape(value)).casefold(),
    ).strip()


def _normalized_redirect_hop(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("merchant redirect proof contains a non-object hop")
    try:
        status = int(raw.get("status") or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("merchant redirect proof has an invalid status") from exc
    if status not in {301, 302, 303, 307, 308}:
        raise ValueError("merchant redirect proof has an unapproved status")
    from_url = normalize_product_url(str(raw.get("from") or ""))
    to_url = normalize_product_url(str(raw.get("to") or ""))
    _assert_not_local_address(from_url)
    _assert_not_local_address(to_url)
    return {"status": status, "from": from_url, "to": to_url}


def _validated_redirect_chain(
    direct_url: str, final_url: str, raw_chain: tuple[dict, ...]
) -> list[dict]:
    direct = normalize_product_url(direct_url)
    final = normalize_product_url(final_url)
    chain = [_normalized_redirect_hop(item) for item in raw_chain]
    if direct == final:
        if chain:
            raise ValueError("merchant redirect proof does not end at a changed identity")
        return []
    if not chain or len(chain) > MAX_MERCHANT_REQUESTS - 1:
        raise ValueError("merchant identity changed without a complete bounded redirect proof")
    current = direct
    for hop in chain:
        if hop["from"] != current:
            raise ValueError("merchant redirect proof is not a continuous chain")
        current = hop["to"]
    if current != final:
        raise ValueError("merchant redirect proof does not end at the final PDP")
    return chain


def _redirect_chain_sha256(chain: list[dict]) -> str:
    encoded = json.dumps(
        chain, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _pin_evidence_provenance(
    hint: dict, *, canonical_url: str, redirect_chain: list[dict]
) -> dict:
    provenance = {
        "verified_by": VERIFIER_VERSION,
        "pinterest_pin_id": hint["pin_id"],
        "pin_direct_outbound_url": hint["product_url"],
        "legacy_pin_product_id": hint["legacy_id"] or None,
    }
    if canonical_url != hint["product_url"]:
        provenance.update({
            "pin_direct_outbound_resolved_url": canonical_url,
            "pin_direct_outbound_resolution_method": "bounded_http_redirect_chain",
            "pin_redirect_chain": redirect_chain,
            "pin_redirect_chain_sha256": _redirect_chain_sha256(redirect_chain),
        })
    if hint["evidence_type"] == "source_pin":
        provenance.update({
            "source_pin_direct_outbound_url": hint["product_url"],
            "source_pin_id": hint["pin_id"],
        })
        if canonical_url != hint["product_url"]:
            provenance["source_pin_direct_outbound_resolved_url"] = canonical_url
    return provenance


def _primary_evidence_row(row: dict) -> dict:
    return {
        "pinterest_pin_id": row["pinterest_pin_id"],
        "pinterest_pin_url": row["pinterest_pin_url"],
        "evidence_type": row["evidence_type"],
        "relationship_method": row["relationship_method"],
        "provenance": dict(row["provenance"]),
    }


_PIN_PROVENANCE_FIELDS = {
    "pinterest_pin_id",
    "pin_direct_outbound_url",
    "pin_direct_outbound_resolved_url",
    "pin_direct_outbound_resolution_method",
    "pin_redirect_chain",
    "pin_redirect_chain_sha256",
    "source_pin_direct_outbound_url",
    "source_pin_direct_outbound_resolved_url",
    "source_pin_id",
    "legacy_pin_product_id",
}


def _with_additional_evidence(row: dict, candidate: dict, *, now: datetime) -> dict:
    updated = copy.deepcopy(row)
    if candidate["canonical_product_url"] != updated["canonical_product_url"]:
        raise ValueError("Additional Evidence resolved to a different product identity")
    if candidate["product_family"] != updated["product_family"]:
        # Product family selects an independently calibrated metric policy.  Two
        # legacy discoveries for one canonical PDP cannot be merged by silently
        # accepting whichever physical/digital label happened to be scanned first.
        raise ValueError("same product identity has conflicting physical/digital families")
    evidence = _primary_evidence_row(candidate)
    existing_pin_ids = {
        updated["pinterest_pin_id"],
        *(item["pinterest_pin_id"] for item in updated.get("additional_evidence", [])),
    }
    if evidence["pinterest_pin_id"] in existing_pin_ids:
        raise ValueError("duplicate Pinterest Pin for the same product identity")
    if len(updated.get("additional_evidence", [])) >= 19:
        raise ValueError("Product Opportunity already has the maximum Additional Evidence")

    if updated["evidence_type"] == "source_pin" and evidence["evidence_type"] == "product_pin":
        prior_primary = _primary_evidence_row(updated)
        merchant_provenance = dict(updated["provenance"])
        for key in _PIN_PROVENANCE_FIELDS:
            merchant_provenance.pop(key, None)
        merchant_provenance.update({
            key: value
            for key, value in evidence["provenance"].items()
            if key in _PIN_PROVENANCE_FIELDS
        })
        updated.update({
            "pinterest_pin_id": evidence["pinterest_pin_id"],
            "pinterest_pin_url": evidence["pinterest_pin_url"],
            "evidence_type": evidence["evidence_type"],
            "relationship_method": evidence["relationship_method"],
            "provenance": merchant_provenance,
        })
        updated.setdefault("additional_evidence", []).append(prior_primary)
    else:
        updated.setdefault("additional_evidence", []).append(evidence)
    validate_candidate(updated, now=now)
    return updated


def _verify_pin_direct(hint: dict, pin: dict) -> None:
    if str(pin.get("id") or pin.get("pin_id") or "") != hint["pin_id"]:
        raise ValueError("PinResource identity does not match the requested Pin")
    direct_url = normalize_product_url(extract_direct_outbound_link(pin) or "")
    if direct_url != hint["product_url"]:
        raise ValueError("Pinterest Pin does not directly link to the same PDP")


async def build_manifest(
    candidates: list[dict],
    *,
    fetch_pin: PinFetcher,
    fetch_merchant: MerchantFetcher,
    now: datetime,
    limit: int = MAX_BATCH,
    existing_url_hashes: set[str] | None = None,
) -> tuple[list[dict], list[dict]]:
    if limit < 1 or limit > MAX_BATCH:
        raise ValueError(f"limit must be between 1 and MAX_BATCH={MAX_BATCH}")
    manifest: list[dict] = []
    rejected: list[dict] = []
    manifest_by_product: dict[str, int] = {}
    existing_url_hashes = existing_url_hashes or set()
    # At most `limit` candidates reach either external provider. Invalid local hints
    # do not consume a provider request, but scanning is still bounded by MAX_SCAN_ROWS.
    external_attempts = 0
    for index, raw in enumerate(candidates[:MAX_SCAN_ROWS]):
        try:
            hint = _legacy_hint(raw)
            identity_hash = hashlib.sha256(hint["product_url"].encode("utf-8")).hexdigest()
            if identity_hash in existing_url_hashes:
                raise ValueError("product identity already exists in the current v3.7 catalog")
            if external_attempts >= limit:
                break
            external_attempts += 1
            pin = await fetch_pin(hint["pin_id"])
            if not pin:
                raise ValueError("Pinterest Pin could not be verified")
            # Do not spend a merchant request when Pinterest cannot prove the
            # exact direct relationship first.
            _verify_pin_direct(hint, pin)
            merchant = await fetch_merchant(hint["product_url"])
            row = _raw_manifest_row(hint, pin, merchant, verified_at=now)
            identity = row["canonical_product_url"]
            identity_hash = hashlib.sha256(identity.encode("utf-8")).hexdigest()
            if identity_hash in existing_url_hashes:
                raise ValueError("resolved product identity already exists in the current v3.7 catalog")
            existing_index = manifest_by_product.get(identity)
            if existing_index is not None:
                manifest[existing_index] = _with_additional_evidence(
                    manifest[existing_index], row, now=now
                )
                continue
            manifest_by_product[identity] = len(manifest)
            manifest.append(row)
        except (TypeError, ValueError) as exc:
            rejected.append({"index": index, "legacyId": str(raw.get("id") or "") if isinstance(raw, dict) else "", "reason": str(exc)})
    return manifest, rejected


def load_legacy_candidates(*, scan_limit: int) -> list[dict]:
    if scan_limit < 1 or scan_limit > MAX_SCAN_ROWS:
        raise ValueError(f"scan-limit must be between 1 and {MAX_SCAN_ROWS}")
    from db import DB  # type: ignore

    return DB().select_many(
        "pin_products",
        columns=(
            "id,source_url,canonical_product_url,parent_pin_id,source_pin_id,"
            "product_pin_id,product_type,source_category,discovery_method,lifecycle_status,created_at"
        ),
        order="created_at.desc,id.desc",
        limit=scan_limit,
    )


def load_current_identity_hashes() -> set[str]:
    from db import DB  # type: ignore

    rows = DB().select_many(
        "product_opportunities",
        columns="canonical_url_hash,lifecycle_status",
        filters={"lifecycle_status": "not.eq.retired"},
        order="created_at.asc,id.asc",
    )
    return {
        str(row.get("canonical_url_hash") or "")
        for row in rows
        if str(row.get("canonical_url_hash") or "")
    }


async def _run_live(
    candidates: list[dict],
    *,
    limit: int,
    now: datetime,
    existing_url_hashes: set[str],
) -> tuple[list[dict], list[dict]]:
    proxy = os.environ.get("PINTEREST_PROXY") or None
    async with PinterestSession(proxy=proxy, delay=1.2) as session:
        async def fetch_pin(pin_id: str) -> dict | None:
            rows = await session._fetch_pin_details([pin_id], concurrency=1)
            return next((row for row in rows if str(row.get("id") or row.get("pin_id") or "") == pin_id), None)

        async with httpx.AsyncClient(
            headers=BROWSER_HEADERS,
            follow_redirects=False,
            timeout=httpx.Timeout(10.0),
        ) as merchant_client:
            async def fetch_merchant(url: str) -> MerchantResponse:
                try:
                    current = url
                    redirect_chain: list[dict] = []
                    for _request_number in range(MAX_MERCHANT_REQUESTS):
                        await _assert_public_resolution(current)
                        async with merchant_client.stream("GET", current) as response:
                            if response.is_redirect:
                                location = response.headers.get("location")
                                if not location:
                                    return MerchantResponse(
                                        response.status_code, b"", str(response.url),
                                        redirect_chain=tuple(redirect_chain),
                                    )
                                target = urljoin(str(response.url), location)
                                redirect_chain.append({
                                    "status": response.status_code,
                                    "from": normalize_product_url(str(response.url)),
                                    "to": normalize_product_url(target),
                                })
                                current = target
                                continue
                            chunks: list[bytes] = []
                            total = 0
                            async for chunk in response.aiter_bytes():
                                total += len(chunk)
                                if total > MAX_MERCHANT_BYTES:
                                    return MerchantResponse(
                                        413, b"", str(response.url),
                                        response.headers.get("content-type", ""),
                                        tuple(redirect_chain),
                                    )
                                chunks.append(chunk)
                            return MerchantResponse(
                                response.status_code,
                                b"".join(chunks),
                                str(response.url),
                                response.headers.get("content-type", ""),
                                tuple(redirect_chain),
                            )
                    return MerchantResponse(310, b"", current, redirect_chain=tuple(redirect_chain))
                except httpx.HTTPError:
                    return MerchantResponse(0, b"", url, redirect_chain=())

            return await build_manifest(
                candidates,
                fetch_pin=fetch_pin,
                fetch_merchant=fetch_merchant,
                now=now,
                limit=limit,
                existing_url_hashes=existing_url_hashes,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="optional JSON array of legacy pin_products rows")
    parser.add_argument("--output", type=Path, required=True, help="local JSON admission manifest")
    parser.add_argument("--limit", type=int, default=MAX_BATCH)
    parser.add_argument("--scan-limit", type=int, default=100)
    args = parser.parse_args()
    try:
        if args.input:
            candidates = json.loads(args.input.read_text(encoding="utf-8"))
            if not isinstance(candidates, list):
                raise ValueError("input root must be an array")
            if len(candidates) > MAX_SCAN_ROWS:
                raise ValueError(f"input exceeds MAX_SCAN_ROWS={MAX_SCAN_ROWS}")
        else:
            candidates = load_legacy_candidates(scan_limit=args.scan_limit)
        existing_url_hashes = load_current_identity_hashes()
        manifest, rejected = asyncio.run(
            _run_live(
                candidates,
                limit=args.limit,
                now=datetime.now(timezone.utc),
                existing_url_hashes=existing_url_hashes,
            )
        )
        args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        print(json.dumps({
            "mode": "read-only-manifest",
            "candidateRows": len(candidates),
            "eligibleRows": len(manifest),
            "additionalEvidenceRows": sum(
                len(row.get("additional_evidence", [])) for row in manifest
            ),
            "rejectedRows": len(rejected),
            "rejections": rejected,
            "maxBatch": MAX_BATCH,
            "databaseWrites": 0,
            "existingCurrentIdentities": len(existing_url_hashes),
            "output": str(args.output),
        }, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"manifest build failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
