"""
shop_the_look_spike.py — DRY-RUN Playwright spike for the Pinterest "Shop the look" module.

Targets the SOURCE pin detail page's shopping module (product cards + category chips),
NOT related-pin outbound links. Multi-pronged: DOM heuristics + network/hydration JSON
capture (because product cards may route through JS / internal redirects).

Read-only: no DB writes, no merchant login/checkout. Screenshots saved when detected.

Run:
  python shop_the_look_spike.py --limit 20            # full
  python shop_the_look_spike.py --limit 3 --validate  # quick validation
"""
import argparse, asyncio, json, re, sys, time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "db"))
from db import select_many  # type: ignore
from product_harvest import accept_link, classify_link, normalize_product_url, url_hash  # type: ignore

ALLOC = {"fashion": 8, "womens-fashion": 6, "home-decor": 6}
SINCE_HOURS = 96
SHOTS = ROOT / "logs" / "shop_the_look_shots"
STL_TEXT = re.compile(r"shop the look|shop similar|more to shop|shop this|buyable", re.I)
CHIP_WORDS = re.compile(r"^(skirts?|shirts?|tops?|jewell?ery|rugs?|sofas?|lighting|decor|dress(es)?|bags?|shoes?|pants?|accessories|furniture|wall art|bedding|curtains?)$", re.I)
# external URL pattern inside JSON blobs
URL_RE = re.compile(r'https?://[^\s"\'<>\\]+')


def pick_sources(limit: int) -> list[dict]:
    cutoff = (datetime.now(tz=timezone.utc) - timedelta(hours=SINCE_HOURS)).isoformat()
    out: list[dict] = []
    for cat, n in ALLOC.items():
        rows = select_many("pin_samples", filters={
            "source_interest": "in.(manual_bootstrap,csv_bootstrap)",
            "category": f"eq.{cat}", "scraped_at": f"gte.{cutoff}", "image_url": "not.is.null",
        }, order="save_count.desc", limit=n) or []
        out.extend(rows)
    return out[:limit] if limit else out


def scan_json_for_products(blob: str) -> tuple[int, list[str]]:
    """Heuristic: count shopping signals + pull external merchant URLs from a JSON blob."""
    signals = 0
    for key in ('"shopping_flags"', '"is_shoppable"', '"buyable_product"', '"rich_summary"',
                '"shop_the_look"', '"shoppable_pins"', '"products"', '"closeup_unified_lockup"',
                '"price_value"', '"price_currency"', '"shoppingNagData"', '"productPin"'):
        signals += blob.count(key)
    urls = []
    if signals:
        for m in URL_RE.findall(blob):
            ml = m.lower()
            if "pinterest." in ml or "pinimg.com" in ml or "i.pinimg" in ml:
                continue
            urls.append(m.rstrip('\\",'))
    return signals, urls


async def extract_pin(page, sp, network_blobs: list[str]) -> dict:
    pid = sp.get("pin_id"); cat = sp.get("category")
    res = {"sourcePinId": pid, "sourceUrl": f"https://www.pinterest.com/pin/{pid}/", "category": cat,
           "saveCount": sp.get("save_count"), "shopTheLookDetected": False, "productCardsVisible": 0,
           "chipsDetected": [], "productCardsClicked": 0, "productCardsExtracted": [],
           "acceptedMerchantLinks": [], "rejectedLinks": [], "screenshot": None, "issue": None}
    network_blobs.clear()
    try:
        await page.goto(res["sourceUrl"], wait_until="domcontentloaded", timeout=35000)
    except Exception as e:
        res["issue"] = f"goto_timeout:{str(e)[:50]}"; return res
    if "/login" in page.url or "/signup" in page.url:
        res["issue"] = "login_wall"; return res
    await asyncio.sleep(2.5)
    try:
        await page.evaluate("""() => { document.querySelectorAll('[data-test-id*=Signup i],[class*=SignupModal],[aria-modal=true]').forEach(e=>e.remove()); document.body.style.overflow=''; }""")
    except Exception:
        pass
    for _ in range(5):
        try:
            await page.mouse.wheel(0, 2200); await asyncio.sleep(1.1)
        except Exception:
            break

    # --- DOM signals ---
    try:
        html = await page.content()
    except Exception:
        html = ""
    res["shopTheLookDetected"] = bool(STL_TEXT.search(html))

    # __PWS_DATA__ hydration JSON
    try:
        pws = await page.eval_on_selector_all(
            "script#__PWS_DATA__, script#__PWS_INITIAL_PROPS__, script[type='application/json']",
            "els => els.map(e => e.textContent).filter(Boolean)")
    except Exception:
        pws = []
    hydration = "\n".join(pws or [])

    # product card heuristics + visible card fields
    try:
        cards = await page.evaluate("""() => {
          const sel = '[data-test-id*="shop" i],[data-test-id*="product" i],[data-test-id*="lockup" i],[aria-label*="$"]';
          const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 60);
          const out = [];
          for (const n of nodes) {
            const a = n.querySelector('a[href]') || (n.tagName==='A'?n:null);
            const txt = (n.getAttribute('aria-label')||n.title||n.innerText||'').trim().slice(0,140);
            const priceM = txt.match(/\\$\\s?\\d[\\d.,]*/);
            out.push({ href: a?a.getAttribute('href'):null, text: txt,
                       price: priceM?priceM[0]:null, sel: n.getAttribute('data-test-id')||n.tagName });
          }
          return out;
        }""")
    except Exception:
        cards = []
    res["productCardsVisible"] = len(cards)

    # chips / shopping tabs — detect AND click each so per-chip products load
    # (real Pinterest tabs render as data-test-id="shopping-tab" / role="tab").
    chip_labels: list[str] = []
    chips_clicked = 0
    try:
        chip_handles = await page.query_selector_all(
            '[data-test-id="shopping-tab"], [data-test-id*="shopping-tab" i], [role="tab"]')
        for ch in chip_handles[:10]:
            try:
                label = ((await ch.inner_text()) or "").strip()
            except Exception:
                label = ""
            if label and len(label) < 40 and label.lower() not in ("shop", ""):
                chip_labels.append(label)
            try:
                await ch.click(timeout=2500)
                chips_clicked += 1
                await asyncio.sleep(1.2)   # let network load this chip's products
            except Exception:
                pass
    except Exception:
        pass
    res["chipsDetected"] = sorted(set(chip_labels))[:12]
    res["productCardsClicked"] = chips_clicked

    # --- gather candidate merchant URLs from DOM cards + hydration + network ---
    cand_urls: list[str] = []
    for c in cards:
        h = c.get("href")
        if h and h.startswith("http"):
            cand_urls.append(h)
        if c.get("text"):
            res["productCardsExtracted"].append({"text": c["text"], "price": c.get("price"), "sel": c.get("sel")})
    hsig, hurls = scan_json_for_products(hydration)
    cand_urls.extend(hurls)
    nsig = 0
    for blob in network_blobs:
        s, u = scan_json_for_products(blob)
        nsig += s; cand_urls.extend(u)
    res["productDataSignals"] = {"hydration": hsig, "network": nsig, "domCards": len(cards)}
    if (hsig or nsig) and not res["shopTheLookDetected"]:
        res["shopTheLookDetected"] = True  # data present even if text not in static HTML

    # accept_link the candidate merchant URLs
    seen = set()
    for u in cand_urls:
        nu = normalize_product_url(u); h = url_hash(nu)
        if h in seen:
            continue
        seen.add(h)
        ok, reason = accept_link(u)
        if ok:
            clf = classify_link(u, None)
            res["acceptedMerchantLinks"].append({"url": u[:90], "platform": clf["source_platform"], "type": clf["type_bucket"], "category": cat})
        else:
            res["rejectedLinks"].append({"url": u[:90], "reason": reason})

    if res["shopTheLookDetected"] or res["productCardsVisible"]:
        try:
            SHOTS.mkdir(parents=True, exist_ok=True)
            p = SHOTS / f"{pid}.png"
            await page.screenshot(path=str(p), full_page=False)
            res["screenshot"] = str(p)
        except Exception:
            pass
    return res


async def main(limit: int):
    from playwright.async_api import async_playwright  # type: ignore
    sources = pick_sources(limit)
    print(f"[stl-spike] source pins: {len(sources)} {dict(Counter(s.get('category') for s in sources))}", flush=True)
    per_pin: list[dict] = []
    network_blobs: list[str] = []
    t0 = time.time()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        ctx = await browser.new_context(viewport={"width": 1380, "height": 1700}, locale="en-US",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        page = await ctx.new_page()

        async def on_response(resp):
            try:
                ct = (resp.headers or {}).get("content-type", "")
                u = resp.url
                if "json" in ct and any(k in u for k in ("Resource", "resource", "graphql", "Closeup", "Pin", "shop")):
                    if len(network_blobs) < 40:
                        t = await resp.text()
                        if len(t) < 2_000_000:
                            network_blobs.append(t)
            except Exception:
                pass
        page.on("response", lambda r: asyncio.create_task(on_response(r)))

        try:
            await page.goto("https://www.pinterest.com", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)
        except Exception:
            pass
        for sp in sources:
            r = await extract_pin(page, sp, network_blobs)
            per_pin.append(r)
            print(f"[stl-spike] {r['sourcePinId']} ({r['category']}) stl={r['shopTheLookDetected']} "
                  f"cards={r['productCardsVisible']} chips={len(r['chipsDetected'])} "
                  f"accepted={len(r['acceptedMerchantLinks'])} signals={r.get('productDataSignals')} issue={r['issue']}", flush=True)

    elapsed = time.time() - t0
    detected = sum(1 for r in per_pin if r["shopTheLookDetected"])
    total_cards = sum(r["productCardsVisible"] for r in per_pin)
    accepted = [m for r in per_pin for m in r["acceptedMerchantLinks"]]
    rejected = [m for r in per_pin for m in r["rejectedLinks"]]
    agg = {
        "sourcePinsScanned": len(per_pin),
        "shopTheLookDetected": detected,
        "totalVisibleProductCards": total_cards,
        "acceptedProductLinks": len(accepted),
        "rejectedLinks": len(rejected),
        "rejectReasonDistribution": dict(Counter(m["reason"] for m in rejected)),
        "acceptedByCategory": dict(Counter(m["category"] for r in per_pin for m in r["acceptedMerchantLinks"])),
        "acceptedByPlatform": dict(Counter(m["platform"] for m in accepted)),
        "pinsWithChips": sum(1 for r in per_pin if r["chipsDetected"]),
        "totalChipTabsClicked": sum(r["productCardsClicked"] for r in per_pin),
        "avgAcceptedPerSourcePin": round(len(accepted) / max(1, len(per_pin)), 2),
        "runtimePer100Min": round(elapsed / max(1, len(per_pin)) * 100 / 60, 1),
        "issues": dict(Counter(r["issue"] for r in per_pin if r["issue"])),
        "loginWalls": sum(1 for r in per_pin if r["issue"] == "login_wall"),
        "screenshotsSaved": sum(1 for r in per_pin if r["screenshot"]),
        "elapsedSec": round(elapsed, 1),
    }
    out = {"aggregate": agg, "perPin": per_pin}
    (ROOT / "logs" / "shop_the_look_spike.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\n" + json.dumps(agg, indent=2, ensure_ascii=False), flush=True)
    print(f"[stl-spike] saved logs/shop_the_look_spike.json", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()
    asyncio.run(main(args.limit))
