// ── Generation Logs v0 data layer (READ-ONLY, internal admin) ────────────────
//
// Powers /admin/generation-logs. Helps founder/support/debug AI generation
// issues (failures, safety blocks, irrelevant outputs).
//
// SAFETY
//   * Read-only. No write actions in v0 (audit inserts happen only in the
//     prompt-reveal API route, not here).
//   * The full internal prompt template is SENSITIVE. This list layer NEVER
//     returns prompt_full / setup_snapshot.promptSnapshot / category_audit
//     .finalPrompt to the client — only a `hasFullPrompt` boolean. The actual
//     text is fetched on demand through the super-admin-gated + audited
//     /api/admin/generation-logs/[id]/prompt route.
//   * No tokens/secrets exist on pin_generations; nothing token-like is read.
//   * Degrades gracefully: missing table/column/permission → null metric +
//     warning, never a crash.
//
// pin_generations does NOT store prompt_version, latency, token counts, cost,
// copy/export/publish, user feedback, or eval score → those columns are null
// (shown as n/a in the UI). Model name IS available via setup_snapshot.model.
// There is no workspaces table → "workspace" is derived from category.

type PgError = { code?: string; message?: string } | null;

export type GenerationDisplayStatus = "success" | "failed" | "blocked" | "pending";

export type GenerationLogRow = {
  id: string;
  createdAt: string | null;
  userId: string | null;
  userEmail: string | null;
  workspace: string | null; // derived from category
  workspaceDerived: boolean;
  type: string | null; // mode / source
  displayStatus: GenerationDisplayStatus;
  rawStatus: string | null;
  sourceType: string | null; // source page
  sourceId: string | null; // session_id
  trendKeyword: string | null;
  productIdeaId: string | null;
  promptVersion: string | null; // not stored
  model: string | null;
  latencyMs: number | null; // not stored
  inputTokens: number | null; // not stored
  outputTokens: number | null; // not stored
  costEstimate: number | null; // not stored
  errorCode: string | null;
  errorMessage: string | null;
  copiedExportedPublished: string | null; // not stored
  userFeedback: string | null; // not stored
  // Drawer (non-sensitive) detail:
  requestId: string | null; // session_id — closest to a trace/request id
  promptExcerpt: string | null; // short (~120 char) preview — safe
  hasFullPrompt: boolean; // whether a full prompt exists to reveal (audited)
  inputSummary: {
    mode: string | null;
    opportunityTitle: string | null;
    keyword: string | null;
    category: string | null;
    format: string | null;
    imagesPerReference: number | null;
    userInstructions: string | null;
    productCount: number;
    referenceCount: number;
    productImages: string[];
    detectedCategory: string | null;
    outputType: string | null;
  } | null;
  outputImages: string[];
  relatedProductIds: string[];
  relatedProductNames: string[];
  internalEvalScore: number | null; // not tracked per-generation
};

export type GenerationLogsFilters = {
  emails: string[];
  workspaces: string[];
  types: string[];
  statuses: GenerationDisplayStatus[];
  promptVersions: string[]; // empty — not stored
  models: string[];
  errorCodes: string[];
};

export type GenerationLogsOverview = {
  available: boolean;
  rows: GenerationLogRow[];
  windowSaturated: boolean;
  filters: GenerationLogsFilters;
  warnings: string[];
};

// ── helpers ──────────────────────────────────────────────────────────────────

function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703" || error.code === "PGRST205" || error.code === "PGRST204") return true;
  return /(relation|column) .* does not exist|could not find the table/i.test(error.message ?? "");
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function isHttp(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

function displayStatusOf(status: string | null, errorType: string | null): GenerationDisplayStatus {
  if (errorType === "safety_blocked") return "blocked";
  if (status === "completed" || status === "partial") return "success";
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "running" || status === "pending") return "pending";
  return "pending";
}

function collectOutputImages(pinUrls: unknown, groups: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(pinUrls)) for (const u of pinUrls) if (isHttp(u)) out.push(u);
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const imgs = (g as { images?: unknown })?.images;
      if (Array.isArray(imgs)) for (const u of imgs) if (isHttp(u)) out.push(u);
    }
  }
  return Array.from(new Set(out)).slice(0, 12);
}

type Snapshot = Record<string, unknown> | null;

function sanitizedInputSummary(setup: Snapshot, categoryAudit: Snapshot): GenerationLogRow["inputSummary"] {
  if (!setup && !categoryAudit) return null;
  const s = setup ?? {};
  const ca = categoryAudit ?? {};
  const products = Array.isArray(s.selectedProducts) ? (s.selectedProducts as Array<Record<string, unknown>>) : [];
  const refs = Array.isArray(s.selectedReferences) ? (s.selectedReferences as unknown[]) : [];
  const productImages = products
    .map(p => (p as { imageUrl?: unknown }).imageUrl)
    .filter(isHttp)
    .slice(0, 6);
  return {
    mode: asString(s.mode),
    opportunityTitle: asString(s.opportunityTitle),
    keyword: asString(s.keyword),
    category: asString(s.category),
    format: asString(s.format),
    imagesPerReference: typeof s.imagesPerReference === "number" ? s.imagesPerReference : null,
    userInstructions: asString(s.userInstructions),
    productCount: products.length,
    referenceCount: refs.length,
    productImages,
    detectedCategory: asString(ca.detectedCategory) ?? asString(ca.effectiveCategory),
    outputType: asString(ca.outputType),
  };
}

// The three places a full prompt may live (all sensitive; never returned here).
function hasFullPrompt(promptFull: unknown, setup: Snapshot, categoryAudit: Snapshot): boolean {
  if (asString(promptFull)) return true;
  if (setup && asString(setup.promptSnapshot)) return true;
  if (categoryAudit && asString(categoryAudit.finalPrompt)) return true;
  return false;
}

const SCAN_LIMIT = 500;

// ── list ─────────────────────────────────────────────────────────────────────

export async function getGenerationLogs(): Promise<GenerationLogsOverview> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];

  // user_id → email (service-role required; degrade if unavailable).
  const emailById = new Map<string, string>();
  try {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error || !data) {
      warnings.push("User emails unavailable — auth.admin.listUsers failed (service-role key required).");
    } else {
      for (const u of data.users ?? []) if (u.email) emailById.set(u.id, u.email);
    }
  } catch {
    warnings.push("User emails unavailable — auth admin API threw.");
  }

  // prompt_full is selected only to compute hasFullPrompt — it is dropped
  // before building the client row and NEVER serialized to the client.
  const full = "id,created_at,user_id,keyword,category,mode,source,session_id,status,expected_total,total_pins,product_ids,product_names,prompt_excerpt,prompt_full,error_type,error_message,setup_snapshot,category_audit,pin_urls,groups_json";
  const base = "id,created_at,user_id,keyword,category,source,session_id,product_ids,product_names,prompt_excerpt,pin_urls,groups_json";

  let raw: Array<Record<string, unknown>> = [];
  let windowSaturated = false;
  const first = await db
    .from("pin_generations")
    .select(full)
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);
  if (first.error) {
    if (isMissingSchema(first.error)) {
      // Older DB: retry with the guaranteed base columns.
      const retry = await db
        .from("pin_generations")
        .select(base)
        .order("created_at", { ascending: false })
        .limit(SCAN_LIMIT);
      if (retry.error) {
        if (isMissingSchema(retry.error)) {
          warnings.push("pin_generations table not found — generation logs unavailable.");
          return { available: false, rows: [], windowSaturated: false, filters: emptyFilters(), warnings };
        }
        warnings.push(`pin_generations query failed: ${retry.error.message}`);
      }
      raw = (retry.data ?? []) as Array<Record<string, unknown>>;
    } else {
      warnings.push(`pin_generations query failed: ${first.error.message}`);
      return { available: false, rows: [], windowSaturated: false, filters: emptyFilters(), warnings };
    }
  } else {
    raw = (first.data ?? []) as Array<Record<string, unknown>>;
  }
  windowSaturated = raw.length >= SCAN_LIMIT;

  const rows: GenerationLogRow[] = raw.map(r => {
    const setup = (r.setup_snapshot ?? null) as Snapshot;
    const categoryAudit = (r.category_audit ?? null) as Snapshot;
    const status = asString(r.status);
    const errorType = asString(r.error_type);
    const productIds = Array.isArray(r.product_ids) ? (r.product_ids as unknown[]).map(String) : [];
    const productNames = Array.isArray(r.product_names) ? (r.product_names as unknown[]).map(String) : [];
    const userId = asString(r.user_id);
    return {
      id: String(r.id),
      createdAt: asString(r.created_at),
      userId,
      userEmail: userId ? emailById.get(userId) ?? null : null,
      workspace: asString(r.category),
      workspaceDerived: true,
      type: asString(r.mode) ?? asString(r.source),
      displayStatus: displayStatusOf(status, errorType),
      rawStatus: status,
      sourceType: asString(r.source),
      sourceId: asString(r.session_id),
      trendKeyword: asString(r.keyword),
      productIdeaId: productIds[0] ?? null,
      promptVersion: null,
      model: setup ? asString(setup.model) ?? asString(setup.modelKey) : null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      costEstimate: null,
      errorCode: errorType,
      errorMessage: asString(r.error_message),
      copiedExportedPublished: null,
      userFeedback: null,
      requestId: asString(r.session_id),
      promptExcerpt: asString(r.prompt_excerpt),
      hasFullPrompt: hasFullPrompt(r.prompt_full, setup, categoryAudit),
      inputSummary: sanitizedInputSummary(setup, categoryAudit),
      outputImages: collectOutputImages(r.pin_urls, r.groups_json),
      relatedProductIds: productIds,
      relatedProductNames: productNames,
      internalEvalScore: null,
    };
  });

  return {
    available: true,
    rows,
    windowSaturated,
    filters: buildFilters(rows),
    warnings,
  };
}

function emptyFilters(): GenerationLogsFilters {
  return { emails: [], workspaces: [], types: [], statuses: ["success", "failed", "blocked", "pending"], promptVersions: [], models: [], errorCodes: [] };
}

function buildFilters(rows: GenerationLogRow[]): GenerationLogsFilters {
  const uniq = (vals: Array<string | null>) => Array.from(new Set(vals.filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b));
  return {
    emails: uniq(rows.map(r => r.userEmail)),
    workspaces: uniq(rows.map(r => r.workspace)),
    types: uniq(rows.map(r => r.type)),
    statuses: ["success", "failed", "blocked", "pending"],
    promptVersions: [], // not stored
    models: uniq(rows.map(r => r.model)),
    errorCodes: uniq(rows.map(r => r.errorCode)),
  };
}

// ── sensitive prompt reveal (super-admin only; caller must audit) ─────────────

export type PromptReveal = {
  found: boolean;
  promptFull: string | null;
  promptSnapshot: string | null;
  finalPrompt: string | null;
};

export async function getGenerationPromptReveal(id: string): Promise<PromptReveal> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  try {
    const { data, error } = await db
      .from("pin_generations")
      .select("prompt_full,setup_snapshot,category_audit")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return { found: false, promptFull: null, promptSnapshot: null, finalPrompt: null };
    const setup = (data.setup_snapshot ?? null) as Snapshot;
    const ca = (data.category_audit ?? null) as Snapshot;
    return {
      found: true,
      promptFull: asString(data.prompt_full),
      promptSnapshot: setup ? asString(setup.promptSnapshot) : null,
      finalPrompt: ca ? asString(ca.finalPrompt) : null,
    };
  } catch {
    return { found: false, promptFull: null, promptSnapshot: null, finalPrompt: null };
  }
}
