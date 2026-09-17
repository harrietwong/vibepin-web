import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

const form = readFileSync("src/app/contact/ContactForm.tsx", "utf8");

test("Contact submit is idempotent while submitting or after success", () => {
  assert.match(form, /if \(status === "submitting" \|\| status === "success"\) return;/);
  assert.match(form, /disabled=\{status === "submitting"\}/);
  assert.match(form, /aria-busy=\{status === "submitting"\}/);
});

test("Contact success is a compact actionable state", () => {
  assert.match(form, /data-testid="contact-success-state"/);
  assert.match(form, /CheckCircle/);
  assert.match(form, /contact\.success\.description/);
  assert.match(form, /data-testid="contact-success-home"/);
  assert.match(form, /data-testid="contact-success-another"/);
  assert.match(form, /aria-live="polite"/);
  assert.match(form, /resetForm/);
});

test("Contact exposes an error state without trapping the form", () => {
  assert.match(form, /data-testid="contact-error"/);
  assert.match(form, /setStatus\("error"\)/);
});

console.log(`\nContact success UI: ${passed} passed, 0 failed`);
