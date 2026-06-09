const u = (id: string, w: number, h: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${h}&q=80`;

export type Category =
  | "All" | "Fashion" | "Beauty" | "Home Decor" | "Jewelry"
  | "Gifts" | "Digital" | "Food" | "Wellness" | "Art" | "Lifestyle";

export type StylePreset = "editorial" | "boho" | "minimal" | "cozy" | "luxe";

export interface StyleCard {
  id: string;
  category: Category;
  tag: string;
  title: string;
  src: string;
  imgH: number;
  preset: StylePreset;
  saves: string;
  keywords: string[];
  sampleTitle: string;
  sampleDesc: string;
}

export const STYLE_CARDS: StyleCard[] = [
  // Fashion
  {
    id: "f1", category: "Fashion", tag: "Outfit inspo",
    title: "Layered fall look — 3 pieces you already own",
    src: u("1515886657613-9f3515b0c78f", 520, 820), imgH: 820,
    preset: "editorial", saves: "12.4k",
    keywords: ["#falloutfit", "#capsulewardrobe", "#ootd"],
    sampleTitle: "Layered Fall Look — 3 Pieces, Infinite Outfits",
    sampleDesc: "Build a versatile fall wardrobe with just three key pieces. Mix and match for effortless everyday style all season long.",
  },
  {
    id: "f2", category: "Fashion", tag: "Summer capsule",
    title: "Minimal summer capsule — 10 pieces, endless looks",
    src: u("1490481651871-ab68de25d43d", 520, 720), imgH: 720,
    preset: "minimal", saves: "9.8k",
    keywords: ["#capsulewardrobe", "#minimalistfashion", "#summerstyle"],
    sampleTitle: "Minimal Summer Capsule — 10 Pieces, Endless Looks",
    sampleDesc: "Curate a minimalist summer wardrobe with versatile basics that take you from morning to evening without the clutter.",
  },
  {
    id: "f3", category: "Fashion", tag: "Style guide",
    title: "How to style this season's trending piece",
    src: u("1483985988355-763728e1935b", 520, 760), imgH: 760,
    preset: "editorial", saves: "15.2k",
    keywords: ["#styleguide", "#fashiontrends", "#ootd"],
    sampleTitle: "How to Style This Season's Must-Have Piece",
    sampleDesc: "Three ways to wear the piece everyone is talking about — from casual daytime to elevated evening looks.",
  },
  // Beauty
  {
    id: "b1", category: "Beauty", tag: "Morning ritual",
    title: "5-min glow routine · clean beauty",
    src: u("1512207736890-6ffed8a84e8d", 520, 640), imgH: 640,
    preset: "minimal", saves: "8.1k",
    keywords: ["#cleanbeauty", "#glowroutine", "#skincare"],
    sampleTitle: "5-Min Glow Routine With Clean Beauty Essentials",
    sampleDesc: "Get luminous skin in under five minutes with these clean, skin-loving products that work for every skin type.",
  },
  {
    id: "b2", category: "Beauty", tag: "Evening ritual",
    title: "Evening skin ritual — ceramides & peptides",
    src: u("1522335789203-aabd1fc54bc9", 520, 880), imgH: 880,
    preset: "editorial", saves: "11.3k",
    keywords: ["#skincareroutine", "#nightroutine", "#antiaging"],
    sampleTitle: "Evening Skin Ritual — Ceramides & Peptides for Overnight Repair",
    sampleDesc: "Wake up to plumper, smoother skin with this science-backed evening routine featuring ceramides and peptides.",
  },
  {
    id: "b3", category: "Beauty", tag: "Flatlay",
    title: "Glow-from-within routine · 4 steps only",
    src: u("1596462502278-27bfdc403348", 520, 600), imgH: 600,
    preset: "minimal", saves: "7.6k",
    keywords: ["#glowskin", "#naturalmakeup", "#beautyessentials"],
    sampleTitle: "Glow From Within — A 4-Step Routine That Actually Works",
    sampleDesc: "Simplify your skincare with just four products that deliver visible results. Less is more when you choose the right ingredients.",
  },
  // Home Decor
  {
    id: "h1", category: "Home Decor", tag: "Living room",
    title: "Small living room — warm minimal layout",
    src: u("1484101403633-562f891dc89a", 520, 940), imgH: 940,
    preset: "boho", saves: "19.2k",
    keywords: ["#homedecor", "#minimalhome", "#livingroom"],
    sampleTitle: "Small Living Room Makeover — Warm Minimal Style",
    sampleDesc: "Transform a compact living space with warm neutrals, natural textures, and intentional furniture placement.",
  },
  {
    id: "h2", category: "Home Decor", tag: "Bedroom",
    title: "Hygge bedroom — textures & warmth",
    src: u("1586023492125-27b2c045efd7", 520, 680), imgH: 680,
    preset: "cozy", saves: "16.7k",
    keywords: ["#hygge", "#bedroomdecor", "#cozyhome"],
    sampleTitle: "Hygge Bedroom Decor — Layer Textures for the Coziest Space",
    sampleDesc: "Create a hygge-inspired bedroom retreat with layered linens, warm lighting, and natural materials.",
  },
  {
    id: "h3", category: "Home Decor", tag: "Shelf styling",
    title: "Bookshelf styling for the aesthetic home",
    src: u("1555041469-a586c61ea9bc", 520, 560), imgH: 560,
    preset: "editorial", saves: "13.4k",
    keywords: ["#shelfie", "#homedecor", "#interior"],
    sampleTitle: "Bookshelf Styling Guide — Make Every Shelf Instagram-Worthy",
    sampleDesc: "Style any bookshelf like a pro with this simple layering method using books, plants, and curated objects.",
  },
  // Jewelry
  {
    id: "j1", category: "Jewelry", tag: "Gold stack",
    title: "Everyday gold stack — gift-ready",
    src: u("1506629082955-511b1aa562c8", 520, 700), imgH: 700,
    preset: "minimal", saves: "6.7k",
    keywords: ["#goldjewelry", "#stackingrings", "#jewelrygift"],
    sampleTitle: "Everyday Gold Stack — The Perfect Gift Set",
    sampleDesc: "Build a timeless everyday stack with delicate gold pieces that layer beautifully and make a thoughtful gift.",
  },
  {
    id: "j2", category: "Jewelry", tag: "Daily look",
    title: "Minimalist jewelry — from work to weekend",
    src: u("1573408301185-9519f945b18d", 520, 780), imgH: 780,
    preset: "luxe", saves: "9.1k",
    keywords: ["#minimalistjewelry", "#jewelrystack", "#goldnecklace"],
    sampleTitle: "Minimalist Jewelry for Every Day — Work to Weekend",
    sampleDesc: "A curated selection of delicate, versatile pieces that transition effortlessly from desk to dinner.",
  },
  // Gifts
  {
    id: "g1", category: "Gifts", tag: "Gift roundup",
    title: "Top gifts under $50 — she'll actually love them",
    src: u("1607344645866-009c320b63e0", 520, 780), imgH: 780,
    preset: "boho", saves: "14.3k",
    keywords: ["#giftideas", "#giftsforher", "#holidaygifts"],
    sampleTitle: "Best Gifts Under $50 — Thoughtful Picks She'll Love",
    sampleDesc: "Skip the guesswork with this curated gift guide featuring unique, affordable finds she'll actually use and love.",
  },
  {
    id: "g2", category: "Gifts", tag: "Gift set",
    title: "Cozy gift set — perfect for gifting season",
    src: u("1549465220-1a8b9238cd48", 520, 620), imgH: 620,
    preset: "cozy", saves: "11.8k",
    keywords: ["#giftguide", "#cozyvibes", "#giftbasket"],
    sampleTitle: "The Coziest Gift Set for the Season",
    sampleDesc: "A beautifully curated collection of cozy essentials — the perfect gift for anyone who loves to nest and unwind.",
  },
  // Digital
  {
    id: "d1", category: "Digital", tag: "Notion template",
    title: "Notion planner pack · start today",
    src: u("1547082899-e8c0dfafc7e4", 520, 660), imgH: 660,
    preset: "editorial", saves: "5.9k",
    keywords: ["#notiontemplate", "#digitalplanner", "#productivitytools"],
    sampleTitle: "Notion Planner Pack — Your Complete Productivity System",
    sampleDesc: "Get organised instantly with this done-for-you Notion system covering goals, habits, projects, and weekly reviews.",
  },
  {
    id: "d2", category: "Digital", tag: "Workspace",
    title: "Minimal desk setup — work from anywhere",
    src: u("1611532736597-de2d4265fba3", 520, 540), imgH: 540,
    preset: "minimal", saves: "8.4k",
    keywords: ["#desksetup", "#workfromhome", "#minimalworkspace"],
    sampleTitle: "The Minimal Desk Setup That Works Anywhere",
    sampleDesc: "A clean, functional workspace doesn't need much — just the right essentials. Here's our minimalist desk must-haves.",
  },
  // Food
  {
    id: "fo1", category: "Food", tag: "Recipe card",
    title: "10-min weeknight dinner — ingredients you have",
    src: u("1490645935967-10de6ba17061", 520, 720), imgH: 720,
    preset: "boho", saves: "22.1k",
    keywords: ["#easyrecipes", "#weeknightdinner", "#foodphotography"],
    sampleTitle: "10-Minute Weeknight Dinner With Pantry Staples",
    sampleDesc: "No grocery run needed. This quick, flavourful dinner uses ingredients you already have and is ready in ten minutes.",
  },
  {
    id: "fo2", category: "Food", tag: "Morning ritual",
    title: "Morning matcha ritual — step by step",
    src: u("1504674900247-0877df9cc836", 520, 640), imgH: 640,
    preset: "minimal", saves: "17.5k",
    keywords: ["#matcharecipe", "#healthyliving", "#morningroutine"],
    sampleTitle: "Morning Matcha Ritual — A Slow Start to a Focused Day",
    sampleDesc: "Swap your coffee for a mindful matcha ritual. Ceremonial-grade, whisked perfectly — here's the step-by-step method.",
  },
  // Wellness
  {
    id: "w1", category: "Wellness", tag: "Yoga flow",
    title: "Morning yoga flow — 20 min energising sequence",
    src: u("1545205597-3d9d02c29597", 520, 800), imgH: 800,
    preset: "minimal", saves: "13.2k",
    keywords: ["#morningyoga", "#yogaroutine", "#wellness"],
    sampleTitle: "20-Min Morning Yoga Flow — Energise Without the Rush",
    sampleDesc: "Start your day with intention. This flowing sequence wakes up the body gently and leaves you focused for hours.",
  },
  {
    id: "w2", category: "Wellness", tag: "Sunday reset",
    title: "Sunday reset routine — recharge for the week",
    src: u("1540555700478-4be290a2d0d4", 520, 680), imgH: 680,
    preset: "cozy", saves: "18.9k",
    keywords: ["#selfcare", "#sundayreset", "#wellbeing"],
    sampleTitle: "Sunday Reset Routine — How to Recharge for the Week Ahead",
    sampleDesc: "A nourishing Sunday ritual that helps you close the week mindfully and open the next one with clarity and calm.",
  },
  // Art
  {
    id: "a1", category: "Art", tag: "Gallery wall",
    title: "Gallery wall inspo — minimalist print collection",
    src: u("1501366062246-723b4d3e4f97", 520, 840), imgH: 840,
    preset: "editorial", saves: "10.4k",
    keywords: ["#wallart", "#gallerywall", "#artprint"],
    sampleTitle: "Gallery Wall Ideas — Minimalist Art Print Curation",
    sampleDesc: "Build a cohesive gallery wall with curated art prints. A step-by-step guide to layout, spacing, and framing.",
  },
  // Lifestyle
  {
    id: "l1", category: "Lifestyle", tag: "Morning routine",
    title: "Aesthetic morning routine — slow living edition",
    src: u("1504257432389-52343af06ae3", 520, 760), imgH: 760,
    preset: "boho", saves: "20.3k",
    keywords: ["#slowliving", "#morningroutine", "#lifestyleinspo"],
    sampleTitle: "Aesthetic Morning Routine — Slow Living Edition",
    sampleDesc: "Reclaim your mornings with a slower, more intentional routine that sets a peaceful tone for the entire day.",
  },
];

export const CATEGORIES: Category[] = [
  "All", "Fashion", "Beauty", "Home Decor", "Jewelry",
  "Gifts", "Digital", "Food", "Wellness", "Art", "Lifestyle",
];
