"""
opportunity_readiness.py — MVP launch readiness tiers, status, and label adjustments.

Pure functions; safe to mirror in web/src/lib/opportunityReadiness.ts.
"""

from __future__ import annotations

from typing import Any

# ── Availability tiers ───────────────────────────────────────────────────────

def availability_tier(count: int) -> str:
    if count <= 0:
        return "none"
    if count <= 4:
        return "weak"
    if count <= 14:
        return "testable"
    if count <= 49:
        return "strong"
    return "deep"


def count_usable_products(products: list[dict], keyword_category: str | None) -> dict[str, int]:
    """Quality-weighted product counts for readiness."""
    with_url = 0
    with_image = 0
    category_match = 0
    usable = 0
    for p in products:
        has_url = bool((p.get("source_url") or p.get("product_url") or "").strip())
        has_img = bool((p.get("image_url") or "").strip())
        has_title = bool((p.get("product_name") or p.get("title") or "").strip())
        p_cat = (p.get("category") or p.get("seed_category") or "").lower()
        kw_cat = (keyword_category or "").lower()
        if has_url:
            with_url += 1
        if has_img:
            with_image += 1
        if kw_cat and p_cat and (p_cat == kw_cat or kw_cat in p_cat or p_cat in kw_cat):
            category_match += 1
        if has_img and has_title and (has_url or has_title):
            usable += 1
    return {
        "linkedProductsCount": len(products),
        "productsWithUrlCount": with_url,
        "productsWithImageCount": with_image,
        "productCategoryMatchCount": category_match,
        "usableProductsCount": usable,
    }


def effective_product_count(counts: dict[str, int]) -> int:
    """Prefer URL+image products; fall back to raw linked count."""
    u = counts.get("usableProductsCount", 0)
    if u > 0:
        return u
    img = counts.get("productsWithImageCount", 0)
    if img > 0:
        return img
    return counts.get("linkedProductsCount", 0)


def compute_readiness_status(
    *,
    product_tier: str,
    reference_tier: str,
    pin_evidence_count: int,
    trend_score: float,
    rising: bool,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    eff_products = product_tier

    if product_tier in ("none", "weak"):
        if rising and trend_score >= 50:
            reasons.append("Strong trend signal but product supply is weak")
            return "needs_products", reasons
        if pin_evidence_count >= 5:
            reasons.append("Pin evidence exists but fewer than 5 usable products")
            return "insight_only", reasons
        reasons.append("No or minimal product signals linked to this keyword")
        return "needs_products" if product_tier == "weak" else "insight_only", reasons

    if product_tier == "testable":
        if pin_evidence_count >= 3:
            reasons.append("5–14 usable products with supporting pin evidence")
            return "testable", reasons
        reasons.append("Product supply is testable but pin evidence is thin")
        return "testable", reasons

    if product_tier in ("strong", "deep") and reference_tier in ("testable", "strong", "deep"):
        if product_tier == "deep" and rising and pin_evidence_count >= 10:
            reasons.append("Deep product catalog, strong trend, and solid pin evidence")
            return "strong_opportunity", reasons
        reasons.append("15+ products and 5+ reference-eligible pins")
        return "launch_ready", reasons

    if product_tier in ("strong", "deep"):
        reasons.append("Strong product supply; reference pin depth still building")
        return "launch_ready" if reference_tier != "none" else "testable", reasons

    reasons.append("Insufficient combined product and reference signals")
    return "testable", reasons


def adjust_primary_label(
    base_label: str,
    readiness_status: str,
    product_tier: str,
) -> str:
    """Never show Best Bet without at least testable product supply."""
    if base_label != "Best Bet":
        return base_label
    if product_tier in ("none", "weak"):
        return "Steady"
    if readiness_status in ("insight_only", "needs_products"):
        return "Steady"
    if readiness_status == "testable":
        return "Steady"
    return base_label


def adjust_trend_state_display(
    base_trend_state: str,
    readiness_status: str,
    rising: bool,
) -> str:
    if readiness_status in ("needs_products", "insight_only") and rising:
        if readiness_status == "insight_only":
            return "Insight Only"
        return "Rising · Needs Products"
    return base_trend_state


def readiness_score_adjustment(
    base_score: float,
    *,
    product_tier: str,
    reference_tier: str,
    products_with_url: int,
    products_with_image: int,
    category_match: int,
) -> float:
    """Boost/penalize opportunity score based on product availability (0–100 scale)."""
    adj = 0.0
    tier_boost = {
        "none": -18,
        "weak": -10,
        "testable": 4,
        "strong": 12,
        "deep": 18,
    }
    adj += tier_boost.get(product_tier, 0)
    ref_boost = {"none": -4, "weak": 0, "testable": 3, "strong": 6, "deep": 8}
    adj += ref_boost.get(reference_tier, 0)
    adj += min(products_with_url, 5) * 1.5
    adj += min(products_with_image, 5) * 1.0
    adj += min(category_match, 5) * 0.8
    return round(min(100.0, max(0.0, base_score + adj)), 2)


def build_readiness_payload(
    *,
    opportunity_id: str | None,
    keyword_id: str,
    category: str | None,
    pin_evidence_count: int,
    reference_eligible_count: int,
    total_saves: int,
    avg_save_velocity: float | None,
    trend_score: float,
    freshness_score: float,
    products: list[dict],
    percentile_metrics: dict[str, Any] | None = None,
    rising: bool = False,
) -> dict[str, Any]:
    counts = count_usable_products(products, category)
    eff = effective_product_count(counts)
    product_tier = availability_tier(eff)
    reference_tier = availability_tier(reference_eligible_count)

    status, reasons = compute_readiness_status(
        product_tier=product_tier,
        reference_tier=reference_tier,
        pin_evidence_count=pin_evidence_count,
        trend_score=trend_score,
        rising=rising,
    )

    payload: dict[str, Any] = {
        "opportunityId": opportunity_id,
        "keywordId": keyword_id,
        "category": category,
        "pinEvidenceCount": pin_evidence_count,
        "referenceEligibleCount": reference_eligible_count,
        "totalSaves": total_saves,
        "avgSaveVelocity": avg_save_velocity,
        "trendScore": round(trend_score, 2),
        "freshnessScore": round(freshness_score, 2),
        "linkedProductsCount": counts["linkedProductsCount"],
        "productsWithUrlCount": counts["productsWithUrlCount"],
        "productsWithImageCount": counts["productsWithImageCount"],
        "productCategoryMatchCount": counts["productCategoryMatchCount"],
        "usableProductsCount": counts["usableProductsCount"],
        "effectiveProductCount": eff,
        "productAvailabilityTier": product_tier,
        "referenceAvailabilityTier": reference_tier,
        "readinessStatus": status,
        "readinessReasons": reasons,
    }
    if percentile_metrics:
        payload.update(percentile_metrics)
    return payload
