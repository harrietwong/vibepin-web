/**
 * Notification preferences — local per-user prefs (localStorage).
 *
 * Only the in-app channel is a real, consumable preference today. Email delivery
 * is NOT implemented, so the UI surfaces email as "Coming soon" and never stores
 * a working email toggle here. These flags are read by in-app surfaces that
 * decide whether to show a given notification type.
 */

export type NotificationKey =
  | "publishSuccess"
  | "publishFailed"
  | "needsDetails"
  | "lowTokenBalance"
  | "weeklySummary"
  | "productOpportunity";

export type NotificationPrefs = Record<NotificationKey, boolean> & { updatedAt?: string };

const STORE_KEY = "vp:notification_prefs:v1";
export const NOTIFICATION_PREFS_EVENT = "vp:notification_prefs_updated";

export const NOTIFICATION_KEYS: NotificationKey[] = [
  "publishFailed",
  "publishSuccess",
  "needsDetails",
  "lowTokenBalance",
  "weeklySummary",
  "productOpportunity",
];

/** Safe defaults — do not spam users by default. */
export function defaultNotificationPrefs(): NotificationPrefs {
  return {
    publishFailed: true,
    publishSuccess: false,
    needsDetails: true,
    lowTokenBalance: true,
    weeklySummary: false,
    productOpportunity: false,
  };
}

function ok(): boolean {
  return typeof window !== "undefined";
}

function emit(): void {
  if (ok()) window.dispatchEvent(new Event(NOTIFICATION_PREFS_EVENT));
}

export function getNotificationPrefs(): NotificationPrefs {
  const base = defaultNotificationPrefs();
  if (!ok()) return base;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    const merged = { ...base };
    for (const key of NOTIFICATION_KEYS) {
      if (typeof parsed[key] === "boolean") merged[key] = parsed[key] as boolean;
    }
    merged.updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
    return merged;
  } catch {
    return base;
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): NotificationPrefs {
  const payload: NotificationPrefs = { ...prefs, updatedAt: new Date().toISOString() };
  if (ok()) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch { /* quota — skip */ }
    emit();
  }
  return payload;
}
