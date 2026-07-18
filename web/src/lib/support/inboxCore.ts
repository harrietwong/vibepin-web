/**
 * inboxCore.ts — pure, network/DB-free helpers for the admin "Support
 * Inbox" (escalated-conversation-awaiting-email-reply view). Split out
 * (matching the metricsCore.ts / escalationCore.ts convention) so unit
 * tests can import this without pulling in db.ts's top-level Supabase
 * client construction.
 */

// ── Escalation reason -> Chinese label (machine reason codes emitted by the
// chat responder / manual escalate path; see escalationCore.ts and
// docs/prd/客服系统简化版v1.1.txt §6.3/§9). Unknown reasons fall back to the
// raw string so a newly-introduced reason code never disappears silently.
const ESCALATION_REASON_LABELS_ZH: Record<string, string> = {
  refund_request: "退款请求",
  duplicate_charge: "重复扣费",
  credits_charged_no_result: "扣费无结果",
  account_security: "账户安全",
  data_deletion: "数据删除",
  user_requested_human: "用户要求人工",
  cannot_answer: "AI无法解答",
};

export function escalationReasonLabelZh(reason: string | null | undefined): string {
  if (!reason) return "—";
  return ESCALATION_REASON_LABELS_ZH[reason] ?? reason;
}

// ── Support Inbox tabs (PRD §6.2: 待回复 / 发送失败 / 已发送 / 全部) -> the
// escalation_state set each tab filters to. "all" (or anything else)
// returns undefined -> no filter, matching the list API's pre-existing
// unfiltered behavior.
export const INBOX_TABS = ["pending", "failed", "sent", "all"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export function escalationStatesForInboxTab(tab: string | null | undefined): string[] | undefined {
  switch (tab) {
    case "pending":
      return ["needs_email_reply", "email_failed"];
    case "failed":
      return ["email_failed"];
    case "sent":
      return ["email_sent"];
    default:
      return undefined;
  }
}

// ── High-risk reply detector (PRD §7.3) — categories, escalation reasons,
// and Chinese/English draft keywords that must be reviewed via the
// translation preview before an email can be sent. The preview is already
// mandatory in email-reply mode; this only decides whether to also show the
// explicit warning banner.
const HIGH_RISK_CATEGORIES = new Set(["billing_or_subscription", "credits_issue"]);
const HIGH_RISK_REASONS = new Set([
  "refund_request",
  "duplicate_charge",
  "credits_charged_no_result",
  "data_deletion",
  "account_security",
]);
const HIGH_RISK_TEXT_PATTERN = /退款|扣费|扣款|删除|refund|charge/i;

export function isHighRiskReply(input: {
  category?: string | null;
  escalationReason?: string | null;
  draftText?: string | null;
}): boolean {
  if (input.category && HIGH_RISK_CATEGORIES.has(input.category)) return true;
  if (input.escalationReason && HIGH_RISK_REASONS.has(input.escalationReason)) return true;
  if (input.draftText && HIGH_RISK_TEXT_PATTERN.test(input.draftText)) return true;
  return false;
}
