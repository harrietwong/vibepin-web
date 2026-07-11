# Pinterest Data Architecture

## Background

As of mid-2025, Pinterest's `BaseSearchResource` API no longer returns results for
anonymous sessions (`_auth=0`). The existing `scraper_v2.py` curl_cffi-based scraper
relied on anonymous session cookies, which now receive soft-blocked empty responses.

This document defines three operating modes, the production path forward, and the
constraints of each approach.

---

## Mode A — Official API (preferred production path)

**Status: not yet enabled. Application required.**

### What Pinterest's official API can do

| Capability | Available | Notes |
|---|---|---|
| Read your own pins/boards | Yes | Standard OAuth v5 |
| Read another user's public pins | Yes | Standard OAuth v5 |
| Global keyword search | **No** | Not in v5 public API |
| Trend data / search volume | **Restricted** | Partner/beta access only |
| Shop-the-look product data | **Restricted** | Partner API |
| Ads / campaign reporting | Yes | Business account required |

### Official API limitations

Pinterest's public REST API v5 (`api.pinterest.com/v5`) is an **account-management
and advertising API**, not a content-discovery API. There is no public endpoint for
"search pins by keyword globally".

The endpoints that could serve this product need partner-level access:
- **Pinterest Trends API** (`trends.pinterest.com`) — keyword trend data, available
  to business accounts via the Pinterest Business access tier
- **Shopping API** — product catalog / shop-the-look, requires `partner` scope
- **Search Insights API** — impression/search volume by keyword, restricted beta

### Path to official access

1. Create a Pinterest Business account
2. Apply at [developers.pinterest.com](https://developers.pinterest.com) for a
   developer app with `pins:read`, `boards:read` and `user_accounts:read`
3. Apply separately for Trends & Insights API beta via business.pinterest.com
4. For shopping/STL data, apply for the Shopping partner program

**Env flag when ready:**
```
PINTEREST_CRAWL_MODE=official_api
PINTEREST_API_ACCESS_TOKEN=<OAuth token>
```

---

## Mode B — Estimated pipeline (current production state)

**Status: active. Data frozen at 2026-06-08.**

The daily cron (01:00 UTC) runs:
```
trends → crawl_queue → scraper_v2 → pin_samples → STL → pin_products → product_scores
```

With `PINTEREST_CRAWL_MODE=disabled` (current default), the crawl step is skipped.
Product Opportunities and Pin Ideas pages serve the existing 12,461 pin_samples rows
with `lastUpdatedAt` reflecting their true age.

**Characteristics:**
- No fake trending/search-volume claims
- `lastUpdatedAt` badge accurately shows data age
- Pin saves, domain, and classification are real (captured during last crawl)
- Product scores are re-calculated nightly from existing data
- No new pin discovery until crawl mode changes

**When to use:** whenever scraper access is unavailable or unverified.
Set `PINTEREST_CRAWL_MODE=disabled`.

---

## Mode C — Authenticated crawl fallback (temporary workaround)

**Status: implemented but disabled by default.**

**This is NOT the production architecture.** It exists only as a short-term
smoke-test to verify whether authenticated sessions can restore data freshness
while the official API path is pursued.

### Risks

| Risk | Impact |
|---|---|
| Account lock / suspension | Test account becomes unusable |
| CAPTCHA / checkpoint | Crawl stops; manual resolution required |
| ToS violation | Pinterest may terminate app / IP / account access |
| Session expiry | Cookies expire in ~25 days; require re-login |
| Low scalability | One account = low request budget |
| IP block cascade | VPS IP flagged → all modes fail |

### Enabling Mode C (smoke-test only)

1. Create a **throwaway** Pinterest account (not your main account)
2. On the VPS edit `/opt/vibepin/backend/.env`:
   ```
   PINTEREST_CRAWL_MODE=authenticated
   PINTEREST_AUTH_CRAWL_ENABLED=true
   PINTEREST_EMAIL=throwaway@example.com
   PINTEREST_PASSWORD=throwaway-password
   ```
3. Run a low-volume smoke test:
   ```bash
   cd /opt/vibepin/backend
   .venv/bin/python3 run_worker.py --job crawl --limit-keywords 3 --region US
   ```
4. Look for `[login] authenticated _auth=1` and non-zero pin counts
5. Session cookies are saved to `.pinterest_session.json` (chmod 600)
6. Subsequent runs reuse the saved session; credentials are not read again

### Safety controls (enforced by scraper)

- `PINTEREST_CRAWL_MAX_KEYWORDS_PER_DAY=30` (env override)
- `PINTEREST_CRAWL_MAX_REQUESTS_PER_ACCOUNT=150` (env override)
- Concurrency: default 3 (use `--concurrency 1` for smoke tests)
- Randomised delay: 1.2–2.4 s between requests
- Stops immediately on `_auth_state = blocked | captcha_required`
- No aggressive retry on login failure

### Disabling Mode C

```
PINTEREST_CRAWL_MODE=disabled
PINTEREST_AUTH_CRAWL_ENABLED=false
```

Or delete the session file to revoke stored cookies:
```bash
rm /opt/vibepin/backend/.pinterest_session.json
```

### Daily cron and Mode C

**The daily cron will NOT use authenticated crawl until explicitly approved.**
The cron respects `PINTEREST_CRAWL_MODE`; while it is `disabled`, the crawl step
is skipped cleanly. Changing it to `authenticated` must be a deliberate act.

---

## Environment variable reference

| Variable | Default | Description |
|---|---|---|
| `PINTEREST_CRAWL_MODE` | `disabled` | `disabled` / `anonymous` / `authenticated` |
| `PINTEREST_AUTH_CRAWL_ENABLED` | `false` | Must be `true` for Mode C to activate |
| `PINTEREST_CRAWL_SESSION_FILE` | `.pinterest_session.json` | Where cookies are persisted |
| `PINTEREST_CRAWL_MAX_KEYWORDS_PER_DAY` | `30` | Hard cap per run in Mode C |
| `PINTEREST_CRAWL_MAX_REQUESTS_PER_ACCOUNT` | `150` | Daily API call cap in Mode C |
| `PINTEREST_EMAIL` | _(commented out)_ | Throwaway account only |
| `PINTEREST_PASSWORD` | _(commented out)_ | Throwaway account only |

---

## Summary

| | Mode A | Mode B | Mode C |
|---|---|---|---|
| **Source** | Official Pinterest API | Existing DB / daily re-score | Authenticated scrape |
| **Status** | Not yet enabled | Active (data frozen Jun 8) | Disabled by default |
| **Stability** | High | High (no new data) | Low |
| **Scalability** | High | N/A | Very low (1 account) |
| **ToS compliance** | Full | Existing data only | Risk |
| **Effort to enable** | Partner application | Already running | Throwaway account + flag |
| **Recommended for** | Long-term production | Current fallback | One-off smoke test only |
