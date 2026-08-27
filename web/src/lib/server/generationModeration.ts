/** Pure request-shape and moderation-check helpers for the generation route. */
export type ModeratedFields = {
  keyword: string;
  prompt: string;
  directionBrief: string;
  category: string;
  selectedTags: Array<{ label?: string }>;
  productMetadata?: Array<{ title?: string }> | null;
};

export const INPUT_LIMITS = {
  KEYWORD: 200,
  PROMPT: 4000,
  CATEGORY: 64,
  DIRECTION_BRIEF: 1200,
  TAG_LABEL: 64,
  TAG_ID: 128,
  TAG_GROUP: 64,
  TAGS: 24,
  PRODUCT_TITLE: 300,
  PRODUCT_URL: 2048,
  PRODUCTS: 24,
} as const;

export const MAX_MODERATION_CHECKS = 56;

export type InputValidation =
  | {
      ok: true;
      selectedTags: Array<{ id: string; label: string; group: string }>;
      productMetadata: Array<{ title?: string; productUrl?: string }> | null;
    }
  | { ok: false; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateGenerationInput(raw: {
  keyword: string;
  prompt: string;
  directionBrief: string;
  category: string;
  selectedTags: unknown;
  productMetadata: unknown;
}): InputValidation {
  const tooLong = (name: string, value: string, max: number) =>
    value.length > max ? `${name} exceeds the maximum length of ${max} characters` : null;
  const scalarError =
    tooLong("keyword", raw.keyword, INPUT_LIMITS.KEYWORD) ??
    tooLong("prompt", raw.prompt, INPUT_LIMITS.PROMPT) ??
    tooLong("directionBrief", raw.directionBrief, INPUT_LIMITS.DIRECTION_BRIEF) ??
    tooLong("category", raw.category, INPUT_LIMITS.CATEGORY);
  if (scalarError) return { ok: false, detail: scalarError };

  let selectedTags: Array<{ id: string; label: string; group: string }> = [];
  if (raw.selectedTags !== undefined && raw.selectedTags !== null) {
    if (!Array.isArray(raw.selectedTags)) {
      return { ok: false, detail: "selectedTags must be an array" };
    }
    if (raw.selectedTags.length > INPUT_LIMITS.TAGS) {
      return { ok: false, detail: `selectedTags exceeds the maximum of ${INPUT_LIMITS.TAGS} tags` };
    }
    const validated: Array<{ id: string; label: string; group: string }> = [];
    for (let i = 0; i < raw.selectedTags.length; i += 1) {
      const entry = raw.selectedTags[i] as unknown;
      if (!isPlainObject(entry)) {
        return { ok: false, detail: `selectedTags[${i}] must be an object` };
      }
      const { id, label, group } = entry;
      if (id !== undefined && typeof id !== "string") {
        return { ok: false, detail: `selectedTags[${i}].id must be a string` };
      }
      if (label !== undefined && typeof label !== "string") {
        return { ok: false, detail: `selectedTags[${i}].label must be a string` };
      }
      if (group !== undefined && typeof group !== "string") {
        return { ok: false, detail: `selectedTags[${i}].group must be a string` };
      }
      const idValue = (id as string | undefined) ?? "";
      const labelValue = (label as string | undefined) ?? "";
      const groupValue = (group as string | undefined) ?? "";
      if (idValue.length > INPUT_LIMITS.TAG_ID) {
        return { ok: false, detail: `selectedTags[${i}].id exceeds the maximum length of ${INPUT_LIMITS.TAG_ID} characters` };
      }
      if (labelValue.length > INPUT_LIMITS.TAG_LABEL) {
        return { ok: false, detail: `selectedTags[${i}].label exceeds the maximum length of ${INPUT_LIMITS.TAG_LABEL} characters` };
      }
      if (groupValue.length > INPUT_LIMITS.TAG_GROUP) {
        return { ok: false, detail: `selectedTags[${i}].group exceeds the maximum length of ${INPUT_LIMITS.TAG_GROUP} characters` };
      }
      validated.push({ id: idValue, label: labelValue, group: groupValue });
    }
    selectedTags = validated;
  }

  let productMetadata: Array<{ title?: string; productUrl?: string }> | null = null;
  if (Array.isArray(raw.productMetadata)) {
    if (raw.productMetadata.length > INPUT_LIMITS.PRODUCTS) {
      return { ok: false, detail: `product_metadata exceeds the maximum of ${INPUT_LIMITS.PRODUCTS} products` };
    }
    const validated: Array<{ title?: string; productUrl?: string }> = [];
    for (let i = 0; i < raw.productMetadata.length; i += 1) {
      const entry = raw.productMetadata[i] as unknown;
      if (!isPlainObject(entry)) {
        return { ok: false, detail: `product_metadata[${i}] must be an object` };
      }
      const { title, productUrl } = entry;
      if (title !== undefined && typeof title !== "string") {
        return { ok: false, detail: `product_metadata[${i}].title must be a string` };
      }
      if (productUrl !== undefined && typeof productUrl !== "string") {
        return { ok: false, detail: `product_metadata[${i}].productUrl must be a string` };
      }
      if (typeof title === "string" && title.length > INPUT_LIMITS.PRODUCT_TITLE) {
        return { ok: false, detail: `product_metadata[${i}].title exceeds the maximum length of ${INPUT_LIMITS.PRODUCT_TITLE} characters` };
      }
      if (typeof productUrl === "string" && productUrl.length > INPUT_LIMITS.PRODUCT_URL) {
        return { ok: false, detail: `product_metadata[${i}].productUrl exceeds the maximum length of ${INPUT_LIMITS.PRODUCT_URL} characters` };
      }
      validated.push({
        ...(title !== undefined ? { title: title as string } : {}),
        ...(productUrl !== undefined ? { productUrl: productUrl as string } : {}),
      });
    }
    productMetadata = validated;
  }

  return { ok: true, selectedTags, productMetadata };
}

export function buildModeratedText(fields: ModeratedFields): string {
  return [
    fields.keyword,
    fields.prompt,
    fields.directionBrief,
    fields.category,
    ...fields.selectedTags.map(tag => tag?.label ?? ""),
    ...(fields.productMetadata ?? []).map(product => product?.title ?? ""),
  ].filter(Boolean).join("\n");
}

export function buildModerationChecks(
  fields: ModeratedFields,
): Array<{ suffix: string; text: string }> {
  const checks: Array<{ suffix: string; text: string }> = [];
  const push = (suffix: string, raw: string) => {
    if (raw.trim()) checks.push({ suffix, text: raw });
  };
  push("keyword", fields.keyword);
  push("prompt", fields.prompt);
  push("direction", fields.directionBrief);
  push("category", fields.category);
  fields.selectedTags.forEach((tag, index) => push(`tag${index + 1}`, tag?.label ?? ""));
  (fields.productMetadata ?? []).forEach((product, index) =>
    push(`product${index + 1}`, product?.title ?? ""));
  push("composite", buildModeratedText(fields));
  return checks;
}
