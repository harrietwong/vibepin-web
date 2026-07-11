#!/usr/bin/env python3
"""
Model-routing self-test for the GPT Image / Gemini Image switch.

Verifies provider routing + image-input capability + the no-silent-fallback
config error, all WITHOUT any network call.

Run:  py backend/test_model_routing.py
"""
import asyncio
import io
import json
import sys

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


def provider_endpoint(model_id: str, has_images: bool) -> str:
    ml = model_id.lower()
    if has_images and "gpt-image" in ml:
        return "/images/edits"
    if "gpt-image" in ml:
        return "/images/generations"
    if "gemini" in ml:
        return "native:generateContent"
    return "chat.completions"


print("\n=== Model routing — self-test ===\n")

# ── A. GPT Image with product + reference ─────────────────────────────────────
gpt_id = gen._resolve_model_id("gpt_image")
check("A: gpt_image → a gpt-image model", "gpt-image" in gpt_id.lower(), gpt_id)
check("A: gpt_image supports image inputs", gen._model_supports_image_input(gpt_id))
check("A: gpt_image + images → /images/edits", provider_endpoint(gpt_id, True) == "/images/edits")

# ── B. Gemini Image with product + reference (configured) ─────────────────────
orig = dict(gen._MODEL_KEY_TO_MODEL_ID)
gen._MODEL_KEY_TO_MODEL_ID["gemini_image"] = "gemini-3.1-flash-image-preview"
gem_id = gen._resolve_model_id("gemini_image")
check("B: gemini_image → a gemini model", "gemini" in gem_id.lower(), gem_id)
check("B: gemini_image supports image inputs", gen._model_supports_image_input(gem_id))
check("B: gemini path → native generateContent", provider_endpoint(gem_id, True) == "native:generateContent")

# ── D. Ordering — products first, reference last; total = 4 ───────────────────
ordering = gen._input_ordering(3, True)
check("D: 4 inputs total (3 products + 1 reference)", len(ordering) == 4, str(ordering))
check("D: positions 1-3 are products", all(o["role"] == "product" for o in ordering[:3]))
check("D: reference is last (position 4)", ordering[3] == {"position": 4, "role": "reference"}, str(ordering[3]))

# capability: a text/chat-only model must NOT be treated as image-capable
check("capability: text/chat model rejects image inputs", not gen._model_supports_image_input("gpt-4o-mini"))

# ── C. Missing Gemini env → clear config error, no fallback ───────────────────
gen._MODEL_KEY_TO_MODEL_ID["gemini_image"] = ""
check("C: unconfigured gemini_image resolves to empty id", gen._resolve_model_id("gemini_image") == "")

# Full offline path: run_from_stdin must emit a configuration error (no network).
emitted: dict = {}
orig_emit = gen._emit
gen._emit = lambda obj: emitted.update(obj)          # type: ignore[assignment]
orig_key = gen.LINAPI_KEY
gen.LINAPI_KEY = "test-key"                            # pass the LINAPI_KEY gate
orig_stdin = sys.stdin
sys.stdin = io.StringIO(json.dumps({
    "keyword": "summer outfit",
    "count": 2,
    "model_key": "gemini_image",
    "product_images": ["data:image/jpeg;base64,AAAA"],
    "style_ref": "https://example.com/street.jpg",
    "prompt_mode": "creative_direction_v2",
    "prompt": "REFERENCE REQUIREMENTS (HIGHEST PRIORITY): ...",
}))
try:
    asyncio.run(gen.run_from_stdin())
finally:
    sys.stdin = orig_stdin
    gen._emit = orig_emit
    gen.LINAPI_KEY = orig_key
    gen._MODEL_KEY_TO_MODEL_ID.clear()
    gen._MODEL_KEY_TO_MODEL_ID.update(orig)

check("C: emits ok=False", emitted.get("ok") is False, str(emitted))
check("C: error message is the config error",
      emitted.get("error") == "Gemini image model is not configured.", str(emitted.get("error")))
check("C: error_type is configuration_error", emitted.get("error_type") == "configuration_error")
check("C: no urls returned (no fallback)", not emitted.get("urls"))

print(f"\n{passed} passed, {failed} failed\n")
sys.exit(1 if failed else 0)
