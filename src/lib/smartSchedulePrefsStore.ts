/**
 * User preferences for Smart Schedule generation — localStorage.
 * Controls which days and time windows to use when generating posting slots.
 * Actual generated slots are stored separately in smartScheduleStore (weeklySlots).
 */

export type TimeWindow = "morning" | "afternoon" | "evening";

export type SmartSchedulePrefs = {
  weeklyGoal: number;         // 1–14, default 7
  preferredDays: number[];    // 0=Mon … 6=Sun subset, default Mon–Fri
  preferredWindows: TimeWindow[]; // default ["morning", "afternoon"]
};

const STORE_KEY = "vp:smart_schedule_prefs:v1";

export function defaultSmartSchedulePrefs(): SmartSchedulePrefs {
  return {
    weeklyGoal: 7,
    preferredDays: [0, 1, 2, 3, 4],
    preferredWindows: ["morning", "afternoon"],
  };
}

// Natural-looking seed times per day index × window
const TIME_SEEDS: Record<number, Record<TimeWindow, string>> = {
  0: { morning: "09:15", afternoon: "15:04", evening: "20:30" },
  1: { morning: "09:30", afternoon: "15:45", evening: "21:00" },
  2: { morning: "09:00", afternoon: "14:20", evening: "20:45" },
  3: { morning: "09:45", afternoon: "15:00", evening: "21:15" },
  4: { morning: "09:15", afternoon: "15:00", evening: "20:30" },
  5: { morning: "10:00", afternoon: "14:00", evening: "19:30" },
  6: { morning: "10:30", afternoon: "13:30", evening: "18:45" },
};

export function generateSmartScheduleSlots(
  prefs: SmartSchedulePrefs,
): Partial<Record<number, string[]>> {
  const days = prefs.preferredDays.length ? [...prefs.preferredDays].sort() : [0, 1, 2, 3, 4, 5, 6];
  const windows: TimeWindow[] = prefs.preferredWindows.length
    ? prefs.preferredWindows
    : ["morning", "afternoon"];

  // Pool: for each window, iterate days — so slots spread across days first
  const pool: { day: number; time: string }[] = [];
  for (const win of windows) {
    for (const day of days) {
      const time = TIME_SEEDS[day]?.[win];
      if (time) pool.push({ day, time });
    }
  }

  // Take up to weeklyGoal unique (day, time) pairs
  const selected = pool.slice(0, prefs.weeklyGoal);

  const result: Partial<Record<number, string[]>> = {};
  for (const { day, time } of selected) {
    if (!result[day]) result[day] = [];
    if (!result[day]!.includes(time)) result[day]!.push(time);
  }
  for (const key of Object.keys(result)) {
    (result as Record<number, string[]>)[Number(key)].sort();
  }

  return result;
}

function ok(): boolean { return typeof window !== "undefined"; }

export function getSmartSchedulePrefs(): SmartSchedulePrefs {
  if (!ok()) return defaultSmartSchedulePrefs();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultSmartSchedulePrefs();
    const p = JSON.parse(raw) as Partial<SmartSchedulePrefs>;
    const d = defaultSmartSchedulePrefs();
    return {
      weeklyGoal:      typeof p.weeklyGoal === "number" ? Math.min(14, Math.max(1, p.weeklyGoal)) : d.weeklyGoal,
      preferredDays:   Array.isArray(p.preferredDays)    ? p.preferredDays.filter(n => n >= 0 && n <= 6)                                         : d.preferredDays,
      preferredWindows: Array.isArray(p.preferredWindows) ? p.preferredWindows.filter(w => ["morning","afternoon","evening"].includes(w as string)) : d.preferredWindows,
    };
  } catch {
    return defaultSmartSchedulePrefs();
  }
}

export function saveSmartSchedulePrefs(prefs: SmartSchedulePrefs): void {
  if (!ok()) return;
  localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
}
