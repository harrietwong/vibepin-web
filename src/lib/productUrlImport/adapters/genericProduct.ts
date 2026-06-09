import { extractCandidatesFromHtml } from "../extractFromHtml";
import type { AdapterResult } from "../types";

/** Generic HTML parser: JSON-LD → og:image → twitter:image → large img tags. */
export function genericProductAdapter(html: string, pageUrl: string): AdapterResult {
  const { title, description, candidates } = extractCandidatesFromHtml(html, pageUrl);
  return {
    status: candidates.length ? "success" : "failed",
    title,
    description,
    candidates,
  };
}
