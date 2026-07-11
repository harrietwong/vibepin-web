# VibePin PRD v8 Current

Version: v8.0 current  
Date: 2026-07-09  
Status: Current product direction, repo-grounded draft  
Audience: Founder/product owner, engineers, future Claude/Codex agents, platform review preparation

## 1. Title / Version / Date

VibePin PRD v8 Current describes the current merchant-facing ecommerce social publishing workflow. It replaces the old v7.1 framing that centered VibePin as a Pinterest-first growth intelligence and data operations platform.

This PRD is based on the current repository state as inspected on 2026-07-09. It does not define a TSX Canvas version.

## 2. One-Paragraph Product Summary

VibePin is a merchant-facing SaaS platform that helps ecommerce merchants turn their own products and product images into Pinterest-ready and social-ready content. The core workflow is Create -> Review -> Schedule -> Connect -> Approve -> Publish: a merchant uploads or selects product content, VibePin helps generate/edit Pin visuals and copy, the merchant schedules the content in Weekly Plan, connects Pinterest through official OAuth, chooses a real board, explicitly clicks Publish, and then views the published Pin on Pinterest.

## 3. Current Product Positioning

VibePin is a publishing assistant for ecommerce merchants, not an automation or scraping-for-publishing tool.

Status: Implemented / Partially implemented

- Implemented: Product-led Create Pins workflow with upload-first Studio Board, AI image versions, AI copy, product/reference inputs, generated assets, and handoff to plan.
- Implemented: Pinterest-first publish path from Pin details through official OAuth, board selection, publish, success state, and View on Pinterest.
- Partially implemented: Multi-platform publishing foundation for Instagram, Facebook Page, and TikTok through a vendor-neutral social provider abstraction.
- Partially implemented: Dashboard, Pin Ideas, Product Opportunities, Keyword Trends, and backend data pipeline as supporting intelligence.
- Planned: DB-backed merchant Pin content as the primary source of truth.
- Planned: Fully live non-Pinterest platform connections and publishing.

Do not position VibePin as:

- Auto-posting.
- Bulk publishing.
- Mass posting.
- AI auto-publishing.
- Automated social spam.
- Scraping tool.
- Competitor monitoring tool.

Use this positioning language:

- Merchant-approved publishing.
- Review before publishing.
- Selected accounts.
- Selected board.
- OAuth authorization.
- Merchant-controlled workflow.
- Approved content.
- Publishing assistant.

## 4. Target Users

- Ecommerce merchant: Needs to turn product photos, product pages, Shopify/Amazon/product-library assets, or store content into publishable Pins.
- Solo founder/operator: Needs a compact workflow from content creation to Pinterest publishing without a separate design and scheduling stack.
- Social/content manager for a small ecommerce brand: Needs to review product posts, schedule a weekly plan, and publish to approved channels.
- Affiliate/product curator: Needs product-linked Pins, image/copy generation, and a review-first publish path.
- Agency/operator: Planned. Needs multi-account, team, approval, and publish history hardening before full support.

## 5. Product Principles

- Merchant control first: Nothing should publish unless the merchant has reviewed the content and clicked Publish.
- Pinterest first, social-ready foundation: Pinterest is the first live destination; other platforms should reuse the same approved-content model.
- Product truth over generic content: Generated copy and visuals should be grounded in the merchant product, image, destination URL, board, page, and selected context.
- Scheduling is planning, not publishing: Weekly Plan organizes intent and timing. Publishing remains an explicit action until scheduled posting is implemented.
- Connection state must be honest: Provider configured, sandbox token available, and merchant connected are different states.
- User-safe errors only: Do not expose API keys, tokens, auth internals, or raw provider secrets.
- Intelligence supports creation: Trends, Pin Ideas, Product Opportunities, and pipeline data help merchants choose angles, but they are no longer the sole product center.
- DB must become the content source of truth: localStorage may be an optimistic cache, not durable product memory.

## 6. Core User Journeys

### 6.1 Product/Image to Published Pinterest Pin

Status: Partially implemented

1. Merchant uploads or selects product/product image in Create Pins.
2. Merchant optionally creates AI image versions using product images and style references.
3. VibePin creates/editable Pin draft cards.
4. Merchant generates AI title, description, tags/keywords, and alt text.
5. Merchant reviews and edits fields.
6. Merchant schedules the Pin in Weekly Plan or publishes from the Pin details surface.
7. Merchant connects Pinterest through official OAuth if not connected.
8. VibePin returns to the same Plan context and same Pin drawer after OAuth.
9. Merchant chooses a board or uses the selected/default board when available.
10. Merchant explicitly clicks Publish.
11. VibePin publishes to the merchant's own Pinterest account.
12. Merchant sees success metadata and opens View on Pinterest.

### 6.2 Weekly Planning

Status: Partially implemented

1. Merchant opens Weekly Plan.
2. Merchant sees an Unscheduled Pins queue.
3. Merchant schedules Pins into week/month calendar slots using Smart Schedule or manual drag/reschedule.
4. Merchant opens a scheduled Pin details modal.
5. Merchant edits copy, board, URL, product links, alt text, and date/time.
6. Merchant publishes a ready Pin manually.
7. Published Pins become read-only with published details and View on Pinterest.

Product lifecycle target for Weekly Plan:

- Unscheduled.
- Scheduled.
- Published.

Current implementation also has readiness labels such as Ready, Need details, Posted, Failed, and local draft statuses such as needs_review / ready. These should be treated as validation and UI helper states, not the global product lifecycle.

### 6.3 Social Account Setup

Status: Partially implemented

1. Merchant opens Settings -> Pinterest or Settings -> Social accounts.
2. Merchant connects Pinterest through official OAuth.
3. Settings shows Pinterest as connected only when there is a real DB-backed user connection.
4. Social accounts shows Pinterest live, with Instagram, Facebook Page, and TikTok as setup-pending/planned.
5. Merchant can disconnect Pinterest.

### 6.4 Intelligence-Assisted Creation

Status: Partially implemented

1. Merchant explores Dashboard/Home, Pin Ideas, Product Opportunities, or Keyword Trends.
2. Merchant uses data-backed ideas as context for content creation.
3. Merchant creates or schedules Pins from selected inspiration or products.

This journey supports the publishing workflow. It should not dominate the positioning.

## 7. Current Feature Map

### 7.1 Dashboard / Intelligence

- Home / Workspace: Implemented. Uses workspace feed and opportunity cards as a planning/intelligence entry.
- Pin Ideas: Implemented. Uses `pin_samples` and reference eligibility data.
- Product Opportunities: Implemented / Partially implemented. Uses `pin_products`, product scoring, and related pipeline tables.
- Keyword Trends: Implemented / Partially implemented. Uses `trend_keywords` and keyword context.
- Data pipeline: Implemented / Partially implemented. Supports trend keywords, pin samples, product signals, scoring, classification, and opportunities.

Product role: supporting infrastructure for content creation and planning.

### 7.2 Create Pins / Studio

- Upload-first Studio Board: Implemented.
- AI image generation from product/reference inputs: Implemented / Needs verification for all providers and environments.
- AI copy generation: Implemented.
- Content language setting: Implemented.
- Generated assets/history flow: Implemented / Partially implemented.
- Product attachments and product URL handling: Partially implemented.
- Add/schedule into Weekly Plan: Implemented / Partially implemented.
- DB-backed Studio board state: Blocked / Known gap. Many Pin draft fields are localStorage-backed.

### 7.3 Weekly Plan

- Week calendar: Implemented.
- Month calendar: Implemented.
- List view: Implemented.
- Unscheduled queue/rail: Implemented.
- Smart schedule: Implemented / Partially implemented.
- Edit scheduled Pin modal: Implemented.
- Published Pin read-only details: Implemented.
- View on Pinterest button: Implemented when `remotePinId` exists.
- No hover preview inside edit modal: Implemented by suspending hover preview while the modal is open.
- Simplified lifecycle target: Planned. Current UI still contains helper states that should be rationalized.

### 7.4 Pinterest Connect and Publish

- Official OAuth start route: Implemented.
- Fast callback return: Implemented.
- Token persistence with encryption: Implemented.
- Status route with connectionSource: Implemented.
- Board loading and cache: Implemented.
- Board search/selection in Pin details: Implemented.
- Publish route: Implemented.
- Public image/link validation: Implemented.
- Success state and metadata persistence to draft: Implemented locally.
- Sandbox demo board: Implemented for review/demo mode.
- Production Pinterest Standard access: Needs verification.

### 7.5 Settings / Social Accounts

- Pinterest settings tab: Implemented.
- Social accounts tab: Implemented.
- Provider configured vs user connected separation: Implemented.
- Sandbox token is not normal user connection in Settings: Implemented.
- Instagram / Facebook Page / TikTok connection cards: Planned/setup pending.
- Developer/debug tools hidden from normal users: Partially implemented / Needs verification.

### 7.6 Multi-Platform Foundation

- `social_connections`: Implemented at migration/API level.
- `social_publish_jobs`: Implemented at migration/API level.
- `social_publish_job_destinations`: Implemented at migration/API level.
- Provider abstraction: Implemented.
- Mock provider: Implemented.
- Zernio and OneUp adapters: Partially implemented / Needs verification.
- Publer and Ayrshare adapters: Planned.
- Pinterest first: Implemented through dedicated OAuth and publish flow.
- Instagram / Facebook / TikTok publish: Planned / Not live.

## 8. Detailed Feature Requirements

### 8.1 Merchant Product Input

Status: Partially implemented

Requirements:

- Merchant can upload one or more product images.
- Merchant can create AI image versions from a source upload.
- Merchant can include product images and reference images in AI generation setup.
- Merchant can preserve product metadata in the Pin draft where available.
- Merchant can attach product links manually in Pin details.
- Product URL is optional for Pinterest publishing, but if present it must be a public http(s) URL.

Current implementation notes:

- Studio Board creates `PinDraft` records in `pinDraftStore`.
- `AiVersionDrawer` accepts product images, reference images, product metadata, category, direction brief, format, and model key.
- Generated child drafts preserve `parentDraftId`, `sourceImageUrl`, `setupSnapshot`, product metadata, prompt snapshot, and generation session id.

### 8.2 AI Visual Generation

Status: Implemented / Needs verification

Requirements:

- Generate Pin-oriented visual assets from product images and optional references.
- Preserve product context where possible.
- Do not overwrite the original upload when generating AI versions.
- Store generated image URLs and prompt/setup context.
- Respect content language where image text/descriptive copy is requested.

Current implementation notes:

- `/api/generate` pipes a structured payload to `backend/generator.py`.
- Payload supports product images first, references after, selected tags, product metadata, creative direction, prompt version, and content language.
- Concurrency is guarded by a per-user/session generation lock.

### 8.3 AI Copy Generation

Status: Implemented

Requirements:

- Generate title, description, tags/keywords, and alt text.
- Use image analysis, product context, destination/page context, Pinterest board context, and keyword context.
- Respect the merchant's content language setting.
- Avoid unsupported claims and keyword stuffing.
- Allow regeneration.

Current implementation notes:

- `generatePinterestPinCopy` calls `/api/ai-copy`.
- Fast path uses cached image analysis and recommended keywords.
- Fallback path performs vision analysis and optional keyword refinement.
- `buildPinCopyPrompt` requires strict JSON and grounding in visible/product/page/board context.
- Non-English copy should not blindly weave English Pinterest keyword terms.

### 8.4 Review and Edit

Status: Implemented / Partially implemented

Requirements:

- Merchant can edit title, description, destination URL, board, product links, alt text, planned date/time, and selected destinations.
- Save should not close the edit modal.
- Published Pins should be read-only.
- Missing required publish fields should be validated at publish time, not as global lifecycle states.

Current implementation notes:

- `DraftDetailsDrawer` is the single Weekly Plan edit/publish modal.
- Fields persist through `pinDraftStore.updateDraft`.
- Readiness is board-aware through `draftReadiness` and `isPinReady`.

### 8.5 Schedule / Plan

Status: Implemented / Partially implemented

Requirements:

- Weekly Plan has week and month views.
- Weekly Plan has list view.
- Unscheduled queue is visible and schedulable.
- Smart Schedule can assign the next available slot.
- Manual drag/drop or reschedule locks the chosen time.
- Scheduled Pins appear on calendar/list surfaces.
- Published Pins remain visible with published state.

Target lifecycle:

- Unscheduled: Pin exists but has no scheduled date.
- Scheduled: Pin has a concrete planned date/time.
- Published: Pin has `postedAt` and remote publish metadata.

Implementation caution:

- Current code still displays legacy helper labels such as Ready, Need details, Posted, and Failed in some surfaces. Do not expand these into product lifecycle states.

### 8.6 Pinterest Connect

Status: Implemented

Requirements:

- Use official Pinterest OAuth.
- Do not collect Pinterest passwords.
- Use sealed state and return path.
- Preserve the originating Plan context and selected Pin.
- Fast-return from callback after token exchange/persist.
- Sync account profile after return, not before redirect.
- Connection status must come from real DB connection in normal Settings UI.

Current implementation notes:

- `GET /api/auth/pinterest/connect` and `POST /api/auth/pinterest/connect` start OAuth.
- `GET /api/auth/pinterest/callback` verifies state, exchanges code, persists encrypted tokens, and redirects.
- `returnTo` is sanitized to internal `/app/*` paths.
- `connectionSource` can be `db`, `sandbox_demo`, or `none`.

### 8.7 Pinterest Boards

Status: Implemented

Requirements:

- Load boards from the connected merchant account.
- Board selection must use real Pinterest board IDs, never a free-text suggestion.
- Board list should avoid blank/stuck loading states.
- Board cache should improve reopen performance but be invalidated after OAuth/disconnect.
- Default board persistence is planned.

Current implementation notes:

- `PinBoardSection` is presentational and controlled by `DraftDetailsDrawer`.
- `boardsCache` is an in-memory session cache with fresh and stale windows.
- `usePinterestBoards` dedupes board fetches through SWR for Studio Board.
- Sandbox mode can create a demo board when the sandbox account has no boards.

### 8.8 Pinterest Publish

Status: Implemented / Needs verification for production access

Requirements:

- Publish only after merchant action.
- Require board ID and public image URL.
- Validate optional link URL.
- Use the merchant's own OAuth token in production.
- Return Pin ID, Pin URL, board metadata, and environment.
- Persist local published metadata.
- Show View on Pinterest.
- Do not retry invisibly in ways that could double-publish.

Current implementation notes:

- `/api/pinterest/pins` validates payload and calls `PinterestClient.createPin`.
- Board ownership is enforced by Pinterest token and friendly fallback checks.
- Current published metadata is written to local `PinDraft` fields: `postedAt`, `remotePinId`, `boardId`, `boardName`.
- Social fan-out is guarded and Pinterest is not double-posted through `/api/publish/social`.

### 8.9 Settings and Accounts

Status: Partially implemented

Requirements:

- Pinterest settings show not connected, connected, or limited/reconnect-required states.
- Social accounts shows all target providers.
- Pinterest has live connect/disconnect.
- Instagram, Facebook Page, and TikTok should show setup pending until real connect paths exist.
- Developer tools and raw debug status should not be visible to normal users.
- User-safe refresh failures should not scare users with raw backend errors.

Current implementation notes:

- `PinterestSettingsPanel` has dedicated status loading, fallback to social connections, connect, reconnect, disconnect, and support CTA.
- `SocialAccountsPanel` reads unified summaries from `/api/social/connections`.
- `isMultiSocialAccountsEnabled` controls add-another-account affordance.

## 9. Publishing Workflow

Canonical workflow:

Create -> Review -> Schedule -> Connect -> Approve -> Publish

Detailed flow:

1. Create: Merchant uploads a product image, imports/selects product content, or generates an AI Pin asset.
2. Review: Merchant reviews image, title, description, URL, alt text, products, board, and destinations.
3. Schedule: Merchant schedules the Pin in Weekly Plan.
4. Connect: Merchant connects Pinterest through official OAuth if needed.
5. Approve: Merchant confirms the selected account/board and content.
6. Publish: Merchant explicitly clicks Publish.
7. Result: VibePin writes publish result metadata and shows View on Pinterest.

Rules:

- Scheduling a Pin must not publish it.
- Connecting Pinterest must not publish anything.
- Generating AI content must not publish anything.
- Selecting a board must not publish anything.
- Publish requires explicit merchant action.
- Missing required fields should be shown as validation at publish time or local readiness guidance.

## 10. Pinterest OAuth + Publish Requirements

### 10.1 OAuth Start

Status: Implemented

- Direct navigation to `/api/auth/pinterest/connect?next=<returnTo>`.
- No pre-flight board sync/status/profile fetch on the hot path.
- State is cryptographically random.
- State and returnTo are stored in cookies.
- ReturnTo must remain an internal `/app/*` path.
- Unauthenticated users redirect to login with next.

### 10.2 OAuth Callback

Status: Implemented

- Handles `access_denied` and other OAuth errors.
- Verifies state against sealed cookie and current session user.
- Exchanges code for tokens server-side.
- Persists encrypted token data to `pinterest_connections`.
- Redirects back to the originating app path with `pinterest=connected` or user-safe status.
- Does not fetch account profile, boards, or publish permissions before redirect.
- Clears one-use OAuth cookies on every outcome.

### 10.3 Status

Status: Implemented

- `/api/pinterest/status` returns client-safe metadata only.
- Must never return tokens.
- Must distinguish `connectionSource`:
  - `db`: real user connection.
  - `sandbox_demo`: server sandbox token available but not a user connection.
  - `none`: no usable connection.
- Normal Settings UI must treat only `db` as connected.

### 10.4 Boards

Status: Implemented

- `/api/pinterest/boards` loads boards through centralized server client.
- Production uses real user connection.
- Sandbox mode uses sandbox token.
- Supports pagination.
- UI cache is in-memory and invalidated after OAuth/disconnect.

### 10.5 Publish

Status: Implemented / Needs verification

- `/api/pinterest/pins` requires authenticated VibePin user.
- Requires `boardId`.
- Requires public `imageUrl`.
- Validates optional `link`.
- Sends title, description, link, alt text, image URL, and board ID to Pinterest.
- Returns Pinterest Pin ID and URL only after Pinterest confirms creation.
- In production, uses merchant's own OAuth token.
- In sandbox mode, uses Pinterest sandbox API/token for review demo.

### 10.6 Sandbox Review Demo

Status: Implemented

Purpose:

- Allow platform review/demo to show the publish flow when Pinterest production access is limited.

Rules:

- Sandbox token is provider/server config, not a merchant connection.
- Settings must not show sandbox token as user-connected.
- Publish drawer may use sandbox mode to unblock board loading/publish demo.
- Demo board creation is allowed only in sandbox mode.
- Demo board creation must never run against a real connected production account.

## 11. Settings / Social Accounts Requirements

Status: Partially implemented

Requirements:

- Pinterest settings card:
  - Not connected: show Connect Pinterest.
  - Connected: show account name when available and disconnect action.
  - Limited access: show access limitation without raw provider internals.
  - Reconnect required: show Reconnect and Disconnect.
- Social accounts tab:
  - Shows Pinterest, Instagram, Facebook Page, TikTok.
  - Pinterest uses dedicated OAuth flow.
  - Non-Pinterest providers show setup pending until real connection is wired.
  - No platform should appear connected only because the provider is configured.
- Debug/developer state:
  - Safe diagnostics may exist behind developer tools.
  - Normal users should not see raw debug provider state, env names, token status, or internal errors.

Connection rules:

- Provider configured != merchant connected.
- Sandbox token != merchant connected.
- Mock provider != live merchant connection.
- Active `pinterest_connections` row with encrypted token and `disconnected_at is null` = real Pinterest connection.

## 12. Data Model Overview

### 12.1 Implemented Tables

Status: Implemented

- `pinterest_connections`: Per-user Pinterest OAuth connection. Stores encrypted access/refresh tokens, scopes, account metadata, reconnect flag, and disconnected timestamp.
- `weekly_plans`: Older weekly plan header keyed by user/category/week.
- `weekly_plan_items`: Older keyword-slot plan items with keyword, category, planned date, sort order, status, and generated asset reference.
- `generated_assets`: Generated asset records used by Studio/History.
- `trend_interests`: Pipeline interest seeds.
- `trend_keywords`: Keyword trend records and source data.
- `crawl_queue`: Pipeline queue for pin sampling.
- `pin_samples`: Pin evidence/reference data.
- `pin_products`: Product signal data.
- `product_scores`: Product opportunity scoring.
- `keyword_product_map`: Keyword-product mapping.
- `trend_opportunities_view`: Aggregated opportunity feed.
- `pipeline_runs` / `pipeline_locks`: Pipeline observability/locking.
- `social_connections`: Multi-platform connected accounts.
- `social_publish_jobs`: Merchant-approved social publish job.
- `social_publish_job_destinations`: Per-platform publish outcome rows.

### 12.2 Local Storage Stores

Status: Implemented but known gap

- `vp:pin_drafts:v1`: Current primary store for many Studio/Plan Pin drafts and published metadata.
- Calendar scope/preferences and other UI settings are also stored locally.

Important:

Some Plan Pin content/images/product bindings are stored in localStorage via `pinDraftStore` and are not fully DB-backed yet.

Impact:

- The same user in another browser/incognito may not see the same scheduled Pin images/content.
- Published metadata written to local drafts may not be durable across devices.
- Platform review demos should use the same browser/session unless DB persistence is completed.

Product requirement:

- DB must become the source of truth for merchant Pin content.

Recommended future direction:

- Add `scheduled_pins` or equivalent durable Pin content table.
- Store Pin images/assets in Supabase Storage with public or signed/proxy-accessible URLs for Pinterest.
- Store title, description, alt text, destination URL, board ID/name, product bindings, schedule, status, and publish metadata in DB.
- Use localStorage only as optimistic cache and UI preference store.
- Add a one-time migration from localStorage drafts into DB-backed drafts.

## 13. API / Integration Overview

### 13.1 Pinterest APIs

Status: Implemented

- `GET/POST /api/auth/pinterest/connect`: Start OAuth.
- `GET /api/auth/pinterest/callback`: Handle OAuth callback.
- `GET /api/pinterest/status`: Safe connection status.
- `GET /api/pinterest/boards`: Load boards.
- `POST /api/pinterest/pins`: Publish Pin.
- `DELETE /api/pinterest/disconnect`: Disconnect account.
- `POST /api/pinterest/sync-account`: Best-effort account profile sync.
- `GET /api/pinterest/debug-status`: Safe diagnostics for developer tools.
- `POST /api/pinterest/sandbox/create-demo-board`: Sandbox-only demo board.

### 13.2 Social APIs

Status: Partially implemented

- `GET /api/social/connections`: Unified safe account summaries.
- `POST /api/social/connect`: Start generic social connection, with Pinterest delegated to Pinterest OAuth.
- `POST /api/social/disconnect`: Disconnect generic social account, with Pinterest delegated to dedicated disconnect.
- `POST /api/publish/social`: Create merchant-approved social publish job for non-Pinterest providers.
- `POST /api/publish/destinations/validate`: Validate selected destinations.
- `GET /api/social/provider-status`: Provider configuration diagnostics. Needs verification.

### 13.3 Creation APIs

Status: Implemented / Partially implemented

- `POST /api/generate`: AI image generation bridge to backend generator.
- `POST /api/ai-copy`: AI copy generation.
- `POST /api/ai-copy/analyze`: Upload-time image analysis.
- `POST /api/studio/upload`: Studio image upload.
- `GET/POST /api/history-storage`: History persistence. Needs verification.
- `GET /api/reference-candidates`: Reference candidates. Needs verification.
- `POST /api/import/product-urls`: Product URL import. Needs verification.

### 13.4 Intelligence APIs

Status: Implemented / Partially implemented

- `GET /api/workspace/feed`: Workspace feed.
- `GET /api/viral-pins`: Pin Ideas feed.
- `GET /api/products/top`: Product Opportunities feed.
- `GET /api/keyword-trends`: Keyword Trends.
- `GET /api/keyword-tool/search`: Keyword search.
- `GET /api/keyword-tool/related`: Related keyword data.
- `GET /api/opportunities`: Opportunities data.

## 14. UX Rules

### 14.1 Weekly Plan UX

Status: Partially implemented

- Default lifecycle should read as Unscheduled, Scheduled, Published.
- Missing fields should be local validation, not global lifecycle states.
- Calendar and list views should show the same underlying Pin plan data.
- Week and month scope should be stable across reloads.
- Unscheduled queue should be available without hiding content on smaller screens.
- Edit scheduled Pin should be one modal/surface.
- Published Pin view should be read-only.
- View on Pinterest should appear only when a real remote Pin URL/id exists.
- No hover preview inside edit modal.

### 14.2 Publish UX

Status: Implemented / Partially implemented

- If disconnected, Publish or board interaction may start OAuth directly.
- OAuth redirect should show immediate "Opening/Redirecting to Pinterest" state.
- After OAuth, return to the same Plan context and same Pin drawer.
- Boards should load calmly with retry, not hang.
- Board errors should be specific: not connected vs reconnect vs API error.
- Publish success should show Pin ID, board, environment, and View on Pinterest.
- Publish errors should be user-safe and retryable.
- Contact support can supplement retry, not replace it.

### 14.3 Settings UX

Status: Partially implemented

- Pinterest settings and Social accounts should agree on real connection state.
- A sandbox token must never make Settings say the merchant connected Pinterest.
- Debug/developer diagnostics should be hidden from normal users.
- Refresh failures should be muted and non-blocking.

### 14.4 Studio UX

Status: Implemented / Partially implemented

- Empty Create Pins page should be upload-first, with Create with AI as secondary.
- Uploaded cards and AI-generated child cards should be separate.
- One card expands inline at a time.
- AI copy should be available from Create, Plan edit, and Batch Edit through shared logic.
- "Saved on this device" reflects current local persistence and must not be mistaken for DB sync.

## 15. Compliance / Platform Review Rules

Status: Required / Partially implemented

Pinterest/Meta/TikTok review language must emphasize:

- VibePin uses official OAuth.
- Merchants connect their own accounts.
- VibePin does not collect passwords.
- VibePin does not bypass cookies, sessions, or platform login.
- VibePin does not publish without explicit merchant approval.
- VibePin does not perform engagement automation.
- VibePin does not automate likes, comments, follows, saves, DMs, or other engagement.
- VibePin does not do unauthorized scraping for publishing.
- VibePin does not mass post.
- VibePin does not bulk publish.
- VibePin does not auto-publish AI content.
- Each publish action is merchant-controlled, account-selected, and board/destination-selected.

Platform review narrative:

VibePin helps ecommerce merchants prepare product content for social publishing. A merchant reviews AI-assisted content, connects their own platform account through OAuth, selects a destination such as a Pinterest board, and clicks Publish. VibePin sends only the approved image, copy, link, and metadata needed to create that post on the merchant's selected account.

## 16. Metrics / Success Criteria

### 16.1 P0 Pinterest Review Demo

Status: Planned / Needs verification

- OAuth connect from Plan click to Pinterest navigation is fast and reliable.
- Callback returns to same Plan and same Pin drawer.
- Board list loads within acceptable time or shows retry.
- Publish succeeds in sandbox demo.
- Success state shows Pin ID, board, environment, and View on Pinterest.
- Settings shows real connection state correctly.
- No normal-user UI exposes debug token/config details.

### 16.2 Merchant Workflow

Status: Planned

- % of uploaded product images that become reviewed Pin drafts.
- % of generated drafts with AI copy accepted or edited.
- % of drafts scheduled.
- % of scheduled Pins with board selected.
- Publish success rate.
- Publish error recovery rate.
- Time from upload to scheduled Pin.
- Time from scheduled Pin to published Pin.

### 16.3 Product Quality

Status: Planned

- Copy quality pass rate.
- Image generation success rate.
- Public image URL validation failure rate.
- Board load failure rate.
- Cross-browser data consistency once DB-backed scheduled Pins are implemented.

## 17. Known Gaps / Technical Debt

### 17.1 Pin Draft Persistence Gap

Status: Blocked / Technical debt

Current discovery:

- Some Plan Pin content/images/product bindings are stored in localStorage via `pinDraftStore`.
- The DB-backed `weekly_plans` and `weekly_plan_items` persist keyword slots, not the full merchant Pin content.

Impact:

- Same user in another browser/incognito may see DB keyword plan rows but not the same scheduled Pin cards/images.
- A published Pin's local `postedAt` and `remotePinId` may not follow the user across browsers.
- "Saved on this device" is accurate but insufficient for production SaaS expectations.

Requirement:

- DB must become source of truth for merchant Pin content.

Recommended direction:

- Add `scheduled_pins` table.
- Store images in Supabase Storage.
- Persist product bindings, metadata, board, schedule, and publish result.
- Use localStorage only for optimistic cache/UI preferences.
- Add one-time local draft migration.

### 17.2 Lifecycle Naming Drift

Status: Partially implemented / Needs cleanup

- Product target lifecycle is Unscheduled, Scheduled, Published.
- Current code still references Ready, Need details, Posted, Failed, needs_review, needs_link, ready, planned, generated, published.
- Recommendation: Keep readiness and validation internally, but simplify user-facing lifecycle.

### 17.3 Default Board Persistence

Status: Planned

- Board selection exists.
- Persistent default board behavior needs product and technical confirmation.
- Recommended: Store default Pinterest board per user/workspace/provider account, with per-Pin override.

### 17.4 Non-Pinterest Social Publishing

Status: Planned / Partially implemented

- UI and API foundation exist.
- Mock provider exists.
- Real Instagram/Facebook/TikTok app review and provider integration are not live.
- `/api/publish/social` intentionally skips Pinterest to avoid double-posting.

### 17.5 Platform Review Surface

Status: Planned / Needs verification

- Website, Privacy, Terms, operator info, and app review demo copy must match compliance narrative.
- User-facing errors should avoid env/config details in production.

### 17.6 Data Pipeline Repositioning

Status: Implemented but positioning needs cleanup

- Pipeline still exists and powers intelligence surfaces.
- Product narrative should no longer make data intelligence the only product center.
- Recommendation: describe pipeline as supporting intelligence for product content decisions.

## 18. Roadmap

### P0 - Pinterest Review Demo / Launch Blocker

Status: In progress / Needs verification

- Plan -> Pinterest Connect -> OAuth -> returnTo -> same Pin drawer.
- Board loading from connected/sandbox account.
- Settings connection sync between Pinterest settings, Social accounts, and publish drawer.
- Published Pin details with read-only view and View on Pinterest.
- Website / Privacy / Terms / operator info aligned with platform review.
- User-safe errors only in production.
- Confirm sandbox demo board creation and publish flow for review video.
- Confirm normal Settings does not show sandbox as user connected.

### P1 - MVP Product Hardening

Status: Planned

- DB-backed scheduled Pins.
- Supabase Storage as durable asset source for scheduled/published Pins.
- Default board persistence.
- One-time localStorage draft migration.
- Zernio provider evaluation/integration.
- Real social connection sync for non-Pinterest accounts.
- Meta app verification.
- Instagram / Facebook Page API application.
- TikTok Login Kit / video.upload application.
- Publish result history backed by DB.
- Clear lifecycle language across Studio, Weekly Plan, and History.

### P2 - Scale

Status: Planned

- Billing.
- Workspaces/teams.
- Analytics.
- Retry and webhook handling.
- Multi-platform publishing.
- Publish history.
- Scheduled posting.
- Approval workflows.
- Multi-account management.
- Team roles and permissions.

## 19. Open Questions

1. What is the exact DB schema for `scheduled_pins` and how should it relate to `generated_assets`, `weekly_plan_items`, `social_publish_jobs`, and product/link tables?
2. Should Weekly Plan keep keyword slots after the product shift, or should it become purely Pin/post based?
3. What is the intended default board behavior: global user default, per-workspace default, per-account default, or per-category default?
4. Should publishing from Studio remain a primary path, or should all publishing happen from Weekly Plan?
5. Which non-Pinterest provider should be first: Zernio, OneUp, Publer, Ayrshare, or official APIs?
6. What should "scheduled posting" mean when implemented: queue for later automatic publish, reminder-only, or platform-native scheduler integration?
7. What product import sources are P0: Shopify, Amazon, manual URL, CSV, product library, or image upload only?
8. How should product bindings be represented for non-Amazon ecommerce products?
9. What review copy and screen recording does Pinterest require for Standard access?
10. Should sandbox publish data be isolated visually from production data in History/Plan?

## 20. Appendix: Current Routes / Components / Tables Discovered From Repo

### 20.1 Primary App Routes

- `/app/plan`: Weekly Plan.
- `/app/studio`: Create Pins / Studio Board.
- `/app/history`: My Pins / generated history.
- `/app/dashboard`: Dashboard.
- `/app/discover`: Pin Ideas.
- `/app/products`: Product Opportunities.
- `/app/trends`: Keyword Trends.
- `/app/settings/pinterest`: Pinterest settings page.
- `/app/settings/social`: Social accounts page.
- `/app/settings/publishing`: Publishing preferences.
- `/app/connect/pinterest`: Pinterest connect intermediate page.
- `/pinterest-app`: Public Pinterest app explanation page.
- `/privacy`: Privacy page.
- `/terms`: Terms page.

### 20.2 Primary Components

- `web/src/app/app/plan/page.tsx`
- `web/src/components/plan/DraftDetailsDrawer.tsx`
- `web/src/components/pin-details/PinBoardSection.tsx`
- `web/src/components/social/PublishDestinations.tsx`
- `web/src/components/settings/SettingsModal.tsx`
- `web/src/components/pinterest/PinterestSettingsPanel.tsx`
- `web/src/components/social/SocialAccountsPanel.tsx`
- `web/src/components/studio/StudioBoard.tsx`
- `web/src/components/studio/AiVersionDrawer.tsx`
- `web/src/components/studio/BatchEditDrawer.tsx`
- `web/src/components/plan/PlanListView.tsx`
- `web/src/components/plan/PinHoverPreview.tsx`
- `web/src/components/plan/PinThumbnail.tsx`

### 20.3 Primary Client Libraries / Hooks

- `web/src/lib/pinDraftStore.ts`
- `web/src/lib/useWeeklyPlan.ts`
- `web/src/lib/weeklyPlanStats.ts`
- `web/src/lib/pinterestClient.ts`
- `web/src/lib/pinterest/boardsCache.ts`
- `web/src/hooks/usePinBoardDrafts.ts`
- `web/src/hooks/usePinterestBoards.ts`
- `web/src/lib/ai-copy/generatePinCopy.ts`
- `web/src/lib/ai-copy/buildPinCopyPrompt.ts`
- `web/src/lib/social/platforms.ts`
- `web/src/lib/social/types.ts`
- `web/src/lib/social/providers/index.ts`
- `web/src/lib/social/socialClient.ts`
- `web/src/lib/social/server/socialConnectionStore.ts`

### 20.4 Pinterest Server Libraries

- `web/src/lib/server/pinterest/service.ts`
- `web/src/lib/server/pinterest/connectionStore.ts`
- `web/src/lib/server/pinterest/config.ts`
- `web/src/lib/server/pinterest/oauthState.ts`
- `web/src/lib/server/pinterest/routeHelpers.ts`
- `web/src/lib/server/pinterest/validatePublish.ts`
- `web/src/lib/server/pinterest/errors.ts`

### 20.5 API Routes

- `web/src/app/api/auth/pinterest/connect/route.ts`
- `web/src/app/api/auth/pinterest/callback/route.ts`
- `web/src/app/api/pinterest/status/route.ts`
- `web/src/app/api/pinterest/boards/route.ts`
- `web/src/app/api/pinterest/pins/route.ts`
- `web/src/app/api/pinterest/disconnect/route.ts`
- `web/src/app/api/pinterest/sync-account/route.ts`
- `web/src/app/api/pinterest/debug-status/route.ts`
- `web/src/app/api/pinterest/sandbox/create-demo-board/route.ts`
- `web/src/app/api/social/connections/route.ts`
- `web/src/app/api/social/connect/route.ts`
- `web/src/app/api/social/disconnect/route.ts`
- `web/src/app/api/social/provider-status/route.ts`
- `web/src/app/api/publish/social/route.ts`
- `web/src/app/api/publish/destinations/validate/route.ts`
- `web/src/app/api/generate/route.ts`
- `web/src/app/api/ai-copy/route.ts`
- `web/src/app/api/ai-copy/analyze/route.ts`
- `web/src/app/api/studio/upload/route.ts`
- `web/src/app/api/workspace/feed/route.ts`
- `web/src/app/api/viral-pins/route.ts`
- `web/src/app/api/products/top/route.ts`
- `web/src/app/api/keyword-trends/route.ts`
- `web/src/app/api/keyword-tool/search/route.ts`
- `web/src/app/api/keyword-tool/related/route.ts`
- `web/src/app/api/opportunities/route.ts`

### 20.6 Migrations / Tables

- `api/migrations/001_pinterest_connections.sql`: `pinterest_connections`.
- `backend/db/migrate_v13.sql`: `weekly_plans`, `weekly_plan_items`.
- `backend/db/migrate_v32_social_connections.sql`: `social_connections`, `social_publish_jobs`, `social_publish_job_destinations`.
- `backend/db/schema.sql`: base intelligence and generated asset schema.
- `backend/db/indexes.sql`: indexes including generated asset indexes.

### 20.7 Backend / Pipeline

- `backend/pipeline.py`: Orchestrates interest discovery, trend fetch, crawl, product signals, scoring, classification, opportunities.
- `backend/run_worker.py`: Cloud-ready job runner for trends, crawl, classify, daily, smoke, product supply, seed reports, and related jobs.
- `backend/generator.py`: Image generation worker called by `/api/generate`.
- `backend/trend_fetcher.py`: Trend keyword provider logic.
- `backend/scraper_v2.py`: Pin sample crawler.
- `backend/shop_the_look_expand.py`: Product supply expansion.
- `backend/calculate_product_scores.py`: Product scoring.
- `backend/classify_product_signals.py`: Product signal classification.
- `backend/classify_reference_pins.py`: Reference Pin classification.
- `backend/generate_opportunities.py`: Opportunities generation.
