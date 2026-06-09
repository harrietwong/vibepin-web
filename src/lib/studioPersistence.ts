/**
 * studioPersistence.ts
 *
 * Two-tier persistence for the Studio generation history:
 *
 *   Tier 1 — localStorage   instant read/write, survives refresh, lost on clear
 *   Tier 2 — Supabase DB    permanent, cross-device, requires auth
 *
 * Additionally exposes `loadHistoryFromSupabaseStorage` which reconstructs
 * past sessions from Supabase Storage file listings — this is how we recover
 * generations that pre-date the history feature.
 *
 * Storage strategy for the session draft:
 *   - Generated image URLs (stable Supabase URLs) → always persisted
 *   - Reference pin URLs → always persisted
 *   - planPinSamples metadata → persisted (tiny, improves UX on reload)
 *   - customStyleRef (https://) → persisted; (data:) → dropped (too large)
 *   - Product base64 images → NOT persisted (quota risk); hadProductImages flag saved
 */

// ── Storage keys ──────────────────────────────────────────────────────────────
const DRAFT_KEY   = "vp:studio:draft";
const HISTORY_KEY = "vp:studio:history";
const MAX_HISTORY = 50;

// ── Shared sub-types ─────────────────────────────────────────────────────────

export type PinGroup = {
  refUrl:       string | null;
  images:       string[];
  visualFormat?: string;    // "on_body" | "flat_lay" | "mirror_selfie" | "unknown" etc.
  humanPresence?: string;   // "visible_person" | "no_person" | "unknown"
};

export type DraftPlanPin = {
  id:         string;
  image_url:  string;
  save_count: number;
};

// ── Setup snapshot types ──────────────────────────────────────────────────────

export type ProductSnapshot = {
  productId?:  string;
  imageUrl:    string | null;
  title:       string;
  source?:     string;          // platform / domain
  productUrl?: string;          // landing / affiliate URL when imported
  sourceDomain?: string;
};

export type ReferenceSnapshot = {
  referenceId?:  string;
  imageUrl:      string;
  title?:        string;
  source?:       string;
  visualFormat?: string;        // on_body | flat_lay | mirror_selfie | room_scene | unknown
  humanPresence?: string;       // visible_person | no_person | unknown
};

export type SetupSnapshot = {
  mode:               string;   // product_led | keyword_led | batch | plan | scratch
  keyword?:           string;
  category?:          string;
  opportunityTitle?:  string;
  noTextOverlay:      boolean;
  imagesPerReference: number;
  selectedProducts:   ProductSnapshot[];
  selectedReferences: ReferenceSnapshot[];
  promptSnapshot:     string;
  userInstructions?:  string;
  createdFrom?:       string;   // studio | shop_signals | weekly_plan | trend_radar | viral_pins
};

// ── Draft ─────────────────────────────────────────────────────────────────────

export type StudioDraft = {
  v:                1;
  savedAt:          string;
  source:           string;
  keyword:          string;
  category:         string;
  style:            string;
  count:            number;
  selectedPlanRefs: string[];
  planPinSamples:   DraftPlanPin[];
  customStyleRef:   string | null;
  myProductUrl:     string;
  myProductName:    string;
  hadProductImages: boolean;
  generatedGroups:  PinGroup[];
  promptText:       string | undefined;
  isBatch:          boolean;
  batchStates:      Record<string, {
    generatedGroups:  PinGroup[];
    selectedPlanRefs: string[];
    customStyleRef:   string | null;
    myProductUrl:     string;
    myProductName:    string;
    hadProductImages: boolean;
  }> | null;
};

export function saveDraft(draft: StudioDraft): void {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* quota */ }
}

export function loadDraft(): StudioDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as StudioDraft;
    return d.v === 1 ? d : null;
  } catch { return null; }
}

export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
}

// ── HistoryEntry ──────────────────────────────────────────────────────────────

// Canonical type. Imported for use in this file AND re-exported so callers
// (studio/page.tsx, _studio-legacy.tsx) that import GenerationStatus from this
// module continue to work without changes.
import type { GenerationStatus } from "./status/pinStatuses";
export type { GenerationStatus };

export type GenerationErrorType =
  | "rate_limited"
  | "safety_blocked"
  | "image_load_failed"
  | "model_returned_text"
  | "api_auth_error"
  | "api_payload_error"
  | "api_server_error"
  | "unknown_error";

export type HistoryEntry = {
  id:             string;
  savedAt:        string;
  keyword:        string;
  category:       string;
  source:         string;
  groups:         PinGroup[];
  refCount:       number;
  productCount:   number;
  totalPins:      number;              // actual total generated
  // ── Extended context (added to all new sessions) ──────────────────────────
  status?:        GenerationStatus;   // completed | partial | failed
  expectedTotal?: number;             // refs × imagesPerRef at time of generation
  mode?:          string;             // "product_led" | "keyword_led" | "batch" | "plan"
  opportunity?:   string;             // opportunity keyword (product-led mode)
  imagesPerRef?:  number;             // images requested per reference
  productNames?:  string[];           // product display names used in session
  productIds?:    string[];           // product DB IDs (for "Create More" navigation)
  promptExcerpt?: string;             // first ~120 chars (short preview)
  promptFull?:    string;             // full generation prompt (stored for audit/reuse)
  // ── Failure diagnostics ───────────────────────────────────────────────────
  errorType?:     GenerationErrorType;  // classified failure reason
  errorMessage?:  string;               // human-readable detail
  // ── Structured setup snapshot (canonical source for History modal left panel) ──
  setupSnapshot?: SetupSnapshot;
};

// Convenience: derive status from entry fields (works for old entries too)
export function deriveEntryStatus(entry: HistoryEntry): GenerationStatus {
  if (entry.status === "pending")     return "pending";
  if (entry.status === "running")     return "running";
  if (entry.status === "interrupted") return "interrupted";
  if (entry.status) return entry.status;
  const expected = entry.expectedTotal;
  if (!expected) return "completed";               // old entry — assume complete
  if (entry.totalPins === 0)          return "failed";
  if (entry.totalPins < expected)     return "partial";
  return "completed";
}

// ── Stale running session detection ──────────────────────────────────────────
// Sessions stuck as "running" for > STALE_THRESHOLD are treated as interrupted.
// The page/component calls this on mount and also pushes the fix to DB.

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export function resolveStaleRunningEntries(): { updated: HistoryEntry[]; staleSessions: string[] } {
  try {
    const existing: HistoryEntry[] = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    const now = Date.now();
    const staleSessions: string[] = [];

    const updated = existing.map(entry => {
      if (entry.status !== "running") return entry;
      const age = now - new Date(entry.savedAt).getTime();
      if (age < STALE_THRESHOLD_MS) return entry;
      staleSessions.push(entry.id);
      return { ...entry, status: "interrupted" as GenerationStatus };
    });

    if (staleSessions.length > 0) {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch { /* noop */ }
    }
    return { updated, staleSessions };
  } catch {
    return { updated: [], staleSessions: [] };
  }
}

// ── localStorage history ──────────────────────────────────────────────────────

export function addHistory(entry: HistoryEntry): void {
  try {
    const existing: HistoryEntry[] = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    const updated = [entry, ...existing.filter(e => e.id !== entry.id)].slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch { /* noop */ }
}

export function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); }
  catch { return []; }
}

export function clearHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* noop */ }
}

// ── Narrow Supabase interface (avoids importing full package into this lib) ───

interface StorageListResult {
  data: Array<{ name: string }> | null;
  error: unknown;
}

interface DbQueryResult<T> {
  data: T | null;
  error: unknown;
}

interface SupabaseLike {
  storage: {
    from(bucket: string): {
      list(path: string, opts?: object): Promise<StorageListResult>;
    };
  };
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<DbQueryResult<null>>;
    update(patch: Record<string, unknown>): {
      eq(col: string, val: unknown): Promise<DbQueryResult<null>>;
    };
    select(cols?: string): {
      eq(col: string, val: unknown): {
        order(col: string, opts?: object): {
          limit(n: number): Promise<DbQueryResult<Record<string, unknown>[]>>;
        };
      };
    };
  };
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null } }>;
  };
}

// ── Load history from Supabase Storage (recovers pre-feature generations) ────

export async function loadHistoryFromSupabaseStorage(
  client: unknown,
  supabaseUrl: string,
): Promise<HistoryEntry[]> {
  try {
    const sb = client as SupabaseLike;
    const { data, error } = await sb.storage.from("generated").list("studio", {
      limit: 300,
      sortBy: { column: "name", order: "desc" },
    });
    if (error || !data?.length) return [];

    // Filenames: [unix_seconds]_[idx]_[uuid8].png
    const files = data
      .filter(f => f.name.endsWith(".png"))
      .map(f => {
        const ts = parseInt(f.name.split("_")[0], 10);
        return {
          ts:  isNaN(ts) ? 0 : ts,
          url: `/api/storage-image?path=studio/${f.name}`,
        };
      })
      .filter(f => f.ts > 0)
      .sort((a, b) => b.ts - a.ts);

    // Group files into sessions: files within 120 s of each other = same session
    const sessions: Array<{ ts: number; urls: string[] }> = [];
    for (const f of files) {
      const hit = sessions.find(s => Math.abs(s.ts - f.ts) < 120);
      if (hit) { hit.urls.push(f.url); }
      else      { sessions.push({ ts: f.ts, urls: [f.url] }); }
    }

    return sessions.map(s => ({
      id:           `storage_${s.ts}`,
      savedAt:      new Date(s.ts * 1000).toISOString(),
      keyword:      "",
      category:     "",
      source:       "storage",
      groups:       [{ refUrl: null, images: s.urls }],
      refCount:     1,
      productCount: 0,
      totalPins:    s.urls.length,
    }));
  } catch {
    return [];
  }
  void supabaseUrl;
}

// ── Normalise a raw DB row into HistoryEntry ──────────────────────────────────

function rowToEntry(row: Record<string, unknown>): HistoryEntry {
  const rawSetup = row.setup_snapshot as SetupSnapshot | null | undefined;
  const rawGroups = Array.isArray(row.groups_json) ? row.groups_json as PinGroup[] : [];
  const flatPinUrls = Array.isArray(row.pin_urls)
    ? (row.pin_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  const flatRefUrls = Array.isArray(row.ref_urls)
    ? (row.ref_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  const imagesPerRef = row.images_per_ref != null ? Number(row.images_per_ref) : undefined;

  const hasGroupedImages = rawGroups.some(g => Array.isArray(g.images) && g.images.length > 0);
  const groups: PinGroup[] = hasGroupedImages || flatPinUrls.length === 0
    ? rawGroups
    : (() => {
        if (flatRefUrls.length > 0 && imagesPerRef && imagesPerRef > 0) {
          return flatRefUrls.map((refUrl, idx) => ({
            refUrl,
            images: flatPinUrls.slice(idx * imagesPerRef, (idx + 1) * imagesPerRef),
          }));
        }
        return [{ refUrl: flatRefUrls[0] ?? null, images: flatPinUrls }];
      })();
  const actualPins = Math.max(
    Number(row.total_pins ?? 0),
    groups.flatMap(g => g.images).length,
    flatPinUrls.length,
  );

  // Merge setup_snapshot into flat fields where the flat field is missing
  const productNames: string[] | undefined =
    (Array.isArray(row.product_names) ? row.product_names as string[] : undefined)
    ?? rawSetup?.selectedProducts?.map(p => p.title);

  const productIds: string[] | undefined =
    (Array.isArray(row.product_ids) ? row.product_ids as string[] : undefined)
    ?? rawSetup?.selectedProducts
      ?.map(p => p.productId)
      .filter((id): id is string => !!id);

  return {
    id:            String(row.session_id ?? row.id),
    savedAt:       String(row.created_at),
    keyword:       String(row.keyword ?? ""),
    category:      String(row.category ?? ""),
    source:        String(row.source   ?? "workspace"),
    groups,
    refCount:      Number(row.ref_count     ?? 1),
    productCount:  Number(row.product_count ?? 0),
    totalPins:     actualPins,
    // Extended context — gracefully undefined for old rows
    status:        (row.status as GenerationStatus | undefined),
    expectedTotal: row.expected_total != null ? Number(row.expected_total) : undefined,
    mode:          row.mode        != null ? String(row.mode)        : undefined,
    opportunity:   row.opportunity != null ? String(row.opportunity) : undefined,
    imagesPerRef,
    productNames,
    productIds,
    promptExcerpt: row.prompt_excerpt != null ? String(row.prompt_excerpt) : undefined,
    promptFull:    row.prompt_full    != null ? String(row.prompt_full)    : undefined,
    setupSnapshot: rawSetup ?? undefined,
  };
}

// ── Supabase DB insert (after successful generation) ─────────────────────────

export async function insertGenerationToDb(
  client: unknown,
  entry: HistoryEntry,
): Promise<void> {
  try {
    const sb = client as SupabaseLike;
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    const allUrls = entry.groups.flatMap(g => g.images);
    const refUrls = entry.groups.map(g => g.refUrl).filter(Boolean) as string[];

    await sb.from("pin_generations").insert({
      user_id:        user.id,
      session_id:     entry.id,
      keyword:        entry.keyword,
      category:       entry.category,
      source:         entry.source,
      ref_urls:       refUrls,
      pin_urls:       allUrls,
      groups_json:    entry.groups,
      ref_count:      entry.refCount,
      product_count:  entry.productCount,
      total_pins:     entry.totalPins,
      // Extended context columns (require DB migration if not present — fail silently)
      status:         entry.status,
      expected_total: entry.expectedTotal,
      mode:           entry.mode,
      opportunity:    entry.opportunity,
      images_per_ref: entry.imagesPerRef,
      product_names:  entry.productNames,
      product_ids:    entry.productIds,
      prompt_excerpt: entry.promptExcerpt,
      prompt_full:    entry.promptFull,
      setup_snapshot: entry.setupSnapshot ?? null,
      error_type:     entry.errorType,
      error_message:  entry.errorMessage,
    });
  } catch { /* table or columns may not exist yet — fail silently */ }
}

// ── Supabase DB fetch (load history across sessions) ─────────────────────────

export async function fetchGenerationsFromDb(
  client: unknown,
): Promise<HistoryEntry[]> {
  try {
    const sb = client as SupabaseLike;
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return [];

    const { data, error } = await sb
      .from("pin_generations")
      .select("id,session_id,created_at,keyword,category,source,groups_json,pin_urls,ref_urls,ref_count,product_count,total_pins,status,expected_total,mode,opportunity,images_per_ref,product_names,product_ids,prompt_excerpt,prompt_full,setup_snapshot")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error || !data?.length) return [];

    return data
      .map(row => rowToEntry(row))
      // Include running/interrupted sessions (may have 0 images) so tabs work
      .filter(e => e.groups.some(g => g.images.length > 0) || e.status === "running" || e.status === "interrupted");
  } catch {
    return [];
  }
}

// ── Create a "running" session in DB immediately on generation start ──────────

export async function createRunningSessionInDb(
  client: unknown,
  entry: HistoryEntry,
): Promise<void> {
  try {
    const sb = client as SupabaseLike;
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;

    console.log("[SessionCreate] setup_snapshot", {
      mode:                    entry.setupSnapshot?.mode,
      opportunityTitle:        entry.setupSnapshot?.opportunityTitle,
      selectedProductsCount:   entry.setupSnapshot?.selectedProducts?.length ?? 0,
      selectedReferencesCount: entry.setupSnapshot?.selectedReferences?.length ?? 0,
      hasPromptSnapshot:       !!entry.setupSnapshot?.promptSnapshot,
      imagesPerReference:      entry.setupSnapshot?.imagesPerReference,
      createdFrom:             entry.setupSnapshot?.createdFrom,
    });

    await sb.from("pin_generations").insert({
      user_id:        user.id,
      session_id:     entry.id,
      keyword:        entry.keyword,
      category:       entry.category,
      source:         entry.source,
      ref_urls:       [],
      pin_urls:       [],
      groups_json:    [],
      ref_count:      entry.refCount,
      product_count:  entry.productCount,
      total_pins:     0,
      status:         "running",
      expected_total: entry.expectedTotal,
      mode:           entry.mode,
      opportunity:    entry.opportunity,
      images_per_ref: entry.imagesPerRef,
      product_names:  entry.productNames,
      product_ids:    entry.productIds,
      prompt_excerpt: entry.promptExcerpt,
      prompt_full:    entry.promptFull,
      setup_snapshot: entry.setupSnapshot ?? null,
    });

    console.log("[SessionCreate] persisted session", entry.id);
  } catch { /* fail silently — DB may not have all columns yet */ }
}

// ── Update an existing session (called after each group and on completion) ────
// IMPORTANT: never pass setup_snapshot in the patch — it is write-once.
// Only update progress fields: status, groups_json, pin_urls, total_pins, etc.

export async function updateSessionInDb(
  client: unknown,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const sb = client as SupabaseLike;
    // Strip setup_snapshot from patch to prevent overwriting the original
    const { setup_snapshot: _dropped, ...safePatch } = patch;
    void _dropped;
    console.log("[SessionUpdate] preserving setup_snapshot", {
      sessionId,
      patchKeys: Object.keys(safePatch),
    });
    await sb.from("pin_generations").update(safePatch).eq("session_id", sessionId);
  } catch { /* fail silently */ }
}

// ── Merge history lists, deduplicate by id, newest first ─────────────────────

export function mergeHistoryEntries(...lists: HistoryEntry[][]): HistoryEntry[] {
  const seen = new Set<string>();
  const result: HistoryEntry[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        result.push(entry);
      }
    }
  }
  return result
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
    .slice(0, MAX_HISTORY);
}
