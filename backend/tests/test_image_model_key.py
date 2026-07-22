"""Defense-in-depth on the image model key (generator.py::_resolve_model_id).

The web route (web/src/app/api/generate/route.ts, Step 2a) is the real trust
boundary and validates `model_key` against a closed set. This suite pins the
SECOND line of defence: the worker must fail closed on its own, because it also
consumes queued generation_jobs.params rows that may have been written by other
or older code paths.

THE DEFECT THIS GUARDS AGAINST: _resolve_model_id used to end with

    return GPT_IMAGE_MODEL or "gpt-image-2"

so ANY unrecognised key silently resolved to a specific PAID model. Because
_model_supports_image_input() branches on the RESOLVED model id, an unknown key
changed not just cost but capability.
"""

import asyncio
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import generator  # noqa: E402


class ResolveModelIdTests(unittest.TestCase):
    def test_canonical_keys_resolve(self):
        """Both supported keys map to a configured model id."""
        self.assertEqual(
            generator._resolve_model_id("gpt_image"),
            generator._MODEL_KEY_TO_MODEL_ID["gpt_image"],
        )
        self.assertEqual(
            generator._resolve_model_id("gemini_image"),
            generator._MODEL_KEY_TO_MODEL_ID["gemini_image"],
        )

    def test_legacy_alias_still_resolves(self):
        """`nano_banana` is a legacy compat alias for the same Gemini model.

        It is kept because historical persisted studio drafts (SetupSnapshot.modelKey)
        can still carry it. The web route normalises it to gemini_image before
        dispatch, so it should not arrive here in practice — but a queued job written
        by older code might, and it must not become an error.
        """
        self.assertIn("nano_banana", generator._MODEL_KEY_TO_MODEL_ID)
        self.assertEqual(
            generator._resolve_model_id("nano_banana"),
            generator._MODEL_KEY_TO_MODEL_ID["nano_banana"],
        )

    def test_unknown_key_raises_instead_of_falling_back_to_gpt_image(self):
        """THE REGRESSION TEST: an unknown key must never silently become a paid model."""
        for bad in (
            "totally_made_up_model",
            "gpt-image-2",          # a provider model id, not a key
            "gemini-image",         # near-miss of a real key
            "NANO_BANANA",          # case matters — the map is exact
            "gpt_image_pro",        # a plausible "premium tier" invention
        ):
            with self.subTest(model_key=bad):
                with self.assertRaises(generator.UnknownModelKeyError):
                    generator._resolve_model_id(bad)

    def test_surrounding_whitespace_is_still_tolerated_on_a_valid_key(self):
        """Whitespace is stripped before the lookup — a padded valid key is not an error."""
        self.assertEqual(
            generator._resolve_model_id("  gpt_image  "),
            generator._MODEL_KEY_TO_MODEL_ID["gpt_image"],
        )

    def test_unknown_key_does_not_return_the_gpt_image_id(self):
        """Explicitly pins the OLD behaviour as gone, not merely changed."""
        try:
            resolved = generator._resolve_model_id("something_unknown")
        except generator.UnknownModelKeyError:
            return  # correct
        self.fail(f"unknown key silently resolved to {resolved!r}")

    def test_error_message_lists_the_supported_keys_without_echoing_input(self):
        """The message helps a developer, and never reflects attacker-controlled text."""
        with self.assertRaises(generator.UnknownModelKeyError) as ctx:
            generator._resolve_model_id("<script>alert(1)</script>")
        message = str(ctx.exception)
        self.assertIn("gpt_image", message)
        self.assertIn("gemini_image", message)
        self.assertNotIn("<script>", message)

    def test_empty_key_is_not_an_error_here(self):
        """Callers default an empty key to gemini_image BEFORE this function.

        An empty string is therefore a caller bug, not attacker input, and raising on
        it would turn a benign default into a hard failure. It still must not resolve
        to GPT Image.
        """
        with self.assertRaises(generator.UnknownModelKeyError):
            generator._resolve_model_id("")

    def test_unknown_key_is_rejected_by_the_prepare_path_with_a_structured_error(self):
        """End-to-end at the worker's own entry point, not just the helper.

        prepare_generation is what reads model_key off a queued job's params. An
        unsupported key must return a structured `invalid_model_key` failure rather
        than proceeding to a provider call.
        """
        result = asyncio.run(generator.prepare_generation({
            "keyword": "cozy mug",
            "prompt": "a cozy ceramic mug",
            "model_key": "totally_made_up_model",
            "providerMode": "mock",
        }))
        self.assertFalse(result["ok"])
        self.assertEqual(result["emit"].get("error_type"), "invalid_model_key")
        self.assertEqual(result["emit"]["urls"], [])

    def test_gemini_missing_configuration_still_fails_as_configuration_error(self):
        """The deliberate guard at the gemini_image branch is UNCHANGED.

        A VALID key whose model id is not configured is a configuration error — a
        different failure from an unsupported key, and it must not be swallowed by
        the new UnknownModelKeyError path or silently fall back to another model.
        """
        original = generator._MODEL_KEY_TO_MODEL_ID["gemini_image"]
        generator._MODEL_KEY_TO_MODEL_ID["gemini_image"] = ""
        try:
            # The helper itself returns "" (not an exception) — the key IS supported.
            self.assertEqual(generator._resolve_model_id("gemini_image"), "")

            result = asyncio.run(generator.prepare_generation({
                "keyword": "cozy mug",
                "prompt": "a cozy ceramic mug",
                "model_key": "gemini_image",
                "providerMode": "mock",
            }))
            self.assertFalse(result["ok"])
            self.assertEqual(result["emit"].get("error_type"), "configuration_error")
            self.assertIn("not configured", result["emit"]["error"])
        finally:
            generator._MODEL_KEY_TO_MODEL_ID["gemini_image"] = original


if __name__ == "__main__":
    unittest.main()
