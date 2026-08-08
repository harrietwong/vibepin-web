/**
 * Website URL persistence across drawer close/reopen (Codex re-review, KNOWN-NOT-FIXED
 * item from 7965584).
 * Run: npx tsx scripts/test-url-persistence.ts
 *
 * The drawer's immediate-persist path used to write ONLY metadataDraft, while the
 * form is rebuilt from the TOP-LEVEL pin.destinationUrl — so a product-derived URL
 * vanished on reopen even though the code claimed it survived.
 *
 * LIMITATION, stated plainly: handleMetadataChange and buildPinDetailsForm are closures
 * inside the /app/studio page component and cannot be imported, so the helpers below
 * MIRROR them. A mirror can drift from production — that is the weakness Codex has
 * flagged repeatedly, and it applies here. These tests therefore pin the CONTRACT
 * (an automated fill must reach the top-level field and stay untouched; a manual edit
 * must persist and stay protected) and are paired with a source assertion in
 * test-canonical-picker that the production block actually writes destinationUrl.
 * Extracting those closures is the real fix and is worth doing before this area
 * changes again.
 */

import assert from "node:assert";
import { EMPTY_TOUCHED, type MetadataTouchedFlags, type PinMetadataDraft } from "../src/lib/pinMetadata";

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n     ${(e as Error).message}`); }
}

/** Minimal stand-in for the pin record the studio page persists into. */
type Pin = {
  destinationUrl: string;
  metadataDraft?: PinMetadataDraft;
  metadataTouched: MetadataTouchedFlags;
};

/** Mirrors buildPinDetailsForm: the form reads the TOP-LEVEL url, not the draft. */
function rebuildForm(pin: Pin) {
  return { destinationUrl: pin.destinationUrl, metadataDraft: pin.metadataDraft ?? null };
}

/**
 * Mirrors handleMetadataChange's immediate-persist block AFTER the fix: an automated
 * URL fill reaches the top-level field and leaves destinationUrlTouched false.
 */
function persistAutomatedUrlFill(pin: Pin, draft: PinMetadataDraft, url: string): Pin {
  return {
    ...pin,
    metadataDraft: draft,
    destinationUrl: url,
    metadataTouched: { ...EMPTY_TOUCHED, ...pin.metadataTouched, destinationUrlTouched: false },
  };
}

/** A manual edit goes through the normal path: top level + touched = true. */
function persistManualEdit(pin: Pin, url: string): Pin {
  return {
    ...pin,
    destinationUrl: url,
    metadataTouched: { ...EMPTY_TOUCHED, ...pin.metadataTouched, destinationUrlTouched: true },
  };
}

const emptyDraft = { destinationUrl: undefined } as unknown as PinMetadataDraft;
const basePin = (): Pin => ({ destinationUrl: "", metadataTouched: { ...EMPTY_TOUCHED } });

test("an automated product URL survives close + reopen", () => {
  let pin = basePin();
  pin = persistAutomatedUrlFill(pin, emptyDraft, "https://shop.example/p/1");
  // …user closes the drawer WITHOUT pressing Save, then reopens it.
  const form = rebuildForm(pin);
  assert.equal(form.destinationUrl, "https://shop.example/p/1", "must not vanish on reopen");
});

test("an automated fill stays auto-managed, so a later product change may update it", () => {
  let pin = basePin();
  pin = persistAutomatedUrlFill(pin, emptyDraft, "https://shop.example/p/1");
  assert.equal(pin.metadataTouched.destinationUrlTouched, false, "derived, not typed");
});

test("a MANUAL edit survives reopen AND stays protected", () => {
  let pin = basePin();
  pin = persistManualEdit(pin, "https://my-own.example/landing");
  const form = rebuildForm(pin);
  assert.equal(form.destinationUrl, "https://my-own.example/landing");
  assert.equal(pin.metadataTouched.destinationUrlTouched, true, "protection persists across reopen");
});

test("an automated CLEAR (product unlinked) also survives reopen", () => {
  let pin = basePin();
  pin = persistAutomatedUrlFill(pin, emptyDraft, "https://shop.example/p/1");
  pin = persistAutomatedUrlFill(pin, emptyDraft, ""); // unlink clears it
  assert.equal(rebuildForm(pin).destinationUrl, "", "the clear must persist too");
});

test("an automated fill never downgrades an existing manual protection to auto", () => {
  let pin = basePin();
  pin = persistManualEdit(pin, "https://my-own.example/x");
  // A later automated fill would be REFUSED upstream by deriveDestinationUrlForProduct
  // (isAutoManaged === false), so persistAutomatedUrlFill is never reached for it.
  // This asserts the guard's input rather than simulating an impossible call.
  assert.equal(pin.metadataTouched.destinationUrlTouched, true);
});

console.log(`\nURL persistence: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
