# Unified Payment + Publishing Preview Validation Receipt — 1d731abd — 2026-08-30

## Verdict

`PREVIEW_READY_PUBLIC_BROWSER_PASS_AUTHENTICATED_E2E_BLOCKED_NOT_PRODUCTION`

The exact unified candidate was built, independently re-tested, frozen into a
Git-bound manifest, pushed, and deployed to a new Vercel Preview. Public Pricing
interaction and unauthenticated billing boundaries pass on that exact Preview.
Authenticated no-mock billing, usage, social publishing, and reference flows
remain external acceptance gates. No production promotion, production migration,
production database/VPS/systemd/timer change, or production environment write was
performed.

## Frozen Identity

- Candidate branch: `codex/payment-publish-handoff-0830`
- Executable runtime candidate: `1d731abdd8162a5d6423117e32fa644b1a3aa085`
- Manifest commit: `6b444faf01d3243e005cf1880d90eafa8d8f8671`
- Remote branch: `origin/codex/payment-publish-handoff-0830` at the same manifest commit
- Manifest: `backend/docs/payment_publish_preview_release_manifest_1d731abd.json`
- Manifest SHA-256: `8d229d69aa8f9da64a397ed492b0652445697a18421c766af586fe570c3662bc`
- Manifest verifier: `ok=true`, `artifactCount=133`, `errors=[]`
- Worktree at freeze: clean

The invalid hand-expanded SHA
`c219b2a995d43c63046031736976eebee1d2b873` is explicitly rejected. Historical
runtime identity is the exact 40-character SHA
`c219b2a9f7d47978803d22f8d145cf5378383938` only.

## Inclusion And Conflict Matrix

| Package | Authoritative source | Unified evidence | Status / conflict disposition |
| --- | --- | --- | --- |
| Product v3.7 | `5fe929355c0531f47934aec84248898741be2f6a`; runtime `60a540f1f3ead08e112d378f3df778000c189abb` | Both are ancestors of `1d731abd`; historical manifest remains traceable | Included |
| Creative / Reference P0 | `68eebbd242889baf3205f2bc3c14396f560a0620` | Runtime ancestor; prior Codex 149-test evidence retained | Included; ZCode remained `NO VERDICT` because of provider CAPTCHA, not product failure |
| Multichannel tombstone/outbox | `f1beaa877a2367cec1c0d4f7eb164b805ded8e97` | Runtime ancestor | Included |
| Pricing | `cc16dfde` | Runtime ancestor; exact three Pricing files are in the manifest | Included |
| TikTok customer-entry hide | source `2cc8c7df90e62c942adec691a4c15647d91c05f3`; integrated `c219b2a9f7d47978803d22f8d145cf5378383938` | Integrated commit is a runtime ancestor; source/integrated stable patch-id `d4c8de03cf99020aacafd3783afaf7d75f9ced26` | Included; canonical provider/type/DB compatibility retained |
| A auth / Shopify boundary | `80b68c74447b08cbcbdfcce7ab99d2f35fd1412b` | Cherry-pick `3e5076785257c1602f705a2fb2445405d2190052`; equal stable patch-id `b882c2226f7b72be9b03e7215a662085f8e39477` | Included |
| B privacy | final fix `4549135b9e06c8f26c6b55b38a6fec7c81a5612c` | Cherry-pick `ab33590ea583bf3e75b05a1b92e700825652c39e`; equal stable patch-id `9a0ee3297e01010899c8a15d0918f85dde289dc0` | Included; earlier `6ebaf28f` generate-route conflict was manually merged, so its integrated cherry-pick is intentionally not patch-identical |
| C verified identity | `46f5e8754fc3180b22c5d29005829aed96646d9f` | Direct runtime ancestor | Included |
| Product Supply fail-closed | `393882e0e54bf05fddb19f9ae23ee67f0b12cfb7` | Cherry-pick `0ec7ab937f1384b728993d3debd21abd61c7f60e`; equal patch-id `66e57034cc8ddfb95f2b4c0ee8b7389639e48d81` | Included in code; VPS canary/timer remains external and disabled |
| Product Supply rotation / URL authority | `c466c7fd84c4653da722f104daf57411a0d73671` | Cherry-pick `e1a904deb30646fbdb86995dfe57f82f4d7e6dcd`; equal patch-id `9e5fe6bd856f769b646c0cbbabdbcfec1ce03cfd` | Included in code; staged execution not performed |
| Worker safe-category integration | n/a | `1d731abdd8162a5d6423117e32fa644b1a3aa085` | Integration-only compatibility fix; raw provider detail remains discarded |
| Create Pin multireference | `459bcf5e1148b7b19dc87285b21e87a9867e776c` | Not an ancestor | Explicitly deferred by the user; not merged or deployed |
| D v69/v70 metering package | historical frozen package only | Not integrated | Not required for shadow/off Preview; remains a production gate |

The manual conflict surface was limited to the existing generation moderation
test and `web/src/app/api/generate/route.ts`. The merge preserved the unified
usage snapshot and the privacy-safe structured log. No Create Pin conflict file
was merged with `ours`/`theirs` or otherwise overwritten.

## Independent Mechanical Gates

- B privacy: `7/7`
- Generation metering: `28/28`
- Generation moderation/rate-limit: `114/114`
- Creative intelligence v1: `63/63`
- Shopify callback auth: `2/2`
- Generator limiter pytest: `3/3`
- C analytics/forged-cookie/auth-order: `11/11`
- Facebook: `46/46`
- Pinterest consistency: `9/9`
- Queue/Plan: `15/15`
- AI provider boundary: `38/38`
- AI auth: `20/20`
- AI rate-limit: `36/36`
- Pinterest OAuth: `34/34`
- Product Supply focused suite: `292 passed` plus `41` subtests
- Full backend: `1143 passed`, `2 skipped`, `1 deselected`, `80` subtests
- Test registry: `221 tracked`, `213 runnable`, `8 excluded`
- TypeScript: PASS
- Scoped ESLint: `0 errors`, `7` inherited warnings
- Python compile: PASS
- Local production Webpack build: compile, TypeScript, page-data, and `71/71` pages PASS

The single deselected backend test is the pre-existing Product integrated-preflight
identity test hard-coded to the historical branch
`codex/product-v37-central-integrate-0829`. It was not modified or relaxed; the
new 133-artifact manifest is the release identity for this candidate.

## Preview Test Configuration

Creem Test Mode was queried against the official test API before deployment.
Eight active test products were present: the six Starter/Pro/Business monthly and
yearly products plus Extra Social Account monthly `$7` and yearly `$60` products.
The two add-on product fingerprints are `71e9522371eb` and `0d0d9322019f`.

The Vercel project has no connected Git repository, so branch-scoped Preview env
creation was rejected before any write. The deployment therefore received an
exact per-deployment configuration using `--env` and `--build-env`. No secret
values are recorded in this receipt. Variable names were:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CREEM_MODE`
- `CREEM_API_KEY`
- `CREEM_WEBHOOK_SECRET`
- `CREEM_PRODUCT_STARTER_MONTHLY`
- `CREEM_PRODUCT_STARTER_YEARLY`
- `CREEM_PRODUCT_PRO_MONTHLY`
- `CREEM_PRODUCT_PRO_YEARLY`
- `CREEM_PRODUCT_BUSINESS_MONTHLY`
- `CREEM_PRODUCT_BUSINESS_YEARLY`
- `CREEM_PRODUCT_EXTRA_ACCOUNT_MONTHLY`
- `CREEM_PRODUCT_EXTRA_ACCOUNT_YEARLY`
- `USAGE_METERING_MODE`
- `USAGE_ENFORCE_AI_IMAGES`
- `USAGE_ENFORCE_AI_TEXT`
- `USAGE_ENFORCE_SCHEDULED_POSTS`

Effective non-production settings were Creem `test`, usage `shadow`, and all
three enforce flags `false`. The Supabase reference was independently matched to
the isolated test project `snulmwprsahzqvdbyenc`. Nothing was copied into a
Production environment.

## Exact Preview Deployment

- Vercel project: `harriets-projects-86e9e358/web`
- Project ID: `prj_dhGFUEZmiktBHuwmCCP7uVNHLsdR`
- Deployment ID: `dpl_Ai6eUUfiAoENjb8EU1T6eAt22UKm`
- URL: `https://web-e1kea840y-harriets-projects-86e9e358.vercel.app`
- Target: `preview`
- Status: `READY`
- Region: `iad1`
- Created: `2026-08-30 22:42:35 America/New_York`
- Cloud build: `npm ci`, Turbopack compile, TypeScript, and `71/71` pages PASS

The earlier Preview `dpl_9R7Hbxd6gS7m27Jzc8vEQMpMagUt` and every Preview
before it are historical evidence only. They cannot be reused for, or promoted
as, this candidate.

## Browser And API Acceptance

Chrome with the existing Vercel session opened the exact protected Preview.

- Monthly cards and comparison header showed `$19/$49/$99`.
- Switching to Yearly changed cards and comparison header to `$15/$39/$79`.
- The page states that one Content counts as one scheduled post regardless of the
  number of channels.
- The paid-plan extra-account rule shows `$7/account/month` monthly and `$5/account/month`
  with annual billing, for any supported platform and multiple slots.
- Customer-facing TikTok text was absent.
- `/app/studio` redirected to `/login?next=%2Fapp%2Fstudio`, confirming the
  authenticated application boundary rather than exposing the private page.
- Protected deployment curl returned JSON `401` for `/api/billing/usage`,
  `/api/billing/creem/status`, and an unauthenticated test-mode checkout POST.
  The checkout request did not reach Creem or create a session.

A non-blocking `Unexpected token '<'` browser console message appeared on both
the public Pricing and login pages under the user's extension-heavy Chrome
profile. It did not affect rendering, billing API JSON responses, or the pricing
toggle. The login page also recorded an unrelated Chrome-extension DOM error.
No product error UI was visible. Authenticated E2E remains required before a
production claim and will distinguish extension noise from authenticated app
runtime behavior.

## Remaining External Gates

1. Sign into VibePin on this exact Preview with an authorized test account and
   complete a no-mock Creem Test checkout, webhook mirror, status/usage readback,
   cancel/refund, and shadow-ledger reconciliation. No real payment is required.
2. Complete authenticated multi-account connect/disconnect/reconnect/remove and
   multichannel publish checks against the correct test-schema database.
3. Complete the Reference Recommendation upload-to-generation no-mock chain,
   including excludeIds, linkback, analysis states, bounded telemetry, and 429
   countdown behavior.
4. Run Product Supply staged 100-pin dry-run and bounded trusted canary on the
   target machine with the timer still disabled; require all provenance,
   merchant-image, canonical URL/hash, timeout, and readback redlines to pass.
5. Integrate and validate the D v69/v70 metering package before any production
   enforcement decision.
6. Obtain an explicit production instruction before any promote, production
   migration, Production env, DB/VPS/systemd/timer, or real publishing action.

This exact Preview deployment is complete. It is not `READY_FOR_PRODUCTION`.
