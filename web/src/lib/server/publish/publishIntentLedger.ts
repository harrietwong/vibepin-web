import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConfirmedPublishReceipt } from "@/lib/studio/publishConfirmation";
import type { PublishDestination } from "@/lib/contentDraftModel";

export type PublishIntentStatus = "claimed" | "published" | "failed" | "delivery_unknown";

export type PublishIntentClaim = {
  claimed: boolean;
  replayed: boolean;
  intentJobId: string;
  destinationJobId: string;
  claimToken: string | null;
  status: PublishIntentStatus;
  attempt: number;
  retryAllowed: boolean;
  providerJobId: string | null;
  remoteId: string | null;
  remoteUrl: string | null;
  providerStatus: number | null;
  evidence: Record<string, unknown>;
};

export class PublishIntentLedgerError extends Error {
  constructor(public readonly code: "unavailable" | "conflict" | "claim_lost", message: string) {
    super(message);
    this.name = "PublishIntentLedgerError";
  }
}

function ledgerError(error: { code?: string; message?: string } | null): never {
  const code = error?.code;
  if (code === "23505") throw new PublishIntentLedgerError("conflict", "The publish intent conflicts with an earlier confirmation.");
  if (code === "40001") throw new PublishIntentLedgerError("claim_lost", "The publish attempt is already being reconciled.");
  throw new PublishIntentLedgerError("unavailable", "Durable publish recovery is unavailable.");
}

export async function claimPublishIntentDestination(
  db: SupabaseClient,
  uid: string,
  receipt: ConfirmedPublishReceipt,
  destination: PublishDestination,
): Promise<PublishIntentClaim> {
  const { data, error } = await db.rpc("publish_intent_claim_destination", {
    p_user_id: uid,
    p_intent_id: receipt.intentId,
    p_fingerprint: receipt.fingerprint,
    p_draft_id: receipt.draftId,
    p_content_id: receipt.contentId,
    p_confirmed_at: receipt.confirmedAt,
    p_mode: receipt.mode,
    p_receipt: receipt,
    p_destination_id: destination.id,
    p_provider: destination.provider,
    p_connection_id: destination.socialConnectionId,
    p_subdestination_id: destination.boardId ?? null,
  });
  if (error || !data || typeof data !== "object") ledgerError(error);
  return data as PublishIntentClaim;
}

/** Atomically claim the complete fan-out; any conflict/unavailable leg rolls back all. */
export async function claimPublishIntentDestinations(
  db: SupabaseClient,
  uid: string,
  receipt: ConfirmedPublishReceipt,
  destinations: readonly PublishDestination[],
): Promise<Array<{ destination: PublishDestination; claim: PublishIntentClaim }>> {
  const ordered = [...destinations].sort((left, right) => left.id.localeCompare(right.id));
  const { data, error } = await db.rpc("publish_intent_claim_destinations", {
    p_user_id: uid,
    p_intent_id: receipt.intentId,
    p_fingerprint: receipt.fingerprint,
    p_draft_id: receipt.draftId,
    p_content_id: receipt.contentId,
    p_confirmed_at: receipt.confirmedAt,
    p_mode: receipt.mode,
    p_receipt: receipt,
    p_destinations: ordered.map(destination => ({
      id: destination.id,
      provider: destination.provider,
      socialConnectionId: destination.socialConnectionId,
      boardId: destination.boardId ?? null,
    })),
  });
  if (error || !Array.isArray(data) || data.length !== ordered.length) ledgerError(error);
  return ordered.map((destination, index) => ({
    destination,
    claim: data[index] as PublishIntentClaim,
  }));
}

export async function settlePublishIntentDestination(
  db: SupabaseClient,
  uid: string,
  input: {
    intentId: string;
    destinationId: string;
    claimToken: string;
    status: Exclude<PublishIntentStatus, "claimed">;
    retryAllowed: boolean;
    providerJobId?: string | null;
    remoteId?: string | null;
    remoteUrl?: string | null;
    providerStatus?: number | null;
    evidence?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.rpc("publish_intent_settle_destination", {
    p_user_id: uid,
    p_intent_id: input.intentId,
    p_destination_id: input.destinationId,
    p_claim_token: input.claimToken,
    p_status: input.status,
    p_retry_allowed: input.retryAllowed,
    p_provider_job_id: input.providerJobId ?? null,
    p_remote_id: input.remoteId ?? null,
    p_remote_url: input.remoteUrl ?? null,
    p_provider_status: input.providerStatus ?? null,
    p_evidence: input.evidence ?? {},
  });
  if (error) ledgerError(error);
}

export type ReconciledPublishIntent = {
  intentId: string;
  fingerprint: string;
  draftId: string;
  contentId: string;
  confirmedAt: string;
  destinations: Array<{
    destinationJobId: string;
    destinationId: string;
    provider: string;
    socialConnectionId: string;
    subdestinationId: string | null;
    status: PublishIntentStatus;
    attempt: number;
    retryAllowed: boolean;
    providerJobId: string | null;
    remoteId: string | null;
    remoteUrl: string | null;
    providerStatus: number | null;
    evidence: Record<string, unknown>;
    claimedAt: string;
    finishedAt: string | null;
  }>;
};

/** Read durable evidence by the original merchant intent; never guesses from post id. */
export async function reconcilePublishIntent(
  db: SupabaseClient,
  uid: string,
  intentId: string,
): Promise<ReconciledPublishIntent | null> {
  const { data: intent, error: intentError } = await db
    .from("publish_intents")
    .select("id,intent_id,fingerprint,draft_id,content_id,confirmed_at")
    .eq("user_id", uid)
    .eq("intent_id", intentId)
    .maybeSingle();
  if (intentError) ledgerError(intentError);
  if (!intent) return null;
  const row = intent as { id: string; intent_id: string; fingerprint: string; draft_id: string; content_id: string; confirmed_at: string };
  const { data: destinations, error: destinationsError } = await db
    .from("publish_intent_destinations")
    .select("id,destination_id,provider,social_connection_id,subdestination_id,status,attempt,retry_allowed,provider_job_id,remote_id,remote_url,provider_status,evidence,claimed_at,finished_at")
    .eq("publish_intent_id", row.id)
    .order("destination_id", { ascending: true });
  if (destinationsError) ledgerError(destinationsError);
  return {
    intentId: row.intent_id,
    fingerprint: row.fingerprint,
    draftId: row.draft_id,
    contentId: row.content_id,
    confirmedAt: row.confirmed_at,
    destinations: (destinations ?? []).map((item: Record<string, unknown>) => ({
      destinationJobId: String(item.id),
      destinationId: String(item.destination_id),
      provider: String(item.provider),
      socialConnectionId: String(item.social_connection_id),
      subdestinationId: typeof item.subdestination_id === "string" ? item.subdestination_id : null,
      status: item.status as PublishIntentStatus,
      attempt: Number(item.attempt),
      retryAllowed: item.retry_allowed === true,
      providerJobId: typeof item.provider_job_id === "string" ? item.provider_job_id : null,
      remoteId: typeof item.remote_id === "string" ? item.remote_id : null,
      remoteUrl: typeof item.remote_url === "string" ? item.remote_url : null,
      providerStatus: typeof item.provider_status === "number" ? item.provider_status : null,
      evidence: item.evidence && typeof item.evidence === "object" ? item.evidence as Record<string, unknown> : {},
      claimedAt: String(item.claimed_at),
      finishedAt: typeof item.finished_at === "string" ? item.finished_at : null,
    })),
  };
}
