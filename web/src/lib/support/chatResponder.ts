/**
 * chatResponder.ts — multi-turn AI chat brain for the Help page (server-only).
 *
 * Per docs/prd/客服系统简化版v1.1.txt §5: the user-facing surface is a chat,
 * not a ticket form. One call here drives one AI turn — it sees the whole
 * conversation so far (so it can notice "this is my 2nd failed attempt")
 * and returns a reply plus an escalation verdict.
 *
 * Same defensive posture as aiResponder.ts/translator.ts: every failure mode
 * (missing key, network error, non-2xx, unparseable JSON, timeout) resolves
 * to `null`. Nothing here throws — callers always have a "canAnswer: false"
 * fallback path that still lets the user escalate.
 */

import { HELP_ARTICLES } from "./helpArticles";
import { safeContextSubset } from "./aiResponder";
import { SUPPORT_CATEGORIES, type SupportCategory } from "./types";

const TIMEOUT_MS = 15_000;

export type ChatMessageInput = { role: "user" | "assistant"; text: string };

export type ChatReplyResult = {
  reply: string;
  canAnswer: boolean;
  category: SupportCategory;
  shouldEscalate: boolean;
  escalationReason: string | null;
};

export type GenerateChatReplyInput = {
  messages: ChatMessageInput[];
  context: Record<string, unknown> | null;
};

// Machine-readable escalation reasons the model may emit. Not exhaustive of
// every English phrase it might invent, but the parser normalizes anything
// outside this list to "cannot_answer" rather than rejecting the whole
// response — see parseChatReplyOutput.
export const CHAT_ESCALATION_REASONS = [
  "refund_request",
  "duplicate_charge",
  "credits_charged_no_result",
  "account_security",
  "data_deletion",
  "user_requested_human",
  "cannot_answer",
] as const;
export type ChatEscalationReason = (typeof CHAT_ESCALATION_REASONS)[number];

const SYSTEM_PROMPT = `You are VibePin's support assistant, chatting live with a customer on the Help page. This is a multi-turn conversation — you will see every prior user and assistant turn. A human support agent takes over by email whenever you escalate, so you are not the only line of defense, but you must be honest about your limits.

You may ONLY use facts that appear in the "Help articles" JSON provided in the user message, plus the conversation itself and the account context fields. Do not use any other knowledge of VibePin, Pinterest, or any product. NEVER invent product behavior, policies, refund terms, timelines, or compensation. NEVER promise a refund, credit, or any other compensation, even if the user asks for one.

Set "shouldEscalate" to true (and set "escalationReason" to the single best-matching machine code below) whenever ANY of these apply:
- The topic is a refund request -> "refund_request"
- The topic is a duplicate or unexpected charge -> "duplicate_charge"
- Credits were charged but the user got no result -> "credits_charged_no_result"
- The topic is account security (compromised account, suspicious login, password/2FA issue) -> "account_security"
- The user is asking to delete their account or their data -> "data_deletion"
- The user explicitly asks for a human, a person, or to "contact support" -> "user_requested_human"
- The help articles do not clearly cover the user's issue AND this is your 2nd or later attempt to answer it in this conversation (you can tell from the prior assistant turns) -> "cannot_answer"

For the five topics above (refund, duplicate charge, credits-charged-no-result, account security, data deletion) — these are HIGH RISK topics. When shouldEscalate is true for one of these, your "reply" must be ONLY a short, generic acknowledgment that you're passing this to the team — do NOT attempt to explain, solve, or reassure beyond that. Do not restate policy. Do not attempt a fix.

For "user_requested_human" and "cannot_answer", your "reply" may still be a short, honest acknowledgment — do not keep attempting a fix once you've decided to escalate.

Set "canAnswer" to false when you have nothing grounded in the help articles to say and are not escalating either (this should be rare — usually not knowing the answer after one attempt should just prompt a clarifying question, not canAnswer=false). Set "canAnswer" to true whenever your "reply" is meaningful — either a grounded help-articles answer, a clarifying question, or (during escalation) the short acknowledgment.

Always set "category" to the single best-fitting value from this exact list: ${SUPPORT_CATEGORIES.join(", ")}.

Write your reply in the same language the user is writing in. Keep it under about 150 words, friendly, and specific — only give steps that come from the help articles' "whatToTry" content, phrased naturally in your own words. Do not fabricate steps that aren't in the articles.

Output STRICT JSON only, with exactly this shape and no other text before or after it: {"reply": string, "canAnswer": boolean, "category": string, "shouldEscalate": boolean, "escalationReason": string | null}`;

function buildUserPrompt(input: GenerateChatReplyInput): string {
  const articles = HELP_ARTICLES.map((a) => ({
    title: a.title,
    shortAnswer: a.shortAnswer,
    commonCauses: a.commonCauses,
    whatToTry: a.whatToTry,
    whenToContactSupport: a.whenToContactSupport,
  }));
  const safeContext = safeContextSubset(input.context);
  const conversation = input.messages.map((m) => ({ role: m.role, text: m.text }));
  return [
    `Help articles (JSON — your ONLY source of product facts):\n${JSON.stringify(articles)}`,
    `Account context (JSON, may be empty):\n${JSON.stringify(safeContext)}`,
    `Conversation so far (JSON, chronological, ends with the latest user message):\n${JSON.stringify(conversation)}`,
  ].join("\n\n");
}

function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === "string" && (SUPPORT_CATEGORIES as readonly string[]).includes(value);
}

function normalizeEscalationReason(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  return (CHAT_ESCALATION_REASONS as readonly string[]).includes(trimmed) ? trimmed : "cannot_answer";
}

/**
 * Pure, unit-testable parser: tolerant JSON extraction (strips markdown
 * fences, tries a raw parse, then falls back to slicing the outermost
 * {...}). Returns null on any structural mismatch instead of throwing.
 *
 * Deviations documented for the test suite:
 *   - Missing/invalid "category" falls back to "other" rather than failing
 *     the whole parse — category is a UI/routing label, not something the
 *     rest of the pipeline should hard-fail on.
 *   - Missing/unrecognized "escalationReason" when shouldEscalate=true
 *     falls back to "cannot_answer" (see normalizeEscalationReason) rather
 *     than failing the parse, for the same reason.
 *   - Missing "canAnswer" or "shouldEscalate" (not booleans) IS a hard
 *     failure (returns null) — those two drive control flow and must be
 *     unambiguous.
 */
export function parseChatReplyOutput(raw: string): ChatReplyResult | null {
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
  if (typeof obj.shouldEscalate !== "boolean") return null;

  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  const category = isSupportCategory(obj.category) ? obj.category : "other";
  const escalationReason = obj.shouldEscalate ? normalizeEscalationReason(obj.escalationReason) : null;

  return {
    reply,
    canAnswer: obj.canAnswer,
    category,
    shouldEscalate: obj.shouldEscalate,
    escalationReason,
  };
}

/**
 * Generates the next AI chat turn, or null when it should be silently
 * skipped (no key, provider failure, timeout, unparseable output). Callers
 * treat a null result as canAnswer=false (no AI message posted; the caller
 * offers the escalate path instead). Self-caps at TIMEOUT_MS.
 */
export async function generateChatReply(input: GenerateChatReplyInput): Promise<ChatReplyResult | null> {
  const key = process.env.LINAPI_KEY;
  if (!key) return null;
  if (!input.messages.length) return null;

  const baseUrl = (process.env.LINAPI_BASE_URL || "https://api.linapi.net/v1").replace(/\/$/, "");
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
        max_tokens: 600,
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

    return parseChatReplyOutput(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fallback category for route handlers when the AI call itself returned
// null (canAnswer=false with no category guess) — see conversations route.
export const DEFAULT_CHAT_CATEGORY: SupportCategory = "other";
