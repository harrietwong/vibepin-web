/**
 * VibePin public pricing — single source of truth shared by the landing
 * pricing preview and the standalone /pricing page.
 *
 * Language rules: every comparison value is "✓", "—", "Limited", or a clear
 * numeric limit. No vague tiers ("Basic discovery", "Advanced", "intelligence").
 */

import {
  allowanceRowValues,
  formatMonthlyAllowance,
  formatPlainCount,
} from "./server/planEntitlements";

export type PlanKey = "free" | "starter" | "pro" | "business";

export type PricingTier = {
  id: PlanKey;
  name: string;
  priceMonthly: number;
  /** Per-month price when billed annually. */
  priceYearly: number;
  description: string;
  /** Full bullet list shown on the /pricing cards. */
  bullets: string[];
  /** Short bullet subset shown on the landing pricing preview cards. */
  previewBullets: string[];
  cta: string;
  ctaHref: string;
  highlighted?: boolean;
  badge?: string;
  /**
   * @deprecated legacy Paddle — historical only, not used for checkout. Creem is
   * the merchant of record; checkout goes through /api/billing/creem/checkout,
   * which resolves the product id server-side from CREEM_PRODUCT_* env vars.
   * These ids are retained only so the legacy Paddle webhook/history keep working.
   */
  paddlePriceIds?: { month: string; year: string };
};

export const PRICING_TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    priceYearly: 0,
    description: "Explore VibePin before you scale.",
    bullets: [
      "Limited high-save products, trending Pins, and keyword ideas",
      "Limited AI Pin generation",
      "1 account per platform",
      "5 scheduled posts / month",
      "10 AI images / month",
      "20 AI text generations / month",
    ],
    previewBullets: [
      "Limited high-save products, trending Pins, and keyword ideas",
      "1 account per platform",
      "5 scheduled posts / month",
      "10 AI images / month",
    ],
    cta: "Get started free",
    ctaHref: "/signup?plan=free",
  },
  {
    id: "starter",
    name: "Starter",
    priceMonthly: 19,
    priceYearly: 15,
    description: "For creators starting a consistent content workflow.",
    bullets: [
      "1 account per platform",
      "150 scheduled posts / month",
      "150 AI images / month",
      "500 AI text generations / month",
      "High-save products, trending Pins, and keyword ideas",
      "AI Pin generation",
      "AI titles, descriptions, and hashtags",
      "Publish to Pinterest, Instagram, and Facebook",
    ],
    previewBullets: [
      "1 account per platform",
      "150 scheduled posts / month",
      "150 AI images / month",
      "High-save products, trending Pins, and keyword ideas",
      "Publish to Pinterest, Instagram, and Facebook",
    ],
    cta: "Start Starter",
    ctaHref: "/signup?plan=starter",
    paddlePriceIds: {
      month: "pri_01kxcssce69ra3ck5ra7k8twmk",
      year: "pri_01kxcssd0gftaxp4ehg9h7xs6z",
    },
  },
  {
    id: "pro",
    name: "Pro",
    priceMonthly: 49,
    priceYearly: 39,
    description: "For sellers, affiliate marketers, and creators scaling content growth.",
    bullets: [
      "2 accounts per platform",
      "300 scheduled posts / month",
      "800 AI images / month",
      "2,000 AI text generations / month",
      "High-save products, trending Pins, and keyword ideas",
      "Batch generation",
      "Batch edit",
      "Product and affiliate workflows",
      "Calendar planning",
      "Performance insights",
      "Priority generation",
    ],
    previewBullets: [
      "2 accounts per platform",
      "300 scheduled posts / month",
      "800 AI images / month",
      "Batch generation and batch edit",
      "Product and affiliate workflows",
    ],
    cta: "Start Pro",
    ctaHref: "/signup?plan=pro",
    highlighted: true,
    badge: "MOST POPULAR",
    paddlePriceIds: {
      month: "pri_01kxcsse6c7v4bybqn520kvz08",
      year: "pri_01kxcsseqq934frrct7kx4ctwv",
    },
  },
  {
    id: "business",
    name: "Business",
    priceMonthly: 99,
    priceYearly: 79,
    description: "For brands managing multiple products, campaigns, and channels.",
    bullets: [
      "3 accounts per platform",
      "Unlimited scheduled posts",
      "3,000 AI images / month",
      "10,000 AI text generations / month",
      "High-save products, trending Pins, and keyword ideas",
      "Batch generation and batch edit",
      "Product and affiliate workflows",
      "Product-level analytics",
      "Higher usage limits",
      "Priority support",
    ],
    previewBullets: [
      "3 accounts per platform",
      "Unlimited scheduled posts",
      "3,000 AI images / month",
      "Product-level analytics",
      "Priority support",
    ],
    cta: "Start Business",
    ctaHref: "/signup?plan=business",
    paddlePriceIds: {
      month: "pri_01kxcssfv1fp06a73md7bwhtxt",
      year: "pri_01kxcssgcr5fc496g6e71jjxfz",
    },
  },
];

export const ENTERPRISE_PLAN = {
  title: "Need more workspaces, users, or client workflows?",
  description: "For agencies and larger teams managing multiple brands or clients.",
  bullets: [
    "Custom workspaces",
    "Custom account limits per platform",
    "Custom AI limits",
    "Client workflows",
    "White-label reports",
    "API access",
    "Priority support",
  ],
  cta: "Contact us",
  ctaHref: "/contact",
} as const;

/** Values ordered Free → Starter → Pro → Business. */
export type ComparisonRow = {
  label: string;
  /** Small helper line rendered under the label. */
  note?: string;
  values: [string, string, string, string];
};

export type ComparisonSection = {
  title: string;
  rows: ComparisonRow[];
};

export const COMPARISON_SECTIONS: ComparisonSection[] = [
  {
    title: "Basics",
    rows: [
      {
        label: "Accounts per platform",
        note: "How many accounts or Pages you can connect on each platform.",
        // Derived from PLAN_ENTITLEMENTS.connectedAccountsPerPlatform → "1"/"1"/"2"/"3".
        values: allowanceRowValues("connectedAccountsPerPlatform", formatPlainCount),
      },
      {
        label: "Scheduled posts",
        // Derived → "5 / month"/"150 / month"/"300 / month"/"Unlimited".
        values: allowanceRowValues("monthlyScheduledPosts", formatMonthlyAllowance),
      },
    ],
  },
  {
    title: "AI Creation",
    rows: [
      {
        label: "AI images",
        // Derived → "10 / month"/"150 / month"/"800 / month"/"3,000 / month".
        values: allowanceRowValues("monthlyAiImages", formatMonthlyAllowance),
      },
      { label: "AI Pin generation", values: ["Limited", "✓", "✓", "✓"] },
      {
        label: "AI titles, descriptions, and hashtags",
        // Derived → "20 / month"/"500 / month"/"2,000 / month"/"10,000 / month".
        values: allowanceRowValues("monthlyAiTextGenerations", formatMonthlyAllowance),
      },
      {
        label: "Batch generation",
        note: "Batch generation uses your AI image allowance — each image counts once.",
        values: ["✓", "✓", "✓", "✓"],
      },
      { label: "Batch edit", values: ["—", "Limited", "✓", "✓"] },
      { label: "Priority generation", values: ["—", "—", "✓", "✓"] },
    ],
  },
  {
    title: "Discovery",
    rows: [
      { label: "High-save products", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Trending Pins", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Keyword ideas", values: ["Limited", "✓", "✓", "✓"] },
    ],
  },
  {
    title: "Publishing",
    rows: [
      { label: "Pinterest publishing", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Instagram publishing", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Facebook publishing", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Calendar planning", values: ["Basic", "✓", "✓", "✓"] },
      { label: "Auto-publishing", values: ["—", "✓", "✓", "✓"] },
    ],
  },
  {
    title: "Products & Affiliate",
    rows: [
      { label: "Product management", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Product links", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Amazon affiliate support", values: ["—", "Limited", "✓", "✓"] },
      { label: "Product campaigns", values: ["—", "—", "✓", "✓"] },
    ],
  },
  {
    title: "Analytics & Support",
    rows: [
      { label: "Basic analytics", values: ["Limited", "✓", "✓", "✓"] },
      { label: "Performance insights", values: ["—", "—", "✓", "✓"] },
      { label: "Product-level analytics", values: ["—", "—", "Limited", "✓"] },
      { label: "Priority support", values: ["—", "—", "—", "✓"] },
    ],
  },
];

/**
 * Price of the extra-account-slots add-on, in USD. ONE place, because it appears
 * on the pricing page, in the FAQ, and on the Settings limit banner — three
 * surfaces that must never quote different numbers. Changing the price is editing
 * this object (and the Creem product itself).
 *
 * `yearlyPerMonth` is the per-month figure when billed yearly, matching how the
 * plan prices are presented.
 */
export const EXTRA_ACCOUNT_PRICE_USD = { monthly: 7, yearlyPerMonth: 5 } as const;

/** Caption rendered under the comparison table to explain the account model. */
export const ACCOUNTS_HELPER_TEXT =
  "An account means one connected Pinterest, Instagram, or Facebook account/page. Starter includes 1 account per platform, Pro includes 2 accounts per platform, and Business includes 3 accounts per platform.";

/**
 * Second caption: the add-on. Kept separate from ACCOUNTS_HELPER_TEXT so the
 * "what a plan includes" sentence and the "how to get more" sentence can be placed
 * (and translated) independently.
 */
export const EXTRA_ACCOUNT_HELPER_TEXT =
  `Need more? Add extra account slots for $${EXTRA_ACCOUNT_PRICE_USD.monthly} per account / month ` +
  `($${EXTRA_ACCOUNT_PRICE_USD.yearlyPerMonth} billed yearly). A slot can be used on any platform, ` +
  "and you can add as many as you need. Available on Starter, Pro, and Business.";

export type PricingFaqItem = {
  question: string;
  answer: string;
};

export const PRICING_FAQ: PricingFaqItem[] = [
  {
    question: "Can I publish to Pinterest, Instagram, and Facebook?",
    answer:
      "Yes. Paid plans support publishing to Pinterest, Instagram, and Facebook. Free users have limited publishing access.",
  },
  {
    question: "What are AI images?",
    answer:
      "Each successfully generated image uses one AI image from your monthly allowance. Failed generations are not counted.",
  },
  {
    question: "What does Limited discovery mean on the Free plan?",
    answer:
      "Free users can preview high-save products, trending Pins, and keyword ideas. Paid plans unlock full access to these discovery features.",
  },
  {
    question: "Do you charge per search?",
    answer:
      "No. VibePin does not price discovery by search count. Paid users get access to discovery features as part of their plan.",
  },
  {
    question: "Can I schedule unlimited posts?",
    answer:
      "Business includes unlimited scheduled posts. Pro includes 300 scheduled posts per month. Starter includes 150 scheduled posts per month. Free includes 5 scheduled posts per month.",
  },
  {
    question: "How many accounts can I connect?",
    answer:
      "Starter includes 1 account per platform (Pinterest, Instagram, and Facebook). Pro includes 2 accounts per platform. Business includes 3 accounts per platform. Free includes 1 account per platform.",
  },
  {
    question: "Need more accounts on a plan?",
    answer:
      `Add extra account slots for $${EXTRA_ACCOUNT_PRICE_USD.monthly} per account / month ` +
      `($${EXTRA_ACCOUNT_PRICE_USD.yearlyPerMonth} per account / month billed yearly). ` +
      "A slot can be used on any platform — Pinterest, Instagram, or Facebook — and there is no limit " +
      "on how many you can add. Extra account slots are available on Starter, Pro, and Business.",
  },
  {
    question: "Which plan should I choose?",
    answer:
      "Choose Starter if you are a solo creator publishing one brand across all platforms. Choose Pro if you want more accounts per platform, more content volume, and batch workflows. Choose Business if you need the highest account limits and unlimited scheduling.",
  },
  {
    question: "Can I change plans later?",
    answer: "Yes. You can upgrade or downgrade as your workflow grows.",
  },
  {
    question: "Do you offer agency or enterprise plans?",
    answer:
      "Yes. Larger teams and agencies can contact us for custom workspaces, account limits, and client workflows.",
  },
];

export const PRICING_REASSURANCE = [
  "No credit card required",
  "Cancel anytime",
  "Upgrade or downgrade anytime",
];
