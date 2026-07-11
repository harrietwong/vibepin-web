#!/usr/bin/env python3
"""
Self-test for the fashion → home-decor generation bug fix.

Verifies the prompt-construction pipeline deterministically (no live API calls):
  1. _detect_category_from_plan recovers the real category from the VLM analysis
  2. _resolve_effective_category trusts the frontend but upgrades empty/generic
  3. _render_final_prompt produces fashion language with no home-decor scene drift
  4. enhance() (cache-hit path) returns detected_category=fashion + a clean prompt
  5. generator._build_prompt_with_images keeps fashion fashion, and home decor home

Run:  py backend/test_fashion_category_fix.py
"""
import asyncio
import re
import sys

import prompt_enhancer as pe
import generator as gen

passed = 0
failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        print(f"  OK   {name}")
        passed += 1
    else:
        print(f"  FAIL {name}" + (f"\n       {detail}" if detail else ""))
        failed += 1


# Home-decor terms that, if they appear in the *positive* scene description,
# indicate the fashion batch drifted into home decor.
_HOME_DRIFT_TERMS = [
    "candle", "vase", "bedroom", "living room", "sofa", "couch", "interior",
    "home decor", "furniture", "throw blanket", "nightstand", "room decor",
]
# Sentences containing these are guardrails / negative constraints — they
# legitimately MENTION home-decor words in order to forbid them, so we exclude
# them when checking the positive scene body.
_NEGATIVE_MARKERS = [
    "do not", "don't", "avoid", "hard constraint", "not convert", "non-fashion",
    "zero text", "no watermark", "unless the user", "fashion category",
]


def positive_body(text: str) -> str:
    """Return the prompt text with guardrail / negative sentences stripped out."""
    segments = re.split(r"(?<=[.!?])\s+|\n+", text)
    kept = [s for s in segments if not any(m in s.lower() for m in _NEGATIVE_MARKERS)]
    return " ".join(kept).lower()


def home_drift_terms_in(text: str) -> list[str]:
    body = positive_body(text)
    return [t for t in _HOME_DRIFT_TERMS if t in body]


# ── Fixtures ────────────────────────────────────────────────────────────────
FASHION_PLAN = {
    "product_constraints": [
        {"product_index": 1, "description": "white lace camisole top, delicate scalloped trim",
         "must_preserve": ["lace texture", "ivory color", "spaghetti straps"]},
        {"product_index": 2, "description": "high-waisted blue denim jeans, straight leg",
         "must_preserve": ["denim wash", "silhouette"]},
    ],
    "reference_style": {
        "scene_type": "fashion editorial outfit styling board",
        "lighting": "soft daylight", "mood": "elevated streetwear",
        "palette": ["ivory", "indigo"], "composition": "centered flat lay",
        "visual_density": "moderately styled",
        "styling_cues": ["folded denim", "layered apparel", "minimal accessories"],
    },
    "scene_plan": "An aspirational summer outfit flat lay pairing the camisole with denim.",
    "visual_prompt": (
        "Style the lace camisole and denim jeans as an aspirational summer outfit flat lay on a "
        "clean neutral textile backdrop, folded and arranged with a few minimal accessories, soft "
        "daylight, editorial fashion mood, apparel as the clear hero."
    ),
    "negative_constraints": ["no faces", "no clutter"],
    "summary_for_ui": {"scene": "outfit flat lay", "style": "editorial fashion",
                       "layout": "centered", "products": "camisole + jeans featured"},
}

HOME_PLAN = {
    "product_constraints": [
        {"product_index": 1, "description": "stoneware ceramic vase, matte cream glaze",
         "must_preserve": ["matte finish", "organic shape"]},
    ],
    "reference_style": {
        "scene_type": "styled shelf vignette in a cozy living room",
        "lighting": "warm window light", "mood": "cozy", "palette": ["cream", "oak"],
        "composition": "rule of thirds", "visual_density": "richly layered",
        "styling_cues": ["stacked books", "trailing plant", "woven texture"],
    },
    "scene_plan": "A cozy shelf vignette featuring the vase among interior decor.",
    "visual_prompt": (
        "Place the ceramic vase on a styled wooden shelf within a cozy living room interior, "
        "surrounded by stacked books, a trailing plant, and warm window light, home decor mood."
    ),
    "negative_constraints": ["no clutter"],
    "summary_for_ui": {"scene": "shelf vignette", "style": "cozy interior",
                       "layout": "layered", "products": "vase featured"},
}


# ── Test 1: category detection from the VLM plan ──────────────────────────────
def test_detection():
    check("detect fashion from product descriptions",
          pe._detect_category_from_plan(FASHION_PLAN) == "fashion",
          f"got {pe._detect_category_from_plan(FASHION_PLAN)!r}")
    check("detect home-decor from product descriptions",
          pe._detect_category_from_plan(HOME_PLAN) == "home-decor",
          f"got {pe._detect_category_from_plan(HOME_PLAN)!r}")
    beauty_plan = {"product_constraints": [{"description": "vitamin C serum dropper bottle",
                                            "must_preserve": ["amber glass"]}]}
    check("detect beauty from product descriptions",
          pe._detect_category_from_plan(beauty_plan) == "beauty",
          f"got {pe._detect_category_from_plan(beauty_plan)!r}")
    check("undetectable plan returns empty",
          pe._detect_category_from_plan({"product_constraints": []}) == "")


# ── Test 2: effective category resolution ─────────────────────────────────────
def test_resolution():
    # frontend sent nothing → upgrade from VLM
    eff, det = pe._resolve_effective_category("", FASHION_PLAN)
    check("empty category upgraded to fashion", eff == "fashion" and det == "fashion",
          f"eff={eff!r} det={det!r}")
    # frontend sent generic → upgrade from VLM
    eff, det = pe._resolve_effective_category("generic", FASHION_PLAN)
    check("generic category upgraded to fashion", eff == "fashion" and det == "fashion",
          f"eff={eff!r} det={det!r}")
    # frontend sent a specific category → trust it, no override
    eff, det = pe._resolve_effective_category("home-decor", FASHION_PLAN)
    check("explicit home-decor is trusted (not overridden)", eff == "home-decor" and det == "",
          f"eff={eff!r} det={det!r}")


# ── Test 3: final prompt rendering ────────────────────────────────────────────
def test_render():
    fp = pe._render_final_prompt(FASHION_PLAN, "editorial", None, False, "2:3", "moderate", "fashion")
    low = fp.lower()
    check("fashion render contains fashion language",
          any(w in low for w in ("fashion", "apparel", "outfit", "lookbook")))
    drift = home_drift_terms_in(fp)
    check("fashion render has NO home-decor scene drift", not drift,
          f"drift terms in positive body: {drift}\n---PROMPT---\n{fp}")
    check("fashion render includes the hard anti-drift constraint",
          "do not convert" in low or "do not" in low and "home decor" in low)

    # Control: home-decor must KEEP interior language
    hp = pe._render_final_prompt(HOME_PLAN, "lifestyle", None, False, "2:3", "moderate", "home-decor")
    hlow = hp.lower()
    check("home-decor render keeps interior/home language",
          any(w in hlow for w in ("interior", "shelf", "living room", "home decor", "cozy")),
          f"---PROMPT---\n{hp}")


# ── Test 4: enhance() cache-hit integration (no network) ──────────────────────
async def test_enhance_integration():
    pe.ENHANCER_MODEL = "test-model"
    pe.LINAPI_KEY = "test-key"
    prod = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"]
    refs = ["https://example.com/fashion-ref.jpg"]
    meta = [{"title": ""}, {"title": ""}]  # Remix recovers products with empty titles
    output_type = "lifestyle"
    incoming_category = ""  # the bug condition: Remix lost the category

    # Seed the cache with the fashion plan under the exact key enhance() will compute.
    ckey = pe._cache_key(prod, refs, meta, output_type, incoming_category)
    pe._save_cache(ckey, FASHION_PLAN)

    result = await pe.enhance(
        product_image_urls=prod, reference_image_urls=refs, user_raw_text=None,
        output_type=output_type, reference_strength="moderate", text_overlay=False,
        fmt="2:3", product_metadata=meta, category=incoming_category,
    )
    check("enhance() cache hit", result.get("cache_hit") is True)
    check("enhance() detected_category == fashion", result.get("detected_category") == "fashion",
          f"got {result.get('detected_category')!r}")
    check("enhance() effective_category == fashion", result.get("effective_category") == "fashion",
          f"got {result.get('effective_category')!r}")
    fp = result.get("final_prompt", "")
    drift = home_drift_terms_in(fp)
    check("enhance() final_prompt has NO home-decor drift", not drift,
          f"drift: {drift}\n---PROMPT---\n{fp}")
    check("enhance() final_prompt is fashion-focused",
          any(w in fp.lower() for w in ("fashion", "apparel", "outfit")))

    # Category-aware fallback (VLM unavailable) must still be fashion-anchored.
    fb = pe._fallback_result(None, False, "2:3", "test", "fashion")
    check("fallback is category-aware (fashion)",
          "fashion" in fb["final_prompt"].lower() and not home_drift_terms_in(fb["final_prompt"]),
          f"---PROMPT---\n{fb['final_prompt']}")


# ── Test 5: generator-level prompt build ──────────────────────────────────────
def test_generator_build():
    neutral_prompt = ("Create a Pinterest-native product Pin. Use the uploaded product images as "
                      "the main items. Place the products naturally in a clean, aesthetic "
                      "Pinterest-native scene. No text overlay. Vertical 2:3 format.")
    # Reproduce the original bug condition: empty category + neutral prompt + no titles → generic
    inferred = gen._infer_category("", "lifestyle", neutral_prompt, [{"title": ""}, {"title": ""}])
    check("generator inference returns 'generic' for neutral fashion input (bug condition)",
          inferred == "generic", f"got {inferred!r}")

    # After the VLM feedback loop upgrades category → fashion, the built prompt is fashion-safe.
    enhancer_fashion_prompt = pe._render_final_prompt(
        FASHION_PLAN, "editorial", None, False, "2:3", "moderate", "fashion")
    built = gen._build_prompt_with_images(
        keyword="summer outfit", style="editorial", product_count=2, has_ref=True,
        custom_prompt=enhancer_fashion_prompt, category="fashion", ref_at_end=True, pin_format="2:3")
    blow = built.lower()
    check("generator fashion build contains fashion language",
          any(w in blow for w in ("fashion", "apparel", "outfit", "wardrobe")))
    check("generator fashion build has NO home-decor scene drift",
          not home_drift_terms_in(built),
          f"drift: {home_drift_terms_in(built)}\n---PROMPT---\n{built[:1200]}")
    hits = gen._home_decor_term_hits(positive_body(built))
    check("generator home_decor_check clean in positive body",
          not any(hits.values()), f"hits={ {k:v for k,v in hits.items() if v} }")

    # Control: home-decor build keeps interior language and is not mangled.
    enhancer_home_prompt = pe._render_final_prompt(
        HOME_PLAN, "lifestyle", None, False, "2:3", "moderate", "home-decor")
    built_home = gen._build_prompt_with_images(
        keyword="cozy shelf", style="lifestyle", product_count=1, has_ref=True,
        custom_prompt=enhancer_home_prompt, category="home-decor", ref_at_end=True, pin_format="2:3")
    check("generator home-decor build keeps interior/home language",
          any(w in built_home.lower() for w in ("interior", "shelf", "room", "home decor", "cozy")),
          f"---PROMPT---\n{built_home[:1200]}")


async def main():
    print("\n=== Fashion category fix — self-test ===\n")
    test_detection()
    test_resolution()
    test_render()
    await test_enhance_integration()
    test_generator_build()
    print(f"\n{passed} passed, {failed} failed\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
