/**
 * VibePin Assistant — Product Knowledge layer (MVP).
 *
 * This is the second of the assistant's two intelligence sources:
 *
 *   1. Workflow intelligence  — live page context + local heuristics + safe checks
 *                               (see chat.ts capability reveal + detectors/*).
 *   2. Product knowledge       — answers about VibePin itself: features, pricing,
 *                               onboarding, troubleshooting, integrations, policies.
 *                               THIS FILE.
 *
 * MVP scope (deliberately NOT an LLM): a small, hand-curated FAQ. We do not try to
 * cover every possible question — instead we define controlled OFFICIAL answers for
 * high-risk topics (pricing, billing, refunds, copyright/commercial use, platform
 * support, affiliate rules, account safety, privacy). When nothing matches confidently
 * the assistant says it is not sure and points to support/docs — it never invents an
 * answer. A later phase can swap this for retrieval over a real Knowledge Base while
 * keeping the same `matchKnowledge` contract.
 *
 * IMPORTANT: the high-risk answers below are intentionally non-committal and route to
 * the authoritative source rather than quoting figures/policy that could be wrong.
 * Replace their copy with legal/approved wording as it becomes available.
 */

export type KnowledgeTopic =
  | "pricing" | "billing" | "refunds" | "copyright" | "platform-support"
  | "affiliate-rules" | "account-safety" | "privacy"
  | "connect-pinterest" | "publishing-readiness" | "image-generation"
  | "onboarding" | "overview";

export type KnowledgeEntry = {
  id:    KnowledgeTopic;
  /** Lowercase substrings/phrases; any hit contributes to the match score. */
  keywords: string[];
  answer: string;
  /**
   * High-risk topics carry an APPROVED official answer and must never be improvised.
   * Kept true so the UI/telemetry can treat them as authoritative.
   */
  highRisk?: boolean;
};

export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  // ── High-risk: official, routes to the source, no invented specifics ──────────
  {
    id: "pricing",
    highRisk: true,
    keywords: ["pricing", "price of vibepin", "how much", "cost", "subscription", "plan", "plans", "tier", "upgrade", "downgrade", "credits", "tokens", "quota", "limit"],
    answer:
      "VibePin's current plans and limits live on the Pricing page, and your own plan is in Settings → Billing. I won't quote a figure that might be out of date — check there for exact numbers, or contact support if you need help choosing a plan.",
  },
  {
    id: "billing",
    highRisk: true,
    keywords: ["billing", "invoice", "receipt", "charge", "charged", "payment", "card", "renew", "cancel subscription"],
    answer:
      "You can manage billing, invoices, and your plan in Settings → Billing. For a specific charge or invoice, contact support with your account email so they can look at your account.",
  },
  {
    id: "refunds",
    highRisk: true,
    keywords: ["refund", "money back", "reimburse", "chargeback"],
    answer:
      "Refunds are handled by VibePin support under our refund policy — I can't approve or promise one myself. Please contact support with your account email and they'll help.",
  },
  {
    id: "copyright",
    highRisk: true,
    keywords: ["copyright", "commercial use", "commercially", "license", "licensing", "rights", "trademark", "resell", "own the image", "who owns"],
    answer:
      "You're responsible for having the rights to what you upload or generate and for how you use generated images commercially. For specifics, see our Terms and content policy or contact support — I can't give legal advice.",
  },
  {
    id: "platform-support",
    highRisk: true,
    keywords: ["supported platform", "supported platforms", "which platforms", "tiktok", "instagram", "facebook", "publish to", "other platforms"],
    answer:
      "VibePin focuses on Pinterest today, with more destinations rolling out. For the current list of supported platforms, check Settings → Publishing/Integrations or our docs.",
  },
  {
    id: "affiliate-rules",
    highRisk: true,
    keywords: ["affiliate", "amazon associate", "associates", "affiliate rule", "affiliate link", "disclosure", "commission", "amazon tag"],
    answer:
      "For affiliate links (e.g. Amazon Associates) you must follow that program's rules, including required disclosures and only tagging eligible links. Set your tag in Settings → Amazon Associates. For program-specific rules, refer to the affiliate program's own policies.",
  },
  {
    id: "account-safety",
    highRisk: true,
    keywords: ["hacked", "compromised", "suspicious", "password", "2fa", "two factor", "login issue", "cant log in", "account safety", "security"],
    answer:
      "For account security — password, login problems, or suspicious activity — go to Settings → Account, or contact support right away if you think your account is compromised. Never share your password.",
  },
  {
    id: "privacy",
    highRisk: true,
    keywords: ["privacy", "my data", "gdpr", "delete my account", "data deletion", "personal data", "policy"],
    answer:
      "How VibePin handles your data is described in our Privacy Policy. For a specific data or deletion request, contact support.",
  },

  // ── General FAQ: safe, factual, and offers a workflow action where useful ─────
  {
    id: "connect-pinterest",
    keywords: ["connect pinterest", "link pinterest", "pinterest account", "authorize pinterest", "reconnect pinterest"],
    answer:
      "To connect Pinterest, open Settings → Pinterest and authorize your account. Once connected, your boards load automatically. Want me to check whether it's connected?",
  },
  {
    id: "publishing-readiness",
    keywords: ["cant publish", "cannot publish", "wont publish", "cant schedule", "cannot schedule", "why cant", "not publishing", "ready to publish", "not scheduling", "cant post"],
    answer:
      "A Pin can be scheduled or published once it has an image, a title, a description, alt text, and a real Pinterest board. A Website URL is optional (recommended for product Pins). Ask me to “check my setup” and I'll pinpoint exactly what's missing.",
  },
  {
    id: "image-generation",
    keywords: ["generate image", "image generation", "create a pin", "how do i make", "how to generate", "ai image", "model settings"],
    answer:
      "In Create Pins, add product or reference images plus a creative direction, then generate. Generated images are yours to edit, schedule, and publish.",
  },
  {
    id: "onboarding",
    keywords: ["get started", "getting started", "onboarding", "new here", "first steps", "how do i start", "where do i begin"],
    answer:
      "A good first flow: connect Pinterest, add a product or reference in Create Pins, generate a few Pins, then review and schedule them in Weekly Plan.",
  },
  {
    id: "overview",
    keywords: ["what is vibepin", "what does vibepin", "what can vibepin", "about vibepin"],
    answer:
      "VibePin helps you research Pinterest opportunities, generate on-brand Pins from your products, and schedule them. Ask me about any part of that, or about your current page.",
  },
];

const MIN_SCORE = 1;

/**
 * Best matching knowledge entry for a free-text question, or null when nothing is a
 * confident match (→ the caller should say it's not sure). High-risk entries win ties
 * so an authoritative answer is preferred over a general one.
 */
export function matchKnowledge(text: string): KnowledgeEntry | null {
  // Strip apostrophes first (so "can't" → "cant"), then punctuation → spaces. Keywords
  // are written apostrophe-free to match.
  const q = ` ${text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  let best: { entry: KnowledgeEntry; score: number } | null = null;
  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of entry.keywords) {
      const needle = kw.toLowerCase();
      // Multi-word phrases are worth more (more specific → higher confidence).
      if (q.includes(` ${needle} `) || q.includes(`${needle} `) || q.includes(needle)) {
        score += needle.includes(" ") ? 2 : 1;
      }
    }
    if (score < MIN_SCORE) continue;
    const better =
      !best ||
      score > best.score ||
      (score === best.score && !!entry.highRisk && !best.entry.highRisk);
    if (better) best = { entry, score };
  }
  return best?.entry ?? null;
}
