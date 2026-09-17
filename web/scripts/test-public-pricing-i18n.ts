/**
 * Public pricing and shared public-shell localization contract.
 *
 * This test fails if pricing presentation copy bypasses the catalog, if a
 * plan/section/FAQ/footer item loses its stable key, or if either Chinese
 * catalog silently resolves the English source string.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/lib/i18n/messages/en";
import { getMessages } from "../src/lib/i18n/messages";
import { PARTIAL } from "../src/lib/i18n/messages";
import { ALL_APP_LANGUAGES } from "../src/lib/i18n/config";
import { publicPricingEn } from "../src/lib/i18n/messages/publicPricing";
import {
  COMPARISON_SECTIONS,
  ENTERPRISE_PLAN,
  PRICING_FAQ,
  PRICING_REASSURANCE,
  PRICING_TIERS,
} from "../src/lib/pricingPlans";
import { FAQ_ITEMS } from "../src/lib/landing/conversionData";

type Catalog = Record<string, string>;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message}`);
    failed++;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function message(catalog: Catalog, key: string): string {
  const value = catalog[key];
  assert(typeof value === "string" && value.trim().length > 0, `missing visible message ${key}`);
  assert(
    !/^(Plan feature|Plan highlight|Feature \d|Section \d|Enterprise benefit|Pricing question|Pricing answer|VibePin question|VibePin answer|套餐功能|套餐亮点|功能 \d|功能分组|企业权益|定价问题|定价说明|VibePin 问题|VibePin 说明|方案功能|方案重點|功能分組|企業權益|定價問題|定價說明|VibePin 問題|VibePin 說明)/.test(value),
    `template placeholder leaked into ${key}`,
  );
  return value;
}

const catalogs: Array<[string, Catalog]> = [
  ["en", en as Catalog],
  ["zh-CN", getMessages("zh-CN") as Catalog],
  ["zh-TW", getMessages("zh-TW") as Catalog],
];

const footerLinks = [
  "intelligence",
  "pinIdeas",
  "productOpportunities",
  "createPins",
  "weeklyPlan",
  "pricing",
  "helpCenter",
  "howWeUsePinterest",
  "about",
  "careers",
  "contact",
  "privacyPolicy",
  "termsOfService",
  "acceptableUsePolicy",
  "refundPolicy",
  "pinterestApp",
] as const;

console.log("public pricing i18n");

test("every target locale contains stable pricing, landing, and footer copy keys", () => {
  for (const [, catalog] of catalogs) {
    for (const plan of PRICING_TIERS) {
      message(catalog, `public.pricing.plan.${plan.id}.name`);
      message(catalog, `public.pricing.plan.${plan.id}.description`);
      message(catalog, `public.pricing.plan.${plan.id}.cta`);
      plan.bullets.forEach((_, index) => message(catalog, `public.pricing.plan.${plan.id}.bullet.${index}`));
      plan.previewBullets.forEach((_, index) => message(catalog, `public.pricing.plan.${plan.id}.previewBullet.${index}`));
    }

    ["eyebrow", "title", "titleAccent", "description", "features", "included", "notIncluded", "limited", "basic"].forEach(key =>
      message(catalog, `public.pricing.compare.${key}`),
    );
    COMPARISON_SECTIONS.forEach((section, sectionIndex) => {
      message(catalog, `public.pricing.compare.section.${sectionIndex}`);
      section.rows.forEach((row, rowIndex) => {
        message(catalog, `public.pricing.compare.row.${sectionIndex}.${rowIndex}`);
        if (row.note) message(catalog, `public.pricing.compare.note.${sectionIndex}.${rowIndex}`);
      });
    });

    ["eyebrow", "title", "description", "cta"].forEach(key =>
      message(catalog, `public.pricing.enterprise.${key}`),
    );
    ENTERPRISE_PLAN.bullets.forEach((_, index) => message(catalog, `public.pricing.enterprise.bullet.${index}`));
    PRICING_REASSURANCE.forEach((_, index) => message(catalog, `public.pricing.reassurance.${index}`));
    ["scheduledPosts", "accounts", "extraAccounts"].forEach(key =>
      message(catalog, `public.pricing.footnote.${key}`),
    );
    ["comingSoon", "comingSoonNotice", "contactUs", "unavailable", "contactSupport", "selectedPlan", "loading", "perMonth", "billedAnnually", "freeForever"].forEach(key =>
      message(catalog, `public.pricing.checkout.${key}`),
    );
    ["title", "titleAccent", "description", "free", "pro", "comingSoon"].forEach(key =>
      message(catalog, `public.pricing.finalCta.${key}`),
    );
    ["eyebrow", "title", "titleAccent", "description", "contact"].forEach(key =>
      message(catalog, `public.pricing.faq.${key}`),
    );
    PRICING_FAQ.forEach((_, index) => {
      message(catalog, `public.pricing.faq.item.${index}.question`);
      message(catalog, `public.pricing.faq.item.${index}.answer`);
    });

    ["eyebrow", "title", "titleAccent", "description", "viewFullPricing"].forEach(key =>
      message(catalog, `public.landing.pricing.${key}`),
    );
    ["eyebrow", "title", "titleAccent", "description", "contact"].forEach(key =>
      message(catalog, `public.landing.faq.${key}`),
    );
    FAQ_ITEMS.forEach((item, index) => {
      message(catalog, `public.landing.faq.item.${index}.question`);
      message(catalog, `public.landing.faq.item.${index}.answer`);
      if (item.note) message(catalog, `public.landing.faq.item.${index}.note`);
    });
    ["description", "copyright", "pinterestDisclaimer"].forEach(key => message(catalog, `public.footer.${key}`));
    message(catalog, "public.footer.legalEntity");
    ["product", "resources", "company", "legal"].forEach(column => message(catalog, `public.footer.column.${column}`));
    footerLinks.forEach(link => message(catalog, `public.footer.link.${link}`));
  }
});

test("all 54 card bullets have real copy instead of generated filler", () => {
  const expectedCount = PRICING_TIERS.reduce(
    (count, plan) => count + plan.bullets.length + plan.previewBullets.length,
    0,
  );
  assert(expectedCount === 54, `pricing source changed from 54 card bullets to ${expectedCount}`);

  for (const [language, catalog] of catalogs) {
    const bullets = PRICING_TIERS.flatMap(plan => [
      ...plan.bullets.map((_, index) => message(catalog, `public.pricing.plan.${plan.id}.bullet.${index}`)),
      ...plan.previewBullets.map((_, index) => message(catalog, `public.pricing.plan.${plan.id}.previewBullet.${index}`)),
    ]);
    assert(bullets.length === 54, `${language} resolves ${bullets.length} card bullets instead of 54`);
  }
});

test("localized pricing copy preserves business numbers and brand names", () => {
  const english = publicPricingEn as Catalog;
  const factPattern = /\$?\d[\d,]*|VibePin|Pinterest|Instagram|Facebook|Amazon|\bAI\b|\bAPI\b/g;

  for (const language of ["zh-CN", "zh-TW"] as const) {
    const catalog = getMessages(language) as Catalog;
    for (const [key, englishValue] of Object.entries(english)) {
      const facts = englishValue.match(factPattern) ?? [];
      const localized = message(catalog, key);
      for (const fact of facts) {
        assert(localized.includes(fact), `${language}.${key} changed business fact ${fact}`);
      }
    }
  }
});

test("public pricing copy avoids machine-written dash phrasing", () => {
  for (const [language, catalog] of catalogs) {
    for (const key of Object.keys(publicPricingEn)) {
      const value = message(catalog, key);
      assert(!/[—–]/.test(value), `${language}.${key} contains an em or en dash`);
    }
  }
});

test("Chinese public-pricing copy is not an English fallback", () => {
  const english = en as Catalog;
  const keys = Object.keys(publicPricingEn);
  const englishSentinels = [
    "Explore VibePin before you scale.",
    "Everything in every plan",
    "Need more workspaces",
    "Can I publish to Pinterest",
    "What is a Pinterest opportunity?",
    "Pinterest growth intelligence",
    "Privacy Policy",
  ];
  for (const language of ["zh-CN", "zh-TW"] as const) {
    const catalog = getMessages(language) as Catalog;
    for (const key of keys) {
      assert(message(catalog, key) !== message(english, key), `${language}.${key} falls back to English`);
    }
    const visibleCopy = keys.map(key => message(catalog, key)).join("\n");
    for (const sentinel of englishSentinels) {
      assert(!visibleCopy.includes(sentinel), `${language} leaked English sentinel: ${sentinel}`);
    }
  }
});

test("non-target locales use the documented English fallback without fake translations", () => {
  const english = en as Catalog;
  const publicKeys = Object.keys(publicPricingEn);

  for (const { code } of ALL_APP_LANGUAGES) {
    if (code === "en" || code === "zh-CN" || code === "zh-TW") continue;
    const resolved = getMessages(code) as Catalog;
    const partial = PARTIAL[code] as Catalog;
    for (const key of publicKeys) {
      assert(partial[key] === undefined, `${code}.${key} copies fallback text into the locale catalog`);
      assert(resolved[key] === english[key], `${code}.${key} does not resolve the documented English fallback`);
    }
  }
});

test("pricing and shared public-shell components resolve public copy through the locale catalog", () => {
  const root = process.cwd();
  const files = [
    "src/app/pricing/pricing-client.tsx",
    "src/components/landing/conversion/PricingSection.tsx",
    "src/components/landing/conversion/FaqSection.tsx",
    "src/components/landing/conversion/LandingFooter.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    assert(source.includes("useLocale") || source.includes("resolvePublicPricingCopy"), `${file} bypasses locale copy`);
  }

  const pricingSource = readFileSync(join(root, "src/app/pricing/pricing-client.tsx"), "utf8");
  const landingPricingSource = readFileSync(join(root, "src/components/landing/conversion/PricingSection.tsx"), "utf8");
  const footerSource = readFileSync(join(root, "src/components/landing/conversion/LandingFooter.tsx"), "utf8");
  for (const forbidden of ["{plan.name}", "{plan.description}", "{plan.cta}", ">{row.label}<", ">{row.note}<"]) {
    assert(!pricingSource.includes(forbidden), `pricing page directly renders ${forbidden}`);
  }
  for (const forbidden of ["{plan.name}", "{plan.description}", "{plan.cta}", "{f}"]) {
    assert(!landingPricingSource.includes(forbidden), `landing pricing directly renders ${forbidden}`);
  }
  assert(!footerSource.includes("label={link.label}"), "footer directly renders English link labels");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
