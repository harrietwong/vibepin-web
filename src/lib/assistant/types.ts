/**
 * VibePin Assistant — shared types.
 *
 * The assistant is a global, contextual workflow helper (not a generic chatbot).
 * A "context" describes what the assistant can do on the current surface: a label,
 * a short summary, and a set of findings. Findings are either real, data-driven
 * observations (only on Create Pins / Batch Edit / Single Pin Edit) or lightweight
 * suggestion cards (everywhere else). Nothing here depends on an LLM.
 */

/** Which surface the active context represents. */
export type PageContextKind =
  | "create-pins"
  | "batch-edit"
  | "single-pin"
  | "calendar"
  | "analytics"
  | "products"
  | "boards"
  | "settings"
  | "generic";

/**
 * Context resolution priority. Higher wins so a drawer/modal context overrides the
 * page it opened on, and any published context overrides the pathname default.
 */
export type ContextSource = "modal" | "page" | "default";

export const SOURCE_PRIORITY: Record<ContextSource, number> = {
  modal:   3,
  page:    2,
  default: 1,
};

/**
 * Finding severity.
 * - `issue`      real, actionable problem found in live data. Only the priority-three
 *                surfaces may emit this. Counts toward the numeric launcher badge.
 * - `suggestion` a helpful thing the assistant can do here. Shows a dot at most.
 * - `ready`      a positive "this looks good" confirmation (e.g. ready to schedule).
 */
export type AssistantFindingSeverity = "issue" | "suggestion" | "ready";

export type AssistantActionKind = "apply" | "review" | "ignore" | "explain";

/** A single before→after change to show in the preview. */
export type PreviewChange = {
  /** e.g. a pin title, a row label. */
  label:  string;
  before: string;
  after:  string;
};

export type AssistantPreview = {
  title:   string;
  /** One row per affected item — batch actions list every affected row. */
  changes: PreviewChange[];
  /** Optional note shown under the change list. */
  note?:   string;
};

export type AssistantAction = {
  kind:  AssistantActionKind;
  label: string;
  /**
   * Applies the change. For `apply` actions this runs only AFTER the user confirms
   * the preview. Supplied by the publishing page so mutations go through the page's
   * own handlers (no shadow write path). Omitted for `explain`/`ignore`.
   */
  run?: () => void | Promise<void>;
  /**
   * Preview shown before `run` for `apply`/`review` actions. If a safe automatic fix
   * cannot be determined the finding should use a `review` action instead of `apply`.
   */
  preview?: AssistantPreview;
  /** For `explain` actions — plain-language detail rendered inline in the panel. */
  explanation?: string;
};

export type AssistantFinding = {
  id:       string;
  severity: AssistantFindingSeverity;
  title:    string;
  detail?:  string;
  actions:  AssistantAction[];
  /**
   * `true`  → a REAL, data-driven finding shown immediately (issues, readiness).
   * falsy   → an optional capability that stays HIDDEN until the user asks for it via
   *           chat (matched by `triggers`). Keeps the opened panel chat-first and clean.
   */
  proactive?: boolean;
  /** Chat keywords that reveal a non-proactive capability card. */
  triggers?: string[];
};

/** Tone for the findings section header — keeps lightweight contexts honest. */
export type FindingsTone = "detected" | "suggested";

export type AssistantContext = {
  /** Stable id for the context source (used to clear it on unmount). */
  id:      string;
  source:  ContextSource;
  kind:    PageContextKind;
  /** Short label under "Ask VibePin" in the header, e.g. "Batch Edit". */
  label:   string;
  /** One-line summary shown at the top of the body, e.g. "24 Pins selected". */
  summary?: string;
  /**
   * "detected" → findings are real analyzed issues ("I found N things to review").
   * "suggested" → lightweight context with no proactive cards. Never claim detection
   * without having analyzed live data.
   */
  tone:     FindingsTone;
  /**
   * All findings for this context. Proactive ones (real issues/readiness) show
   * immediately; non-proactive ones are optional capabilities revealed via chat.
   */
  findings: AssistantFinding[];
  /** Chat-first greeting shown when there are no proactive findings to display. */
  greeting?: string;
  /** Subtle example prompt chips shown under the greeting. */
  examplePrompts?: string[];
  /**
   * Extra bottom offset (px) so the launcher clears a page's Save/Schedule footer.
   */
  footerOffset?: number;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id:   string;
  role: ChatRole;
  text: string;
};

/** Derived launcher visual state. */
export type LauncherState = "normal" | "suggestions" | "issues" | "loading";

export type AssistantContextValue = {
  open:    boolean;
  busy:    boolean;
  context: AssistantContext;
  /** Findings with dismissed ones filtered out. */
  visibleFindings: AssistantFinding[];
  launcherState: LauncherState;
  /** Count of non-dismissed `issue` findings — the numeric badge. Suggestions never count. */
  issueCount: number;
  chatLog: ChatMessage[];

  setOpen: (v: boolean) => void;
  toggle:  () => void;
  publishContext: (ctx: AssistantContext) => void;
  clearContext:   (id: string) => void;
  dismissFinding: (id: string) => void;
  sendChat: (text: string) => void;
  setBusy:  (v: boolean) => void;
};
