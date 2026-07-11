// Rule-based product intent extractor.
// Parses product names to extract semantic attributes used for opportunity matching.

export type ProductIntent = {
  productTypes: string[];
  colors:       string[];
  styles:       string[];
  audiences:    string[];
  useCases:     string[];
  category:     string | null;
  rawTokens:    string[];
};

export type ProductSignalInput = {
  product_name: string;
  domain?:      string | null;
};

// ── Keyword banks ──────────────────────────────────────────────────────────────

const FASHION_TYPES = [
  "jacket","coat","pants","jeans","dress","shirt","blouse","skirt","shorts",
  "legging","leggings","cardigan","hoodie","blazer","trench","cargo","crop","top",
  "tee","sweater","sweatshirt","vest","suit","overall","jumpsuit","romper",
  "bodysuit","kimono","kaftan","tunic","parka","windbreaker","denim",
];
const HOME_TYPES = [
  "sofa","couch","chair","table","desk","shelf","bookshelf","lamp","rug","curtain",
  "cushion","pillow","blanket","throw","candle","vase","frame","mirror","clock",
  "basket","storage","ottoman","bench","stool","cabinet","dresser","nightstand",
  "bed","duvet","comforter","bedding","towel","planter","artwork","print",
];
const BEAUTY_TYPES = [
  "lipstick","mascara","foundation","blush","bronzer","highlighter","eyeshadow",
  "eyeliner","serum","moisturizer","cleanser","toner","sunscreen","spf","primer",
  "concealer","powder","palette","brush","skincare","makeup","perfume","fragrance",
  "lotion","cream","exfoliant","retinol","vitamin","gua sha","roller",
];
const DIGITAL_TYPES = [
  "planner","template","worksheet","tracker","printable","guide","ebook","course",
  "preset","font","pattern","clipart","sticker","journal","calendar","spreadsheet",
  "notion","canva","svg","cricut","digital download",
];
const CRAFT_TYPES = [
  "yarn","fabric","bead","beads","crochet","knit","knitting","embroidery","clay",
  "macrame","scrapbook","sticker sheet","washi","ribbon","felt","stencil","craft kit",
  "diy kit","sewing","quilt","resin","candle making","soap making","paint set",
];
const TRAVEL_TYPES = [
  "luggage","suitcase","backpack","carry on","carry-on","duffel","packing cube",
  "passport","travel pillow","toiletry bag","travel kit","map","guidebook","itinerary",
];

const ALL_PRODUCT_TYPES = [...FASHION_TYPES, ...HOME_TYPES, ...BEAUTY_TYPES, ...DIGITAL_TYPES, ...CRAFT_TYPES, ...TRAVEL_TYPES];

const COLOR_WORDS = [
  "white","black","grey","gray","beige","cream","nude","tan","brown","navy","blue",
  "red","pink","green","olive","sage","camel","khaki","burgundy","rust","coral",
  "yellow","orange","purple","lavender","mint","teal","charcoal","ivory","ecru",
  "neutral","monochrome","colorblock",
];

const STYLE_WORDS_FASHION = [
  "clean girl","minimalist","streetwear","casual","elegant","chic","aesthetic",
  "y2k","cottagecore","dark academia","preppy","boho","bohemian","vintage","retro",
  "athleisure","sporty","business casual","capsule wardrobe","monochrome",
  "editorial","luxe","quiet luxury","coastal","mob wife","coquette",
];

const STYLE_WORDS_HOME = [
  "minimalist","japandi","scandinavian","bohemian","boho","industrial","farmhouse",
  "coastal","tropical","maximalist","art deco","mid century","rustic","modern",
  "contemporary","eclectic","traditional","french country","hamptons","earthy","moody",
];

const FASHION_USE_CASES = [
  "outfit","flat lay","mirror outfit","ootd","lookbook","capsule wardrobe",
  "styling","style inspo","fashion inspo","wardrobe","closet","fit check",
  "editorial","summer outfit","winter outfit","fall outfit","spring outfit",
  "everyday look","date night","work outfit","vacation outfit",
];

const HOME_USE_CASES = [
  "room decor","home decor","interior design","room setup","bedroom ideas",
  "living room","shelf styling","decor inspo","moodboard","home inspo",
  "styling","cozy home","aesthetic room","apartment decor","kitchen decor",
];

const DIGITAL_USE_CASES = [
  "free printable","editable template","digital planner","notion template",
  "instagram template","canva template","budget tracker","meal planner",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function detectCategory(allText: string, tokens: string[]): string | null {
  let fashionScore = 0, homeScore = 0, beautyScore = 0, digitalScore = 0, craftScore = 0, travelScore = 0;

  for (const t of tokens) {
    if (FASHION_TYPES.some(f => t === f || t.includes(f) || f.includes(t))) fashionScore += 2;
    if (HOME_TYPES.some(f => t === f || t.includes(f) || f.includes(t))) homeScore += 2;
    if (BEAUTY_TYPES.some(f => t === f || t.includes(f) || f.includes(t))) beautyScore += 2;
    if (DIGITAL_TYPES.some(f => t === f || t.includes(f) || f.includes(t))) digitalScore += 2;
    if (CRAFT_TYPES.some(f => t === f || t.includes(f) || f.includes(t))) craftScore += 2;
    if (TRAVEL_TYPES.some(f => t === f || t.includes(f) || f.includes(t))) travelScore += 2;
  }

  // Multi-word digital signals
  if (/digital|printable|template|planner|worksheet/i.test(allText)) digitalScore += 5;
  if (/\b(diy|handmade|craft|crochet|knitting|how to make)\b/i.test(allText)) craftScore += 5;
  if (/\b(travel|destination|wanderlust|itinerary|vacation|packing)\b/i.test(allText)) travelScore += 5;

  const max = Math.max(fashionScore, homeScore, beautyScore, digitalScore, craftScore, travelScore);
  if (max === 0) return null;
  if (max === craftScore  && craftScore  > 0) return "diy-crafts";
  if (max === travelScore && travelScore > 0) return "travel";
  if (max === fashionScore  && fashionScore  > homeScore + beautyScore) return "fashion";
  if (max === homeScore     && homeScore     > fashionScore)            return "home-decor";
  if (max === beautyScore   && beautyScore   > fashionScore)            return "beauty";
  if (max === digitalScore)                                             return "digital-products";
  if (fashionScore >= homeScore) return "fashion";
  return "home-decor";
}

// ── Main export ───────────────────────────────────────────────────────────────

export function extractProductIntent(products: ProductSignalInput[]): ProductIntent {
  const allText = products.map(p => p.product_name).join(" ");
  const tokens  = tokenize(allText);
  const cat     = detectCategory(allText, tokens);

  // Product types — match against combined bank
  const productTypes = ALL_PRODUCT_TYPES.filter(t =>
    tokens.some(tok => tok === t || tok.includes(t) || t.includes(tok))
  );

  // Colors
  const colors = COLOR_WORDS.filter(c => {
    const re = new RegExp(`\\b${c}\\b`, "i");
    return re.test(allText);
  });

  // Styles — pick bank by detected category
  const styleBank = cat === "home-decor" ? STYLE_WORDS_HOME : STYLE_WORDS_FASHION;
  const styles    = styleBank.filter(s => allText.toLowerCase().includes(s));

  // Audiences
  const audiences: string[] = [];
  if (/\b(women|woman|ladies|female|girl|girls)\b/i.test(allText)) audiences.push("women");
  if (/\b(men|man|male|boys|guy)\b/i.test(allText))                audiences.push("men");
  if (/\b(kids|kid|child|children|toddler|baby)\b/i.test(allText)) audiences.push("kids");
  if (/\bplus.?size\b|\bcurv/i.test(allText))                      audiences.push("plus-size");

  // Use cases
  const useCaseBank =
    cat === "home-decor"        ? HOME_USE_CASES    :
    cat === "digital-products"  ? DIGITAL_USE_CASES :
    FASHION_USE_CASES;

  const useCases = useCaseBank.filter(u => allText.toLowerCase().includes(u));

  // Always include default use cases for the detected category
  if (cat === "fashion" && !useCases.includes("outfit")) useCases.push("outfit");
  if (cat === "home-decor" && !useCases.includes("home decor")) useCases.push("home decor");

  return {
    productTypes: [...new Set(productTypes)],
    colors:       [...new Set(colors)],
    styles:       [...new Set(styles)],
    audiences:    [...new Set(audiences)],
    useCases:     [...new Set(useCases)],
    category:     cat,
    rawTokens:    tokens,
  };
}
