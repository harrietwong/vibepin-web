"""
product_supply_spike.py — Playwright related-pin spike (DRY-RUN, no DB writes).

Validates whether browser-rendered Pinterest pin detail pages can yield related
pins + product outbound links (the curl_cffi resource endpoints are 404/dead).

Scope: recent bootstrap pins, P0 categories (no beauty), seed-pin-limit 10,
related-per-pin 8, depth 1. Read-only: reports candidates, writes nothing.
"""
import asyncio, json, sys, time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "db"))
from db import select_many  # type: ignore
from product_harvest import accept_link, classify_link, normalize_product_url, url_hash  # type: ignore

CATS = ["fashion", "womens-fashion", "home-decor", "digital-products"]
SEED_LIMIT = 10
RELATED_PER_PIN = 8
SINCE_HOURS = 72


def pick_sources():
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=SINCE_HOURS)).isoformat()
    rows = select_many("pin_samples", filters={
        "source_interest": "in.(manual_bootstrap,csv_bootstrap)",
        "category": "in.(" + ",".join(CATS) + ")",
        "scraped_at": f"gte.{cutoff}", "image_url": "not.is.null",
    }, order="save_count.desc", limit=2000) or []
    per = max(1, SEED_LIMIT // len(CATS))
    by: dict[str, list] = {c: [] for c in CATS}
    for r in rows:
        c = r.get("category")
        if c in by and len(by[c]) < per:
            by[c].append(r)
    sel = [r for c in CATS for r in by[c]]
    return sel[:SEED_LIMIT]


async def _extract_external_links(page) -> list[str]:
    """All external (non-pinterest/social) http hrefs visible on the closeup."""
    try:
        hrefs = await page.eval_on_selector_all(
            "a[href^='http']", "els => els.map(e => e.href)")
    except Exception:
        hrefs = []
    out = []
    for h in hrefs:
        hl = h.lower()
        if "pinterest.com" in hl:
            continue
        out.append(h)
    return out


async def _related_pin_ids(page, source_id: str) -> list[str]:
    try:
        hrefs = await page.eval_on_selector_all(
            "a[href*='/pin/']", "els => els.map(e => e.getAttribute('href'))")
    except Exception:
        hrefs = []
    ids = []
    for h in hrefs or []:
        if not h:
            continue
        parts = [p for p in h.split("/pin/") if p]
        if len(parts) >= 1:
            pid = parts[-1].strip("/").split("/")[0].split("?")[0]
            if pid.isdigit() and pid != source_id and pid not in ids:
                ids.append(pid)
    return ids


async def main():
    from playwright.async_api import async_playwright  # type: ignore
    sources = pick_sources()
    print(f"[spike] source pins: {len(sources)} ({dict(Counter(s.get('category') for s in sources))})", flush=True)

    accepted: list[dict] = []
    rejected: list[dict] = []
    seen_hashes: set[str] = set()
    related_found = related_opened = 0
    blocked = timeouts = 0
    t0 = time.time()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        ctx = await browser.new_context(viewport={"width": 1280, "height": 1600}, locale="en-US",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        page = await ctx.new_page()
        try:
            await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)
        except Exception:
            pass

        async def kill_modal():
            try:
                await page.evaluate("""() => { document.querySelectorAll('[data-test-id*=Signup],[class*=SignupModal],[aria-modal=true]').forEach(e=>e.remove()); document.body.style.overflow=''; }""")
            except Exception:
                pass

        for sp in sources:
            spid = sp.get("pin_id"); cat = sp.get("category")
            kw = sp.get("seed_keyword") or sp.get("source_keyword")
            try:
                await page.goto(f"https://www.pinterest.com/pin/{spid}/", wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(2); await kill_modal()
                if "/login" in page.url or "/signup" in page.url:
                    blocked += 1; print(f"[spike] {spid} blocked (login wall)", flush=True); continue
                for _ in range(4):
                    await page.mouse.wheel(0, 2400); await asyncio.sleep(1.0)
                await kill_modal()
            except Exception as e:
                timeouts += 1; print(f"[spike] {spid} source timeout: {str(e)[:60]}", flush=True); continue

            rel_ids = (await _related_pin_ids(page, str(spid)))[:RELATED_PER_PIN]
            related_found += len(rel_ids)
            print(f"[spike] {spid} ({cat}) related found: {len(rel_ids)}", flush=True)

            for rid in rel_ids:
                try:
                    await page.goto(f"https://www.pinterest.com/pin/{rid}/", wait_until="domcontentloaded", timeout=25000)
                    await asyncio.sleep(1.2); await kill_modal()
                    related_opened += 1
                    ext = await _extract_external_links(page)
                except Exception:
                    timeouts += 1; continue
                got = False
                for url in ext:
                    ok, reason = accept_link(url)
                    if not ok:
                        rejected.append({"url": url[:110], "reason": reason, "category": cat}); continue
                    h = url_hash(normalize_product_url(url))
                    if h in seen_hashes:
                        continue
                    seen_hashes.add(h)
                    clf = classify_link(url, None)
                    accepted.append({"category": cat, "depth": 1, "path": f"{spid} -> {rid} -> {url[:50]}",
                        "platform": clf["source_platform"], "type_bucket": clf["type_bucket"],
                        "domain": clf["domain"], "url": url, "seed_keyword": kw})
                    got = True
                if got:
                    print(f"[spike]   {rid} -> product link(s)", flush=True)

    elapsed = time.time() - t0
    per_pin = round(len(accepted) / max(1, len(sources)), 2)
    report = {
        "mode": "spike-dry-run", "engine": "playwright",
        "sourcePinsScanned": len(sources),
        "relatedPinsFound": related_found, "relatedPinsOpened": related_opened,
        "productCandidatesFound": len(accepted) + len(rejected),
        "acceptedProductLinks": len(accepted), "linksRejected": len(rejected),
        "rejectReasonDistribution": dict(Counter(r["reason"] for r in rejected)),
        "duplicatesSkipped": (len(accepted) + len(rejected)) - len(seen_hashes) if seen_hashes else 0,
        "projectedInserts": len(accepted), "projectedUpdates": 0,
        "productsByCategory": dict(Counter(a["category"] for a in accepted)),
        "productsByDepth": dict(Counter(a["depth"] for a in accepted)),
        "productsByPlatform": dict(Counter(a["platform"] for a in accepted)),
        "productTypeEstimate": dict(Counter(a["type_bucket"] for a in accepted)),
        "avgProductsPerSourcePin": per_pin,
        "estRuntimePer100SourcePinsMin": round(elapsed / max(1, len(sources)) * 100 / 60, 1),
        "blockedLoginWalls": blocked, "timeouts": timeouts,
        "legacyTouched": 0,
        "sampleAccepted": accepted[:30],
        "sampleRejected": rejected[:30],
        "elapsedSec": round(elapsed, 1),
    }
    out = ROOT / "logs" / "product_supply_spike.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\n" + json.dumps({k: v for k, v in report.items() if k not in ("sampleAccepted", "sampleRejected")}, indent=2, ensure_ascii=False), flush=True)
    print(f"\n[spike] saved {out}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
