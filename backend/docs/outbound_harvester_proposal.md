# Outbound-Link Harvester — Proposal (analysis only, nothing run)

**Status: PROPOSAL ONLY.** No harvester run, no crawler, no scoring, no writes, no
timer. The numbers below come from **read-only** `pin_samples` count queries plus the
harvester's own `accept_link()` (a pure function) applied to already-stored links.
Authored 2026-07-03.

## Headline
`pin_samples` already contains **abundant outbound/product links**, and the existing
harvester converts them to `pin_products` **with zero scraping (no Playwright, no
Pinterest navigation)**. This is dramatically more productive than Shop-the-Look and
**can realistically hit 200–300 rows** from existing data.

---

### 1. What outbound-link harvester currently exists
`backend/product_harvest.py` → `harvest()`, exposed as run_worker job
**`harvest-outbound-products`**. Docstring: *"Converts product URLs ALREADY collected
on crawled pins into product rows, with zero new scraping (no Playwright)."* It reads
`pin_samples.outbound_link`, runs `accept_link()` (commerce-domain + product-path gate)
+ a content gate (`evaluate_pin_content`, rejects wallpaper/quote/meme), dedups by
normalized URL, and writes `pin_products`. Provenance = `discovery_method="outbound_link_bootstrap"`.

### 2. Does it write to pin_products?
Yes — on **apply** only, via `_apply_rows()` → `upsert("pin_products", rows,
"parent_pin_id,source_url")`. **Dry-run writes nothing** (`writes.pin_products = 0`).

### 3. Dry-run command
```
py run_worker.py --job harvest-outbound-products --since-hours 336 --dry-run
# (optionally --source bootstrap to restrict to bootstrap pins; --limit N; --category X)
```
Dry-run takes **no lock** and does **no navigation** — it's a pure DB read + classify.

### 4. Apply command
```
py run_worker.py --job harvest-outbound-products --since-hours 336 --apply
```
Requires `--since-hours` (refuses to run unscoped). Apply wraps in
`pipeline_job("harvest-outbound-products")` (records a `pipeline_runs` row + lock).
**Note:** no confirm token is required (lighter gate than the STL apply's
`APPLY_BOOTSTRAP_PRODUCTS`) — see risks §11.

### 5. Which pin_samples fields are used
The link column is **`outbound_link`** (single field). There is **no** separate
`outbound_url` / `link` / `product_url` / `domain` / `metadata` column.

| Your term | Actual source | Notes |
|---|---|---|
| outbound_url / link / product_url | **`outbound_link`** | the one outbound URL field |
| domain | **computed** `get_domain(outbound_link)` | not stored |
| metadata | **`title`** only | used for product_name + content gate + classify |
| save_count | **`save_count`** | inherited → both `save_count` & `source_pin_save_count` |
| category | **`category`** | selection filter (default P0 categories) |
| seed_keyword | **`seed_keyword` or `source_keyword`** | carried onto the row |
| (selection) | `scraped_at`, `outbound_link not null`, `source_interest`, `image_url`, `pin_id` | |

Default category scope = P0 = `fashion, womens-fashion, home-decor, beauty,
digital-products` (**note: harvester does NOT exclude beauty/digital-products**, unlike STL).

### 6. Eligible outbound-link pins (read-only counts, `outbound_link not null`)
| Window | Total | P0 categories |
|---|---|---|
| 24h | 66 | 53 |
| 48h | 155 | 100 |
| 5d | 427 | 200 |
| **14d** | **2,329** | **1,628** |

Compare STL: ~10 shop modules per 50 pins. Outbound links are ~10–30× more abundant.

### 7. Domain breakdown (top-1000 by save, 14d sample)
| Bucket | Count | Accepted? |
|---|---|---|
| Etsy | 212 | ✅ (known commerce) |
| Amazon | 35 | ✅ |
| Shopify (`myshopify` / `/products/`) | ~47 (by path) | ✅ |
| Other known-commerce (payhip, redbubble, teacherspayteachers…) | 50 | ✅ |
| Other domains (blogs, small shops not allow-listed) | 501 | ❌ mostly |
| Social (instagram 165, x 12, facebook 7…) | 202 | ❌ |

Top domains: etsy.com 203, instagram.com 165, amazon.com 32, shffls.com 27,
payhip.com 18, sewmamasew.com 17, teacherspayteachers 8, redbubble 8, canva 7.

### 8. Rejection rules (from `accept_link` + content gate)
`empty_or_relative`, `no_domain`, `pinterest_internal`, **`social_media`** (IG/TikTok/
X/FB/YouTube/Reddit/Linktree), `marketplace_profile` (Teepublic user/store pages),
`shopify_non_product_path`, `retailer_non_product_path`, **`non_product_path`**
(homepage `/`, search/category/collections/user/store/cart/checkout/login/blog),
`non_product_path` for Amazon `/shop/` storefronts, **`non_commerce_domain`** (domain
not in the allow-list), and `content:<reason>` (wallpaper/quote/meme by title+category).
Duplicates: collapsed by normalized-URL hash (keeps highest source save_count).

### 9. Projected inserts (read-only estimate — dry-run gives the exact figure)
Measured acceptance on the top-1000-by-save 14d sample: **318 / 1000 = 32%**, and
**318/318 accepted rows have an image**. Applying ~32% to the eligible P0 pools:

| Window | P0 pins | ~32% accepted | After dedup/existing (65 already) |
|---|---|---|---|
| 24h | 53 | ~17 | ~10–15 |
| 5d | 200 | ~64 | ~50–60 |
| **14d** | **1,628** | **~520** | **~300–450 new** |

**A single 14d run plausibly yields 300–450 new rows — meeting the 200–300 goal.**
(Estimate caveats: 32% is from the highest-save sample; acceptance is allow-list-based
and conservative; the real dry-run applies the content gate + dedup + existing-row
exclusion and returns `projectedInserts` exactly.)

### 10. Product detail UI fields — all preserved
`build_product_row()` sets everything the drawer needs; outbound rows surface via the
`/api/products/top` primary tier and the `productIdeas.ts` `outbound_link_bootstrap`
fetch (no UI change needed).

| UI field | Source on the harvested row |
|---|---|
| Product saves | `save_count` (inherited; `product_pin_id=null` → UI shows "source-Pin" evidence, same as STL) |
| Source Pin saves | `source_pin_save_count` (inherited) ✅ |
| Found date | row `created_at` (insert time) ✅ |
| Product URL | `source_url` = `outbound_link` ✅ |
| Pinterest Pin URL | `parent_pin_id` → pin URL ✅ |
| Source platform | `source_platform` + `domain` (UI `merchantLabel(domain)`) ✅ |
| Category / keyword | `seed_keyword` (category via client kwCatMap) ✅ |

Minor gaps vs STL: `merchant` and `source_category` are not set (UI derives merchant
from `domain`; category from `seed_keyword`) — no visible loss.

### 11. Risk assessment
- **Idempotency key differs from STL:** conflict = `(parent_pin_id, source_url)`, not
  product-URL hash. Same product URL from two different pins → two rows. Within a run
  `_dedup` collapses same-URL; **across pins/runs the same product can appear more than
  once** in the grid (the primary API tier doesn't identity-dedup). Quality, not safety.
- **Lighter apply gate:** `--apply` needs no confirm token and no preflight/cooldown
  (fine — no scraping), but that means less friction; recommend still dry-run-first.
- **Allow-list conservatism:** legit small shops in "other_domain" (501) and Amazon
  short links (`amzn.to`) are rejected → yield is understated but clean. Conversely
  Etsy `/shop/<name>` homepages can slip through as "products" (Etsy is allow-listed and
  `/shop` isn't in the non-product paths) — a few non-product Etsy rows possible.
- **No scraping** → no captcha / proxy / OOM / rate-limit / 20-min runtime. Runs in
  seconds–minutes. Operationally low-risk — the big advantage over STL.
- **Data honesty preserved:** saves are inherited source-Pin evidence, `product_pin_id=null`,
  `inspiration_only=true`; consistent with the current honesty stance.

### 12. Exact files that would change
**None required to run the dry-run** — the harvester code exists and the schema columns
it needs (`discovery_method`, etc.) are present. Before **apply**, verify one prereq:
- Confirm `pin_products` has a unique constraint on **(parent_pin_id, source_url)** for
  the `on_conflict` upsert (legacy STL used the same key, so it's very likely present).
Optional hardening (not required): a `cloud_run_outbound_harvest.sh` wrapper + a
`pipeline_runs` metadata surface in `/admin`, mirroring the STL scheduler.

### 13. Exact dry-run command to run next (on approval)
```
py run_worker.py --job harvest-outbound-products --since-hours 336 --limit 2000 --dry-run
```
(14-day window, P0 categories, no `--source` filter to maximise coverage; `--limit 2000`
so the 1,628 P0 pins aren't capped at the 600 default. Writes nothing.)

### 14. Rollback plan
- Dry-run: nothing to roll back (no writes).
- Apply: rows are tagged `discovery_method='outbound_link_bootstrap'` in a known
  `created_at` window → a bad batch is deletable by that filter. Insert/upsert only,
  no schema change, legacy rows untouched. Idempotent on rerun (conflict key).

### 15. Recommendation — harvester vs scoped shoppable crawl
**Run the outbound-link harvester first.** It uses the *existing* fresh `pin_samples`,
needs **no crawler and no scraping**, is fast and low-risk, and the data shows it can
generate **hundreds** of clean, image-backed product rows now (32% accept over 1,628 P0
pins in 14d). A **scoped shoppable crawl** is a *supply-refresh* for later — it brings
new pins but requires running the crawler (excluded now), Playwright, and still needs a
harvest/STL pass on top. Sequence: **harvester now → (separately) decide on a crawl to
keep the outbound pool fresh.**

**Next step:** on your approval I'll run the §13 **dry-run** (no writes) and report the
exact `projectedInserts`, category/platform/domain distribution, rejection reasons, and
duplicate count — then wait for apply approval.
