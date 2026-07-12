/**
 * Local heuristic chat responder — the assistant's answer router (NOT an LLM).
 *
 * The customer should feel they can ask anything, but internally every reply comes from
 * one of four trusted sources, tried in order:
 *
 *   1. Workflow capability reveal — the ask maps to a page capability/check → reveal it.
 *   2. Product knowledge (FAQ)    — matchKnowledge() → an approved/official answer.
 *   3. Workflow advisory          — light guidance tied to the user's own content
 *                                   (e.g. "how should I price THIS product?").
 *   4. Not-sure fallback          — no reliable answer → say so, point to support/docs,
 *                                   and offer the safe workflow checks. Never invents.
 *
 * A later phase can replace (2) with retrieval over a real VibePin Knowledge Base while
 * keeping this same routing and the same never-fabricate guarantee.
 */
import type { AssistantContext, AssistantFinding } from "./types";
import { matchKnowledge } from "./knowledge";

export type ChatSource = "workflow" | "knowledge" | "fallback";
export type ChatResult = { reply: string; revealIds: string[]; source: ChatSource };

const KIND_HELP: Record<string, string> = {
  "create-pins": "I can look at your creative direction, suggest Pinterest angles, and check your products and references.",
  "batch-edit": "I can review the whole batch — similar titles, missing boards or URLs, product/affiliate links, duplicate images, and schedule conflicts.",
  "single-pin": "I can check this Pin's title and description quality, destination URL, product/affiliate status, and schedule readiness.",
  calendar: "I can look at schedule spacing, URL/board overuse, empty slots, and cadence.",
  analytics: "I can summarize performance, spot winners and losers, and flag Pins worth refreshing.",
  products: "I can check links, thumbnails, and affiliate status, find unused products, and suggest campaign angles.",
  boards: "I can review board coverage gaps, naming, matching, and underused boards.",
  settings: "I can help confirm your Pinterest/publishing connections, affiliate tag, and board coverage.",
  generic: "I can help with your Pins, scheduling, products, boards, and setup.",
};

// (3) Advisory answers tied to the user's OWN content/decisions — these are workflow
// intelligence, distinct from VibePin product knowledge.
const WORKFLOW_ADVISORY: { test: RegExp; answer: string }[] = [
  {
    test: /\b(how (should|do) i price|price (this|my|the)|pricing (this|my|strategy))\b/,
    answer: "For pricing your product, weigh what comparable products charge and the value your creative communicates. I can't pull live market prices, but tell me the product and I'll share what to consider.",
  },
];

function findCapabilityMatches(text: string, findings: AssistantFinding[]): AssistantFinding[] {
  const q = text.toLowerCase();
  const wantsAll = /(check my setup|is everything|everything connected|full check|run.*checks?)/.test(q);
  return findings.filter((f) => {
    if (f.proactive) return false; // proactive findings are already visible
    if (wantsAll && (f.triggers?.length ?? 0) > 0) return true;
    return (f.triggers ?? []).some((t) => q.includes(t.toLowerCase()));
  });
}

function notSure(context: AssistantContext): ChatResult {
  return {
    reply:
      "I'm not sure about that one, and I don't want to guess. You can check the VibePin docs or contact support for the definitive answer. " +
      `In the meantime I can help right here: ${KIND_HELP[context.kind] ?? KIND_HELP.generic} Try “check my setup”, or ask about publishing readiness, product links, boards, or scheduling.`,
    revealIds: [],
    source: "fallback",
  };
}

export function respondToChat(text: string, context: AssistantContext): ChatResult {
  const trimmed = text.trim();
  if (!trimmed) return { reply: KIND_HELP[context.kind] ?? KIND_HELP.generic, revealIds: [], source: "workflow" };
  const q = trimmed.toLowerCase();

  const caps = findCapabilityMatches(trimmed, context.findings);
  const capIds = caps.map((c) => c.id);
  const capNote =
    caps.length > 0
      ? ` I've also opened ${caps.map((c) => `“${c.title}”`).join(", ")} above.`
      : "";

  // (2) Product knowledge — an approved/official answer. Pair it with any capability
  // the same question maps to (e.g. an affiliate question opens the affiliate check).
  const faq = matchKnowledge(trimmed);
  if (faq) {
    return { reply: `${faq.answer}${capNote}`, revealIds: capIds, source: "knowledge" };
  }

  // (1) Pure workflow capability request (no FAQ) — reveal the checks.
  if (caps.length > 0) {
    const names = caps.map((c) => `“${c.title}”`);
    return {
      reply: `Sure — I've opened ${names.join(", ")} above.`,
      revealIds: capIds,
      source: "workflow",
    };
  }

  // (3) Workflow advisory tied to the user's own content.
  const advisory = WORKFLOW_ADVISORY.find((a) => a.test.test(q));
  if (advisory) return { reply: advisory.answer, revealIds: [], source: "workflow" };

  // "What can you do here" style.
  if (/(what can you|help me|how can you|what do you)/.test(q)) {
    return { reply: KIND_HELP[context.kind] ?? KIND_HELP.generic, revealIds: [], source: "workflow" };
  }

  // (4) No reliable answer — say so, never invent.
  return notSure(context);
}
