"""
Product metadata scraper.
Priority: Shopify JSON → Etsy API → Playwright OG fallback.
Fallback on any failure: return None so caller can prompt manual input.
"""
import re
import httpx
from typing import Optional
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential

from app.models.task import ProductMetadata
from app.core.config import get_settings


def _detect_platform(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if "etsy.com" in host:
        return "etsy"
    # Shopify stores don't share a common domain, detect by path pattern
    return "shopify"  # Try Shopify first, fallback to generic


@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=4))
async def _try_shopify(url: str, client: httpx.AsyncClient) -> Optional[ProductMetadata]:
    """Try Shopify's public product JSON endpoint."""
    parsed = urlparse(url)
    # Extract handle from path like /products/my-product-handle
    match = re.search(r"/products/([^/?#]+)", parsed.path)
    if not match:
        return None
    handle = match.group(1)
    json_url = f"{parsed.scheme}://{parsed.netloc}/products/{handle}.json"
    try:
        resp = await client.get(json_url, timeout=8.0)
        if resp.status_code != 200:
            return None
        data = resp.json().get("product", {})
        if not data:
            return None
        variant = data.get("variants", [{}])[0]
        image = data.get("images", [{}])[0]
        return ProductMetadata(
            product_id=str(data["id"]),
            title=data.get("title", ""),
            price=float(variant.get("price", 0)) if variant.get("price") else None,
            currency="USD",
            image_url=image.get("src", ""),
            product_url=url,
            category_tags=[t["value"] for t in data.get("tags", []) if isinstance(t, dict)]
                          if data.get("tags") and isinstance(data["tags"][0], dict)
                          else (data.get("tags", []) if isinstance(data.get("tags"), list) else []),
            platform_source="shopify",
        )
    except Exception:
        return None


@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=4))
async def _try_etsy(url: str, client: httpx.AsyncClient) -> Optional[ProductMetadata]:
    """Try Etsy Open API v3."""
    settings = get_settings()
    match = re.search(r"/listing/(\d+)", url)
    if not match:
        return None
    listing_id = match.group(1)
    api_url = f"https://openapi.etsy.com/v3/application/listings/{listing_id}"
    try:
        resp = await client.get(
            api_url,
            headers={"x-api-key": settings.pinterest_app_id},  # Etsy key stored separately in prod
            timeout=8.0,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        images_resp = await client.get(
            f"https://openapi.etsy.com/v3/application/listings/{listing_id}/images",
            headers={"x-api-key": settings.pinterest_app_id},
            timeout=8.0,
        )
        image_url = ""
        if images_resp.status_code == 200:
            imgs = images_resp.json().get("results", [])
            if imgs:
                image_url = imgs[0].get("url_fullxfull", imgs[0].get("url_570xN", ""))
        return ProductMetadata(
            product_id=str(data["listing_id"]),
            title=data.get("title", ""),
            price=float(data.get("price", {}).get("amount", 0)) / float(data.get("price", {}).get("divisor", 100))
                  if data.get("price") else None,
            currency=data.get("price", {}).get("currency_code", "USD"),
            image_url=image_url,
            product_url=url,
            category_tags=[data.get("taxonomy_path", "")],
            platform_source="etsy",
        )
    except Exception:
        return None


async def _try_playwright(url: str) -> Optional[ProductMetadata]:
    """OG tag + JSON-LD fallback via Playwright."""
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=15000)
            content = await page.content()
            await browser.close()

        soup = BeautifulSoup(content, "lxml")

        def og(prop: str) -> str:
            tag = soup.find("meta", property=f"og:{prop}") or soup.find("meta", attrs={"name": f"og:{prop}"})
            return tag["content"] if tag and tag.get("content") else ""

        title = og("title") or (soup.title.string if soup.title else "")
        image_url = og("image")
        price_tag = soup.find("meta", property="product:price:amount")
        price = float(price_tag["content"]) if price_tag else None
        currency_tag = soup.find("meta", property="product:price:currency")
        currency = currency_tag["content"] if currency_tag else "USD"

        if not title or not image_url:
            return None

        return ProductMetadata(
            product_id=url.split("/")[-1].split("?")[0] or "unknown",
            title=title.strip(),
            price=price,
            currency=currency,
            image_url=image_url,
            product_url=url,
            platform_source="generic",
        )
    except Exception:
        return None


async def scrape_product(url: str) -> Optional[ProductMetadata]:
    """
    Main entry point. Returns None on total failure → caller shows manual input form.
    """
    platform = _detect_platform(url)
    async with httpx.AsyncClient(
        follow_redirects=True,
        headers={"User-Agent": "Mozilla/5.0 (compatible; SocialFlowBot/1.0)"},
    ) as client:
        # Try platform-specific first
        if platform == "etsy" or "etsy.com" in url:
            result = await _try_etsy(url, client)
            if result:
                return result
        else:
            result = await _try_shopify(url, client)
            if result:
                return result

        # Playwright fallback
        return await _try_playwright(url)
