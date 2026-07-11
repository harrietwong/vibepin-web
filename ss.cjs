const { chromium } = require("./pw_temp/node_modules/playwright");
const fs = require("fs");

const OUT = "d:/代码/Pinterest flow/screenshots";
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const pages = [
    { name: "01_dashboard",  url: "http://localhost:3000/app/dashboard"  },
    { name: "02_trends",     url: "http://localhost:3000/app/trends"     },
    { name: "03_discover",   url: "http://localhost:3000/app/discover"   },
    { name: "04_products",   url: "http://localhost:3000/app/products"   },
    { name: "05_queue",      url: "http://localhost:3000/app/queue"      },
    { name: "06_studio",     url: "http://localhost:3000/app/studio"     },
  ];

  for (const p of pages) {
    console.log("Visiting:", p.name);
    await page.goto(p.url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: OUT + "/" + p.name + ".png", fullPage: false });
    console.log("  saved:", p.name);
  }

  console.log("Taking tooltip screenshot on trends...");
  await page.goto("http://localhost:3000/app/trends", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);
  const badge = page.locator(".group\\/tag").first();
  const cnt = await badge.count();
  console.log("  Badge count:", cnt);
  if (cnt > 0) {
    await badge.hover();
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT + "/07_tooltip.png" });
    console.log("  saved: 07_tooltip");
  }

  await browser.close();
  console.log("All done");
})().catch(e => { console.error(e.toString()); process.exit(1); });
