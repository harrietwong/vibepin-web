/**
 * Smart Schedule — ONE canonical scheduling configuration (localStorage).
 * Shared by the Weekly Plan Smart Schedule modal, the Settings Smart Schedule page,
 * and every Schedule action. Holds publishing timezone, pins-per-day, active days,
 * preferred time windows, the generated weekly posting slots, and (advanced) board
 * rotation. `weeklySlots` stays numeric-keyed (Mon=0…Sun=6) so the scheduling engine
 * is unchanged.
 */

export type SmartScheduleBoard = {
  boardId:   string;
  boardName: string;
};

/** Monday = 0 … Sunday = 6 (matches Weekly Plan calendar). */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 3-letter day names, index-aligned to WeekdayIndex (Mon=0…Sun=6). */
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type DayName = (typeof DAY_NAMES)[number];

export type TimeWindow = { label: string; start: string; end: string };

/** Posting rhythm mode. "recommended" = VibePin generates a balanced, system-defined
 *  weekly rhythm (counts may vary by day, NO numeric input); "same_every_day" = exactly
 *  `pinsPerDay` on every active day. (Per-day "custom" counts were removed in P0.) */
export type RhythmMode = "recommended" | "same_every_day";

export type SmartScheduleConfig = {
  /** Publishing timezone (IANA), e.g. "America/New_York". Used for future schedules. */
  timezone: string;
  /** Posting rhythm mode. Default "recommended". */
  rhythmMode: RhythmMode;
  /** Exact slots per active day used in "same_every_day" mode. 1–20, default 4. */
  pinsPerDay: number;
  /** Active publishing days, e.g. ["Mon","Tue",...]. */
  activeDays: DayName[];
  /** Editable preferred posting windows the generator distributes slots across. */
  preferredTimeWindows: TimeWindow[];
  /** Generated posting times per weekday, 24h "HH:mm", sorted ascending per day.
   *  This is the live OUTPUT of the rules (generated ∪ customSlots). */
  weeklySlots: Partial<Record<WeekdayIndex, string[]>>;
  /** Manually-added extra slots per weekday, merged into weeklySlots and preserved
   *  across rule changes / regeneration. */
  customSlots: Partial<Record<WeekdayIndex, string[]>>;
  /** Up to 2 real Pinterest boards for (advanced) board rotation. */
  boards: SmartScheduleBoard[];
  /** Default real Pinterest boardId for single-board scheduling/publishing. */
  defaultBoardId?: string;
  updatedAt?: string;
};

const STORE_KEY = "vp:smart_schedule:v1";
export const SMART_SCHEDULE_EVENT = "vp:smart_schedule_updated";

/** Example seed schedule — used only when no saved config exists. */
export const DEFAULT_WEEKLY_SLOTS: Record<WeekdayIndex, string[]> = {
  0: ["09:12", "09:41", "10:07", "15:04"],
  1: ["09:26", "15:43", "23:26"],
  2: ["09:17", "09:37", "14:20", "23:17"],
  3: ["09:00", "15:00", "21:00"],
  4: ["09:00", "15:00", "21:00"],
  5: ["09:30", "14:00"],
  6: ["10:00", "18:00"],
};

export const DEFAULT_TIME_WINDOWS: TimeWindow[] = [
  { label: "Morning",   start: "09:00", end: "11:00" },
  { label: "Afternoon", start: "14:00", end: "16:00" },
  { label: "Evening",   start: "20:00", end: "23:00" },
];

/** System-recommended weekly rhythm (Mon=0…Sun=6). Fixed, balanced, no user input —
 *  fuller mid-week, lighter weekend. */
export const RECOMMENDED_COUNTS: Record<WeekdayIndex, number> = { 0: 4, 1: 3, 2: 4, 3: 3, 4: 3, 5: 2, 6: 2 };

/** Recommended slot count for a single weekday (system rhythm; no numeric input). */
export function recommendedCountForDay(day: WeekdayIndex): number {
  return RECOMMENDED_COUNTS[day];
}

/** Browser/user local IANA timezone (never hardcoded). */
export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

export function defaultSmartScheduleConfig(): SmartScheduleConfig {
  return {
    timezone: localTimeZone(),
    rhythmMode: "recommended",
    pinsPerDay: 4,
    activeDays: [...DAY_NAMES],
    preferredTimeWindows: DEFAULT_TIME_WINDOWS.map(w => ({ ...w })),
    weeklySlots: { ...DEFAULT_WEEKLY_SLOTS },
    customSlots: {},
    boards: [],
    updatedAt: new Date().toISOString(),
  };
}

/** The slot count for a given weekday under the active rhythm mode.
 *  - same_every_day → exactly `pinsPerDay` on every active day.
 *  - recommended    → the fixed system rhythm (varies by day, no numeric input). */
export function pinsForDay(config: SmartScheduleConfig, day: WeekdayIndex): number {
  if (config.rhythmMode === "same_every_day") return clampPinsPerDay(config.pinsPerDay);
  return recommendedCountForDay(day);
}

function ok(): boolean {
  return typeof window !== "undefined";
}

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(SMART_SCHEDULE_EVENT));
}

function normalizeTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return "";
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function normalizeWeeklySlots(
  raw: Partial<Record<WeekdayIndex, string[]>> | undefined,
): Partial<Record<WeekdayIndex, string[]>> {
  const out: Partial<Record<WeekdayIndex, string[]>> = {};
  if (!raw) return out;
  for (const key of [0, 1, 2, 3, 4, 5, 6] as WeekdayIndex[]) {
    const times = (raw[key] ?? [])
      .map(normalizeTime)
      .filter(Boolean)
      .sort();
    if (times.length) out[key] = [...new Set(times)];
  }
  return out;
}

function normalizeActiveDays(raw: unknown): DayName[] {
  if (!Array.isArray(raw)) return [...DAY_NAMES];
  const days = raw.filter((d): d is DayName => (DAY_NAMES as readonly string[]).includes(d as string));
  return days.length ? [...new Set(days)] : [...DAY_NAMES];
}

function normalizeWindows(raw: unknown): TimeWindow[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TIME_WINDOWS.map(w => ({ ...w }));
  const out: TimeWindow[] = [];
  for (const w of raw as TimeWindow[]) {
    const start = normalizeTime(w?.start ?? "");
    const end = normalizeTime(w?.end ?? "");
    if (start && end) out.push({ label: (w?.label ?? "").trim() || "Window", start, end });
  }
  return out.length ? out : DEFAULT_TIME_WINDOWS.map(w => ({ ...w }));
}

/**
 * Normalize/migrate any raw (possibly legacy / partial) config object into a full
 * canonical SmartScheduleConfig. Used both when reading from storage and when a
 * caller hands us a partial config to validate. Never throws.
 */
export function normalizeSmartScheduleConfig(raw: unknown): SmartScheduleConfig {
  const base = defaultSmartScheduleConfig();
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<SmartScheduleConfig>;
  const boards = (parsed.boards ?? [])
    .filter(b => b?.boardId?.trim())
    .slice(0, 2)
    .map(b => ({ boardId: b.boardId.trim(), boardName: (b.boardName ?? "").trim() || b.boardId }));
  const defaultBoardId = typeof parsed.defaultBoardId === "string" && parsed.defaultBoardId.trim()
    ? parsed.defaultBoardId.trim()
    : undefined;
  const customSlots = normalizeWeeklySlots(parsed.customSlots as Partial<Record<WeekdayIndex, string[]>>);
  const weeklySlotsParsed = normalizeWeeklySlots(parsed.weeklySlots as Partial<Record<WeekdayIndex, string[]>>);
  const weeklySlots = Object.keys(weeklySlotsParsed).length === 0 ? { ...base.weeklySlots } : weeklySlotsParsed;
  const pinsPerDay = clampPinsPerDay(parsed.pinsPerDay);
  // Migration: read new `rhythmMode` or legacy `volumeMode`. "same_every_day"/"same" →
  // "same_every_day"; anything else (incl. removed "custom" and legacy "average") →
  // "recommended". `averagePinsPerDay` is intentionally dropped (recommended is now a
  // fixed system rhythm with no numeric input).
  const legacy = parsed as Record<string, unknown>;
  const rawMode = (legacy.rhythmMode ?? legacy.volumeMode) as string | undefined;
  const rhythmMode: RhythmMode =
    rawMode === "same_every_day" || rawMode === "same" ? "same_every_day" : "recommended";
  return {
    timezone: (typeof parsed.timezone === "string" && parsed.timezone.trim()) ? parsed.timezone.trim() : base.timezone,
    rhythmMode,
    pinsPerDay,
    activeDays: normalizeActiveDays(parsed.activeDays),
    preferredTimeWindows: normalizeWindows(parsed.preferredTimeWindows),
    weeklySlots,
    customSlots,
    boards,
    defaultBoardId,
    updatedAt: parsed.updatedAt,
  };
}

export function getSmartScheduleConfig(): SmartScheduleConfig {
  if (!ok()) return defaultSmartScheduleConfig();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultSmartScheduleConfig();
    return normalizeSmartScheduleConfig(JSON.parse(raw));
  } catch {
    return defaultSmartScheduleConfig();
  }
}

export function clampPinsPerDay(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 3;
  return Math.min(20, Math.max(1, v));
}

/** Accepts a partial config (e.g. just weeklySlots) and merges it over the current
 *  config, so callers never have to re-specify every field. Always normalizes. */
export function saveSmartScheduleConfig(config: Partial<SmartScheduleConfig>): void {
  if (!ok()) return;
  const base = getSmartScheduleConfig();
  const merged = { ...base, ...config };
  const pinsPerDay = clampPinsPerDay(merged.pinsPerDay);
  const payload: SmartScheduleConfig = {
    timezone: (merged.timezone || "").trim() || localTimeZone(),
    rhythmMode: merged.rhythmMode === "same_every_day" ? "same_every_day" : "recommended",
    pinsPerDay,
    activeDays: normalizeActiveDays(merged.activeDays),
    preferredTimeWindows: normalizeWindows(merged.preferredTimeWindows),
    weeklySlots: normalizeWeeklySlots(merged.weeklySlots),
    customSlots: normalizeWeeklySlots(merged.customSlots),
    boards: (merged.boards ?? []).filter(b => b.boardId.trim()).slice(0, 2),
    defaultBoardId: merged.defaultBoardId?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  emit();
}

// ── Slot generation ────────────────────────────────────────────────────────────

function toMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); }
function toHHMM(min: number): string {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** Add a minute value to the set, bumping to the nearest free minute within [lo, hi]
 *  so we never lose a slot to a collision. Returns true if a distinct slot was placed. */
function placeDistinct(set: Set<number>, target: number, lo: number, hi: number): boolean {
  let v = Math.max(lo, Math.min(hi, Math.round(target)));
  if (!set.has(v)) { set.add(v); return true; }
  for (let step = 1; step <= hi - lo; step++) {
    if (v + step <= hi && !set.has(v + step)) { set.add(v + step); return true; }
    if (v - step >= lo && !set.has(v - step)) { set.add(v - step); return true; }
  }
  return false; // window fully saturated
}

/**
 * Generate exactly `count` distinct posting times for one day, distributed as evenly as
 * possible across the preferred time windows. Deterministic (stable jitter, no per-render
 * randomness). Guarantees the returned array length equals `count` (a tight window that
 * can't hold its share spills into the remaining day so the count is always honored).
 */
function generateDaySlots(count: number, windows: TimeWindow[], daySeed: number): string[] {
  if (count <= 0) return [];
  const wins = windows.length ? windows : DEFAULT_TIME_WINDOWS;
  const W = wins.length;
  const mins = new Set<number>();
  // Even split of `count` across windows: first (count % W) windows get one extra.
  const perWin = wins.map((_, wi) => Math.floor(count / W) + (wi < count % W ? 1 : 0));
  wins.forEach((w, wi) => {
    const k = perWin[wi];
    if (!k) return;
    const startMin = toMin(w.start);
    const endMin = Math.max(startMin + 1, toMin(w.end));
    const span = endMin - startMin;
    for (let j = 0; j < k; j++) {
      const frac = (j + 1) / (k + 1);                          // even interior spread
      const jitter = ((daySeed * 11 + wi * 7 + j * 5 + 3) % 11) - 5; // -5..5, stable
      placeDistinct(mins, startMin + span * frac + jitter, startMin, endMin);
    }
  });
  // Fallback fill (only if a tight window saturated): step across the whole day so the
  // final count always equals `count`.
  if (mins.size < count) {
    const dayStart = toMin(wins[0].start);
    for (let m = dayStart; m < 1440 && mins.size < count; m++) if (!mins.has(m)) mins.add(m);
    for (let m = 0; m < dayStart && mins.size < count; m++) if (!mins.has(m)) mins.add(m);
  }
  return [...mins].sort((a, b) => a - b).slice(0, count).map(toHHMM);
}

/**
 * Generate weeklySlots from the active rhythm mode × active days distributed across the
 * preferred time windows. "same_every_day" → pinsPerDay for every active day;
 * "recommended" → the fixed system weekly rhythm (varies by day, no numeric input).
 * Inactive days produce no entry (0 slots). Each active day gets EXACTLY its computed
 * number of distinct slots. Deterministic.
 */
export function generateWeeklySlots(config: SmartScheduleConfig): Partial<Record<WeekdayIndex, string[]>> {
  const windows = config.preferredTimeWindows?.length ? config.preferredTimeWindows : DEFAULT_TIME_WINDOWS;
  const activeIdx = normalizeActiveDays(config.activeDays)
    .map(n => DAY_NAMES.indexOf(n))
    .filter(i => i >= 0) as WeekdayIndex[];
  const out: Partial<Record<WeekdayIndex, string[]>> = {};
  for (const d of activeIdx) {
    const count = pinsForDay(config, d);
    if (count > 0) out[d] = generateDaySlots(count, windows, d);
  }
  return out;
}

/** Union two slot maps per weekday (sorted, de-duplicated). */
export function mergeSlotMaps(
  a: Partial<Record<WeekdayIndex, string[]>>,
  b: Partial<Record<WeekdayIndex, string[]>>,
): Partial<Record<WeekdayIndex, string[]>> {
  const out: Partial<Record<WeekdayIndex, string[]>> = {};
  for (const key of [0, 1, 2, 3, 4, 5, 6] as WeekdayIndex[]) {
    const merged = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])]
      .map(normalizeTime)
      .filter(Boolean)
      .sort();
    if (merged.length) out[key] = merged;
  }
  return out;
}

/**
 * Canonical preview/output generator: the rule-generated slots merged with the
 * user's manually-added customSlots. This is exactly what Save persists into
 * `weeklySlots`, so the live preview and the saved value never diverge.
 * Deterministic for the same config.
 */
export function generateWeeklySlotsFromConfig(config: SmartScheduleConfig): Partial<Record<WeekdayIndex, string[]>> {
  return mergeSlotMaps(generateWeeklySlots(config), config.customSlots ?? {});
}

/** True if any rule input that affects generated slots differs between two configs. */
export function hasSmartScheduleInputsChanged(
  oldConfig: SmartScheduleConfig,
  formState: SmartScheduleConfig,
): boolean {
  const pick = (c: SmartScheduleConfig) => JSON.stringify({
    timezone: c.timezone,
    rhythmMode: c.rhythmMode,
    pinsPerDay: c.pinsPerDay,
    activeDays: [...c.activeDays].sort(),
    preferredTimeWindows: c.preferredTimeWindows,
    customSlots: normalizeWeeklySlots(c.customSlots),
  });
  return pick(oldConfig) !== pick(formState);
}

/** Subscribe to canonical Smart Schedule config changes (any surface saving).
 *  Returns an unsubscribe function. No-op on the server. */
export function subscribeToSmartScheduleConfigChanges(listener: () => void): () => void {
  if (!ok()) return () => {};
  window.addEventListener(SMART_SCHEDULE_EVENT, listener);
  return () => window.removeEventListener(SMART_SCHEDULE_EVENT, listener);
}

/** Canonical read: the weekly posting slots every surface shares. */
export function getWeeklyPostingSlots(): Partial<Record<WeekdayIndex, string[]>> {
  return getSmartScheduleConfig().weeklySlots;
}

/** Canonical write: replace only the weekly posting slots, preserving the rest of the
 *  config. Persists + emits SMART_SCHEDULE_EVENT so every surface reads the same value. */
export function updateWeeklyPostingSlots(
  weeklySlots: Partial<Record<WeekdayIndex, string[]>>,
): SmartScheduleConfig {
  const current = getSmartScheduleConfig();
  saveSmartScheduleConfig({ ...current, weeklySlots });
  return getSmartScheduleConfig();
}

export function hasConfiguredSlots(config?: SmartScheduleConfig): boolean {
  const c = config ?? getSmartScheduleConfig();
  return Object.values(c.weeklySlots).some(slots => (slots?.length ?? 0) > 0);
}

export function allConfiguredSlotTimes(config?: SmartScheduleConfig): string[] {
  const c = config ?? getSmartScheduleConfig();
  const set = new Set<string>();
  for (const slots of Object.values(c.weeklySlots)) {
    for (const t of slots ?? []) set.add(t);
  }
  return [...set].sort();
}
