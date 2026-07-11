# VibePin PRD v8 Open Questions

Date: 2026-07-09  
Status: Product decisions and technical debt list

## P0 Questions

1. Pinterest review demo environment: Should the demo use sandbox only, production Trial access, or both?
2. Review recording: What exact screen recording should be submitted to Pinterest: Studio -> Plan -> OAuth -> board -> publish -> View on Pinterest?
3. Settings connection state: Are there any remaining normal-user paths where sandbox mode appears as a real connected account?
4. Error copy: Which production errors still mention env/config details and need user-safe rewrites?
5. Website review assets: Are Privacy, Terms, contact/operator info, and Pinterest app explanation current enough for platform review?

## Product Decisions

1. Should publishing from Studio remain a primary path, or should merchants be guided to publish only from Weekly Plan?
2. Should Weekly Plan keep keyword slots, or should it become purely Pin/post based?
3. What is the final user-facing lifecycle: Unscheduled, Scheduled, Published only, or should Failed remain visible as a substate?
4. What should "Approve" mean in UI: explicit final review before publish, or just the Publish click itself?
5. Should destination URL be optional for all Pinterest Pins, or required for ecommerce merchants?
6. Should product attachment be required before publishing, optional, or required only for product-led Pins?
7. What product sources are first-class in MVP: Shopify, Amazon, manual URL, uploaded image, CSV, product library?
8. Should VibePin support multiple Pinterest accounts in MVP or defer until teams/workspaces?
9. Is default board global, per workspace, per Pinterest account, per category, or per product source?
10. Should sandbox-published Pins appear in normal history, or be visually separated as demo/test publishes?

## Technical Debt

1. DB-backed Pin content: Define and implement `scheduled_pins` or equivalent.
2. LocalStorage migration: Migrate existing `vp:pin_drafts:v1` drafts into DB-backed rows.
3. Asset durability: Ensure scheduled/published Pin images live in Supabase Storage and are public/reachable by Pinterest.
4. Publish metadata durability: Persist `postedAt`, `remotePinId`, `remotePinUrl`, board, account, environment, and error history in DB.
5. Lifecycle cleanup: Normalize Ready / Need details / Posted / Failed / needs_review / ready naming across Studio, Plan, History.
6. Default board persistence: Add durable user/workspace/account setting.
7. Social provider persistence: Confirm whether Zernio/OneUp provider-reported accounts should be mirrored into `social_connections`.
8. Publish job model: Decide how Pinterest dedicated publish results relate to `social_publish_jobs`.
9. Scheduled posting: Define queue, retry, timezone, and provider behavior before implementation.
10. Webhooks/retries: Plan for provider callbacks, status polling, and idempotency.

## Platform / Compliance

1. Pinterest Standard access: What scopes and written review explanation are required for the current flow?
2. Meta verification: Which app type and permissions are required for Instagram photo publishing and Facebook Page publishing?
3. TikTok: Is Login Kit plus `video.upload` the right path, given VibePin currently creates image-first Pins?
4. Non-Pinterest text: How should content be transformed for Instagram/Facebook/TikTok without implying automatic cross-posting?
5. Data pipeline wording: How should public copy mention trend/reference data without sounding like unauthorized scraping or competitor monitoring?

## Metrics To Define

1. Upload-to-reviewed-draft conversion.
2. AI copy acceptance/edit rate.
3. Draft-to-scheduled conversion.
4. Scheduled-to-published conversion.
5. OAuth connect success rate.
6. Board load success/latency.
7. Publish success rate.
8. Publish error recovery rate.
9. Cross-browser data consistency after DB-backed Pins.
10. Merchant time from product image to published Pin.
