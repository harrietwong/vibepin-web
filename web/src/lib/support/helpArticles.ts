/**
 * Static Help Center article registry. No CMS — content lives in this file.
 * Each article renders through the shared /app/help/[slug] template (short
 * answer / common causes / what to try / when to contact support / CTA).
 */

export type HelpArticle = {
  slug: string;
  title: string;
  shortAnswer: string;
  commonCauses: string[];
  whatToTry: string[];
  whenToContactSupport: string;
  /** Prefills ContactSupportModal when the article's CTA is used. */
  supportCategory: import("./types").SupportCategory;
};

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: "connect-pinterest",
    title: "How to connect Pinterest",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "If you're stuck, contact support and we'll help you get connected.",
    supportCategory: "pinterest_connection_issue",
  },
  {
    slug: "why-publishing-can-fail",
    title: "Why publishing can fail",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "If a Pin keeps failing to publish, contact support with the ticket details.",
    supportCategory: "publishing_issue",
  },
  {
    slug: "how-scheduling-works",
    title: "How scheduling works",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "If a scheduled Pin didn't go out, contact support.",
    supportCategory: "scheduling_issue",
  },
  {
    slug: "why-boards-may-not-load",
    title: "Why boards may not load",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "If boards still won't load after retrying, contact support.",
    supportCategory: "pinterest_connection_issue",
  },
  {
    slug: "ai-credits-explained",
    title: "AI credits explained",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "If you were charged credits but didn't get a result, contact support.",
    supportCategory: "credits_issue",
  },
  {
    slug: "billing-and-subscriptions",
    title: "Billing and subscriptions",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "For billing questions we can't answer here, contact support.",
    supportCategory: "billing_or_subscription",
  },
  {
    slug: "refund-policy",
    title: "Cancellation and refund policy",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "To request a refund or cancellation, contact support.",
    supportCategory: "billing_or_subscription",
  },
  {
    slug: "how-to-report-a-bug",
    title: "How to report a bug",
    shortAnswer: "Full article coming soon.",
    commonCauses: [],
    whatToTry: [],
    whenToContactSupport: "Ready to report it? Contact support with steps to reproduce.",
    supportCategory: "bug_report",
  },
];

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}
