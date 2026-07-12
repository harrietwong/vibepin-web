/**
 * Plan-origin Pinterest Connect UX (Parts A/B/I).
 * Clicking Connect from the Weekly Plan Pin drawer must go STRAIGHT to the OAuth start
 * route — no interstitial page, no "Continue connecting Pinterest?" / "may take long?"
 * confirmation — with an inline "Redirecting to Pinterest…" state and an inline error
 * fallback. Settings-origin connect is untouched.
 *
 * P0 regression guard: the redirect status must NEVER be flipped to a failure state by
 * a client-side timer. window.location.assign() cannot be observed or cancelled from
 * JS, so a "still on this page after Nms" guess is indistinguishable from Pinterest's
 * own (often slow) authorize page still loading — racing a timer against it previously
 * produced a false "could not open Pinterest" dialog while the real navigation quietly
 * completed anyway (clicking "Cancel" on that dialog still landed on Pinterest). The
 * only legitimate failure is window.location.assign() throwing synchronously.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "@/lib/i18n/messages";

const root = process.cwd();
const drawer = readFileSync(join(root, "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  OK ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`       ${(e as Error).message}`); failed++; }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

console.log("Plan-origin Pinterest Connect UX");

test("Plan drawer connect goes straight to the OAuth start route (no interstitial page)", () => {
  assert(drawer.includes("/api/auth/pinterest/connect?next="), "connect must target the OAuth start route directly");
  assert(!/\/app\/connect\/pinterest/.test(drawer), "connect must NOT route through the /app/connect/pinterest interstitial");
});

test("No second confirmation ('Continue connecting' / 'take long, continue?') in the drawer", () => {
  assert(!/Continue connecting Pinterest/i.test(drawer), "drawer must not ask 'Continue connecting Pinterest?'");
  assert(!/taking longer than expected/i.test(drawer), "drawer must not show a 'this may take long, continue?' style prompt");
});

// Copy now flows through i18n (t("pinDetails.xxx")) rather than literal JSX text, so
// these checks confirm BOTH that the drawer renders the right key AND that the
// English catalog value for that key is still the required user-facing copy.
function usesMessageKey(key: string): boolean {
  return drawer.includes(`t("${key}")`);
}

test("Single inline 'Redirecting to Pinterest…' state (button disables, drawer not frozen)", () => {
  assert(usesMessageKey("pinDetails.redirectStatus"), "inline redirecting status key missing");
  assert(en["pinDetails.redirectStatus"] === "Opening Pinterest authorization...", "redirect status copy must match P0 wording");
  assert(drawer.includes('data-testid="draft-redirect-status"'), "inline redirect status testid missing");
  assert(/disabled=\{[^}]*isRedirectingToPinterest/.test(drawer), "connect/publish buttons must disable while redirecting");
  assert(usesMessageKey("pinDetails.redirectBody"), "redirect body key missing");
  assert(/Keep this tab open/i.test(en["pinDetails.redirectBody"]), "reassuring 'keep this tab open' copy missing for long Pinterest loads");
  assert(/return to this Pin automatically/i.test(en["pinDetails.redirectBody"]), "Plan return reassurance copy missing");
});

test("Redirect failure shows an inline error + Retry (not a confirmation modal)", () => {
  assert(!drawer.includes('data-testid="draft-redirect-error"'), "failure modal must not be shown during OAuth navigation");
  assert(!drawer.includes('data-testid="draft-redirect-retry"'), "Retry control must not appear during OAuth navigation");
  assert(!drawer.includes('data-testid="draft-redirect-cancel"'), "Cancel control must not appear during OAuth navigation");
});

test("P0: no client-side timer ever flips the redirect status to a failure state", () => {
  // beginPinterestRedirect/goToPinterestOAuth must not race a setTimeout against the
  // real navigation. The only allowed setState-to-failure path is the synchronous
  // catch around window.location.assign() itself.
  // Note: [^}]* (not `.`) already matches newlines, so no dotAll ("s") flag is
  // needed here — the project's tsconfig targets ES2017, which predates it.
  assert(!/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*setRedirectFailed\(true\)/.test(drawer),
    "a setTimeout must not set redirectFailed(true) — that reintroduces the false-negative timeout dialog");
  assert(!/redirectTimeoutRef/.test(drawer), "no timer ref driving redirect failure should remain");
  // Precisely bound the beginPinterestRedirect useCallback (up to its dependency array)
  // so the slice can't accidentally swallow the separate slow-fallback effect below it.
  const beginStart = drawer.indexOf("const beginPinterestRedirect");
  const beginEnd = drawer.indexOf("}, [setIsRedirectingToPinterest, setPublishError]);", beginStart);
  const beginFn = drawer.slice(beginStart, beginEnd);
  assert(beginStart >= 0 && beginEnd > beginStart, "could not locate beginPinterestRedirect body");
  assert(!/setTimeout/.test(beginFn), "beginPinterestRedirect must not start any timer");
  assert(!/setRedirectFailed/.test(beginFn), "beginPinterestRedirect must not set a failure state after assigning navigation");
});

test("No slow-redirect fallback UI (removed for product/demo UX — debug/proxy fallback only)", () => {
  // The 15s "Still here?" manual-open fallback was a debugging aid for proxy/VPN/
  // extension cases and was explicitly removed from the product experience. The
  // redirect overlay must stay a SIMPLE calm state: spinner + status + body only.
  assert(!/redirectSlow/.test(drawer), "redirectSlow state must not remain in the drawer");
  assert(!/pendingConnectUrl/.test(drawer), "pendingConnectUrl must not remain in the drawer");
  assert(!/REDIRECT_SLOW_MS/.test(drawer), "the 15s slow-redirect timer constant must not remain");
  assert(!drawer.includes('data-testid="draft-redirect-slow"'), "slow-redirect fallback section must not render");
  assert(!drawer.includes('data-testid="draft-redirect-manual"'), "manual fallback link must not render");
  assert(!drawer.includes('data-testid="draft-redirect-manual-newtab"'), "manual 'open in new tab' link must not render");
  assert(!usesMessageKey("pinDetails.redirectSlowHint"), "slow-hint copy key must not be used");
  assert(!usesMessageKey("pinDetails.redirectManual"), "manual fallback copy key must not be used");
  assert(!usesMessageKey("pinDetails.redirectManualNewTab"), "manual new-tab copy key must not be used");
  // No VPN/extension/proxy debug wording anywhere in the drawer's user-facing surface.
  assert(!/VPN|extension may be slowing|browser extension/i.test(drawer), "no infra/debug wording should be shown to users");
});

test("No blocking 'still waiting, continue?' style copy anywhere in the drawer", () => {
  assert(!/taking longer than expected/i.test(drawer), "must not resurrect a 'taking longer than expected' prompt");
  assert(!/still waiting/i.test(drawer), "must not show a 'still waiting, continue?' style prompt");
});

test("All drawer connect entry points use the shared direct goToPinterestOAuth", () => {
  assert(/onNeedsConnect=\{goToPinterestOAuth\}/.test(drawer), "board 'needs connect' not wired to direct connect");
  assert(/onConnectPinterest=\{goToPinterestOAuth\}/.test(drawer), "Publish destinations connect not wired to direct connect");
});

test("Return context is preserved through OAuth (reopen the same Pin drawer)", () => {
  assert(/params\.set\("pinId"/.test(drawer) && /params\.set\("modal", "publish"\)/.test(drawer), "pinId/modal return context missing");
  assert(/weeklyPlanItemId/.test(drawer), "weeklyPlanItemId return context missing");
});

console.log(`\nPlan Pinterest Connect: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
