import type { AICopyV2Evidence, CachedImageAnalysis, PinCopyLength, ProductContext } from "./types";
import type {
  CopyResultV2,
  FactCardV1,
  KeywordEvidence,
  KeywordProvenance,
} from "./v2/types";

export type AICopyV2AnalyzePayload = {
  draftId: string;
  idempotencyKey: string;
  locale: string;
  country: string;
  productContext?: Record<string, unknown>;
  imageObserved?: Record<string, unknown>;
  boardContext?: Record<string, unknown>;
  userKeywords?: string[];
};

export type BuildAnalyzePayloadInput = {
  draftId: string;
  locale: string;
  country?: string;
  idempotencyKey: string;
  product?: ProductContext;
  image?: CachedImageAnalysis | null;
  board?: { name?: string; description?: string };
  userKeywords?: string[];
};

export function isAICopyV2ClientEnabled(value = process.env.NEXT_PUBLIC_AI_COPY_V2): boolean {
  return value === "true";
}

export function shouldConfirmAICopyV2Overwrite(values: Array<string | null | undefined>, enabled = isAICopyV2ClientEnabled()): boolean {
  return enabled && values.some(value => Boolean(value?.trim()));
}

export function keywordProvenanceLabel(provenance: KeywordProvenance): string {
  if (provenance === "official") return "Official";
  if (provenance === "estimated") return "Estimated";
  return "Data unknown";
}

const compactStrings = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value))));

export function buildAICopyV2AnalyzePayload(input: BuildAnalyzePayloadInput): AICopyV2AnalyzePayload {
  const product = input.product;
  const image = input.image;
  const board = input.board;
  const userKeywords = compactStrings(input.userKeywords ?? []);
  return {
    draftId: input.draftId,
    idempotencyKey: input.idempotencyKey,
    locale: input.locale,
    country: (input.country || "US").toUpperCase(),
    ...(product ? { productContext: {
      title: product.title,
      productType: product.category,
      vendor: product.vendor,
      price: product.price,
      availability: product.availability,
      tags: product.tags,
      attributes: product.attributes,
    } } : {}),
    ...(image ? { imageObserved: {
      summary: image.imageSummary,
      objects: image.visibleObjects,
      colors: image.colors,
      style: image.style,
      ocrText: image.ocrText ? [image.ocrText] : [],
      category: image.category,
    } } : {}),
    ...(board?.name || board?.description ? { boardContext: board } : {}),
    ...(userKeywords.length ? { userKeywords } : {}),
  };
}

type AnalyzeResponse = {
  ok?: boolean;
  sessionId?: string;
  factCard?: FactCardV1;
  keywordEvidence?: KeywordEvidence;
  degradedMode?: AICopyV2Evidence["degradedMode"];
  message?: string;
};

type GenerateResponse = { ok?: boolean; result?: CopyResultV2; message?: string };

export type GeneratePinterestPinCopyV2Input = Omit<BuildAnalyzePayloadInput, "idempotencyKey"> & {
  imageUrl?: string;
  length?: PinCopyLength;
  angleId?: string;
  angleRequest?: string;
  fetcher?: typeof fetch;
  createId?: () => string;
  onStage?: (stage: "analyzing" | "generating" | "checking") => void;
};

export type GeneratePinterestPinCopyV2Result = {
  fields: { title: string; description: string; altText: string };
  evidence: AICopyV2Evidence;
  factCard: FactCardV1;
  keywordEvidence: KeywordEvidence;
  result: CopyResultV2;
};

async function readJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch { return {} as T; }
}

const SAFE_ERROR = "We couldn't generate grounded copy right now. Please try again.";

export async function generatePinterestPinCopyV2(input: GeneratePinterestPinCopyV2Input): Promise<GeneratePinterestPinCopyV2Result> {
  const fetcher = input.fetcher ?? fetch;
  const createId = input.createId ?? (() => globalThis.crypto.randomUUID());
  input.onStage?.("analyzing");
  let image = input.image;
  if (!image && input.imageUrl) {
    const visionResponse = await fetcher("/api/ai-copy/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        draftId: input.draftId,
        imageUrl: input.imageUrl,
        category: input.product?.category,
        boardName: input.board?.name,
        language: input.locale,
        country: input.country,
        productTitle: input.product?.title,
        productType: input.product?.category,
        productTags: input.product?.tags,
      }),
    });
    const vision = await readJson<{ ok?: boolean; message?: string; userMessage?: string; analysis?: CachedImageAnalysis }>(visionResponse);
    if (!visionResponse.ok || !vision.ok || !vision.analysis?.imageSummary) throw new Error(vision.userMessage || vision.message || SAFE_ERROR);
    image = vision.analysis;
  }
  const analyzeResponse = await fetcher("/api/ai-copy/v2/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(buildAICopyV2AnalyzePayload({ ...input, image, idempotencyKey: createId() })),
  });
  const analyzed = await readJson<AnalyzeResponse>(analyzeResponse);
  if (!analyzeResponse.ok || !analyzed.ok || !analyzed.sessionId || !analyzed.factCard || !analyzed.keywordEvidence) {
    throw new Error(analyzed.message || SAFE_ERROR);
  }

  input.onStage?.("generating");
  const generateResponse = await fetcher("/api/ai-copy/v2/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      sessionId: analyzed.sessionId,
      idempotencyKey: createId(),
      lengthPreference: input.length ?? "standard",
      angleId: input.angleId,
      angleRequest: input.angleRequest,
    }),
  });
  input.onStage?.("checking");
  const generated = await readJson<GenerateResponse>(generateResponse);
  const result = generated.result;
  if (!generateResponse.ok || !generated.ok || !result || !result.title || !result.description || !result.altText || !result.validationReport?.valid) {
    throw new Error(generated.message || SAFE_ERROR);
  }

  const byId = new Map(analyzed.keywordEvidence.candidates.map(candidate => [candidate.id, candidate]));
  // The server's usedKeywordIds are computed from the final validated copy. Do not
  // present every candidate passed to the model as though it was actually used.
  const selectedKeywords = result.usedKeywordIds.map(id => byId.get(id)).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)).map(candidate => ({
    id: candidate.id,
    phrase: candidate.phrase,
    provenance: candidate.provenance,
    label: keywordProvenanceLabel(candidate.provenance),
  }));
  return {
    fields: { title: result.title, description: result.description, altText: result.altText },
    factCard: analyzed.factCard,
    keywordEvidence: analyzed.keywordEvidence,
    result,
    evidence: {
      facts: result.factSummary,
      primaryKeyword: selectedKeywords[0],
      selectedKeywords,
      degradedMode: result.degradedMode,
      validationReport: result.validationReport,
    },
  };
}
