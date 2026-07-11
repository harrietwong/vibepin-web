# VibePin PRD v8 Current Summary

Version: v8.0 current  
Date: 2026-07-09  
Status: Executive summary

## Product Direction

VibePin is now a merchant-facing ecommerce social publishing workflow. The product helps merchants turn their own products, product photos, and product links into Pinterest-ready and social-ready content.

The current core workflow is:

Create -> Review -> Schedule -> Connect -> Approve -> Publish

More specifically:

1. Merchant uploads/selects product or product image content.
2. VibePin helps generate Pin/social visual content, title, description, URL, tags/keywords, and alt text.
3. Merchant reviews and edits the content.
4. Merchant schedules the content in Weekly Plan.
5. Merchant connects Pinterest through official OAuth.
6. Merchant selects a Pinterest board.
7. Merchant explicitly clicks Publish.
8. VibePin publishes approved content to the merchant's own Pinterest account.
9. Merchant can view the published Pin on Pinterest.

This replaces the older v7.1 positioning where VibePin was described mainly as a Pinterest-first growth intelligence/data operations platform. Data intelligence still exists, but it is now supporting infrastructure for content creation and planning.

## Current Implemented Center

Implemented / Partially implemented:

- Create Pins / Studio Board: Upload-first board, AI image generation, AI copy generation, product/reference inputs, generated Pin drafts.
- Weekly Plan: Week/month calendar, list view, unscheduled queue, smart schedule, scheduled Pin edit modal, published Pin read-only view, View on Pinterest.
- Pinterest OAuth: Official OAuth start/callback, sealed state, encrypted token persistence, returnTo back to Plan, user-safe status.
- Pinterest boards: Board loading, session cache, searchable board picker, sandbox demo board.
- Pinterest publish: Public image/link validation, board ID publish, merchant-controlled Publish click, success state with Pin URL.
- Settings: Pinterest connection panel and unified Social accounts panel.
- Multi-platform foundation: `social_connections`, `social_publish_jobs`, `social_publish_job_destinations`, provider abstraction, mock/Zernio/OneUp foundation.
- Intelligence layer: Dashboard/Home, Pin Ideas, Product Opportunities, Keyword Trends, backend pipeline.

Planned / Not live:

- Durable DB-backed scheduled Pin content.
- Default board persistence.
- Real Instagram/Facebook Page/TikTok connection and publishing.
- Scheduled posting.
- Publish history and analytics hardening.
- Billing, teams, workspaces, retry/webhook handling.

## Critical Known Gap

Some merchant Pin content is still stored in localStorage through `pinDraftStore` (`vp:pin_drafts:v1`).

Impact:

- Same user in another browser/incognito may not see the same scheduled Pin cards/images.
- DB `weekly_plans` / `weekly_plan_items` persist older keyword plan slots, not the full merchant Pin content.
- Published metadata such as `postedAt` and `remotePinId` may remain local to one browser.

Product requirement:

- DB must become the source of truth for merchant Pin content.

Recommended direction:

- Add a `scheduled_pins` table or equivalent.
- Store Pin assets in Supabase Storage.
- Persist title, description, alt text, destination URL, board, product bindings, schedule, lifecycle, and publish metadata.
- Use localStorage only as optimistic cache/UI preferences.
- Add one-time migration from localStorage drafts.

## Weekly Plan Lifecycle

Target user-facing lifecycle:

- Unscheduled.
- Scheduled.
- Published.

Do not revive old global lifecycle states such as Ready or Need details. Missing fields should be validation/readiness guidance at publish time or inside the edit surface, not top-level product states.

Current code still has helper labels like Ready, Need details, Posted, Failed, needs_review, and ready. These should be normalized over time.

## Pinterest Review / Compliance Positioning

Use safe platform-review wording:

- Official OAuth.
- Merchant's own account.
- Merchant-approved publishing.
- Review before publishing.
- Selected board/account.
- Explicit Publish action.
- No password collection.
- No cookie/session bypass.
- No engagement automation.
- No publish without approval.

Avoid risky wording:

- Auto-posting.
- Bulk publishing.
- Mass posting.
- AI auto-publishing.
- Automated social spam.
- Scraping tool.
- Competitor monitoring tool.

## Roadmap

### P0 - Pinterest Review Demo / Launch Blocker

- Plan -> Pinterest Connect -> OAuth -> returnTo -> same Pin drawer.
- Board loading.
- Settings connection sync.
- Published Pin details + View on Pinterest.
- Website / Privacy / Terms / operator info.
- User-safe errors only.
- Sandbox review demo confirmed.

### P1 - MVP Product Hardening

- DB-backed scheduled Pins.
- Default board persistence.
- Zernio provider evaluation/integration.
- Real social connection sync.
- Meta app verification.
- Instagram / Facebook Page API application.
- TikTok Login Kit / video.upload application.
- LocalStorage migration.

### P2 - Scale

- Billing.
- Workspaces/teams.
- Analytics.
- Retry/webhook handling.
- Multi-platform publishing.
- Publish history.
- Scheduled posting.

## Repo Sources Captured

Major inspected areas:

- Plan: `web/src/app/app/plan/page.tsx`, `DraftDetailsDrawer.tsx`, `PinBoardSection.tsx`, `PublishDestinations.tsx`, `pinDraftStore`, `useWeeklyPlan`.
- Pinterest: OAuth connect/callback, status, boards, pins, sandbox demo board, `pinterestClient`, `boardsCache`, server Pinterest client and connection store.
- Social: social connection APIs, publish social APIs, provider abstraction, social migrations.
- Settings: `SettingsModal`, `PinterestSettingsPanel`, `SocialAccountsPanel`.
- Studio: `StudioBoard`, AI copy, AI image generation route, product/reference setup.
- Backend/data: `pipeline.py`, `run_worker.py`, migrations, trends/pin samples/product signals tables.
