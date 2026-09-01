import { redirect } from "next/navigation";
import { SETTINGS_SOCIAL_PATH } from "@/lib/settingsPaths";

/**
 * Legacy Pinterest settings route — Pinterest lives in Social accounts now (PRD §2).
 *
 * Kept as a redirect rather than deleted: bookmarks, and any Pinterest OAuth return
 * URL captured before this change, still point here. The `?pinterest=<status>` query
 * an OAuth return carries is forwarded so the Social accounts panel consumes it
 * (toast + URL cleanup) exactly as it would on a fresh connect — a returning user
 * must never land on a 404 or silently lose the outcome of their authorization.
 */
export default async function LegacyPinterestSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value.length > 0) query.set(key, value[0]);
  }
  const search = query.toString();
  redirect(search ? `${SETTINGS_SOCIAL_PATH}?${search}` : SETTINGS_SOCIAL_PATH);
}
