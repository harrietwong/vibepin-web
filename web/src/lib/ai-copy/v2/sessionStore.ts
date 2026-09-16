/** Server-only durable claims for AI Copy v2. */
import { createServerClient } from "@/lib/supabase";
import { randomUUID } from "node:crypto";
import type { CopyResultV2, FactCardV1, KeywordEvidence, ValidationReport } from "./types";

export interface SessionRow {
  id: string;
  vibepin_user_id: string;
  workspace_id: string;
  draft_id: string;
  analyze_idempotency_key: string;
  status: "pending" | "completed" | "expired";
  claim_token: string;
  claim_expires_at: string;
  fact_card: FactCardV1 | null;
  keyword_evidence: KeywordEvidence | null;
  last_output: CopyResultV2 | null;
  validation_report: ValidationReport | null;
  model_version: string;
  prompt_version: string;
  last_generation_idempotency_key: string | null;
  generation_count: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface GenerationLedgerRow {
  id: string;
  session_id: string;
  vibepin_user_id: string;
  idempotency_key: string;
  status: "pending" | "completed";
  claim_token: string;
  claim_expires_at: string;
  angle_id: string | null;
  output: CopyResultV2 | null;
  validation_report: ValidationReport | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimSessionParams {
  userId: string;
  workspaceId: string;
  draftId: string;
  analyzeIdempotencyKey: string;
  modelVersion: string;
  promptVersion: string;
  expiresAtIso?: string;
}

export interface CompleteSessionParams {
  sessionId: string;
  userId: string;
  claimToken: string;
  factCard: FactCardV1;
  keywordEvidence: KeywordEvidence;
}

export interface ClaimGenerationParams {
  sessionId: string;
  userId: string;
  idempotencyKey: string;
  angleId?: string | null;
}

export type ClaimResult<T> =
  | { state: "claimed"; row: T }
  | { state: "pending"; row: T }
  | { state: "completed"; row: T };

export interface SessionStore {
  claimSession(params: ClaimSessionParams): Promise<ClaimResult<SessionRow>>;
  completeSession(params: CompleteSessionParams): Promise<SessionRow>;
  releaseSessionClaim(sessionId: string, userId: string, claimToken: string): Promise<void>;
  getValidSession(sessionId: string, userId: string, nowIso?: string): Promise<SessionRow | null>;
  claimGeneration(params: ClaimGenerationParams): Promise<ClaimResult<GenerationLedgerRow>>;
  completeGeneration(params: {
    generationId: string;
    sessionId: string;
    userId: string;
    claimToken: string;
    output: CopyResultV2;
    validationReport: ValidationReport;
  }): Promise<GenerationLedgerRow>;
  releaseGenerationClaim(generationId: string, sessionId: string, userId: string, claimToken: string): Promise<void>;
}

const expiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const claimExpiry = () => new Date(Date.now() + 2 * 60 * 1000).toISOString();

function stateFor<T extends { status: "pending" | "completed" }>(row: T): ClaimResult<T> {
  return row.status === "completed"
    ? { state: "completed", row }
    : { state: "pending", row };
}

function supabaseSessionStore(): SessionStore {
  const db = () => createServerClient();
  const findSession = async (userId: string, key: string): Promise<SessionRow | null> => {
    const { data, error } = await db().from("ai_copy_v2_sessions").select("*")
      .eq("vibepin_user_id", userId).eq("analyze_idempotency_key", key).maybeSingle();
    if (error) throw new Error("session_read_failed");
    return (data as SessionRow | null) ?? null;
  };
  const findGeneration = async (sessionId: string, userId: string, key: string): Promise<GenerationLedgerRow | null> => {
    const { data, error } = await db().from("ai_copy_v2_generations").select("*")
      .eq("session_id", sessionId).eq("vibepin_user_id", userId)
      .eq("idempotency_key", key).maybeSingle();
    if (error) throw new Error("generation_read_failed");
    return (data as GenerationLedgerRow | null) ?? null;
  };

  return {
    async claimSession(params) {
      const now = new Date().toISOString();
      const claimToken = randomUUID();
      const { data, error } = await db().from("ai_copy_v2_sessions").insert({
        vibepin_user_id: params.userId,
        workspace_id: params.workspaceId,
        draft_id: params.draftId,
        analyze_idempotency_key: params.analyzeIdempotencyKey,
        status: "pending",
        claim_token: claimToken,
        claim_expires_at: claimExpiry(),
        model_version: params.modelVersion,
        prompt_version: params.promptVersion,
        expires_at: params.expiresAtIso ?? expiry(),
        created_at: now,
        updated_at: now,
      }).select("*").single();
      if (!error && data) return { state: "claimed", row: data as SessionRow };
      if (error?.code === "23505") {
        const { data: stolen, error: stealError } = await db().from("ai_copy_v2_sessions").update({
          claim_token: claimToken,
          claim_expires_at: claimExpiry(),
          updated_at: now,
        }).eq("vibepin_user_id", params.userId)
          .eq("analyze_idempotency_key", params.analyzeIdempotencyKey)
          .eq("status", "pending").lt("claim_expires_at", now)
          .select("*").maybeSingle();
        if (stealError) throw new Error("session_claim_failed");
        if (stolen) return { state: "claimed", row: stolen as SessionRow };
        const existing = await findSession(params.userId, params.analyzeIdempotencyKey);
        if (existing) return existing.status === "completed"
          ? { state: "completed", row: existing }
          : { state: "pending", row: existing };
      }
      throw new Error("session_claim_failed");
    },

    async completeSession(params) {
      const { data, error } = await db().from("ai_copy_v2_sessions").update({
        status: "completed",
        fact_card: params.factCard,
        keyword_evidence: params.keywordEvidence,
        updated_at: new Date().toISOString(),
      }).eq("id", params.sessionId).eq("vibepin_user_id", params.userId)
        .eq("status", "pending").eq("claim_token", params.claimToken).select("*").single();
      if (error || !data) throw new Error("session_finalize_failed");
      return data as SessionRow;
    },

    async releaseSessionClaim(sessionId, userId, claimToken) {
      const { error } = await db().from("ai_copy_v2_sessions").delete()
        .eq("id", sessionId).eq("vibepin_user_id", userId).eq("status", "pending").eq("claim_token", claimToken);
      if (error) throw new Error("session_release_failed");
    },

    async getValidSession(sessionId, userId, nowIso = new Date().toISOString()) {
      const { data, error } = await db().from("ai_copy_v2_sessions").select("*")
        .eq("id", sessionId).eq("vibepin_user_id", userId)
        .eq("status", "completed").gt("expires_at", nowIso).maybeSingle();
      if (error) throw new Error("session_get_valid_failed");
      return (data as SessionRow | null) ?? null;
    },

    async claimGeneration(params) {
      const now = new Date().toISOString();
      const claimToken = randomUUID();
      const { data, error } = await db().from("ai_copy_v2_generations").insert({
        session_id: params.sessionId,
        vibepin_user_id: params.userId,
        idempotency_key: params.idempotencyKey,
        status: "pending",
        claim_token: claimToken,
        claim_expires_at: claimExpiry(),
        angle_id: params.angleId ?? null,
        created_at: now,
        updated_at: now,
      }).select("*").single();
      if (!error && data) return { state: "claimed", row: data as GenerationLedgerRow };
      if (error?.code === "23505") {
        const { data: stolen, error: stealError } = await db().from("ai_copy_v2_generations").update({
          claim_token: claimToken,
          claim_expires_at: claimExpiry(),
          angle_id: params.angleId ?? null,
          output: null,
          validation_report: null,
          updated_at: now,
        }).eq("session_id", params.sessionId).eq("vibepin_user_id", params.userId)
          .eq("idempotency_key", params.idempotencyKey).eq("status", "pending")
          .lt("claim_expires_at", now).select("*").maybeSingle();
        if (stealError) throw new Error("generation_claim_failed");
        if (stolen) return { state: "claimed", row: stolen as GenerationLedgerRow };
        const existing = await findGeneration(params.sessionId, params.userId, params.idempotencyKey);
        if (existing) return stateFor(existing);
      }
      throw new Error("generation_claim_failed");
    },

    async completeGeneration(params) {
      const { data, error } = await db().rpc("complete_ai_copy_v2_generation", {
        p_generation_id: params.generationId,
        p_session_id: params.sessionId,
        p_user_id: params.userId,
        p_claim_token: params.claimToken,
        p_output: params.output,
        p_validation_report: params.validationReport,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) throw new Error("generation_finalize_failed");
      return row as GenerationLedgerRow;
    },

    async releaseGenerationClaim(generationId, sessionId, userId, claimToken) {
      const { error } = await db().from("ai_copy_v2_generations").delete()
        .eq("id", generationId).eq("session_id", sessionId)
        .eq("vibepin_user_id", userId).eq("status", "pending").eq("claim_token", claimToken);
      if (error) throw new Error("generation_release_failed");
    },
  };
}

let override: SessionStore | null = null;
export function __setSessionStoreForTests(store: SessionStore | null): void { override = store; }
export function getSessionStore(): SessionStore { return override ?? supabaseSessionStore(); }
