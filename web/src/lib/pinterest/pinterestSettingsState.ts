/**
 * Maps real /api/pinterest/status data to the three Pinterest Settings UI states.
 * Does not invent permissions — uses granted scopes only.
 */

import type { PinterestStatus } from "@/lib/pinterestClient";
import { formatEnglishDateTime } from "@/lib/dateTimeFormat";

export type PinterestSettingsVisualState = "not_connected" | "connected" | "limited_access";

const PUBLISH_SCOPES = ["pins:write"] as const;
const BOARD_SCOPES = ["boards:read", "boards:write"] as const;

function hasAnyScope(scopes: string[], candidates: readonly string[]): boolean {
  const set = new Set(scopes);
  return candidates.some(s => set.has(s));
}

export function derivePinterestSettingsState(
  status: PinterestStatus | null,
  opts?: { serverError?: boolean },
): PinterestSettingsVisualState {
  if (opts?.serverError || !status?.connected) return "not_connected";

  // Only a real DB-backed user connection is "connected" in the normal Settings UI.
  // A sandbox token (connectionSource "sandbox_demo") unblocks publishing but is
  // provider config, not a user connection — so it must never render as connected
  // here (it surfaces in Developer tools instead). Older/production responses omit
  // connectionSource, so we fall back to the plain `connected` flag when it's absent.
  if (status.connectionSource && status.connectionSource !== "db") return "not_connected";

  const scopes = status.scopes ?? [];
  const canPublish = hasAnyScope(scopes, PUBLISH_SCOPES);

  // Connected token but missing publish scopes → Limited Access (trial / partial grant).
  if (!canPublish) return "limited_access";

  // Flagged reconnect with no usable publish permission.
  if (status.needsReconnect) return "limited_access";

  return "connected";
}

export type PermissionRow = {
  label: string;
  value: string;
  tone: "success" | "warning" | "muted";
};

export function buildPermissionRows(
  state: PinterestSettingsVisualState,
  status: PinterestStatus | null,
  lastSyncedLabel: string | null,
): PermissionRow[] {
  const scopes = status?.scopes ?? [];
  const canReadBoards = hasAnyScope(scopes, BOARD_SCOPES);
  const canPublish = hasAnyScope(scopes, PUBLISH_SCOPES);

  if (state === "not_connected") return [];

  if (state === "limited_access") {
    return [
      { label: "Boards", value: canReadBoards ? "Available" : "Unknown", tone: canReadBoards ? "success" : "muted" },
      { label: "Publishing", value: "Limited", tone: "warning" },
      { label: "Analytics", value: "Limited", tone: "warning" },
      ...(lastSyncedLabel ? [{ label: "Last synced", value: lastSyncedLabel, tone: "success" as const }] : []),
    ];
  }

  return [
    { label: "Boards", value: canReadBoards ? "Read" : "Unknown", tone: canReadBoards ? "success" : "muted" },
    { label: "Pins", value: canPublish ? "Read & Publish" : "Read only", tone: canPublish ? "success" : "warning" },
    ...(lastSyncedLabel ? [{ label: "Last synced", value: lastSyncedLabel, tone: "success" as const }] : []),
  ];
}

export function formatSyncedAt(iso: string | null | undefined): string | null {
  return iso ? formatEnglishDateTime(iso) : null;
}
