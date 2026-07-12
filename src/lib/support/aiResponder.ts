/**
 * aiResponder.ts — AI First Responder for support tickets (server-only).
 *
 * Posts an AI-generated first reply on a newly created ticket, grounded
 * ONLY in the static Help Center articles (helpArticles.ts) plus the
 * ticket's own subject/description/context fields. A human agent still
 * reviews every ticket — this is a first-touch reply, not a replacement.
 *
 * Failure posture: this must NEVER break ticket creation. Every failure
 * mode (missing key, network error, non-2xx, unparseable JSON, timeout)
 * resolves to `null`, which the caller silently skips. Nothing here throws.
 *
 * Self-contained rather than reusing web/src/lib/ai-copy/visionServer.ts —
 * that module is a different product surface (image-grounded Pin copy) with
 * its own timeout/retry conventions; support replies need a hard, simple
 * 10s cap and no image handling.
 */

import { HELP_ARTICLES } from "./helpArticles";
import { SUPPORT_CATEGORY_LABELS, type SupportCategory } from "./types";

const TIMEOUT_MS = 10_000;

export type AiResponderInput = {
  category: SupportCategory;
  subject: string | null;
  description: string;
  context: Record<string, unknown> | null;
};

export type AiResponderOutput = { canAnswer: boolean; reply: string };

// Non-PII, diagnostic-relevant context keys the model may see. Deliberately
// excludes userId/email/workspaceId/pageUrl/browser/os/timezone/accountCreatedAt
// and anything else buildSupportContext (context.ts) may attach — only the
// fields that are actually useful for grounding a support answer make it in.
const SAFE_CONTEXT_KEYS = [
  "plan",
  "accountStatus",
  "pinterestConnectionStatus",
  "connectionStatus",
  "tokenExpired",
  "boardFetchError",
  "boardName",
  "publishErrorCode",
  "publishErrorMessage",
  "retryCount",
  "generationStatus",
  "providerError",
  "creditsCharged",
  "paymentStatus",
] as const;

/** Shared by every support-LLM prompt (aiResponder, admin summary, admin
 * suggest-reply): the ONLY ticket-context fields allowed into a prompt. */
export function safeContextSubset(context: Record<string, unknown> | null): Record<string, unknown> {
  if (!context) return {};
  const out: Record<string, unknown> = {};
  for (const key of SAFE_CONTEXT_KEYS) {
    const v = context[key];
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  }
  return out;
}

const SYSTEM_PROMPT = `You are VibePin's support assistant. You are about to post the FIRST reply on a newly created support ticket — a human support agent will also review this ticket afterward, so you are not the only line of defense.

You may ONLY use facts that appear in the "Help articles" JSON provided in the user message, plus the ticket's own subject/description/context fields. Do not use any other knowledge of VibePin, Pinterest, or any product. If the help articles do not clearly cover the user's issue, or you are not confident your answer is correct and safe, set "canAnswer" to false and leave "reply" empty.

NEVER invent product behavior, policies, refund terms, timelines, or compensation. NEVER promise a refund, credit, or any other compensation, even if the user asks for one.

If the ticket is about a refund, a duplicate or unexpected charge, or credits that were charged without a result: do NOT attempt to solve or explain it. You may only reply with a short, generic acknowledgment that the team will personally review the ticket (nothing else) — that acknowledgment form is the only case where canAnswer=true is allowed for these topics; if you are not confident even that is appropriate, set canAnswer=false instead.

Write your reply in the same language the user wrote their description in.

Keep the reply short (under about 150 words), friendly, and specific — only give steps that come from the help articles' "whatToTry" content, phrased naturally in your own words. Do not fabricate steps that aren't in the articles. End the reply by noting that a human teammate will follow up if this doesn't solve it.

Output STRICT JSON only, with exactly this shape and no other text before or after it: {"canAnswer": boolean, "reply": string}`;

function buildUserPrompt(input: AiResponderInput): string {
  const articles = HELP_ARTICLES.map((a) => ({
    title: a.title,
    shortAnswer: a.shortAnswer,
    commonCauses: a.commonCauses,
    whatToTry: a.whatToTry,
    whenToContactSupport: a.whenToContactSupport,
  }));
  const safeContext = safeContextSubset(input.context);
  const ticket = {
    category: SUPPORT_CATEGORY_LABELS[input.category],
    subject: input.subject || undefined,
    description: input.description,
    context: Object.keys(safeContext).length ? safeContext : undefined,
  };
  return [
    `Help articles (JSON — your ONLY source of product facts):\n${JSON.stringify(articles)}`,
    `Ticket (JSON):\n${JSON.stringify(ticket)}`,
  ].join("\n\n");
}

/**
 * Pure, unit-testable parser: tolerant JSON extraction (strips markdown
 * fences, tries a raw parse, then falls back to slicing the outermost
 * {...}). Returns null on any structural mismatch instead of throwing.
 */
export function parseAiResponderOutput(raw: string): AiResponderOutput | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    const first = unfenced.indexOf("{");
    const last = unfenced.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      parsed = JSON.parse(unfenced.slice(first, last + 1));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.canAnswer !== "boolean") return null;
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  return { canAnswer: obj.canAnswer, reply };
}

/**
 * Generates the AI first-response, or null when it should be silently
 * skipped (no key, provider failure, timeout, unparseable output). Self-caps
 * at TIMEOUT_MS via AbortController — callers never need their own timeout.
 */
export async function generateAiFirstResponse(input: AiResponderInput): Promise<AiResponderOutput | null> {
  const key = process.env.LINAPI_KEY;
  if (!key) return null;

  const baseUrl = (process.env.LINAPI_BASE_URL || "https://api.linapi.net/v1").replace(/\/$/, "");
  // Default must be a model with an active channel on our LINAPI account —
  // gpt-4o-mini has none (503 model_not_found, verified 2026-07-11).
  const model = process.env.SUPPORT_AI_MODEL || "gemini-2.5-flash";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | null;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseAiResponderOutput(content);
  } catch {
    // Network error, non-JSON envelope, or the AbortController firing on timeout.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
