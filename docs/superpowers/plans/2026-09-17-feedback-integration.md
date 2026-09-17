# VibePin 0905 Feedback Integration Plan

> **For Codex:** Execute this plan in isolated branches, integrate only after focused tests pass, and keep Production, real payments, and real provider publishing untouched.

**Goal:** Close the remaining P0/P1 gaps from the 0905 feedback PRD, run two independent verification rounds, deploy one unified Preview candidate, and hand the user one acceptance checklist.

**Architecture:** Keep `caf0ef06d86014702045a643325e9db2006df09c` as the frozen base. Implement independent Product, Auth, Public Shell, and Create Pin media fixes in isolated worktrees, then integrate them into `codex/feedback-integration-0917`. Existing CP-13/CP-14/generation/payment/security patches that are already ancestors or patch-equivalent must not be cherry-picked again.

**Tech Stack:** Next.js/React/TypeScript, Supabase Preview/Test, repository script tests, ESLint, TypeScript, webpack build, Vercel Preview.

---

### Task 1: Product data truth and compact UI

**Files:**
- Modify: `web/src/components/products/ProductOpportunitiesV1.tsx`
- Modify: `web/src/components/products/ProductOpportunitiesV1.module.css`
- Modify: `web/src/lib/productOpportunitiesClient.ts`
- Modify: `web/src/lib/server/productOpportunities.ts`
- Modify: `web/src/app/api/product-opportunities/route.ts`
- Test: `web/scripts/test-product-opportunities-ui-contract.ts`
- Test: existing Product opportunity and picker scripts

- [ ] Add failing tests for API error, auth error, catalog empty, filtered empty, partial, stale, and syncing states.
- [ ] Return an explicit safe state contract with request/runtime/deployment evidence.
- [ ] Never turn API/database errors into a normal empty state and never invent product data.
- [ ] Reduce the oversized route header and merge product type into the filter bar.
- [ ] Verify desktop 1440 and mobile 390 layouts.

### Task 2: Auth callback sanitizer

**Files:**
- Modify: `web/src/lib/authRedirects.ts`
- Modify: `web/src/app/auth/callback/route.ts`
- Test: `web/scripts/test-pricing-auth-p0p1.ts`

- [ ] Add failing tests for malformed percent encoding, external/protocol-relative URLs, backslashes, login loops, double encoding, and query/cookie conflicts.
- [ ] Add a non-throwing decode/sanitize path shared by login and callback.
- [ ] Ensure callback errors return to a safe local login route without leaking provider details.
- [ ] Preserve valid `/pricing?...` and `/app/studio` destinations.

### Task 3: Create Pin historical placeholder identity

**Files:**
- Modify: `web/src/components/studio/PinCardMedia.tsx`
- Modify/Add: `web/src/lib/studio/mediaPlaceholderQuality.ts`
- Test: `web/scripts/test-media-placeholder-quality.ts`
- Test: Studio media/component contract scripts

- [ ] Identify stable historical placeholder provenance/path/hash markers.
- [ ] Add failing tests proving the pink legacy asset is skipped while valid solid-color images remain visible.
- [ ] Preserve video renderer/poster/provenance behavior.
- [ ] Use the neutral low-contrast gradient fallback only after all real candidates fail.
- [ ] Verify generation-failed, publish-failed, healthy, desktop, mobile, and all locales.

### Task 4: Public shell, theme/language, and Contact success

**Files:**
- Add: `web/src/components/public/PublicShell.tsx`
- Add: `web/src/components/public/PublicLanguageTheme.tsx`
- Modify: Landing, Pricing, Contact, About, Careers, Privacy, Terms, Refund, Login, and Signup surfaces as needed
- Test: `web/scripts/test-public-shell-controls.ts`
- Test: `web/scripts/test-contact-success-ui.ts`

- [ ] Reuse the same persisted locale/theme contract as the app shell without nesting duplicate providers.
- [ ] Add accessible keyboard/focus behavior and update document language.
- [ ] Replace oversized/templated public-page chrome with a compact shared shell.
- [ ] Replace Contact's large success block with a compact actionable success state.
- [ ] Verify en, zh-CN, zh-TW; light, dark, system; desktop and mobile.

### Task 5: Integration and automatic gates

- [ ] Integrate only reviewed commits into `codex/feedback-integration-0917`.
- [ ] Run focused test suites twice from a clean state.
- [ ] Run registry, i18n, scoped/full ESLint as applicable, TypeScript, diff-check, and two fresh webpack builds.
- [ ] Confirm no duplicated CP-13/CP-14/generation patches and no Production bindings.
- [ ] Freeze source/runtime/manifest/artifact hashes and rollback boundary.

### Task 6: Unified Preview and USER acceptance

- [ ] Deploy one Preview candidate only after all automatic P0 gates pass.
- [ ] Bind the exact deployment to the Test Supabase ref.
- [ ] Run Round 1 on desktop and 390 for public pages, Auth, Pricing/Billing, Product, Reference, Create Pin, Destination, Schedule, Batch, Settings, and Contact.
- [ ] Run Round 2 for refresh/recovery, A→B→A isolation, three locales, and persisted state.
- [ ] Run four-plan Credit tests with owner-isolated safe fixtures; do not make real payments or exhaust credits through real bulk generation.
- [ ] Capture every failure/unknown/limit state with sanitized screenshots and record method/path/status/code/requestId.
- [ ] Deliver one user checklist plus rollback/deployment receipt. Production remains blocked.
