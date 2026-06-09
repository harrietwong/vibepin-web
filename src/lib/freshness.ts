export type ApiListMeta = {
  lastUpdatedAt: string | null;
  source: string;
  itemCount: number;
};

export const STALE_DATA_HOURS = 48;

export function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

export function formatUpdatedAgo(iso: string | null | undefined): string | null {
  const hours = hoursSince(iso);
  if (hours === null) return null;
  if (hours < 1) return "Updated just now";
  if (hours < 24) {
    const h = Math.round(hours);
    return `Updated ${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hours / 24);
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
}

export function isDataStale(iso: string | null | undefined, thresholdHours = STALE_DATA_HOURS): boolean {
  const hours = hoursSince(iso);
  if (hours === null) return false;
  return hours > thresholdHours;
}
