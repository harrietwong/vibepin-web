// Batch 1 verification: the blocker fix must hold when /api/social/connections is SLOW.
// Before the fix a >3s response painted every row "Not connected".
import fs from "node:fs";
import { chromium } from "playwright";

const OUT = "C:/Users/44740/AppData/Local/Temp/claude/d-----Pinterest-flow/ef3a6fdc-9959-47c0-b31c-9ad7f9519873/scratchpad";
const s = JSON.parse(fs.readFileSync(`${OUT}/session.json`, "utf8"));
const env = fs.readFileSync(".env.local", "utf8");
const g = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : null; };
const ref = new URL(g("NEXT_PUBLIC_SUPABASE_URL")).hostname.split(".")[0];
const BASE = "http://127.0.0.1:3000";
const rec = [];
const log = (id, v, d) => { rec.push({ id, v }); console.log(`[${v}] ${id} — ${d}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{
  name: `sb-${ref}-auth-token`,
  value: `base64-${Buffer.from(JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now()/1000)+3600, token_type: "bearer", user: { id: s.user_id } })).toString("base64")}`,
  domain: "127.0.0.1", path: "/",
}]);

const page = await ctx.newPage();
// Force the exact condition that used to break it: delay the connections read past 3s.
await page.route("**/api/social/connections*", async (route) => {
  await new Promise(r => setTimeout(r, 5000));   // 5s > the old 3000ms ceiling
  await route.continue();
});

await page.goto(`${BASE}/app/studio?view=plan`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForTimeout(12000);   // let the slow read land

// Open a Pin's Edit details to reach the destinations block.
const edit = page.getByRole("button", { name: /edit details/i }).first();
if (await edit.count()) { await edit.click(); await page.waitForTimeout(9000); }
await page.screenshot({ path: `${OUT}/qa-b1-drawer.png`, fullPage: true });

const dests = page.locator('[data-testid="publish-destinations"]');
if (await dests.count()) {
  for (const p of ["pinterest", "instagram", "facebook"]) {
    const st = page.locator(`[data-testid="publish-dest-${p}-status"]`);
    const txt = (await st.count()) ? (await st.first().innerText()).trim() : "(row absent)";
    const bad = /not connected/i.test(txt);
    log(`slow-read-${p}`, bad ? "FAIL" : "PASS", `status reads "${txt}" after a 5s response`);
  }
  // Now let the slow read land and confirm it resolves to the truth, not to a guess.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${OUT}/qa-b1-resolved.png`, fullPage: true });
  for (const p of ["pinterest", "instagram", "facebook"]) {
    const st = page.locator(`[data-testid="publish-dest-${p}-status"]`);
    const txt = (await st.count()) ? (await st.first().innerText()).trim() : "(row absent)";
    const ok = /connected/i.test(txt) && !/not connected/i.test(txt);
    log(`resolved-${p}`, ok ? "PASS" : "FAIL", `settles to "${txt}"`);
  }
} else {
  log("destinations-block", "INFO", "publish-destinations not rendered on this surface — see screenshot");
}

await browser.close();
console.log(`\nPASS ${rec.filter(r => r.v === "PASS").length}  FAIL ${rec.filter(r => r.v === "FAIL").length}`);
