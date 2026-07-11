export function formatEnglishDateTime(value: string | number | Date, timeZone?: string): string | null {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return null;
  }
}

export function browserTimeZone(): string {
  if (typeof Intl === "undefined") return "Unknown";
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
}
