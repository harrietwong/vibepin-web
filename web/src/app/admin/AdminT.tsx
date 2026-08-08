"use client";

/**
 * Tiny translation leaf — lets Server Component admin pages (which fetch data
 * server-side) render a translated string without becoming client components
 * themselves. Only wrap pure UI prose here — never database content, table
 * names, column names, IDs, or URLs.
 */

import { useAdminChrome } from "./AdminChromeProvider";
import type { AdminMessageKey } from "@/lib/admin/adminMessages";

export function AdminT({ k }: { k: AdminMessageKey }) {
  const { t } = useAdminChrome();
  return <>{t(k)}</>;
}

/** Like AdminT but interpolates `{token}` placeholders from `vars`. */
export function AdminTFmt({ k, vars }: { k: AdminMessageKey; vars: Record<string, string | number> }) {
  const { tFmt } = useAdminChrome();
  return <>{tFmt(k, vars)}</>;
}
