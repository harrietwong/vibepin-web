// Legacy types — kept here so they don't pollute the new opportunity.ts schema
export type TrendStage = "Peaking" | "Rising" | "Stable" | "Emerging";

export interface MockProductOpportunity {
  id:              string;
  productType:     string;
  platform:        string;
  productScore:    number;
  commercialAngle: string;
  sourceSignal:    string;
}

export interface OpportunityBrief {
  keyword:              string;
  category:             string;
  weeklyGrowth:         number;
  yoyGrowth:            number;
  priorityScore:        number;
  trendStage:           TrendStage;
  intentType:           string;
  contentType:          string;
  whyRising:            string;
  productOpportunities: MockProductOpportunity[];
  contentIdeas:         string[];
}

// ── Hash helper ────────────────────────────────────────────────────────────────
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Trend Stage ────────────────────────────────────────────────────────────────
export function mockTrendStage(weeklyChange: number, yoyChange: number): TrendStage {
  if (weeklyChange > 50 || yoyChange > 500) return "Peaking";
  if (weeklyChange > 20 || yoyChange > 100) return "Rising";
  if (weeklyChange > 5  || yoyChange > 0)   return "Stable";
  return "Emerging";
}

// ── Stage badge color ─────────────────────────────────────────────────────────
export function stageBadgeStyle(stage: TrendStage): { color: string; bg: string; border: string } {
  switch (stage) {
    case "Peaking":  return { color: "#FFD700", bg: "rgba(255,215,0,0.12)",    border: "rgba(255,215,0,0.3)"    };
    case "Rising":   return { color: "#00F2FE", bg: "rgba(0,242,254,0.10)",    border: "rgba(0,242,254,0.28)"   };
    case "Stable":   return { color: "#4ade80", bg: "rgba(74,222,128,0.10)",   border: "rgba(74,222,128,0.28)"  };
    case "Emerging": return { color: "#FBBF24", bg: "rgba(251,191,36,0.10)",   border: "rgba(251,191,36,0.28)"  };
  }
}

// ── Intent & Content type by category ─────────────────────────────────────────
const INTENT_BY_CAT: Record<string, string> = {
  beauty:    "Visual Search / Aspirational",
  home:      "Visual Search / Commercial",
  fashion:   "Inspirational / Commercial",
  jewelry:   "Gift Intent / Self-treat",
  wellness:  "Inspirational / Informational",
  art:       "Aspirational / Decorating",
  lifestyle: "Aspirational / Lifestyle",
  gifts:     "Gift Intent / Commercial",
  food:      "Instructional / Aspirational",
  digital:   "Commercial / Educational",
};

const CONTENT_BY_CAT: Record<string, string> = {
  beauty:    "Inspiration Pin / Tutorial Pin",
  home:      "Inspiration Pin / Shop the Look",
  fashion:   "Outfit Idea / Editorial Pin",
  jewelry:   "Product Pin / Gift Guide",
  wellness:  "Routine Inspiration / Tips Pin",
  art:       "Gallery Inspo / Product Pin",
  lifestyle: "Aesthetic Mood / Lifestyle Pin",
  gifts:     "Gift Guide / Product Pin",
  food:      "Recipe Pin / Roundup",
  digital:   "Educational Pin / Product Pin",
};

// ── Why Rising summaries ───────────────────────────────────────────────────────
const WHY_TEMPLATES: Record<string, string[]> = {
  beauty: [
    "{kw} is gaining momentum as graduation season and summer beauty content overlap. High-save Pins show strong demand for minimal, soft-color styles.",
    "{kw} is trending due to the \"clean girl\" aesthetic wave. Pinterest users are saving aspirational, achievable beauty routines at record rates.",
    "{kw} search volume is accelerating — seasonal demand combined with creator-led virality is pushing this keyword into peak discovery.",
  ],
  home: [
    "{kw} is rising as homeowners seek cozy, Pinterest-worthy spaces. The japandi and quiet luxury movements are driving saves in this category.",
    "{kw} reflects growing interest in DIY home transformation. Weekend project content is seeing 3× higher save rates than last quarter.",
    "{kw} aligns with the \"slow living\" aesthetic trend. Users are saving in clusters, signaling strong intent to redecorate.",
  ],
  fashion: [
    "{kw} is accelerating ahead of the seasonal wardrobe refresh cycle. Quiet luxury and capsule wardrobe content are driving high-intent saves.",
    "{kw} is trending as creators shift from fast fashion to curated personal style. This keyword pulls strong commercial intent from fashion-forward savers.",
    "{kw} benefits from the 2026 \"effortless chic\" wave on Pinterest. Save velocity is highest among 18–32 women with strong purchasing power.",
  ],
  jewelry: [
    "{kw} is rising on the back of gifting season demand and the dainty/minimalist jewelry trend. Etsy and Amazon saves are clustering around this keyword.",
    "{kw} is catching momentum from self-treat and daily jewelry trends. High-save Pins show layered stack aesthetics dominating discovery.",
    "{kw} benefits from both gift intent and personal style intent. Commercial saves are 2× above the jewelry category average.",
  ],
  wellness: [
    "{kw} is rising as users seek structured morning and evening routines. Pinterest is the #1 platform for wellness aspiration content.",
    "{kw} aligns with the \"soft life\" aesthetic moment. Save rates for ritual and routine content have tripled in this category.",
    "{kw} is trending because of seasonal health awareness. Creator content is accumulating saves at above-average velocity.",
  ],
  art: [
    "{kw} is gaining traction as home gallery culture grows. Users are actively planning room aesthetics and saving Pins for future purchases.",
    "{kw} is trending due to the printable wall art boom. Low-cost decorating content is saving at 4× the category baseline.",
  ],
  lifestyle: [
    "{kw} is rising because of the \"Pinterest aesthetic\" revival. Curated, aspirational lifestyle content is seeing the highest save rates in 18 months.",
    "{kw} benefits from the cozy content wave — creators are producing high-save content and this keyword sits at the intersection of multiple trending niches.",
  ],
  gifts: [
    "{kw} is rising ahead of gifting season. Pinterest users save gift ideas months before purchase, making this a high-intent commercial keyword.",
    "{kw} is trending because of the shift toward thoughtful, sentimental gifting. Pins showing personalized or curated {kw} ideas are outperforming.",
  ],
  food: [
    "{kw} is rising as seasonal cooking content peaks. Pinterest food keywords see 2× save volume in Q2 vs Q4, and {kw} is riding that wave.",
    "{kw} benefits from the quick-recipe and aesthetic food styling trend. High-save Pins show minimal, aspirational plating styles dominating.",
  ],
  digital: [
    "{kw} is gaining momentum as the creator economy expands. Pinterest users are actively researching digital products and passive income strategies.",
    "{kw} is trending because of the Etsy digital download boom. Pins showing income potential and aesthetic templates are saving at record rates.",
  ],
};

export function mockWhyRising(keyword: string, category: string, weeklyChange: number, yoyChange: number): string {
  const cat = category.toLowerCase();
  const templates = WHY_TEMPLATES[cat] ?? WHY_TEMPLATES.lifestyle;
  const idx = hashStr(keyword) % templates.length;
  return templates[idx].replace(/\{kw\}/g, keyword);
}

// ── Product Opportunities ──────────────────────────────────────────────────────
const PRODUCTS_BY_CAT: Record<string, Array<{
  productType: string; platform: string; score: number; commercialAngle: string; sourceSignal: string;
}>> = {
  beauty: [
    { productType: "Press-On Nails Set",     platform: "Etsy / Amazon", score: 88, commercialAngle: "Graduation nail sets, summer nail kits",        sourceSignal: "High-save beauty tutorial pins" },
    { productType: "Nail Polish Collection", platform: "Amazon / Ulta",  score: 81, commercialAngle: "Soft pink, maroon, clean girl palette",         sourceSignal: "Strong visual search intent" },
    { productType: "Cuticle Care Kit",       platform: "Amazon / Etsy",  score: 74, commercialAngle: "At-home manicure routine, self-care bundle",    sourceSignal: "Ritual/routine content clustering" },
  ],
  home: [
    { productType: "Aesthetic Wall Prints",  platform: "Etsy",           score: 91, commercialAngle: "Gallery wall, printable decor, room refresh",   sourceSignal: "Gallery wall pins saving in clusters" },
    { productType: "Cozy Throw Blanket",     platform: "Amazon / Target", score: 84, commercialAngle: "Japandi, cozy living, neutral palette styling",sourceSignal: "Interior styling pin saves" },
    { productType: "Decorative Candles",     platform: "Etsy / Target",  score: 77, commercialAngle: "Aesthetic desk/table setup, scent ritual",      sourceSignal: "Lifestyle flatlay pin saves" },
  ],
  fashion: [
    { productType: "Capsule Wardrobe Piece", platform: "ASOS / Zara",    score: 87, commercialAngle: "Quiet luxury, effortless chic, neutral basics", sourceSignal: "Outfit inspo pins with shop tags" },
    { productType: "Linen Summer Set",       platform: "Etsy / Amazon",  score: 82, commercialAngle: "Summer aesthetic, beach edit, coastal vibe",    sourceSignal: "Seasonal fashion pin clustering" },
    { productType: "Mini Shoulder Bag",      platform: "Amazon / SHEIN", score: 76, commercialAngle: "Y2K revival, outfit completion, gift potential",sourceSignal: "Accessories saves in fashion pins" },
  ],
  jewelry: [
    { productType: "Dainty Gold Necklace",   platform: "Etsy",           score: 93, commercialAngle: "Layer stack, minimal, everyday wear, gifting", sourceSignal: "Jewelry stack tutorial pins" },
    { productType: "Pearl Earring Set",      platform: "Amazon / Etsy",  score: 85, commercialAngle: "Clean girl aesthetic, office to dinner",        sourceSignal: "Soft aesthetic pin saves" },
    { productType: "Stackable Ring Set",     platform: "Etsy / Amazon",  score: 79, commercialAngle: "Gift set, self-treat, minimalist stacking",     sourceSignal: "Product pin commercial intent" },
  ],
  wellness: [
    { productType: "Morning Ritual Kit",     platform: "Amazon / Etsy",  score: 86, commercialAngle: "Self-care bundle, journaling, routine building",sourceSignal: "Ritual aesthetic pin saves" },
    { productType: "Pilates / Yoga Mat",     platform: "Amazon",         score: 82, commercialAngle: "Home workout setup, aesthetic gym gear",         sourceSignal: "Wellness lifestyle pin clusters" },
    { productType: "Matcha Starter Set",     platform: "Amazon / Etsy",  score: 75, commercialAngle: "Morning routine, clean eating, aesthetic drink",sourceSignal: "Food + wellness crossover saves" },
  ],
  art: [
    { productType: "Printable Wall Art",     platform: "Etsy",           score: 94, commercialAngle: "Instant download, gallery wall, room refresh",  sourceSignal: "Gallery wall pin saves" },
    { productType: "Art Print (Framed)",     platform: "Etsy / Amazon",  score: 87, commercialAngle: "Gift, room styling, aesthetic home",            sourceSignal: "Interior inspo pin saves" },
    { productType: "Canvas Art Kit",         platform: "Amazon",         score: 71, commercialAngle: "DIY art, creative hobby, home décor activity",  sourceSignal: "DIY craft pin saves" },
  ],
  lifestyle: [
    { productType: "Aesthetic Desk Organiser",platform: "Amazon / Etsy", score: 85, commercialAngle: "WFH setup, clean girl desk, aesthetic study",  sourceSignal: "Study/desk inspo pin saves" },
    { productType: "Cozy Reading Kit",        platform: "Amazon",        score: 78, commercialAngle: "Book aesthetic, slow living, self-care ritual", sourceSignal: "Bookshelf + cozy pin clustering" },
    { productType: "Scented Candle Set",      platform: "Etsy / Target", score: 72, commercialAngle: "Lifestyle flatlay, gifting, aesthetic ambiance",sourceSignal: "Lifestyle content saves" },
  ],
  gifts: [
    { productType: "Curated Gift Box",        platform: "Etsy",          score: 92, commercialAngle: "Birthday, Galentines, sentimental gifting",     sourceSignal: "Gift guide pin saves" },
    { productType: "Personalised Keepsake",   platform: "Etsy",          score: 88, commercialAngle: "Sentimental, unique, graduation gift",          sourceSignal: "Occasion-specific pin clustering" },
    { productType: "Luxury Candle",           platform: "Etsy / Amazon", score: 79, commercialAngle: "Gift for her, birthday, housewarming",          sourceSignal: "Gift save intent signals" },
  ],
  food: [
    { productType: "Aesthetic Food Props",    platform: "Amazon",        score: 80, commercialAngle: "Food styling, content creation, home cook",     sourceSignal: "Aesthetic food pin saves" },
    { productType: "Matcha / Coffee Tool",    platform: "Amazon / Etsy", score: 77, commercialAngle: "Morning ritual, café aesthetic, gifting",       sourceSignal: "Lifestyle + food pin overlap" },
  ],
  digital: [
    { productType: "Canva Template Pack",     platform: "Etsy",          score: 91, commercialAngle: "Social media kit, brand starter, creator tools",sourceSignal: "Creator/entrepreneur pin saves" },
    { productType: "Digital Planner",         platform: "Etsy",          score: 85, commercialAngle: "Productivity, journaling, student organization",sourceSignal: "Study aesthetic pin saves" },
  ],
};

export function mockProductOpportunities(category: string): MockProductOpportunity[] {
  const cat = category.toLowerCase();
  const prods = PRODUCTS_BY_CAT[cat] ?? PRODUCTS_BY_CAT.lifestyle;
  return prods.slice(0, 3).map((p, i) => ({
    id: `prod-${cat}-${i}`,
    productType: p.productType,
    platform: p.platform,
    productScore: p.score,
    commercialAngle: p.commercialAngle,
    sourceSignal: p.sourceSignal,
  }));
}

// ── Content Ideas ──────────────────────────────────────────────────────────────
const IDEA_TEMPLATES: Record<string, string[]> = {
  beauty:    ["12 {kw} Ideas for Graduation Season", "Minimal {kw} Looks That Feel Expensive", "Clean Girl {kw} Designs for Summer", "The {kw} Trend Everyone Is Saving Right Now", "Best {kw} You Can Copy in Under 10 Minutes"],
  home:      ["10 {kw} Ideas to Transform Your Space", "The {kw} Aesthetic Changing Every Feed", "How to Get the {kw} Look for Under $100", "{kw} Inspo for Every Room in Your House", "Affordable {kw} Finds From Amazon + Etsy"],
  fashion:   ["12 Ways to Style {kw} This Season", "The {kw} Outfit Formula Everyone Is Copying", "How to Build a {kw} Capsule Wardrobe", "{kw} Looks That Feel Effortlessly Expensive", "The Best {kw} Pieces Under $50"],
  jewelry:   ["The {kw} Stack You'll Wear Every Day", "Dainty {kw} Ideas for a Minimal Look", "Best {kw} for Gifting This Season", "{kw} Trends for 2026 That Are Already Viral", "How to Layer {kw} Like a Stylist"],
  wellness:  ["Your {kw} Morning Ritual, Elevated", "5 {kw} Habits That Actually Stick", "The {kw} Routine Changing People's Lives", "Beginner {kw} Guide for 2026", "Everything You Need for Your {kw} Ritual"],
  art:       ["Gallery Wall Ideas Featuring {kw}", "The {kw} Print Everyone Is Saving", "How to Style {kw} in Any Room", "Affordable {kw} Finds for Your Walls", "{kw} Inspiration That Transforms Any Room"],
  lifestyle: ["The {kw} Aesthetic Taking Over Pinterest", "Slow Living {kw} Vibes for Your Daily Routine", "How to Build Your Perfect {kw} Life", "{kw} Inspo for Every Season of 2026", "The {kw} Content That's Going Viral"],
  gifts:     ["The Best {kw} Gift Ideas for Her", "{kw} Gift Guide: Something for Everyone", "Unique {kw} Gifts They Won't Expect", "The Thoughtful {kw} Gift That Always Lands", "Last-Minute {kw} Gifts That Look Expensive"],
  food:      ["The {kw} Recipe That Broke the Internet", "Make {kw} in Under 30 Minutes", "10 Aesthetic {kw} Ideas to Try This Week", "{kw} Made Easy: Beginner-Friendly Version", "The {kw} Plating Style Getting 50K+ Saves"],
  digital:   ["How to Start Selling {kw} on Etsy", "The {kw} Side Hustle Making Real Money", "Best {kw} Templates That Sell Themselves", "Beginners Guide to {kw} Digital Products", "My {kw} Income Report — First 30 Days"],
};

export function mockContentIdeas(keyword: string, category: string): string[] {
  const templates = IDEA_TEMPLATES[category.toLowerCase()] ?? IDEA_TEMPLATES.lifestyle;
  return templates.map(t => t.replace(/\{kw\}/g, keyword));
}

// ── Full Opportunity Brief builder ─────────────────────────────────────────────
export function buildOpportunityBrief(
  keyword: string, category: string,
  weeklyChange: number, yoyChange: number, priorityScore: number,
): OpportunityBrief {
  const cat = category.toLowerCase();
  return {
    keyword,
    category,
    weeklyGrowth: weeklyChange,
    yoyGrowth: yoyChange,
    priorityScore,
    trendStage: mockTrendStage(weeklyChange, yoyChange),
    intentType:  INTENT_BY_CAT[cat]  ?? "Visual Search / Inspirational",
    contentType: CONTENT_BY_CAT[cat] ?? "Inspiration Pin / Product Pin",
    whyRising:   mockWhyRising(keyword, cat, weeklyChange, yoyChange),
    productOpportunities: mockProductOpportunities(category),
    contentIdeas: mockContentIdeas(keyword, category),
  };
}

// ── Card-level intelligence scores — fallbacks only, use real data when available ─
export function fallbackMakeSimilarScore(saveCount: number, velocity: number): number {
  return Math.min(98, Math.max(42, Math.round(52 + Math.min(28, saveCount / 700) + Math.min(18, velocity / 15))));
}

export function fallbackCommercialIntentScore(saveCount: number, category: string): number {
  const bonus: Record<string, number> = { gifts: 20, jewelry: 18, beauty: 15, fashion: 14, home: 12, art: 10, wellness: 8, lifestyle: 6 };
  return Math.min(97, Math.max(38, Math.round(44 + Math.min(25, saveCount / 800) + (bonus[category.toLowerCase()] ?? 8))));
}

// Legacy aliases — kept so old imports don't break during migration
export const mockMakeSimilarScore = fallbackMakeSimilarScore;
export const mockCommercialIntentScore = fallbackCommercialIntentScore;
