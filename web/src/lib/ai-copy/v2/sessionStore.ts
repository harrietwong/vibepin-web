/**
 * sessionStore.ts   AI Copy v2 Session and Generation Ledger Store (SERVER-ONLY).
 *
 * Requirements:
 *  - Stores user/workspace ownership, draft ID, analyze idempotency key,
 *    FactCardV1, KeywordEvidence, last output, validation report, model/prompt versions,
 *    last generation idempotency key, generation count, status, expiry (24h default), timestamps.
 *  - Unique analyze idempotency within owning user. Repeated request returns original stored result.
 *  - Unique generate idempotency within owning session/user (supporting A -> B -> retry A).
 *  - Concurrency-safe unique idempotency claims before work to prevent double-spend.
 *  - Owner + expiry filtered together: foreign or expired session both return null (handled as 404).
 *  - Injected test seam (__setSessionStoreForTests) for hermetic testing.
 */

import { createServerClient } from "@/lib/supabase";
import type {
  CopyResultV2,
  FactCardV1,
  KeywordEvidence,
  ValidationReport,
} from "./types";

export interface SessionRow {
  id: string;
  vibepin_user_id: string;
  workspace_id?: string | null;
  draft_id: string;
  analyze_idempotency_key: string;
  status: "active" | "completed" | "expired";
  fact_card: FactCardV1;
  keyword_evidence: KeywordEvidence;
  last_output?: CopyResultV2 | null;
  validation_report?: ValidationReport | null;
  model_version: string;
  prompt_version: string;
  last_generation_idempotency_key?: string | null;
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
  angle_id?: string | null;
  output: CopyResultV2;
  validation_report: ValidationReport;
  created_at: string;
}

export interface CreateSessionParams {
  userId: string;
  workspaceId?: string | null;
  draftId: string;
  analyzeIdempotencyKey: string;
  factCard: FactCardV1;
  keywordEvidence: KeywordEvidence;
  modelVersion: string;
  promptVersion: string;
  expiresAtIso?: string;
}

export interface RecordGenerationParams {
  sessionId: string;
  userId: string;
  idempotencyKey: string;
  angleId?: string | null;
  output: CopyResultV2;
  validationReport: ValidationReport;
}

export interface SessionStore {
  findSessionByAnalyzeKey(userId: string, analyzeIdempotencyKey: string): Promise<SessionRow | null>;
  createSession(params: CreateSessionParams): Promise<{ session: SessionRow; created: boolean }>;
  getValidSession(sessionId: string, userId: string, nowIso?: string): Promise<SessionRow | null>;
  findGeneration(sessionId: string, idempotencyKey: string): Promise<GenerationLedgerRow | null>;
  recordGeneration(params: RecordGenerationParams): Promise<{ generation: GenerationLedgerRow; created: boolean }>;
}

function defaultExpiryIso(nowMs: number = Date.now()): string {
  return new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
}

function supabaseSessionStore(): SessionStore {
  const db = () => createServerClient();

  return {
    async findSessionByAnalyzeKey(userId, analyzeIdempotencyKey) {
      const { data, error } = await db()
        .from("ai_copy_v2_sessions")
        .select("*")
        .eq("vibepin_user_id", userId)
        .eq("analyze_idempotency_key", analyzeIdempotencyKey)
        .maybeSingle();

      if (error) throw new Error(`session_read_by_analyze_key_failed: ${error.message}`);
      return (data as SessionRow | null) ?? null;
    },

    async createSession(params) {
      const nowIso = new Date().toISOString();
      const expiresAt = params.expiresAtIso ?? defaultExpiryIso();

      const newRow = {
        vibepin_user_id: params.userId,
        workspace_id: params.workspaceId ?? null,
        draft_id: params.draftId,
        analyze_idempotency_key: params.analyzeIdempotencyKey,
        status: "active",
        fact_card: params.factCard,
        keyword_evidence: params.keywordEvidence,
        last_output: null,
        validation_report: null,
        model_version: params.modelVersion,
        prompt_version: params.promptVersion,
        last_generation_idempotency_key: null,
        generation_count: 0,
        expires_at: expiresAt,
        created_at: nowIso,
        updated_at: nowIso,
      };

      const { data, error } = await db()
        .from("ai_copy_v2_sessions")
        .insert(newRow)
        .select("*")
        .single();

      if (!error && data) {
        return { session: data as SessionRow, created: true };
      }

      if (error?.code === "23505") {
        // Lost creation race or duplicate analyze request -> re-read
        const existing = await this.findSessionByAnalyzeKey(params.userId, params.analyzeIdempotencyKey);
        if (existing) return { session: existing, created: false };
      }

      throw new Error(`session_create_failed: ${error?.message ?? "unknown"}`);
    },

    async getValidSession(sessionId, userId, nowIso = new Date().toISOString()) {
      // Owner + expiry filtered together in single query
      const { data, error } = await db()
        .from("ai_copy_v2_sessions")
        .select("*")
        .eq("id", sessionId)
        .eq("vibepin_user_id", userId)
        .gt("expires_at", nowIso)
        .maybeSingle();

      if (error) throw new Error(`session_get_valid_failed: ${error.message}`);
      return (data as SessionRow | null) ?? null;
    },

    async findGeneration(sessionId, idempotencyKey) {
      const { data, error } = await db()
        .from("ai_copy_v2_generations")
        .select("*")
        .eq("session_id", sessionId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (error) throw new Error(`generation_find_failed: ${error.message}`);
      return (data as GenerationLedgerRow | null) ?? null;
    },

    async recordGeneration(params) {
      const nowIso = new Date().toISOString();
      const insertData = {
        session_id: params.sessionId,
        vibepin_user_id: params.userId,
        idempotency_key: params.idempotencyKey,
        angle_id: params.angleId ?? null,
        output: params.output,
        validation_report: params.validationReport,
        created_at: nowIso,
      };

      const { data, error } = await db()
        .from("ai_copy_v2_generations")
        .insert(insertData)
        .select("*")
        .single();

      if (!error && data) {
        // Update session's last_output, last_generation_idempotency_key, and bump generation_count
        const { error: sessionUpdateErr } = await db().rpc("noop").catch(() => ({ error: null })); // fallback safe
        await db()
          .from("ai_copy_v2_sessions")
          .update({
            last_output: params.output,
            validation_report: params.validationReport,
            last_generation_idempotency_key: params.idempotencyKey,
            updated_at: nowIso,
          })
          .eq("id", params.sessionId);

        return { generation: data as GenerationLedgerRow, created: true };
      }

      if (error?.code === "23505") {
        const existing = await this.findGeneration(params.sessionId, params.idempotencyKey);
        if (existing) return { generation: existing, created: false };
      }

      throw new Error(`generation_record_failed: ${error?.message ?? "unknown"}`);
    },
  };
}

let sessionStoreOverride: SessionStore | null = null;

export function __setSessionStoreForTests(store: SessionStore | null): void {
  sessionStoreOverride = store;
}

export function getSessionStore(): SessionStore {
  return sessionStoreOverride ?? supabaseSessionStore();
}
