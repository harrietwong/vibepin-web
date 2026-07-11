const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUT = "d:/代码/Pinterest flow/screenshots";
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const pages = [
    { name: "dashboard",  url: "http://localhost:3000/app/dashboard"  },
    { name: "trends",     url: "http://localhost:3000/app/trends"     },
    { name: "discover",   url: "http://localhost:3000/app/discover"   },
    { name: "products",   url: "http://localhost:3000/app/products"   },
    { name: "queue",      url: "http://localhost:3000/app/queue"      },
    { name: "studio",     url: "http://localhost:3000/app/studio"     },
  ];

  for (const p of pages) {
    console.log("Visiting:", p.name);
    await page.goto(p.url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${p.name}.png`, fullPage: false });
    console.log("  saved:", p.name);
  }

  // Extra: hover over a MarketTag badge on trends page to show tooltip
  await page.goto("http://localhost:3000/app/trends", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);
  const badge = page.locator(".group\\/tag").first();
  if (await badge.count() > 0) {
    await badge.hover();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/trends_tooltip.png` });
    console.log("  saved: trends_tooltip");
  }

  await browser.close();
  console.log("Done");
})();
