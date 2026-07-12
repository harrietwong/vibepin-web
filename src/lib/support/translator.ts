/**
 * translator.ts — Chinese-facing translation + summary AI helpers for the
 * support admin UI (server-only).
 *
 * Phase B: VibePin's human support operators work in Chinese while
 * customers write in any language. This module powers (a) a Chinese
 * summary of a ticket, (b) user-message -> Chinese translation, (c)
 * Chinese admin draft -> customer-language translation, and (d) a
 * Chinese-language AI-suggested reply.
 *
 * Failure posture matches aiResponder.ts: every failure mode (missing key,
 * network error, non-2xx, unparseable JSON, timeout) resolves to `null`.
 * Nothing here throws. Translation failing must NEVER block reading a
 * ticket or sending a reply — callers always have an untranslated
 * fallback path.
 */

import { HELP_ARTICLES } from "./helpArticles";
import { SUPPORT_CATEGORY_LABELS, type SupportCategory } from "./types";

const TIMEOUT_MS = 15_000;

// Product terms that must NEVER be translated — kept verbatim in every
// translation/summary/suggestion prompt below.
const GLOSSARY_TERMS = ["VibePin", "Pin", "Pinterest", "Board", "Smart Schedule", "AI Credits", "Weekly Plan"];
const GLOSSARY_RULE = `Glossary — NEVER translate these product terms, keep them verbatim exactly as written (including capitalization): ${GLOSSARY_TERMS.join(", ")}.`;

function getConfig(): { key: string; baseUrl: string; model: string } | null {
  const key = process.env.LINAPI_KEY;
  if (!key) return null;
  const baseUrl = (process.env.LINAPI_BASE_URL || "https://api.linapi.net/v1").replace(/\/$/, "");
  // Default must be a model with an active channel on our LINAPI account —
  // gpt-4o-mini has none (503 model_not_found, verified 2026-07-11).
  const model = process.env.SUPPORT_AI_MODEL || "gemini-2.5-flash";
  return { key, baseUrl, model };
}

async function callChatJson(system: string, userPrompt: string): Promise<string | null> {
  const config = getConfig();
  if (!config) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | null;
    const content = data?.choices?.[0]?.message?.content;
    return content || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerant JSON extraction shared by all parsers below: strips markdown fences, tries a raw parse, then falls back to slicing the outermost {...}. Never throws. */
function tolerantJsonParse(raw: string): Record<string, unknown> | null {
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
  return parsed as Record<string, unknown>;
}

// ── translateToZh ────────────────────────────────────────────────────────

export type TranslateToZhOutput = { detectedLanguage: string; zh: string };

export function parseTranslateToZhOutput(raw: string): TranslateToZhOutput | null {
  const obj = tolerantJsonParse(raw);
  if (!obj) return null;
  const language = typeof obj.language === "string" ? obj.language.trim() : "";
  const translation = typeof obj.translation === "string" ? obj.translation : "";
  if (!language) return null;
  return { detectedLanguage: language, zh: translation };
}

/**
 * Translates arbitrary user text to Chinese, also returning the detected
 * source language. If the text is already Chinese, detectedLanguage="zh"
 * and zh is the original text unchanged.
 */
export async function translateToZh(text: string): Promise<TranslateToZhOutput | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const system = `You are a professional translator for VibePin's customer support team. Detect the language of the given text and translate it to Simplified Chinese for a Chinese-speaking support agent. If the text is already in Chinese, set "language" to "zh" and return the original text unchanged as "translation".

${GLOSSARY_RULE}

Output STRICT JSON only, with exactly this shape and no other text before or after it: {"language": "<ISO 639-1 code such as en, es, zh, fr, ja>", "translation": "<Simplified Chinese translation>"}`;
  const userPrompt = `Text to translate:\n${trimmed}`;

  const content = await callChatJson(system, userPrompt);
  if (!content) return null;
  return parseTranslateToZhOutput(content);
}

// ── translateFromZh ──────────────────────────────────────────────────────

export function parseTranslationOutput(raw: string): string | null {
  const obj = tolerantJsonParse(raw);
  if (!obj) return null;
  const translation = typeof obj.translation === "string" ? obj.translation : null;
  return translation;
}

/** Translates a Chinese admin draft into the customer's language. Returns just the translated text, or null on any failure. */
export async function translateFromZh(zhText: string, targetLanguage: string): Promise<string | null> {
  const trimmed = zhText.trim();
  if (!trimmed) return null;

  const system = `You are a professional translator for VibePin's customer support team. Translate the given Simplified Chinese text, written by a support agent, into the target language so it reads naturally to a native speaker. Preserve tone, meaning, and formatting (line breaks, lists).

${GLOSSARY_RULE}

Output STRICT JSON only, with exactly this shape and no other text before or after it: {"translation": "<translated text in the target language>"}`;
  const userPrompt = `Target language (ISO 639-1 or name): ${targetLanguage}\n\nChinese text to translate:\n${trimmed}`;

  const content = await callChatJson(system, userPrompt);
  if (!content) return null;
  return parseTranslationOutput(content);
}

// ── summarizeTicketZh ─────────────────────────────────────────────────────

export type TicketSummaryInput = {
  ticket: {
    category: SupportCategory;
    subject: string | null;
    description: string;
    context?: Record<string, unknown> | null;
  };
  messages: { senderType: string; text: string }[];
};

function buildTicketPrompt(input: TicketSummaryInput): string {
  const ticket = {
    category: SUPPORT_CATEGORY_LABELS[input.ticket.category] ?? input.ticket.category,
    subject: input.ticket.subject || undefined,
    description: input.ticket.description,
    context: input.ticket.context && Object.keys(input.ticket.context).length ? input.ticket.context : undefined,
  };
  const conversation = input.messages.map((m) => ({ from: m.senderType, text: m.text }));
  return [`Ticket (JSON):\n${JSON.stringify(ticket)}`, `Conversation so far (JSON, chronological):\n${JSON.stringify(conversation)}`].join("\n\n");
}

/** Concise Chinese summary of a ticket for a Chinese-speaking support agent. Never invents facts not present in the ticket/conversation. */
export async function summarizeTicketZh(input: TicketSummaryInput): Promise<string | null> {
  const system = `You are VibePin's internal support tooling. Write a concise SUMMARY IN SIMPLIFIED CHINESE of a support ticket for a human support agent, using ONLY facts present in the ticket and conversation JSON provided — never invent anything.

${GLOSSARY_RULE}

Structure the summary as plain text (no markdown headers) with these four labeled parts, each 1-2 short sentences:
客户问题: what the customer's issue is.
已知状态: any known account/system status from the ticket's context fields, if present; omit this line if there's no context.
已回复要点: what the AI or a human agent has already replied with, if anything; omit this line if nobody has replied yet.
建议下一步: a neutral suggested next step for the agent (do not promise refunds, credits, or specific timelines).

Keep the whole summary under about 200 Chinese characters. Output STRICT JSON only, with exactly this shape and no other text before or after it: {"summary": "<the Chinese summary text>"}`;
  const userPrompt = buildTicketPrompt(input);

  const content = await callChatJson(system, userPrompt);
  if (!content) return null;
  const obj = tolerantJsonParse(content);
  if (!obj) return null;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  return summary || null;
}

// ── suggestReplyZh ────────────────────────────────────────────────────────

export type SuggestReplyInput = TicketSummaryInput;

/** Drafts a Chinese-language reply for a human agent to review before sending, grounded ONLY in the static help articles + conversation. Same no-invention rules as aiResponder.ts. */
export async function suggestReplyZh(input: SuggestReplyInput): Promise<string | null> {
  const articles = HELP_ARTICLES.map((a) => ({
    title: a.title,
    shortAnswer: a.shortAnswer,
    commonCauses: a.commonCauses,
    whatToTry: a.whatToTry,
    whenToContactSupport: a.whenToContactSupport,
  }));

  const system = `You are VibePin's internal support tooling. Draft a reply IN SIMPLIFIED CHINESE for a human support agent to review and send to a customer. The agent will read and edit this before it goes out — you are a draft assistant, not the final word.

You may ONLY use facts from the "Help articles" JSON provided, plus the ticket's own subject/description/context and the conversation so far. Do not use any other knowledge of VibePin, Pinterest, or any product. If the help articles do not clearly cover the issue, write a short, honest Chinese reply acknowledging the issue and saying a teammate will follow up personally — do not guess at a fix.

NEVER invent product behavior, policies, refund terms, timelines, or compensation. NEVER promise a refund, credit, or any other compensation, even if the user asks for one. For refund/duplicate-charge/credits-charged-without-result topics, only offer a short generic acknowledgment that the team will personally review it.

${GLOSSARY_RULE}

Keep the reply short (under about 150 Chinese characters worth of content), friendly, and specific. Output STRICT JSON only, with exactly this shape and no other text before or after it: {"reply": "<the Chinese draft reply>"}`;
  const userPrompt = [`Help articles (JSON — your ONLY source of product facts):\n${JSON.stringify(articles)}`, buildTicketPrompt(input)].join("\n\n");

  const content = await callChatJson(system, userPrompt);
  if (!content) return null;
  const obj = tolerantJsonParse(content);
  if (!obj) return null;
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  return reply || null;
}
