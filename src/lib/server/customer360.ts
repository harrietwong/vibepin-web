// ── Customer 360 v0 data layer (READ-ONLY, internal admin) ───────────────────
//
// Powers /admin/users (list) and /admin/users/[id] (detail). Founder/support
// use this to search a customer and understand account/workspace/binding
// status, recent activity, usage, and recent generation errors.
//
// SAFETY
//   * Every query is read-only (the only write path in this feature is adding a
//     support note, handled by its own API route).
//   * Secrets never leave the server: token ciphertext columns are NEVER
//     selected. Integration status is derived only from safe metadata
//     (connection_status / needs_reconnect / disconnected_at / *_expires_at /
//     updated_at). No access tokens, refresh tokens, secrets, or auth headers.
//   * Degrades gracefully: a missing table/column or a permission error turns
//     into null metrics + a warning, never a crash.
//
// There is no dedicated `workspaces` table or per-user activity-event table in
// this schema yet, so "workspaces" are derived from weekly_plans + generation
// categories, and the activity timeline is synthesized from the concrete rows
// that DO exist (generations, publishes, connections, last login). Both are
// clearly labeled as derived in the UI.

type Db = ReturnType<typeof import("@/lib/supabase").createServerClient>;
type PgError = { code?: string; message?: string } | null;

export type AccountStatus = "active" | "unconfirmed" | "banned";

export type IntegrationSummary = {
  pinterest: "connected" | "reconnect" | "none";
  socialConnected: number;
  hasIssue: boolean;
};

export type UserListRow = {
  id: string;
  email: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  plan: string | null;
  totalWorkspaces: number | null;
  activeWorkspaces: number | null;
  totalGenerations: number | null; // within the recent scan window
  generations24h: number | null;
  hasFailedGeneration: boolean;
  accountStatus: AccountStatus;
  integration: IntegrationSummary;
  latestActivityAt: string | null;
};

export type UsersOverview = {
  available: boolean;
  rows: UserListRow[];
  generationsWindowSaturated: boolean;
  warnings: string[];
};

// ── shared helpers ───────────────────────────────────────────────────────────

function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "42703" || error.code === "PGRST205" || error.code === "PGRST204") return true;
  return /(relation|column) .* does not exist|could not find the table/i.test(error.message ?? "");
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const present = values.filter((v): v is string => !!v);
  return present.length ? present.reduce((a, b) => (a > b ? a : b)) : null;
}

type AuthUserLite = {
  id: string;
  email: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  banned_until?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

function accountStatusOf(u: AuthUserLite): AccountStatus {
  const banned = typeof u.banned_until === "string" && Date.parse(u.banned_until) > Date.now();
  if (banned) return "banned";
  if (!u.email_confirmed_at) return "unconfirmed";
  return "active";
}

function planOf(u: AuthUserLite): string | null {
  const fromApp = u.app_metadata?.["plan"];
  const fromUser = u.user_metadata?.["plan"];
  const plan = typeof fromApp === "string" ? fromApp : typeof fromUser === "string" ? fromUser : null;
  return plan;
}

// pinterest connection → safe summary (never selects token ciphertext).
function pinterestStatus(row: { needs_reconnect?: boolean; disconnected_at?: string | null } | undefined): "connected" | "reconnect" | "none" {
  if (!row || row.disconnected_at) return "none";
  return row.needs_reconnect ? "reconnect" : "connected";
}

const GENERATION_SCAN_LIMIT = 5000;

// ── list page ────────────────────────────────────────────────────────────────

export async function getUsersOverview(): Promise<UsersOverview> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];

  // 1. Users (service-role required).
  let users: AuthUserLite[] = [];
  try {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error || !data) {
      warnings.push("User list unavailable — auth.admin.listUsers failed (a SUPABASE_SERVICE_ROLE_KEY is required).");
      return { available: false, rows: [], generationsWindowSaturated: false, warnings };
    }
    users = (data.users ?? []) as unknown as AuthUserLite[];
    if (users.length >= 1000) warnings.push("User list capped at 1000 (first page only).");
  } catch {
    warnings.push("User list unavailable — auth admin API threw.");
    return { available: false, rows: [], generationsWindowSaturated: false, warnings };
  }

  const last24h = isoHoursAgo(24);

  // 2. Bulk aggregates in a few queries (avoid N+1 per user).
  const genByUser = new Map<string, { total: number; last24h: number; failed: boolean; latest: string | null }>();
  let generationsWindowSaturated = false;
  try {
    const { data, error } = await db
      .from("pin_generations")
      .select("user_id,created_at,status")
      .order("created_at", { ascending: false })
      .limit(GENERATION_SCAN_LIMIT);
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`pin_generations scan failed: ${error.message}`);
    } else {
      const rows = data ?? [];
      generationsWindowSaturated = rows.length >= GENERATION_SCAN_LIMIT;
      for (const r of rows) {
        const uid = r.user_id as string | null;
        if (!uid) continue;
        const entry = genByUser.get(uid) ?? { total: 0, last24h: 0, failed: false, latest: null };
        entry.total += 1;
        if ((r.created_at as string) >= last24h) entry.last24h += 1;
        if (r.status === "failed") entry.failed = true;
        entry.latest = maxIso([entry.latest, r.created_at as string]);
        genByUser.set(uid, entry);
      }
    }
  } catch {
    warnings.push("pin_generations scan threw.");
  }

  // 3. Workspaces (derived from weekly_plans categories).
  const wsByUser = new Map<string, { categories: Set<string>; activeCategories: Set<string>; latest: string | null }>();
  const weekActiveSince = isoHoursAgo(24 * 7);
  try {
    const { data, error } = await db.from("weekly_plans").select("user_id,category,updated_at").limit(10000);
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`weekly_plans scan failed: ${error.message}`);
    } else {
      for (const r of data ?? []) {
        const uid = r.user_id as string | null;
        if (!uid) continue;
        const entry = wsByUser.get(uid) ?? { categories: new Set<string>(), activeCategories: new Set<string>(), latest: null };
        const cat = (r.category as string) ?? "(uncategorized)";
        entry.categories.add(cat);
        if ((r.updated_at as string) >= weekActiveSince) entry.activeCategories.add(cat);
        entry.latest = maxIso([entry.latest, r.updated_at as string]);
        wsByUser.set(uid, entry);
      }
    }
  } catch {
    warnings.push("weekly_plans scan threw.");
  }

  // 4. Pinterest connections (safe columns only — no tokens).
  const pinByUser = new Map<string, { needs_reconnect?: boolean; disconnected_at?: string | null }>();
  try {
    const { data, error } = await db.from("pinterest_connections").select("vibepin_user_id,needs_reconnect,disconnected_at");
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`pinterest_connections scan failed: ${error.message}`);
    } else {
      for (const r of data ?? []) pinByUser.set(r.vibepin_user_id as string, r);
    }
  } catch {
    /* optional */
  }

  // 5. Social connections (status only).
  const socialByUser = new Map<string, { connected: number; issue: boolean }>();
  try {
    const { data, error } = await db.from("social_connections").select("user_id,connection_status");
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`social_connections scan failed: ${error.message}`);
    } else {
      for (const r of data ?? []) {
        const uid = r.user_id as string;
        const entry = socialByUser.get(uid) ?? { connected: 0, issue: false };
        if (r.connection_status === "connected") entry.connected += 1;
        if (r.connection_status === "expired" || r.connection_status === "revoked" || r.connection_status === "error") entry.issue = true;
        socialByUser.set(uid, entry);
      }
    }
  } catch {
    /* optional */
  }

  const rows: UserListRow[] = users.map(u => {
    const gen = genByUser.get(u.id);
    const ws = wsByUser.get(u.id);
    const pin = pinterestStatus(pinByUser.get(u.id));
    const social = socialByUser.get(u.id) ?? { connected: 0, issue: false };
    const integration: IntegrationSummary = {
      pinterest: pin,
      socialConnected: social.connected,
      hasIssue: pin === "reconnect" || social.issue,
    };
    return {
      id: u.id,
      email: u.email,
      createdAt: u.created_at,
      lastLoginAt: u.last_sign_in_at,
      plan: planOf(u),
      totalWorkspaces: ws ? ws.categories.size : 0,
      activeWorkspaces: ws ? ws.activeCategories.size : 0,
      totalGenerations: gen ? gen.total : 0,
      generations24h: gen ? gen.last24h : 0,
      hasFailedGeneration: gen?.failed ?? false,
      accountStatus: accountStatusOf(u),
      integration,
      latestActivityAt: maxIso([u.last_sign_in_at, gen?.latest ?? null, ws?.latest ?? null]),
    };
  });

  rows.sort((a, b) => (b.latestActivityAt ?? "").localeCompare(a.latestActivityAt ?? ""));
  return { available: true, rows, generationsWindowSaturated, warnings };
}

// ── detail page ──────────────────────────────────────────────────────────────

export type WorkspaceRow = {
  id: string;
  name: string;
  category: string | null;
  createdAt: string | null;
  latestActivityAt: string | null;
  latestGenerationAt: string | null;
  latestProductIdeasAt: string | null; // null: not tracked per-workspace
  freshness: "fresh" | "stale" | "unknown";
  derived: boolean;
};

export type IntegrationRow = {
  provider: string;
  connected: boolean;
  status: string;
  accountLabel: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  reauthRequired: boolean;
};

export type ActivityEvent = {
  type: string;
  detail: string | null;
  at: string | null;
};

export type GenerationLog = {
  id: string;
  type: string | null;
  status: string | null;
  createdAt: string | null;
  promptVersion: string | null; // not stored yet
  model: string | null;         // not stored yet
  errorCode: string | null;
  errorMessage: string | null;
  previewImageUrl: string | null;
};

export type UserDetail = {
  found: boolean;
  warnings: string[];
  account: {
    id: string;
    email: string | null;
    createdAt: string | null;
    lastLoginAt: string | null;
    plan: string | null;
    status: AccountStatus;
    tokenBalance: number | null;
    internalTags: string[];
  } | null;
  workspaces: { available: boolean; derived: boolean; rows: WorkspaceRow[] };
  integrations: IntegrationRow[];
  activity: { available: boolean; events: ActivityEvent[]; note: string | null };
  generations: GenerationLog[];
};

function safeImagePreview(pinUrls: unknown, groups: unknown): string | null {
  const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);
  if (Array.isArray(pinUrls)) {
    const hit = pinUrls.find(isHttp);
    if (hit) return hit;
  }
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const imgs = (g as { images?: unknown })?.images;
      if (Array.isArray(imgs)) {
        const hit = imgs.find(isHttp);
        if (hit) return hit;
      }
    }
  }
  return null;
}

export async function getUserDetail(userId: string): Promise<UserDetail> {
  const { createServerClient } = await import("@/lib/supabase");
  const db = createServerClient();
  const warnings: string[] = [];

  // Account (service-role required).
  let authUser: AuthUserLite | null = null;
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      warnings.push("User not found or auth admin API unavailable.");
    } else {
      authUser = data.user as unknown as AuthUserLite;
    }
  } catch {
    warnings.push("Auth admin API threw while loading the user.");
  }

  if (!authUser) {
    return {
      found: false,
      warnings,
      account: null,
      workspaces: { available: false, derived: true, rows: [] },
      integrations: [],
      activity: { available: false, events: [], note: null },
      generations: [],
    };
  }

  const tokenMeta = authUser.user_metadata?.["tokens"] ?? authUser.app_metadata?.["tokens"];
  const tokenBalance = typeof tokenMeta === "number" ? tokenMeta : null;
  const tagsMeta = authUser.app_metadata?.["internal_tags"] ?? authUser.user_metadata?.["internal_tags"];
  const internalTags = Array.isArray(tagsMeta) ? tagsMeta.filter((t): t is string => typeof t === "string") : [];

  // Parallel section loads.
  const [workspaces, integrations, generations, publishEvents] = await Promise.all([
    loadWorkspaces(db, userId, warnings),
    loadIntegrations(db, userId, warnings),
    loadGenerations(db, userId, warnings),
    loadPublishEvents(db, userId),
  ]);

  const activity = buildActivity(authUser, generations, integrations, publishEvents);

  return {
    found: true,
    warnings,
    account: {
      id: authUser.id,
      email: authUser.email,
      createdAt: authUser.created_at,
      lastLoginAt: authUser.last_sign_in_at,
      plan: planOf(authUser),
      status: accountStatusOf(authUser),
      tokenBalance,
      internalTags,
    },
    workspaces,
    integrations,
    activity,
    generations,
  };
}

async function loadWorkspaces(db: Db, userId: string, warnings: string[]): Promise<UserDetail["workspaces"]> {
  // Derived from weekly_plans (closest thing to a workspace) + generation
  // activity per category. No dedicated workspaces table exists.
  const byCat = new Map<string, WorkspaceRow>();

  try {
    const { data, error } = await db
      .from("weekly_plans")
      .select("id,category,created_at,updated_at")
      .eq("user_id", userId);
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`weekly_plans query failed: ${error.message}`);
    } else {
      for (const r of data ?? []) {
        const cat = (r.category as string) ?? "(uncategorized)";
        const row = byCat.get(cat) ?? emptyWorkspace(cat);
        row.createdAt = minIso(row.createdAt, r.created_at as string);
        row.latestActivityAt = maxIso([row.latestActivityAt, r.updated_at as string]);
        byCat.set(cat, row);
      }
    }
  } catch {
    warnings.push("weekly_plans query threw.");
  }

  try {
    const { data, error } = await db
      .from("pin_generations")
      .select("category,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (!error) {
      for (const r of data ?? []) {
        const cat = (r.category as string) || "(uncategorized)";
        const row = byCat.get(cat) ?? emptyWorkspace(cat);
        row.latestGenerationAt = maxIso([row.latestGenerationAt, r.created_at as string]);
        row.latestActivityAt = maxIso([row.latestActivityAt, r.created_at as string]);
        row.createdAt = minIso(row.createdAt, r.created_at as string);
        byCat.set(cat, row);
      }
    }
  } catch {
    /* best-effort */
  }

  const rows = Array.from(byCat.values()).map(r => ({
    ...r,
    freshness: freshnessOf(r.latestActivityAt),
  }));
  rows.sort((a, b) => (b.latestActivityAt ?? "").localeCompare(a.latestActivityAt ?? ""));
  return { available: rows.length > 0, derived: true, rows };
}

function emptyWorkspace(cat: string): WorkspaceRow {
  return {
    id: cat,
    name: cat,
    category: cat,
    createdAt: null,
    latestActivityAt: null,
    latestGenerationAt: null,
    latestProductIdeasAt: null,
    freshness: "unknown",
    derived: true,
  };
}

function minIso(a: string | null, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

function freshnessOf(iso: string | null): "fresh" | "stale" | "unknown" {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  return Date.now() - t <= 7 * 24 * 3_600_000 ? "fresh" : "stale";
}

async function loadIntegrations(db: Db, userId: string, warnings: string[]): Promise<IntegrationRow[]> {
  const out: IntegrationRow[] = [];

  // Pinterest (dedicated table). Select SAFE columns only — never tokens.
  try {
    const { data, error } = await db
      .from("pinterest_connections")
      .select("pinterest_username,pinterest_account_type,needs_reconnect,scopes,access_token_expires_at,updated_at,disconnected_at")
      .eq("vibepin_user_id", userId)
      .is("disconnected_at", null)
      .maybeSingle();
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`pinterest_connections query failed: ${error.message}`);
    } else if (data) {
      out.push({
        provider: "pinterest",
        connected: true,
        status: data.needs_reconnect ? "reauth required" : "connected",
        accountLabel: (data.pinterest_username as string) ?? (data.pinterest_account_type as string) ?? null,
        tokenExpiresAt: (data.access_token_expires_at as string) ?? null,
        lastSyncAt: (data.updated_at as string) ?? null,
        lastSyncError: null,
        reauthRequired: !!data.needs_reconnect,
      });
    } else {
      out.push({ provider: "pinterest", connected: false, status: "not connected", accountLabel: null, tokenExpiresAt: null, lastSyncAt: null, lastSyncError: null, reauthRequired: false });
    }
  } catch {
    /* optional */
  }

  // Other social providers (unified table). Safe columns only.
  try {
    const { data, error } = await db
      .from("social_connections")
      .select("provider,provider_account_username,provider_account_name,connection_status,token_expires_at,updated_at")
      .eq("user_id", userId);
    if (error) {
      if (!isMissingSchema(error)) warnings.push(`social_connections query failed: ${error.message}`);
    } else {
      for (const r of data ?? []) {
        const status = (r.connection_status as string) ?? "not_connected";
        out.push({
          provider: (r.provider as string) ?? "unknown",
          connected: status === "connected",
          status,
          accountLabel: (r.provider_account_username as string) ?? (r.provider_account_name as string) ?? null,
          tokenExpiresAt: (r.token_expires_at as string) ?? null,
          lastSyncAt: (r.updated_at as string) ?? null,
          lastSyncError: null,
          reauthRequired: status === "expired" || status === "revoked" || status === "error",
        });
      }
    }
  } catch {
    /* optional */
  }

  return out;
}

async function loadGenerations(db: Db, userId: string, warnings: string[]): Promise<GenerationLog[]> {
  // model / prompt_version are not stored in pin_generations yet → null.
  const minimal = "id,created_at,keyword,category,mode,source,status,error_type,error_message,pin_urls,groups_json";
  try {
    let rows: Array<Record<string, unknown>> = [];
    const first = await db
      .from("pin_generations")
      .select(minimal)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (first.error) {
      // Older DBs may lack some columns; retry with the base set.
      const retry = await db
        .from("pin_generations")
        .select("id,created_at,keyword,category,pin_urls,groups_json")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (retry.error) {
        if (!isMissingSchema(retry.error)) warnings.push(`pin_generations query failed: ${retry.error.message}`);
      }
      rows = (retry.data ?? []) as Array<Record<string, unknown>>;
    } else {
      rows = (first.data ?? []) as Array<Record<string, unknown>>;
    }
    return rows.map((r): GenerationLog => ({
      id: String(r.id),
      type: (r as Record<string, unknown>).mode as string ?? (r as Record<string, unknown>).source as string ?? null,
      status: ((r as Record<string, unknown>).status as string) ?? null,
      createdAt: (r.created_at as string) ?? null,
      promptVersion: null,
      model: null,
      errorCode: ((r as Record<string, unknown>).error_type as string) ?? null,
      errorMessage: ((r as Record<string, unknown>).error_message as string) ?? null,
      previewImageUrl: safeImagePreview(r.pin_urls, r.groups_json),
    }));
  } catch {
    warnings.push("pin_generations detail query threw.");
    return [];
  }
}

async function loadPublishEvents(db: Db, userId: string): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for (const table of ["social_publish_jobs", "publish_jobs"]) {
    try {
      const { data, error } = await db
        .from(table)
        .select("status,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (!error) {
        for (const r of data ?? []) {
          events.push({ type: "publish", detail: `${table} · ${(r.status as string) ?? ""}`.trim(), at: (r.created_at as string) ?? null });
        }
      }
    } catch {
      /* optional */
    }
  }
  return events;
}

function buildActivity(
  user: AuthUserLite,
  generations: GenerationLog[],
  integrations: IntegrationRow[],
  publishEvents: ActivityEvent[],
): UserDetail["activity"] {
  const events: ActivityEvent[] = [];

  if (user.last_sign_in_at) events.push({ type: "login", detail: null, at: user.last_sign_in_at });

  for (const g of generations.slice(0, 15)) {
    const type =
      g.status === "failed" ? "generation.failed" :
      g.status === "completed" ? "generation.succeeded" :
      g.status === "running" || g.status === "pending" ? "generation.started" :
      "generation";
    const detail = g.status === "failed" ? (g.errorMessage ?? g.errorCode ?? "failed") : g.type;
    events.push({ type, detail, at: g.createdAt });
  }

  for (const i of integrations) {
    if (i.connected) events.push({ type: "integration.connected", detail: `${i.provider}${i.accountLabel ? ` · ${i.accountLabel}` : ""}`, at: i.lastSyncAt });
  }

  events.push(...publishEvents);

  events.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  return {
    available: events.length > 0,
    events: events.slice(0, 25),
    // Product-idea interaction events (exposed/saved/hidden/not_relevant) and
    // export events are not yet instrumented in this schema.
    note: "Granular product-idea (exposed/saved/hidden/not_relevant) and export events are not yet instrumented — this timeline is synthesized from logins, generations, integrations, and publishes.",
  };
}
