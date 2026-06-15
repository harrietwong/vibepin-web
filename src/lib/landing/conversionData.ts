export const TESTIMONIALS_ENABLED = false;

export type PersonaAccent = "pink" | "green" | "purple" | "blue";

export type PersonaCardData = {
  id: string;
  title: string;
  outcome: string;
  description: string;
  workflow: string;
  benefits: string[];
  cta: string;
  ctaHref: string;
  accent: PersonaAccent;
};

export const PERSONAS: PersonaCardData[] = [
  {
    id: "creators",
    title: "Creators & Bloggers",
    outcome: "Turn trends into consistent content.",
    description:
      "Find topics people are already searching for, study proven Pin formats, and turn them into a repeatable weekly content plan.",
    workflow: "Trend → Reference → Pins → Weekly Plan",
    benefits: [
      "Find trending content angles",
      "Use winning Pins as references",
      "Plan and auto-publish consistently",
    ],
    cta: "Create my content plan",
    ctaHref: "/app/plan?demo=true",
    accent: "pink",
  },
  {
    id: "sellers",
    title: "Ecommerce Sellers",
    outcome: "Connect your products to Pinterest demand.",
    description:
      "See what shoppers are interested in, match your products to rising demand, and generate product-aware Pins that drive discovery and sales.",
    workflow: "Demand → Product → Creative → Traffic",
    benefits: [
      "Match products to rising interests",
      "Create product-aware Pins",
      "Schedule and auto-publish product campaigns",
    ],
    cta: "Promote my products",
    ctaHref: "/app/products?demo=true",
    accent: "green",
  },
  {
    id: "affiliate",
    title: "Affiliate Marketers",
    outcome: "Find what is worth promoting.",
    description:
      "Discover high-potential niches and products before spending time creating promotional content.",
    workflow: "Opportunity → Product → Campaign → Traffic",
    benefits: [
      "Find products with Pinterest demand",
      "Compare opportunity and competition",
      "Turn products into scheduled Pin campaigns",
    ],
    cta: "Find product opportunities",
    ctaHref: "/app/products?demo=true",
    accent: "purple",
  },
  {
    id: "managers",
    title: "Pinterest Managers",
    outcome: "Run research and production in one system.",
    description:
      "Manage opportunity research, creative production, scheduling, and publishing without switching between disconnected tools.",
    workflow: "Research → Create → Review → Publish",
    benefits: [
      "Research multiple content directions",
      "Create and review Pins faster",
      "Schedule and auto-publish weekly plans",
    ],
    cta: "Plan client content",
    ctaHref: "/app/plan?demo=true",
    accent: "blue",
  },
];

export const SUPPORTED_NICHES = [
  "Home Decor",
  "Fashion",
  "Beauty",
  "Food & Drink",
  "DIY & Crafts",
  "Travel",
  "Digital Products",
  "Seasonal",
  "+ More categories",
];

export type WorkflowPersona = "all" | "creator" | "seller" | "affiliate" | "manager";

export type WorkflowStory = {
  id: string;
  persona: WorkflowPersona;
  label: string;
  title: string;
  statement: string;
  result: string;
  steps: string[];
};

export const WORKFLOW_STORIES: WorkflowStory[] = [
  {
    id: "creator",
    persona: "creator",
    label: "Creator Workflow",
    title: "Creator Workflow",
    statement:
      "Move from “What should I post?” to a complete weekly Pinterest plan without switching between research, design, scheduling, and publishing tools.",
    result: "Research, create, schedule, and publish in one place",
    steps: ["Pin Evidence", "Create Pins", "Weekly Plan", "Auto-Publish"],
  },
  {
    id: "seller",
    persona: "seller",
    label: "Seller Workflow",
    title: "Ecommerce Seller Workflow",
    statement:
      "Match rising Pinterest demand to your catalog, generate product-aware Pins, and schedule a week of shoppable content from one workspace.",
    result: "One connected product-to-Pin workflow",
    steps: ["Product Signals", "Create Pins", "Weekly Plan", "Auto-Publish"],
  },
  {
    id: "affiliate",
    persona: "affiliate",
    label: "Affiliate Workflow",
    title: "Affiliate Workflow",
    statement:
      "Compare opportunity and competition before you create, then turn high-potential products into scheduled promotional Pins.",
    result: "Opportunity-first promotion planning",
    steps: ["Opportunity", "Product Pick", "Create Pins", "Schedule"],
  },
  {
    id: "manager",
    persona: "manager",
    label: "Manager Workflow",
    title: "Pinterest Manager Workflow",
    statement:
      "Research multiple directions, batch-create drafts, review every Pin, and publish client calendars without juggling separate tools.",
    result: "End-to-end client production in one system",
    steps: ["Research", "Create Pins", "Weekly Plan", "Auto-Publish"],
  },
];

export const WORKFLOW_TABS: { id: WorkflowPersona; label: string }[] = [
  { id: "all", label: "All" },
  { id: "creator", label: "Creators" },
  { id: "seller", label: "Sellers" },
  { id: "affiliate", label: "Affiliate" },
  { id: "manager", label: "Managers" },
];

export type PricingPlan = {
  id: string;
  name: string;
  bestFor: string;
  priceMonthly: number;
  priceYearly: number;
  valueStatement: string;
  features: string[];
  cta: string;
  planKey: string;
  highlighted?: boolean;
  badge?: string;
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: "free",
    name: "Free",
    bestFor: "Explore Pinterest opportunities.",
    priceMonthly: 0,
    priceYearly: 0,
    valueStatement: "Discover how VibePin turns Pinterest signals into content decisions.",
    features: [
      "Limited opportunity discovery",
      "Basic Pin and product evidence",
      "Limited Pin generations",
      "Basic weekly planning",
    ],
    cta: "Get started free",
    planKey: "free",
  },
  {
    id: "creator",
    name: "Creator",
    bestFor: "Creators building a consistent content system.",
    priceMonthly: 19,
    priceYearly: 15,
    valueStatement: "Research, create, schedule, and publish Pinterest content as a solo creator.",
    features: [
      "Full opportunity intelligence",
      "Pin Ideas and creative references",
      "AI Pin generation",
      "Weekly planning and scheduling",
      "Pinterest auto-publishing",
    ],
    cta: "Start Creator",
    planKey: "creator",
  },
  {
    id: "growth",
    name: "Growth",
    bestFor: "Sellers and marketers turning Pinterest into growth.",
    priceMonthly: 49,
    priceYearly: 39,
    valueStatement:
      "Connect product opportunities, creative production, campaign planning, and auto-publishing.",
    features: [
      "Everything in Creator",
      "Product opportunity intelligence",
      "Higher generation limits",
      "Advanced campaign planning",
      "Automated publishing workflows",
    ],
    cta: "Start Growth",
    planKey: "growth",
    highlighted: true,
    badge: "MOST POPULAR",
  },
  {
    id: "agency",
    name: "Agency",
    bestFor: "Teams managing multiple Pinterest workflows.",
    priceMonthly: 99,
    priceYearly: 79,
    valueStatement:
      "Plan, review, schedule, and publish Pinterest content across accounts or clients.",
    features: [
      "Everything in Growth",
      "Higher usage limits",
      "Built for higher-volume workflows",
      "Campaign organization at scale",
      "Priority support",
    ],
    cta: "Choose Agency",
    planKey: "pro",
  },
];

export type FaqItem = {
  question: string;
  answer: string;
  note?: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What is a Pinterest opportunity?",
    answer:
      "A Pinterest opportunity is a topic or product direction supported by multiple signals, such as rising demand, strong Pin engagement, manageable competition, and related product interest. VibePin brings these signals together so you can decide what is worth creating or promoting.",
  },
  {
    question: "What's the difference between Pin Ideas and Product Opportunities?",
    answer:
      "Pin Ideas help you understand how successful Pinterest content is presented, including its format, visual style, and content angle. Product Opportunities help you identify what may be worth promoting, using product-related Pinterest demand and performance signals. Pin Ideas show you how to create. Product Opportunities show you what to promote.",
  },
  {
    question: "Can I use my own products?",
    answer:
      "Yes. You can upload product images or import a product URL, add Pin references, and use VibePin's creative direction to generate Pinterest-native drafts around your own products.",
  },
  {
    question: "Does VibePin publish automatically?",
    answer:
      "Yes. After connecting your Pinterest account, you can review your Pins, schedule them in your weekly plan, and let VibePin publish them automatically at the selected times. You remain in control of every draft and can review or edit content before it is scheduled.",
    note:
      "Auto-publishing availability may depend on Pinterest account connection and API access.",
  },
  {
    question: "Where does the data come from?",
    answer:
      "VibePin analyzes Pinterest demand signals, high-save Pin performance, and related product signals. These inputs are processed into opportunity scores and recommendations that help you make better content decisions.",
  },
  {
    question: "Do I need a Pinterest account?",
    answer:
      "You can explore opportunities and create content without connecting a Pinterest account. A connected Pinterest account is required for scheduling, account-specific recommendations, and automatic publishing.",
  },
  {
    question: "Can I use VibePin for digital products?",
    answer:
      "Yes. VibePin supports both physical and digital product opportunities, including templates, printables, educational resources, creative assets, and other Pinterest-friendly digital products.",
  },
  {
    question: "Is VibePin only for ecommerce?",
    answer:
      "No. VibePin is also designed for creators, bloggers, affiliate marketers, and Pinterest managers who need a repeatable research-to-content workflow.",
  },
];

export const PRICING_REASSURANCE = [
  "No credit card required",
  "Cancel anytime",
  "Review every Pin before publishing",
  "Schedule and auto-publish when ready",
];

export const FINAL_CTA_TRUST = [
  "No credit card required",
  "Review every Pin before publishing",
  "Cancel anytime",
];
