/**
 * Runtime contract for the public shell.
 *
 * This deliberately evaluates the exact first-paint script in a VM. A source
 * substring check would not catch a broken regular expression or a branch
 * that applies an app theme to the wrong route.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  PUBLIC_THEME_INIT_SCRIPT,
  publicThemeTarget,
} from "../src/lib/theme/publicThemeBootstrap";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

function runBootstrap(pathname: string, storedTheme: string | null, prefersDark = false) {
  const attributes = new Map<string, string>();
  const context = {
    location: { pathname },
    localStorage: { getItem: (key: string) => key === "vp:appearance_theme:v1" ? storedTheme : key === "vibepin-admin-theme" ? storedTheme : null },
    window: { matchMedia: () => ({ matches: prefersDark }) },
    document: { documentElement: { setAttribute: (key: string, value: string) => attributes.set(key, value) } },
  };
  new vm.Script(PUBLIC_THEME_INIT_SCRIPT).runInNewContext(context);
  return attributes;
}

test("bootstrap script is executable JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(PUBLIC_THEME_INIT_SCRIPT));
});

test("public routes restore the stored light preference before paint", () => {
  for (const path of ["/", "/login", "/privacy", "/pinterest-app"]) {
    assert.equal(runBootstrap(path, "light").get("data-theme"), "light", path);
    assert.equal(publicThemeTarget(path), "app", path);
  }
});

test("app and admin routes use their separate theme stores", () => {
  assert.equal(runBootstrap("/app/studio", "dark").get("data-theme"), "dark");
  assert.equal(runBootstrap("/admin", "dark").get("data-admin-theme"), "dark");
  assert.equal(runBootstrap("/admin", "system").get("data-admin-theme"), "light");
  assert.equal(publicThemeTarget("/admin"), "admin");
});

test("unrelated routes retain their own appearance state", () => {
  const attributes = runBootstrap("/products", "light");
  assert.equal(attributes.size, 0);
  assert.equal(publicThemeTarget("/products"), null);
});

test("system preference resolves at execution time", () => {
  assert.equal(runBootstrap("/signup", "system", true).get("data-theme"), "dark");
  assert.equal(runBootstrap("/signup", "system", false).get("data-theme"), "light");
});

console.log(`\nPublic shell runtime: ${passed} passed`);
