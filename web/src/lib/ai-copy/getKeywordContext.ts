import type { ImageContext, KeywordContext, PageContext, BoardContext, ProductContext } from "./types";
import { readCached, writeCached } from "./cache";

function clean(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9\s-]+/g, "").replace(/\s+/g, " ").trim();
}

export async function getKeywordContext(input: {
  image?: ImageContext;
  product?: ProductContext;
  page?: PageContext;
  board?: BoardContext;
  category?: string;
  locale: string;
}): Promise<KeywordContext> {
  const topic = clean([
    input.image?.primarySubject,
    input.image?.scene,
    input.product?.title,
    input.product?.category,
    input.page?.pageTitle,
    input.board?.boardName,
    input.category,
  ].filter(Boolean).join(" "));
  if (!topic) return { terms: [], source: "none" };

  const cacheId = `${input.locale}:${topic}`;
  const cached = readCached<KeywordContext>("keywords", cacheId, 24 * 60 * 60 * 1000);
  if (cached) return { ...cached, source: "cached" };

  const raw = [
    input.image?.primarySubject,
    input.image?.scene,
    input.product?.title,
    input.product?.category,
    input.board?.boardName,
    input.page?.pageTitle,
    input.category,
  ].filter(Boolean).map(v => clean(String(v))).filter(Boolean);
  const terms = Array.from(new Set(raw)).slice(0, 5);
  const result: KeywordContext = { terms, source: terms.length ? "heuristic" : "none" };
  writeCached("keywords", cacheId, result);
  return result;
}
