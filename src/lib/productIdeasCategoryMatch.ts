const CAT_KEYS: Record<string, string[]> = {
  "Home Decor":       ["home", "decor", "interior", "living", "bedroom", "lamp", "rug", "candle", "mirror"],
  "Fashion":          ["fashion", "outfit", "apparel", "clothing", "dress", "bag", "shoe"],
  "Beauty":           ["beauty", "makeup", "skincare", "wellness", "hair", "nail"],
  "DIY & Crafts":     ["diy", "craft", "handmade", "art", "paint", "crochet"],
  "Digital Products": ["digital", "template", "printable", "planner", "notion", "canva"],
  "Food & Drink":     ["food", "drink", "recipe", "coffee", "cake", "kitchen"],
  "Wedding":          ["wedding", "bridal", "bride", "bouquet"],
  "Travel":           ["travel", "hotel", "vacation", "beach"],
};

export function matchesCategory(text: string, category: string): boolean {
  if (category === "All Products" || category === "All") return true;
  const keys = CAT_KEYS[category] ?? [];
  const haystack = text.toLowerCase();
  return keys.some(k => haystack.includes(k));
}
