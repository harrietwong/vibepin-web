/**
 * Pathname-derived default assistant context — chat-first.
 *
 * Lightweight surfaces (Settings, Products, Calendar, My Pins, Boards, generic) open
 * with a short greeting + a few subtle example prompts and the chat input. They show
 * NO cards by default. Their "capabilities" (setup checks, board coverage, …) are
 * non-proactive findings that stay hidden until the user asks for them in chat — the
 * chat responder reveals the matching ones. Nothing here claims to have "found" issues.
 */
import type { AssistantContext, AssistantFinding, PageContextKind } from "./types";

const DEFAULT_ID = "default";

/** A hidden capability: only appears once the user's chat matches `triggers`. */
function capability(id: string, title: string, detail: string, triggers: string[]): AssistantFinding {
  return {
    id: `cap:${id}`,
    severity: "suggestion",
    proactive: false,
    triggers,
    title,
    detail,
    actions: [{ kind: "explain", label: "Explain", explanation: detail }],
  };
}

type Spec = {
  kind:  PageContextKind;
  label: string;
  greeting: string;
  examplePrompts: string[];
  capabilities: AssistantFinding[];
};

const ROUTES: { match: (p: string) => boolean; spec: Spec }[] = [
  {
    match: (p) => p.startsWith("/app/studio"),
    spec: {
      kind: "create-pins",
      label: "Create Pins",
      greeting: "Hi, I'm VibePin Assistant. Ask me anything about your creative setup, products, references, or how to get stronger Pins.",
      examplePrompts: ["Check my setup", "Suggest Pinterest angles", "Why is my direction weak?"],
      capabilities: [
        capability("angles", "Suggest 3 Pinterest angles", "Get three content angles tailored to your products and niche.", ["angle", "idea", "content", "suggest"]),
        capability("direction", "Review creative direction", "I can review your creative direction and suggest a stronger brief.", ["direction", "brief", "creative", "prompt"]),
        capability("links", "Check product links", "I'll flag products missing a destination link before you generate.", ["link", "product", "url"]),
      ],
    },
  },
  {
    match: (p) => p.startsWith("/app/plan"),
    spec: {
      kind: "calendar",
      label: "Calendar",
      greeting: "Hi, I'm VibePin Assistant. Ask me anything about your schedule, cadence, or the best times to post.",
      examplePrompts: ["Check my schedule spacing", "Find empty slots", "Is any URL overused?"],
      capabilities: [
        capability("spacing", "Review schedule spacing", "Check whether a URL or board is scheduled too often this week.", ["spacing", "space", "often", "overuse", "url", "board"]),
        capability("slots", "Find empty high-value slots", "Spot open slots worth filling and suggest a cadence.", ["slot", "empty", "gap", "cadence", "when"]),
        capability("redistribute", "Redistribute a busy day", "If one day is overloaded, I can suggest a more even spread.", ["redistribute", "busy", "spread", "balance", "reschedule"]),
      ],
    },
  },
  {
    match: (p) => p.startsWith("/app/history"),
    spec: {
      kind: "analytics",
      label: "My Pins",
      greeting: "Hi, I'm VibePin Assistant. Ask me anything about how your Pins are performing or what to refresh.",
      examplePrompts: ["What's working?", "Which Pins should I refresh?", "Compare product vs. inspiration Pins"],
      capabilities: [
        capability("winners", "Spot winners and losers", "Summarize which Pins are over- and under-performing.", ["winner", "loser", "performing", "best", "worst", "working"]),
        capability("refresh", "Find Pins worth refreshing", "Identify low-performing Pins to refresh or retire.", ["refresh", "low", "retire", "improve"]),
        capability("patterns", "Look for content patterns", "Compare product Pins vs. inspiration Pins and board performance.", ["pattern", "compare", "product", "inspiration", "board"]),
      ],
    },
  },
  {
    match: (p) => p.startsWith("/app/products"),
    spec: {
      kind: "products",
      label: "Products",
      greeting: "Hi, I'm VibePin Assistant. Ask me anything about your products, links, affiliate status, or campaign ideas.",
      examplePrompts: ["Check product links", "Which products aren't used yet?", "How should I set up affiliate links?"],
      capabilities: [
        capability("links", "Check product links", "Flag products missing links, thumbnails, or affiliate status.", ["link", "thumbnail", "broken", "missing", "affiliate"]),
        capability("unused", "Find products not used in Pins", "Surface products you haven't turned into Pins yet.", ["unused", "not used", "idle"]),
        capability("ideas", "Brainstorm product campaigns", "Suggest Pinterest angles for a chosen product.", ["campaign", "idea", "angle", "brainstorm"]),
      ],
    },
  },
  {
    match: (p) => p.startsWith("/app/settings"),
    spec: {
      kind: "settings",
      label: "Settings",
      greeting: "Ask me anything about your setup, integrations, publishing connections, affiliate settings, or account configuration.",
      examplePrompts: ["Check my setup", "Is everything connected?", "How should I set up affiliate links?"],
      capabilities: [
        capability("connections", "Check publishing connections", "Confirm Pinterest and other destinations are connected.", ["connect", "connection", "connected", "publish", "publishing", "pinterest", "destination", "setup", "everything"]),
        capability("affiliate", "Confirm affiliate setup", "Make sure your Amazon Associates tag is configured.", ["affiliate", "amazon", "associate", "tag", "link", "setup", "everything"]),
        capability("boards", "Review board coverage", "Check for coverage gaps and underused boards.", ["board", "coverage", "gap", "setup", "everything"]),
      ],
    },
  },
];

const GENERIC: Spec = {
  kind: "generic",
  label: "VibePin",
  greeting: "Hi, I'm VibePin Assistant. Ask me anything about this page, your Pins, scheduling, products, boards, or setup.",
  examplePrompts: ["How do I connect Pinterest?", "Check my setup", "Why can't I schedule?"],
  capabilities: [],
};

export function deriveDefaultContext(pathname: string): AssistantContext {
  const spec = ROUTES.find((r) => r.match(pathname))?.spec ?? GENERIC;
  return {
    id: DEFAULT_ID,
    source: "default",
    kind: spec.kind,
    label: spec.label,
    tone: "suggested",
    greeting: spec.greeting,
    examplePrompts: spec.examplePrompts,
    findings: spec.capabilities,
  };
}
