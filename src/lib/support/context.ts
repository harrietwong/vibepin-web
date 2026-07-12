/**
 * buildSupportContext — the single place that assembles ticket context.
 *
 * Runs server-side (inside POST /api/support/tickets) so redaction is
 * authoritative regardless of what the client sends. Every entry point
 * (Help & Support form, publish-failed CTA, AI-generation-failed CTA,
 * Pinterest-connection CTA, billing CTA) funnels through this one function
 * instead of hand-building its own context object.
 */

import { redactContext } from "./redact";
import type { SupportSource } from "./types";

type LooseUser = {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

export type BuildSupportContextInput = {
  source: SupportSource;
  user: LooseUser;
  workspaceId?: string | null;
  pageUrl?: string | null;
  browser?: string | null;
  os?: string | null;
  timezone?: string | null;
  // Raw, source-specific fields gathered by the caller (client hook or
  // server-side entry point). Only the allowlisted keys for `source` are
  // read out of this bag — anything else is dropped, then everything that
  // survives is run through redactContext as defense in depth.
  extra?: Record<string, unknown>;
};

export type BuiltSupportContext = {
  context: Record<string, unknown>;
  // Human-readable checkmark lines for the UI. Never raw JSON, never tokens.
  summary: string[];
};

export function pickSourceFields(source: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

export const SOURCE_FIELDS: Record<SupportSource, string[]> = {
  help_center: [],
  publish_failed: [
    "draftId", "publishJobId", "boardId", "boardName", "imageUrlExists", "destinationUrlExists",
    "publishErrorCode", "publishErrorMessage", "retryCount", "pinterestConnectionStatus",
  ],
  ai_generation: [
    "draftId", "generationRequestId", "provider", "model", "prompt", "creditsBefore", "creditsAfter",
    "creditsCharged", "generationStatus", "providerError", "resultCount",
  ],
  pinterest_connection: [
    "connectedAccountId", "pinterestUserId", "connectionStatus", "tokenExpired",
    "lastConnectedAt", "lastBoardSyncAt", "boardFetchError",
  ],
  billing: ["stripeCustomerId", "subscriptionId", "plan", "paymentStatus", "latestInvoiceId", "billingPageUrl"],
  other: [],
};

function deriveAccountMetadata(user: LooseUser) {
  const metadata = { ...(user.app_metadata ?? {}), ...(user.user_metadata ?? {}) };
  const plan =
    (typeof metadata.plan_name === "string" && metadata.plan_name) ||
    (typeof metadata.planName === "string" && metadata.planName) ||
    (typeof metadata.plan === "string" && metadata.plan) ||
    null;
  const accountStatus =
    (typeof metadata.subscription_status === "string" && metadata.subscription_status) ||
    (typeof metadata.subscriptionStatus === "string" && metadata.subscriptionStatus) ||
    null;
  return { plan, accountStatus };
}

export function buildSupportContext(input: BuildSupportContextInput): BuiltSupportContext {
  const { plan, accountStatus } = deriveAccountMetadata(input.user);

  const common: Record<string, unknown> = {
    userId: input.user.id,
    email: input.user.email ?? null,
    workspaceId: input.workspaceId ?? null,
    plan,
    accountStatus,
    pageUrl: input.pageUrl ?? null,
    browser: input.browser ?? null,
    os: input.os ?? null,
    timezone: input.timezone ?? null,
    accountCreatedAt: input.user.created_at ?? null,
  };

  const sourceFields = pickSourceFields(input.extra, SOURCE_FIELDS[input.source] ?? []);
  const context = redactContext({ ...common, ...sourceFields });

  const summary = summarizeContext({
    source: input.source,
    hasPageUrl: !!input.pageUrl,
    hasBrowser: !!(input.browser || input.os),
    sourceFields,
  });

  return { context, summary };
}

/**
 * Pure "what did we attach" summary — no secrets ever pass through here (just
 * presence checks), so it's safe to reuse client-side too (SupportContextSummary
 * renders a preview of this before the user submits, using the same rules).
 */
export function summarizeContext(args: {
  source: SupportSource;
  hasPageUrl: boolean;
  hasBrowser: boolean;
  sourceFields: Record<string, unknown>;
}): string[] {
  const { source, hasPageUrl, hasBrowser, sourceFields } = args;
  const summary: string[] = ["Account details attached"];
  if (hasPageUrl) summary.push("Current page attached");
  if (hasBrowser) summary.push("Browser details attached");

  if (source === "publish_failed") {
    summary.push("Publish log attached");
    if (sourceFields.pinterestConnectionStatus) summary.push("Pinterest connection status attached");
  } else if (source === "ai_generation") {
    if (sourceFields.generationRequestId) summary.push("Generation request attached");
    if (sourceFields.creditsBefore !== undefined || sourceFields.creditsAfter !== undefined) {
      summary.push("Credits transaction attached");
    }
    if (sourceFields.providerError) summary.push("Provider error attached");
  } else if (source === "pinterest_connection") {
    summary.push("Pinterest connection status attached");
  } else if (source === "billing") {
    summary.push("Billing details attached");
  }
  return summary;
}
