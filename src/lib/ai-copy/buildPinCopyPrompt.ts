import type { BoardContext, CopyContextBundle, CopyStrategy, ImageContext, PageContext, ProductContext } from "./types";

function sentence(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(", ");
}

export function summarizeContext(input: {
  image?: ImageContext;
  product?: ProductContext;
  page?: PageContext;
  board?: BoardContext;
  keywordTerms: string[];
  seasonalSignal?: string;
}): Pick<CopyContextBundle, "contextSourcesUsed" | "contextSummary" | "contextDetails"> {
  const sources: string[] = [];
  const details: string[] = [];
  if (input.image && input.image.source !== "unavailable") {
    sources.push("image");
    details.push(`Image: ${sentence([input.image.primarySubject, input.image.scene, ...input.image.attributes, ...input.image.style])}`);
  }
  if (input.board?.boardName) {
    sources.push("board");
    details.push(`Board: ${input.board.boardName}`);
  }
  if (input.product?.title || input.product?.category) {
    sources.push("product");
    details.push(`Product: ${sentence([input.product.title, input.product.category])}`);
  }
  if (input.page?.pageTitle || input.page?.domain) {
    sources.push("page");
    details.push(`Page: ${sentence([input.page.pageTitle, input.page.domain])}`);
  }
  if (input.keywordTerms.length) {
    sources.push("keywords");
    details.push(`Keywords: ${input.keywordTerms.slice(0, 5).join(", ")}`);
  }
  details.push(`Seasonal signal: ${input.seasonalSignal || "none used"}`);

  const labels = sources.map(s => s === "image" ? "image" : s === "board" ? "Board" : s === "product" ? "product" : s === "page" ? "page" : "keywords");
  return {
    contextSourcesUsed: sources,
    contextSummary: labels.length ? `Based on ${labels.join(", ")} context` : "Based on available Pin context",
    contextDetails: details,
  };
}

export function buildPinCopyPrompt(input: {
  titleBase: string;
  image?: ImageContext;
  product?: ProductContext;
  page?: PageContext;
  board?: BoardContext;
  keywords: string[];
  strategy: CopyStrategy;
}): string {
  const context = {
    imageContext: input.image ? {
      primarySubject: input.image.primarySubject,
      scene: input.image.scene,
      attributes: input.image.attributes,
      style: input.image.style,
      detectedText: input.image.detectedText,
    } : null,
    productContext: input.product ?? null,
    pageContext: input.page ? {
      title: input.page.pageTitle,
      description: input.page.pageDescription,
      domain: input.page.domain,
    } : null,
    boardContext: input.board?.boardName ? {
      name: input.board.boardName,
      description: input.board.boardDescription,
    } : null,
    keywordContext: input.keywords,
  };

  return [
    "Generate one strong Pinterest Pin copy set as strict JSON.",
    "Use specific visible image details first. Stay consistent with product/page/board context.",
    "Avoid generic filler such as \"Pinterest-ready idea\", \"Relevant ideas\", \"Discover beautiful ideas\", and unsupported claims.",
    "Return JSON only: {\"title\":\"...\",\"description\":\"...\",\"tags\":[\"...\"],\"altText\":\"...\"}.",
    `Regeneration mode: ${input.strategy === "regenerate" ? "produce a materially different wording while preserving the same context" : "first result"}.`,
    `Structured context:\n${JSON.stringify(context, null, 2)}`,
  ].join("\n");
}
