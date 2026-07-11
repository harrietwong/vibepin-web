#!/usr/bin/env python3
"""Generate category test records for all 5 categories."""
import re
import sys
import prompt_enhancer as pe

PLANS = {
    "fashion": {
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
            "Style the lace camisole and denim jeans as an aspirational summer outfit flat lay "
            "on a clean neutral textile backdrop, folded and arranged with a few minimal accessories, "
            "soft daylight, editorial fashion mood, apparel as the clear hero."
        ),
        "negative_constraints": ["no faces", "no clutter"],
    },
    "home-decor": {
        "product_constraints": [
            {"product_index": 1, "description": "stoneware ceramic vase, matte cream glaze",
             "must_preserve": ["matte finish", "organic shape"]},
        ],
        "reference_style": {
            "scene_type": "styled shelf vignette in a cozy living room",
            "lighting": "warm window light", "mood": "cozy",
            "palette": ["cream", "oak"], "composition": "rule of thirds",
            "visual_density": "richly layered",
            "styling_cues": ["stacked books", "trailing plant", "woven texture"],
        },
        "scene_plan": "A cozy shelf vignette featuring the vase among interior decor.",
        "visual_prompt": (
            "Place the ceramic vase on a styled wooden shelf within a cozy living room interior, "
            "surrounded by stacked books, a trailing plant, and warm window light, home decor mood."
        ),
        "negative_constraints": ["no clutter"],
    },
    "beauty": {
        "product_constraints": [
            {"product_index": 1, "description": "vitamin C brightening serum, amber glass dropper bottle",
             "must_preserve": ["amber glass", "gold dropper cap", "minimalist label"]},
        ],
        "reference_style": {
            "scene_type": "clean beauty product flatlay on marble",
            "lighting": "soft diffused studio light", "mood": "clinical luxury",
            "palette": ["white", "gold", "amber"], "composition": "centered product hero",
            "visual_density": "minimal",
            "styling_cues": ["botanicals", "marble surface", "soft shadows"],
        },
        "scene_plan": "Clean beauty hero shot of the serum on marble with botanical accents.",
        "visual_prompt": (
            "Photograph the amber serum dropper bottle centered on a white marble surface, "
            "surrounded by a few dried botanicals, soft diffused studio light, "
            "clean luxury skincare aesthetic."
        ),
        "negative_constraints": ["no faces", "no clutter"],
    },
    "food-and-drink": {
        "product_constraints": [
            {"product_index": 1, "description": "artisan cold brew coffee bottle, kraft label",
             "must_preserve": ["bottle shape", "kraft label design", "dark liquid color"]},
        ],
        "reference_style": {
            "scene_type": "cafe tabletop product photography",
            "lighting": "natural window light", "mood": "warm rustic",
            "palette": ["brown", "cream", "terracotta"], "composition": "editorial tabletop",
            "visual_density": "moderately styled",
            "styling_cues": ["coffee beans", "linen napkin", "ceramic mug"],
        },
        "scene_plan": "Rustic cafe tabletop with the cold brew bottle as hero.",
        "visual_prompt": (
            "Style the cold brew bottle on a wooden cafe table with scattered coffee beans, "
            "a ceramic mug, and a linen napkin, warm natural window light, "
            "editorial food and drink photography."
        ),
        "negative_constraints": ["no clutter"],
    },
    "digital-products": {
        "product_constraints": [
            {"product_index": 1,
             "description": "weekly planner printable PDF template, pastel minimal design",
             "must_preserve": ["pastel color palette", "grid layout", "clean typography"]},
        ],
        "reference_style": {
            "scene_type": "digital product mockup on tablet and desk",
            "lighting": "bright airy", "mood": "productive minimal",
            "palette": ["white", "sage", "blush"], "composition": "flat lay with device",
            "visual_density": "clean",
            "styling_cues": ["iPad mockup", "printed sheets", "pen", "coffee cup"],
        },
        "scene_plan": "Clean desk mockup showing the planner on tablet plus printed.",
        "visual_prompt": (
            "Display the pastel weekly planner template on a white iPad screen on a clean desk, "
            "with a few printed sheets, a fine-liner pen, and a small coffee cup, "
            "bright airy light, minimal productivity aesthetic."
        ),
        "negative_constraints": ["no clutter"],
    },
}

OUTPUT_TYPES = {
    "fashion": "editorial",
    "home-decor": "lifestyle",
    "beauty": "lifestyle",
    "food-and-drink": "lifestyle",
    "digital-products": "lifestyle",
}

_HOME_DRIFT_TERMS = [
    "candle", "vase", "bedroom", "living room", "sofa", "couch",
    "interior", "home decor", "furniture", "throw blanket", "nightstand", "room decor",
]
_NEGATIVE_MARKERS = [
    "do not", "don't", "avoid", "hard constraint", "not convert",
    "non-fashion", "zero text", "no watermark", "unless the user", "fashion category",
]


def positive_body(text):
    segments = re.split(r"(?<=[.!?])\s+|\n+", text)
    kept = [s for s in segments if not any(m in s.lower() for m in _NEGATIVE_MARKERS)]
    return " ".join(kept).lower()


def drift_terms(text):
    body = positive_body(text)
    return [t for t in _HOME_DRIFT_TERMS if t in body]


EXPECTED_PASS = {
    "fashion":          {"drift_allowed": False, "must_contain": ["fashion", "apparel", "outfit", "lookbook"]},
    "home-decor":       {"drift_allowed": True,  "must_contain": ["interior", "shelf", "living room", "home decor", "cozy"]},
    "beauty":           {"drift_allowed": False, "must_contain": ["serum", "skincare", "beauty", "marble", "botanicals"]},
    "food-and-drink":   {"drift_allowed": False, "must_contain": ["coffee", "tabletop", "food", "cafe", "drink"]},
    "digital-products": {"drift_allowed": False, "must_contain": ["planner", "mockup", "template", "tablet", "digital"]},
}

all_passed = True

for cat, plan in PLANS.items():
    det = pe._detect_category_from_plan(plan)
    eff, detected_via_resolve = pe._resolve_effective_category("", plan)
    fp = pe._render_final_prompt(plan, OUTPUT_TYPES[cat], None, False, "2:3", "moderate", eff)
    drift = drift_terms(fp)
    fp_low = fp.lower()

    exp = EXPECTED_PASS[cat]
    det_ok = (det == cat)
    eff_ok = (eff == cat)
    drift_ok = exp["drift_allowed"] or not drift
    content_ok = any(w in fp_low for w in exp["must_contain"])

    status = "PASS" if (det_ok and eff_ok and drift_ok and content_ok) else "FAIL"
    if status == "FAIL":
        all_passed = False

    guardrails = []
    if "FASHION CATEGORY" in fp:
        guardrails.append("fashion_category_header")
    if "HARD CONSTRAINT" in fp:
        guardrails.append("fashion_hard_constraint")
    if "BEAUTY CATEGORY" in fp.upper():
        guardrails.append("beauty_category_header")

    print(f"{'='*60}")
    print(f"Category Test Record: {cat.upper()}")
    print(f"{'='*60}")
    print(f"  Test name             : {cat} generation audit")
    print(f"  Frontend category     : \"\" (empty — Remix bug condition)")
    print(f"  Detected category     : {det!r}  {'OK' if det_ok else 'FAIL'}")
    print(f"  Effective category    : {eff!r}  {'OK' if eff_ok else 'FAIL'}")
    print(f"  Output type           : {OUTPUT_TYPES[cat]!r}")
    print(f"  Aspect ratio          : 2:3")
    print(f"  Model                 : prompt-construction test (no live model)")
    print(f"  Guardrails applied    : {guardrails if guardrails else 'none (non-fashion)'}")
    print(f"  Home-decor drift      : {drift if drift else 'none'}  {'OK' if drift_ok else 'FAIL'}")
    print(f"  Content keywords OK   : {content_ok}  (checked: {exp['must_contain']})")
    print(f"  Category source       : VLM plan (frontend sent empty, upgraded)")
    print(f"  Recovery status       : not applicable (prompt-construction test only)")
    print(f"  Overall status        : {status}")
    print()
    print(f"  --- Final Prompt Preview (first 500 chars) ---")
    print(f"  {fp[:500].replace(chr(10), chr(10) + '  ')}")
    print()

print(f"{'='*60}")
print(f"SUMMARY: {'ALL PASSED' if all_passed else 'SOME FAILED'}")
print(f"{'='*60}")
sys.exit(0 if all_passed else 1)
