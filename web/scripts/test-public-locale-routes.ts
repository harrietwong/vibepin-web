/**
 * Public-route localization contract.
 *
 * Break caught: a public route can silently fall back to English, omit its
 * locale-aware copy binding, or lose the theme tokens that make both shell
 * appearances readable.  The route copy is deliberately pure so this test can
 * render the copy contract for every supported public locale without a browser
 * or authenticated runtime.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getPublicCopy,
  PUBLIC_ROUTE_COPY_KEYS,
  PUBLIC_SUPPORTED_LOCALES,
} from "../src/components/public/publicLocaleCopy";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}`); console.error(`       ${(error as Error).message}`); failed++; }
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const routeSources: Record<(typeof PUBLIC_ROUTE_COPY_KEYS)[number], string> = {
  about: "src/app/about/page.tsx",
  careers: "src/app/careers/page.tsx",
  privacy: "src/app/privacy/page.tsx",
  terms: "src/app/terms/page.tsx",
  refund: "src/app/refund-policy/page.tsx",
  acceptableUse: "src/app/acceptable-use-policy/page.tsx",
  pinterest: "src/app/pinterest-app/page.tsx",
  welcome: "src/app/welcome/page.tsx",
  dataDeletion: "src/app/data-deletion-status/page.tsx",
  login: "src/app/login/page.tsx",
  signup: "src/app/signup/page.tsx",
};

console.log("public route localization");

for (const route of PUBLIC_ROUTE_COPY_KEYS) {
  test(`${route} renders non-empty core copy in every public locale`, () => {
    for (const locale of PUBLIC_SUPPORTED_LOCALES) {
      const copy = getPublicCopy(locale, route);
      for (const [field, value] of Object.entries(copy)) {
        assert(value.trim().length > 0, `${locale}/${route}/${field} is empty`);
      }
    }
  });

  test(`${route} is bound to locale-aware public copy`, () => {
    const source = readFileSync(join(process.cwd(), routeSources[route]), "utf8");
    assert(source.includes(`route=\"${route}\"`) || source.includes(`usePublicRouteCopy(\"${route}\")`),
      `${routeSources[route]} does not bind ${route} to public locale copy`);
  });
}

test("public shell has concrete light and dark token palettes", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  assert(css.includes(".public-shell {") && css.includes("--public-bg: #F7F8FA"), "light public tokens are missing");
  assert(css.includes('[data-theme="dark"] .public-shell') && css.includes("--public-bg: #080E0B"), "dark public tokens are missing");
  assert(css.includes("--public-text:") && css.includes("--public-surface:"), "public contrast tokens are missing");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
