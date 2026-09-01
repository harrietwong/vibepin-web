/**
 * Canonical connection/capability model consumed by Settings, destination pickers,
 * validation routes and publish/schedule execution.
 *
 * Client safe: no secrets, DB access or Node APIs.  A caller must supply the exact
 * owner-scoped connection it resolved; this module never chooses an account, Board
 * or Page on the caller's behalf.
 */

import { accountUiState, missingRequiredPinterestScopes, type AccountUiState } from "./accountUiState";
import { canSchedule, PLATFORMS, VISIBLE_SOCIAL_PROVIDERS, type SocialProvider } from "./platforms";
import type { SocialConnection } from "./types";

export type DestinationDisabledReason =
  | "not_connected"
  | "needs_reconnect"
  | "permission_missing"
  | "account_expired"
  | "media_required"
  | "subdestination_required"
  | "schedule_unsupported"
  | "unsupported_provider"
  | "owner_mismatch";

export type PublishMode = "now" | "scheduled";

export type CanonicalCapability = {
  provider: SocialProvider;
  connectionId: string | null;
  providerAccountId: string | null;
  displayIdentity: string | null;
  state: AccountUiState | "not_connected";
  selectable: boolean;
  publishNow: boolean;
  schedule: boolean;
  requiresMedia: boolean;
  requiresSubdestination: boolean;
  unavailableReason: DestinationDisabledReason | null;
};

export type CapabilityInput = {
  provider: SocialProvider;
  /** Exact owner-scoped connection. Undefined/null means no account was selected. */
  connection?: SocialConnection | null;
  /** Exact id the user selected. It must match `connection.id`. */
  connectionId?: string | null;
  mode?: PublishMode;
  mediaCount?: number;
  /** Pinterest Board id (and future provider subdestinations). */
  subdestinationId?: string | null;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function connectionDisplayIdentity(connection: SocialConnection): string | null {
  return clean(connection.providerAccountUsername)
    || clean(connection.providerAccountName)
    || clean(connection.providerAccountId)
    || null;
}

export type ConnectionStateSource = Pick<SocialConnection, "provider" | "connectionStatus" | "scopes">;

export function connectionState(connection: ConnectionStateSource): AccountUiState {
  return accountUiState({
    connectionStatus: connection.connectionStatus,
    scopes: connection.scopes,
    enforcePinterestScopes: connection.provider === "pinterest",
  });
}

function blocked(
  input: CapabilityInput,
  reason: DestinationDisabledReason,
  state: CanonicalCapability["state"],
): CanonicalCapability {
  return {
    provider: input.provider,
    connectionId: input.connection?.id ?? null,
    providerAccountId: input.connection?.providerAccountId ?? null,
    displayIdentity: input.connection ? connectionDisplayIdentity(input.connection) : null,
    state,
    selectable: false,
    publishNow: false,
    schedule: false,
    requiresMedia: true,
    requiresSubdestination: input.provider === "pinterest",
    unavailableReason: reason,
  };
}

/** Resolve one exact connection. No account/Board/Page defaulting is permitted. */
export function resolveDestinationCapability(input: CapabilityInput): CanonicalCapability {
  if (!(VISIBLE_SOCIAL_PROVIDERS as readonly string[]).includes(input.provider)
      || !PLATFORMS[input.provider].liveConnect) {
    return blocked(input, "unsupported_provider", "not_connected");
  }

  const requestedId = clean(input.connectionId);
  const connection = input.connection ?? null;
  if (!requestedId || !connection) return blocked(input, "not_connected", "not_connected");
  if (connection.id !== requestedId || connection.provider !== input.provider) {
    return blocked(input, "owner_mismatch", connection ? connectionState(connection) : "not_connected");
  }

  const state = connectionState(connection);
  if (connection.connectionStatus === "expired") return blocked(input, "account_expired", state);
  if (state === "needs_reconnect") {
    const reason = input.provider === "pinterest" && missingRequiredPinterestScopes(connection.scopes).length
      ? "permission_missing"
      : "needs_reconnect";
    return blocked(input, reason, state);
  }
  if (state !== "connected") return blocked(input, "not_connected", state);

  if ((input.mediaCount ?? 1) < 1) return blocked(input, "media_required", state);
  if (input.provider === "pinterest" && !clean(input.subdestinationId)) {
    return blocked(input, "subdestination_required", state);
  }
  if (input.mode === "scheduled" && !canSchedule(input.provider)) {
    return blocked(input, "schedule_unsupported", state);
  }

  return {
    provider: input.provider,
    connectionId: connection.id,
    providerAccountId: connection.providerAccountId,
    displayIdentity: connectionDisplayIdentity(connection),
    state,
    selectable: true,
    publishNow: true,
    schedule: canSchedule(input.provider),
    requiresMedia: true,
    requiresSubdestination: input.provider === "pinterest",
    unavailableReason: null,
  };
}

/**
 * A platform row may turn a click into an exact account selection only when there is
 * exactly one usable account. This is UI resolution at the moment of explicit user
 * choice, never a dispatch-time fallback.
 */
export function soleConnectedAccount(
  accounts: readonly SocialConnection[],
): SocialConnection | null {
  const usable = accounts.filter(account => connectionState(account) === "connected");
  return usable.length === 1 ? usable[0] : null;
}

export type PublishSchedule = {
  publishMode: PublishMode;
  scheduledAt: string | null;
  timezone: string | null;
};

/**
 * Optional scheduling normalizer. Switching to Publish now or closing a fresh
 * schedule editor removes hidden stale time; scheduled mode requires both an
 * absolute/parseable time and an IANA timezone supplied by the caller.
 */
export function normalizePublishSchedule(input: {
  publishMode?: PublishMode | null;
  scheduledAt?: string | null;
  timezone?: string | null;
}): PublishSchedule {
  if (input.publishMode !== "scheduled") {
    return { publishMode: "now", scheduledAt: null, timezone: null };
  }
  const scheduledAt = clean(input.scheduledAt);
  const timezone = clean(input.timezone);
  if (!scheduledAt || !timezone || Number.isNaN(Date.parse(scheduledAt))) {
    throw new Error("scheduled_time_required");
  }
  return { publishMode: "scheduled", scheduledAt, timezone };
}
