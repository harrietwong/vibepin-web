# Create Pin Baseline Disposition — 2026-08-29

## Scope and evidence

- Current main worktree: `feat/pinterest-production-transition@fec94a7f` plus uncommitted files.
- Create Pins integration: `integrate/create-pins-on-fanout-0827@80631ec9`.
- Current intersection: 52 repository paths, of which 32 are under `web/` and 20 are unrelated/cross-domain backend or tooling paths.
- The three known Create Pin/QA worktrees were clean when this sheet was produced.
- This is a read-only disposition. No product file was edited, merged, pushed, deployed, or applied to production.

## Baseline decision

Use `80631ec9` as the only Create Pin UI/data/publish baseline. Do not copy the current Studio tree wholesale and do not mechanically three-way merge it. The current main version is generally a feature-reduced predecessor; most user-requested UI intent is already present in `80631ec9` with stronger media, destination, lifecycle, accessibility, and retry behavior.

## Direct web collision decisions

| Path | Disposition | Rationale / preservation rule |
|---|---|---|
| `web/.env.example` | Take 80631 | Current deletion is not a Create Pin requirement; preserve the tracked configuration. |
| `web/.gitignore` | Take 80631 | Current deletion is unsafe and unrelated to the requested UI. |
| `web/package.json` | Take 80631 | Required build/test registry and scripts; current deletion makes clean verification impossible. |
| `web/playwright.config.ts` | Take 80631 | Required browser QA configuration; current deletion is not a product decision. |
| `web/scripts/test-publish-error-display.ts` | Take 80631 | Current and 80631 blobs are identical; do not duplicate. |
| `web/scripts/test-shopify-product-selection.ts` | Take 80631 | Current asserts the retired picker; 80631 tests canonical selection. |
| `web/src/app/app/layout.tsx` | Keep outside Create Pin package | Unrelated current app-shell intent must be handled by its owner; do not port it through Create Pin reconciliation. |
| `web/src/app/app/products/page.tsx` | Keep outside Create Pin package | Product Opportunities scope; preserve separately, not in the Studio merge. |
| `web/src/app/settings/page.tsx` | Keep outside Create Pin package | Settings/multi-account scope; preserve separately, not in the Studio merge. |
| `web/src/components/pins/PinAICopyPanel.tsx` | Take 80631 | Compact action is already present; 80631 also preserves shared action layout and neutral 429 UX. |
| `web/src/components/products/ProductOpportunityPicker.tsx` | Defer to Product owner | Do not couple opportunity-loading changes to Create Pin baseline work. |
| `web/src/components/studio/BatchEditDrawer.tsx` | Take 80631 | Current UI intent is already included; current loses readiness/retry/selection protections. |
| `web/src/components/studio/ContentMediaStrip.tsx` | Take 80631 | 80631 is a strict functional superset for sizing, offending media, and cross-card drag. |
| `web/src/components/studio/PinBoardCard.tsx` | Take 80631 | User-requested selection, recent-board fallback, lightweight AI actions, product entry, compact custom schedule, failure reason, and Details are already present; current deletes mature destination/media state. |
| `web/src/components/studio/PinCardMedia.tsx` | Take 80631 | Preserves chain reset, original badge, i18n/ARIA, and non-white fallback. |
| `web/src/components/studio/PinFallbackArtwork.tsx` | Take 80631 | Both blobs are identical; do not recreate. |
| `web/src/components/studio/ProductPickerModal.tsx` | Defer | 80631 deliberately replaces the old modal with canonical pickers. Do not revive the second picker; approved Etsy support must enter the canonical picker later. |
| `web/src/components/studio/StudioBoard.tsx` | Manual, 80631 as base | First fix the generation double-execution P0. Then port only the UI rule `selectedIds.size >= 2` for Batch Edit visibility. Do not port current direct-publish/generation orchestration. |
| `web/src/components/studio/StudioBoardFilters.tsx` | Take 80631 | Current order is present; 80631 also preserves Plan navigation state. |
| `web/src/components/studio/StudioPlanSidebar.tsx` | Take 80631 | Implements one-button open/close, hover reveal, click-to-pin, status and correct Studio Plan route. |
| `web/src/hooks/usePinBoardDrafts.ts` | Take 80631 | Current removes canonical active/failure collections and breaks All/Failed consistency. |
| `web/src/lib/contentDraftModel.ts` | Take 80631; never port current wholesale | Current is an early parallel model and loses destination history, media rules, readiness, and canonical scheduled intent. |
| `web/src/lib/createPinsPrefill.ts` | Take 80631 | Blobs are identical. |
| `web/src/lib/i18n/messages/en/studioBoard.ts` | Take 80631 | Current restores rejected “No image” and obsolete readiness copy. |
| `web/src/lib/i18n/messages/zh-CN.ts` | Take 80631 | Current restores dead title/description gates and obsolete copy. |
| `web/src/lib/i18n/messages/zh-TW.ts` | Take 80631 | Same reason as zh-CN. |
| `web/src/lib/pinDraftStore.ts` | Take 80631; never port current wholesale | Current loses media normalization, job reload recovery, destination history, timezone behavior, and canonical scheduled intent. |
| `web/src/lib/productIdeas.ts` | Defer as paired Product package | The 400→3000 intent depends on current-only `/api/products/top` chunking. Never port one side alone. |
| `web/src/lib/productTitle.ts` | Take 80631 | Blobs are identical; preserves honest nullable titles. |
| `web/src/lib/server/pinterest/service.ts` | Manual merge, 80631 as base | Preserve 80631 per-connection token/CAS/account identity/carousel code; port only separately reviewed Insights analytics methods from current. Requires Create Pin + Insights review. |
| `web/src/lib/studio/pinLifecycle.ts` | Take 80631 | Current loses week failure helpers, failure identity, carousel classification, and Plan/Create Pin consistency. |
| `web/src/lib/studio/publishErrorDisplay.ts` | Take 80631 | Blobs are identical and raw errors remain redacted. |

## Related 80631 dependencies to keep together

These may not all be dirty in the current main worktree, but they are architectural dependencies and must stay on the 80631 side of reconciliation:

- `web/src/components/plan/DraftDetailsDrawer.tsx`
- `web/src/components/plan/PinThumbnail.tsx`
- `web/src/components/plan/PlanCardStatusBadge.tsx`
- `web/src/components/plan/PlanListView.tsx`
- `web/src/components/plan/WeeklyPlanWorkspace.tsx`
- `web/src/components/studio/AiVersionDrawer.tsx`
- `web/src/components/studio/BulkActionSheets.tsx`
- `web/src/components/studio/CanonicalProductPicker.tsx`
- `web/src/components/studio/CreativeChips.tsx`
- `web/src/components/studio/InlineCreateAssetPicker.tsx`
- `web/src/components/studio/PinDetailsDrawer.tsx`
- `web/src/components/studio/ProductPreview.tsx`
- `web/src/components/studio/PublishDestinationPicker.tsx`
- `web/src/components/studio/ShopifyProductPickerPanel.tsx`

## Current-only work that must not be lost

The following URL-import changes are current-only rather than 80631 collision paths. They require a separate read-only gap audit on top of 80631; do not overwrite them and do not create another URL-import system:

- `web/scripts/test-product-url-import.ts`
- `web/src/lib/productUrlImport/adapters/etsy.ts`
- `web/src/lib/productUrlImport/adapters/woocommerce.ts`
- `web/src/lib/productUrlImport/extractProductUrls.ts`
- `web/src/lib/productUrlImport/urlImportService.ts`
- `web/src/lib/productUrlImport/urlSecurity.ts`
- `web/src/lib/productUrlImportClient.ts`

The current-only `web/src/components/studio/EtsyProductPickerPanel.tsx` is not ready to enter the baseline because its only caller is the retired `ProductPickerModal`. Preserve it in place; a later Etsy package may port approved behavior into `CanonicalProductPicker`.

## Current-only URL Import verdict

The seven current-only files are `+129/-25` relative to both `fec94a7` and `80631ec9`; they are one working-tree delta, not divergent branch implementations. They must not be ported as a bundle.

### Security gate before integration

- `/api/import/product-urls` has no authenticated-user gate and is outside the `/app/*` proxy matcher.
- Anonymous callers can trigger multiple server-side fetches and, after the Etsy delta, relay Etsy API-key quota.
- The current guard validates hostname text only. It does not resolve and reject every non-public A/AAAA result, bind the connection to the validated address, cover IPv4-mapped/link-local IPv6, or enforce the same guard on every redirect.
- The response-size check occurs after `arrayBuffer()` and therefore does not bound memory while downloading.
- The existing isolated worktree `codex/fetch-og-ssrf-0829` is already modifying `fetch-og/route.ts` and adding `safeOutboundUrl.ts` plus tests. It is dirty/in progress and must remain exclusively owned by the security worker. URL Import must consume an independently accepted shared server-only guard later; it must not clone this logic.

### URL Import package U1 · Input normalization

- Allowlist: `urlSecurity.ts`, `productUrlImportClient.ts`, and the relevant portions of `test-product-url-import.ts`.
- Port selectively: scheme-less domain and protocol-relative input normalization.
- Required negative coverage: userinfo, malformed ports, protocol-relative private addresses, IPv4/IPv6 edge forms, and path-case behavior.
- This package improves input UX only; it must not be described as SSRF hardening.

### URL Import package U2 · WooCommerce extraction

- Allowlist: `adapters/woocommerce.ts`, the Woo-specific branch of `urlImportService.ts`, and one shared-test owner.
- Rewrite rather than copy: the current regex scans the whole page and may score ads, recommendations, or arbitrary links as product gallery images.
- Acceptance: only product gallery/structured product image nodes are eligible; gallery-external negative examples remain excluded.

### URL Import package U3 · Etsy public listing

- Blocked until authenticated-user, per-user rate-limit, shared outbound-guard, redacted-error, and streaming-size gates are accepted.
- Allowlist after unblock: Etsy adapter, Etsy branch in `extractProductUrls` and `urlImportService`, one minimal server-only public-listing DTO/client, the API route, focused tests, and the API-key-only environment contract.
- Do not import the current untracked Etsy sync/OAuth/store directory wholesale. Its configuration incorrectly requires shared secret and redirect URI for public import, and its normalize module pulls Shopify store types into this path.
- Correctly map Etsy `full_width/full_height`, remove dead fallback branches, never expose provider errors or API keys, and keep single-item failure isolated within batch import.

### URL Import independent acceptance

```powershell
npx tsx scripts/test-product-url-import.ts
npx eslint scripts/test-product-url-import.ts src/lib/productUrlImport src/lib/productUrlImportClient.ts src/app/api/import/product-urls/route.ts
npm run typecheck
```

Required behavioral proofs include 401-before-fetch, 429-before-fetch, DNS/IPv4/IPv6 private-address rejection, every-redirect revalidation, pre-buffer streaming limits, Woo gallery negative cases, Etsy error/key redaction, correct Etsy dimensions, batch failure isolation, and canonical `ProductUrlImportPanel` fallback UX.

## Cross-domain collision rule

The 20 backend/tool intersections are not Create Pin work. They remain owned by backend, migration, product-supply, or security workstreams. A Create Pin worker must not stage, edit, copy, or commit them.

## Exclusive owner routing

- Advisor: baseline decision, allowlist enforcement, final acceptance.
- Senior Opus implementation worker: `StudioBoard` P0 and the tightly reviewed Pinterest service merge, in separate packages/worktrees.
- Claude Create Pins worker: card, lifecycle, hook, batch, product-selection, and Plan integration only after the baseline is accepted.
- Sonnet localization worker: the three Studio i18n files only, if copy changes remain after taking 80631.
- Product Opportunities owner: `productIdeas` plus `/api/products/top` as one paired package.
- Etsy/Product integrations owner: later canonical Etsy integration; never restore the old picker as a shortcut.
- Zcode `GLM-5.3/max`: architecture/product review and evidence-based acceptance guidance; no implementation in the dirty main worktree.

## Acceptance gate

1. Reconciliation occurs only in a new isolated worktree based on exact `80631ec9`.
2. The current main worktree and all three known Create Pin/QA worktrees remain byte-for-byte untouched by the reconciliation worker.
3. No worker uses `git add -A`, copies the Studio directory wholesale, or stages a path outside its package allowlist.
4. `StudioBoard` produces one inline execution or one worker enqueue per user action; counted-call orchestration tests prove it.
5. Batch Edit appears only when at least two items are selected.
6. Canonical content/destination/media/history/readiness models remain the only sources of truth.
7. The old `ProductPickerModal` is not restored; Etsy work enters through canonical product selection only after approval.
8. URL import, readiness, publish validation/error mapping, and creative-direction types are extended rather than duplicated.
9. Package-specific tests, `npm run check:test-registry`, `npm run test:studio`, and `npm run typecheck` pass in the isolated worktree before browser QA.
10. No push, merge, deploy, real publish, authentication workaround, migration, or production action occurs.
