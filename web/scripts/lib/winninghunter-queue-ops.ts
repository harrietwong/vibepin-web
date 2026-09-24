import { createHash } from "node:crypto";

export type WinningHunterQueueItem = {
  queue_rank: number;
  queue_class: string;
  readiness: string;
  sha256: string;
  source_files: string[];
  source_ad_ids: string[];
  title: string;
  shopify_product_id: string;
  handle: string;
  public_url: string;
  homepage_featured: boolean;
  active_status: string;
  active_verified_at: string;
  mapping_confirmed: boolean;
  copy_override_applied: boolean;
  copy: { pinterest: { title: string; description: string; destination_url: string } };
  platforms: Record<string, unknown>;
  [key: string]: unknown;
};

export type ExistingScheduleRow = {
  status?: string | null;
  payload?: Record<string, unknown> | null;
  scheduled_at?: string | null;
};

export type ExistingClassification = "protected" | "shiftable" | "ignore";

export const BOARD_IDS = {
  gifts: "813814663855482394",
  home: "813814663854885698",
  cleaning: "813814663855482395",
  gadgets: "813814663855482397",
  fashion: "813814663855482396",
} as const;
export const BOARD_NAMES: Record<string, string> = {
  [BOARD_IDS.gifts]: "Gift Ideas for Her & Personalized Jewelry",
  [BOARD_IDS.home]: "Home & Kitchen Finds",
  [BOARD_IDS.cleaning]: "Cleaning & Self-Care Finds",
  [BOARD_IDS.gadgets]: "Smart Gadgets & Everyday Essentials",
  [BOARD_IDS.fashion]: "fashion",
};

export const MAX_PRIVATE_VIDEO_BYTES = 45 * 1024 * 1024;
const VIDEO_STORAGE_BUDGET_FRACTION = 0.92;

export function targetWinningHunterVideoBitrateKbps(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("invalid_video_duration_ms");
  const totalKbps = (MAX_PRIVATE_VIDEO_BYTES * VIDEO_STORAGE_BUDGET_FRACTION * 8) / durationMs;
  return Math.max(700, Math.min(3200, Math.floor(totalKbps - 128)));
}

const DAY_MS = 86_400_000;

export function dedupeWinningHunterQueue(items: WinningHunterQueueItem[]) {
  const seen = new Set<string>();
  const accepted: WinningHunterQueueItem[] = [];
  const duplicates: Array<{ item: WinningHunterQueueItem; keys: string[] }> = [];
  for (const item of items) {
    const keys = [
      `sha:${item.sha256.toLowerCase()}`,
      ...item.source_files.map((file) => `file:${file.toLowerCase()}`),
      ...item.source_ad_ids.map((ad) => `ad:${ad}`),
      `product:${item.shopify_product_id}|url:${item.public_url}`,
    ];
    const clashes = keys.filter((key) => seen.has(key));
    if (clashes.length) duplicates.push({ item, keys: clashes });
    else { keys.forEach((key) => seen.add(key)); accepted.push(item); }
  }
  return { accepted, duplicates };
}

export function mapWinningHunterBoard(title: string, handle = ""): string {
  const text = `${title} ${handle}`.toLowerCase();
  if (/fashion|dress|shirt|scarf|skirt|pants|hoodie|clothing|apparel/.test(text)) return BOARD_IDS.fashion;
  if (/clean|self.?care|beauty|makeup|skin|hair|soap|shampoo/.test(text)) return BOARD_IDS.cleaning;
  if (/gadget|phone|tech|usb|led|charger|kitchen|home|storage|organizer|tool/.test(text)) return BOARD_IDS.gadgets;
  if (/gift|christmas|advent|toy|baby|kids|pet|jewelry|necklace|bracelet|earring|ring|rose/.test(text)) return BOARD_IDS.gifts;
  return BOARD_IDS.home;
}

function etParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function localIso(date: Date): string {
  const p = etParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Convert a civil wall-clock time in an IANA zone to an unambiguous UTC ISO. */
export function toUtcIso(local: string, timeZone = "America/New_York"): string {
  const naive = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(naive)) throw new Error(`invalid_local_time:${local}`);
  let guess = naive;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const rendered = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const renderedNaive = Date.parse(`${rendered.year}-${rendered.month}-${rendered.day}T${rendered.hour}:${rendered.minute}:${rendered.second}Z`);
    guess -= renderedNaive - naive;
  }
  return new Date(guess).toISOString();
}

export function buildEtSlots(now: Date, count: number): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("invalid_slot_count");
  const p = etParts(new Date(now.getTime() + DAY_MS));
  const first = Date.parse(`${p.year}-${p.month}-${p.day}T09:00:00Z`);
  const slots: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = Math.floor(index / 12);
    const hour = 9 + (index % 12);
    const date = new Date(first + day * DAY_MS);
    const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const values = Object.fromEntries(dayParts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    slots.push(`${values.year}-${values.month}-${values.day}T${String(hour).padStart(2, "0")}:00`);
  }
  return slots;
}

/** Preview-safe portrait conversion: contain foreground, blurred cover background,
 * and force limited-range yuv420p output. */
export function buildWinningHunterPortraitTransformCommand(inputPath: string, outputPath: string, durationMs = 30_000): string[] {
  const videoKbps = targetWinningHunterVideoBitrateKbps(durationMs);
  const filter = "[0:v]split=2[bg0][fg0];[bg0]scale=1080:1920:force_original_aspect_ratio=increase:in_range=auto:out_range=tv,crop=1080:1920,boxblur=luma_radius=24:luma_power=2[bg];[fg0]scale=1080:1920:force_original_aspect_ratio=decrease:in_range=auto:out_range=tv[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setparams=range=limited[v]";
  return ["-y", "-i", inputPath, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-movflags", "+faststart", outputPath];
}

export function classifyExistingDraft(row: ExistingScheduleRow): ExistingClassification {
  const payload = row.payload ?? {};
  const status = String(row.status ?? payload.status ?? "").toLowerCase();
  if (["posted", "failed"].includes(status) || payload.postedAt || payload.remotePinId || payload.publishError) return "ignore";
  if (payload.scheduleSource === "manual" || payload.scheduleLocked === true) return "protected";
  if (payload.scheduleSource === "smart" && payload.scheduleLocked !== true && (payload.plannedAt || row.scheduled_at)) return "shiftable";
  return "ignore";
}

export function stableQueueId(item: WinningHunterQueueItem): string {
  return `cheerish_${createHash("sha256").update(item.sha256.toLowerCase()).digest("hex").slice(0, 56)}`;
}

export type WinningHunterPlanRow = {
  draftId: string;
  sha256: string;
  sourceFile: string;
  productId: string;
  destinationUrl: string;
  boardId: string;
  plannedAt: string;
  scheduledAt: string;
  scheduleTimezone: "America/New_York";
  idempotencyKey: string;
  applyState: "create";
};

/** Build a write-free plan. Existing rows are supplied by a prior read/export. */
export function buildWinningHunterPlan(items: WinningHunterQueueItem[], now: Date, existing: ExistingScheduleRow[] = []): WinningHunterPlanRow[] {
  const unique = dedupeWinningHunterQueue(items).accepted;
  const slots = buildEtSlots(now, unique.length);
  return unique.map((item, index) => {
    const plannedAt = slots[index];
    return {
      draftId: stableQueueId(item), sha256: item.sha256.toLowerCase(), sourceFile: item.source_files[0] ?? "",
      productId: item.shopify_product_id, destinationUrl: item.public_url,
      boardId: mapWinningHunterBoard(item.title, item.handle), plannedAt,
      scheduledAt: toUtcIso(plannedAt), scheduleTimezone: "America/New_York",
      idempotencyKey: `winninghunter:${item.sha256.toLowerCase()}`, applyState: "create",
    };
  });
}

export type ExistingShiftPlanRow = { draftId: string; plannedAt: string; scheduledAt: string };

/** Move only smart/unlocked scheduled rows to the first slot after the new batch. */
export function buildExistingShiftPlan(existing: Array<ExistingScheduleRow & { draftId?: string }>, now: Date, newCount = 48): ExistingShiftPlanRow[] {
  const shiftable = existing.filter((row) => classifyExistingDraft(row) === "shiftable");
  if (!shiftable.length) return [];
  const slots = buildEtSlots(now, newCount + shiftable.length).slice(newCount);
  return shiftable.map((row, index) => ({
    draftId: String((row as ExistingScheduleRow & { draft_id?: string }).draft_id ?? row.draftId ?? ""), plannedAt: slots[index], scheduledAt: toUtcIso(slots[index]),
  }));
}
