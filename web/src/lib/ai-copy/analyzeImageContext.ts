import type { PinDraft } from "@/lib/pinDraftStore";
import type { ImageContext } from "./types";
import { readCached, writeCached } from "./cache";

const COLOR_WORDS = ["pink", "green", "blue", "red", "white", "black", "cream", "neutral", "brown", "gold", "silver", "beige", "striped", "paisley", "lemon", "ceramic"];
const STYLE_WORDS = ["cozy", "modern", "boho", "minimal", "vintage", "street", "editorial", "casual", "warm", "aesthetic"];

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function inferScene(text: string, category: string): string | undefined {
  const t = text.toLowerCase();
  if (/bed|bedding|bedroom/.test(t)) return "bedroom scene";
  if (/kitchen|shelf|counter|ceramic/.test(t)) return "kitchen styling scene";
  if (/living|sofa|couch/.test(t)) return "living room scene";
  if (/outfit|fashion|street|jeans|bag|dress|camisole/.test(`${t} ${category}`)) return "fashion product or outfit";
  if (/food|recipe|drink|cake|coffee/.test(`${t} ${category}`)) return "food or drink scene";
  if (/travel|mountain|trail|outdoor|overlook|golden hour/.test(`${t} ${category}`)) return "outdoor travel scene";
  if (/beauty|makeup|skin|hair/.test(`${t} ${category}`)) return "beauty product scene";
  return undefined;
}

function inferSubject(text: string, category: string): string {
  const t = text.toLowerCase();
  if (/bedding|blanket|duvet|pillow/.test(t)) return "bedding set";
  if (/jeans|bag|dress|camisole|outfit/.test(t)) return "fashion outfit";
  if (/candle|vase|chair|decor/.test(t)) return "home decor product";
  if (/kitchen|shelf|ceramic/.test(t)) return "kitchen decor";
  if (/makeup|serum|cream|beauty/.test(t)) return "beauty product";
  if (/coffee|cake|recipe|food|pasta|lemon/.test(t)) return "recipe dish";
  if (/travel|mountain|trail|outdoor|overlook/.test(`${t} ${category}`)) return "outdoor travel view";
  return category ? `${category.replace(/[-_]/g, " ")} image` : "Pin image";
}

export async function analyzeImageContext(draft: PinDraft): Promise<ImageContext> {
  const identity = draft.imageUrl || draft.id;
  const cached = readCached<ImageContext>("image", identity, 7 * 24 * 60 * 60 * 1000);
  if (cached) return { ...cached, source: "cached" };

  const text = [draft.title, draft.keyword, draft.category, draft.altText].filter(Boolean).join(" ");
  const tokenSet = new Set(words(text));
  const attributes = COLOR_WORDS.filter(w => tokenSet.has(w));
  const style = STYLE_WORDS.filter(w => tokenSet.has(w));
  const result: ImageContext = {
    primarySubject: inferSubject(text, draft.category),
    scene: inferScene(text, draft.category),
    attributes,
    style,
    detectedText: [],
    source: "heuristic",
  };
  writeCached("image", identity, result);
  return result;
}
