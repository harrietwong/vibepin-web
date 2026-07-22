import { test, expect } from "@playwright/test";

/**
 * Landing → signup → login → /pricing: the purchase intent must survive the
 * whole round trip.
 *
 * ── BILLING SWITCH (CREEM_MODE) ──────────────────────────────────────────────
 * The landing pricing cards are plain <Link>s to /signup (PricingSection.tsx),
 * so steps 1-3 below are billing-agnostic and ALWAYS run. Only the last step —
 * what /pricing does with a resumed `?checkout=pro` — depends on the server's
 * billing posture, read from CREEM_MODE (legal values: disabled | test | live;
 * unset/unrecognized ⇒ disabled):
 *
 *   disabled → /pricing must show the "coming soon" state and open NO checkout.
 *              Landing on /pricing (not /app/studio) is still the assertion that
 *              matters: the intent was not lost.
 *   test|live → /pricing must start checkout exactly once, for the right plan,
 *              carrying the buyer's real Supabase identity.
 *
 * The posture is detected at runtime via helpers/billingMode.ts (the test process
 * cannot read the dev server's env). To exercise the checkout branch locally set
 * CREEM_MODE=test in web/.env.local and restart the dev server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── HOW CHECKOUT IS OBSERVED (Creem, full-page redirect) ─────────────────────
 * This case used to stub `window.Paddle.Checkout.open` and read back the
 * recorded `customData.userId`, because Paddle checkout was an in-page overlay.
 * Creem is a HOSTED checkout: pricing-client.tsx POSTs `{ plan, interval }` to
 * `/api/billing/creem/checkout` and then `window.location.assign(url)` — a real
 * navigation. The old `page.evaluate` read therefore blew up with "Execution
 * context was destroyed", and there is no SDK call object left to inspect.
 *
 * The rewrite observes the same invariant one layer down, at an interface we own:
 * helpers/creemCheckout intercepts that POST, records its body plus the
 * `Authorization: Bearer <supabase JWT>` it carries, and answers with a
 * same-origin fake checkout URL so the redirect never leaves the test.
 *
 * LESSON LEARNED: a test that asserts *how a third-party SDK was called* is only
 * as durable as the vendor contract. Asserting that *our own server received the
 * right parameters* protects the same invariant and survives a provider swap.
 *
 * Needs E2E_USER_EMAIL / E2E_USER_PASSWORD for a real Supabase account — the
 * login step cannot be faked (see the LESSON LEARNED note in
 * pricing-purchase-intent.spec.ts).
 */

import { isBillingEnabled } from "./helpers/billingMode";
import { interceptCreemCheckout, UUID_RE } from "./helpers/creemCheckout";

const BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? "http://localhost:3000";

const CREDS = { email: process.env.E2E_USER_EMAIL, password: process.env.E2E_USER_PASSWORD };

test.describe("landing purchase intent", () => {
  test.skip(!CREDS.email || !CREDS.password, "needs E2E_USER_EMAIL / E2E_USER_PASSWORD");

  test("landing Start Pro → 注册页带意图 → 登录 → 回到 /pricing", async ({ page, browser }) => {
    const billingEnabled = await isBillingEnabled(browser);

    const checkout = await interceptCreemCheckout(page, BASE_URL);
    await page.goto("/", { waitUntil: "networkidle" });

    // 1. landing 点 Start Pro
    //    <Link> 需要 React 接管后才会做 client 导航；SSR 的 <a> 直接点也会走
    //    整页跳转，但 networkidle 后再给一点时间更稳。
    const startPro = page.getByRole("link", { name: /^Start Pro$/ }).first();
    await startPro.waitFor({ state: "visible" });
    await page.waitForTimeout(2000);
    await startPro.click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/signup");

    const u = new URL(page.url());
    expect(u.searchParams.get("plan")).toBe("pro");
    const next = u.searchParams.get("next")!;
    const nu = new URL(next, "http://x");
    expect(nu.pathname).toBe("/pricing");
    expect(nu.searchParams.get("checkout")).toBe("pro");

    // 2. 已有账号 → 点 Sign in（意图应透传）
    await page.getByRole("link", { name: /sign in/i }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20000 }).toBe("/login");
    expect(new URL(page.url()).searchParams.get("next")).toContain("checkout");

    // 3. 登录
    const em = page.locator('input[type="email"]');
    await em.click();
    await em.pressSequentially(CREDS.email!, { delay: 25 });
    const pw = page.locator('input[type="password"]');
    await pw.click();
    await pw.pressSequentially(CREDS.password!, { delay: 25 });
    await page.locator('button[type="submit"]').click();

    // 4. 必须回到 /pricing —— 绝不能落到 /app/studio（那才是意图丢失）。
    //    这一条与计费开关无关，两种状态下都必须成立。
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30000 }).toBe("/pricing");

    // 5. 计费开关决定接下来发生什么。
    if (!billingEnabled) {
      // CREEM_MODE=disabled：/pricing 明确显示 coming soon 且绝不拉起 checkout。
      await expect(page.getByText(/coming soon|isn't open just yet/i).first()).toBeVisible({
        timeout: 15000,
      });
      await page.waitForTimeout(3000); // 给任何走漏的 auto-checkout 一个开火机会
      expect(checkout.requests).toHaveLength(0);
      return;
    }

    // 计费已开放：checkout 恰好被拉起一次，且带着正确的 plan 和真实身份。
    await expect.poll(() => checkout.requests.length, { timeout: 30000 }).toBe(1);
    const [call] = checkout.requests;
    expect(call.body.plan).toBe("pro");

    // userId 不在请求体里：route handler 用 getUserIdFromBearerOrCookies() 在服务端
    // 解析，再写进 Creem 的 metadata.userId。浏览器侧能观察到的、且与服务端解析结果
    // 完全一致的东西，就是这个 bearer JWT 的 `sub`（服务端 auth.getUser(token).user.id
    // 就是它）。所以断言 sub 是真实 UUID，等价于断言真实 userId 会到达账单侧。
    expect(call.authorization).toMatch(/^Bearer .+/);
    expect(call.bearerUserId).toBeTruthy();
    expect(call.bearerUserId!).toMatch(UUID_RE);

    // 托管结账是整页跳转（这里跳到同源的替身页）——落到它才证明 checkout 真被拉起。
    await page.waitForURL(u2 => u2.toString().startsWith(checkout.fakeCheckoutUrl), {
      timeout: 20000,
    });
  });
});
