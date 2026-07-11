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
    shortAnswer:
      "Go to Settings → Pinterest and select \"Connect Pinterest.\" You'll be taken to Pinterest to approve access, then brought back to VibePin already connected. Both business and personal Pinterest accounts work, though publishing may be limited until Pinterest finishes approving full access for new accounts.",
    commonCauses: [],
    whatToTry: [
      "Open Settings → Pinterest and select \"Connect Pinterest.\"",
      "Log in to Pinterest and approve the access request when prompted.",
      "Wait to be redirected back to VibePin — the connection should show as active.",
      "If the connection later shows as expired, select \"Reconnect Pinterest\" to renew it.",
      "Make sure pop-ups or redirects aren't being blocked by your browser.",
    ],
    whenToContactSupport: "If you're stuck, contact support and we'll help you get connected.",
    supportCategory: "pinterest_connection_issue",
  },
  {
    slug: "why-publishing-can-fail",
    title: "Why publishing can fail",
    shortAnswer:
      "Publishing usually fails because Pinterest isn't connected (or the connection expired), no board is selected, or the Pin is missing a required detail like an image, title, description, or alt text. A destination link is optional and won't block publishing. Pinterest also has occasional temporary errors that clear up on retry.",
    commonCauses: [
      "Pinterest isn't connected, or the connection has expired.",
      "No board is selected for the Pin.",
      "The Pin is missing a required detail — image, title, description, or alt text.",
      "Boards are still loading, or failed to load, when you tried to publish.",
      "A temporary error on Pinterest's side.",
    ],
    whatToTry: [
      "Check Settings → Pinterest to confirm the connection is active; reconnect if it's expired.",
      "Open the Pin's details and make sure a board is selected.",
      "Fill in any missing title, description, or alt text.",
      "Select \"Try again\" to retry — many failures are temporary.",
      "If boards won't load, tap the board field to retry loading them.",
    ],
    whenToContactSupport: "If a Pin keeps failing to publish, contact support with the ticket details.",
    supportCategory: "publishing_issue",
  },
  {
    slug: "how-scheduling-works",
    title: "How scheduling works",
    shortAnswer:
      "Every Pin can be sent right away with \"Publish now\" or scheduled for a specific date and time. Scheduled Pins show up on the Weekly Plan calendar, where you can drag them to a new day or edit the time from the Pin's details. Smart Schedule can also pick good times for you automatically.",
    commonCauses: [],
    whatToTry: [
      "From a Pin's details, choose \"Publish now\" to send it immediately, or \"Schedule\" to set a date and time.",
      "Find scheduled Pins on the Weekly Plan calendar and drag them to reschedule.",
      "Open a Pin's details to edit its scheduled time directly.",
      "Use Smart Schedule to have times picked for you automatically.",
      "Turn on \"Keep this time\" for a Pin if you don't want automatic rebalancing to move it.",
      "A scheduled Pin still needs its board, image, and other required details filled in — the same as publishing now.",
    ],
    whenToContactSupport: "If a scheduled Pin didn't go out, contact support.",
    supportCategory: "scheduling_issue",
  },
  {
    slug: "why-boards-may-not-load",
    title: "Why boards may not load",
    shortAnswer:
      "Boards usually fail to load because your Pinterest connection has expired, Pinterest's API is briefly slow or unavailable, or the connected account is new and doesn't have any boards yet. This is separate from your Pin's content — it just affects the board picker.",
    commonCauses: [
      "The Pinterest connection has expired and needs to be renewed.",
      "A temporary issue on Pinterest's side.",
      "The connected Pinterest account has no boards yet.",
    ],
    whatToTry: [
      "Tap the board field to retry loading boards.",
      "Go to Settings → Pinterest and reconnect if it shows as expired.",
      "If the account is brand new, create a board on Pinterest first, then retry.",
      "Wait a moment and try again — Pinterest's own service can be briefly slow.",
    ],
    whenToContactSupport: "If boards still won't load after retrying, contact support.",
    supportCategory: "pinterest_connection_issue",
  },
  {
    slug: "ai-credits-explained",
    title: "AI credits explained",
    shortAnswer:
      "AI credits (shown as tokens in the app) are used whenever you generate a Pin image with AI. Every plan includes a monthly allowance — see the Pricing page for current amounts. You can check your balance and usage anytime in Settings → Billing.",
    commonCauses: [],
    whatToTry: [
      "Check your current balance and usage in Settings → Billing.",
      "See the Pricing page for how many credits each plan includes.",
      "Upgrade your plan from the Pricing page if you need more credits.",
      "Credits are only used when an image is actually generated, so failed generations shouldn't normally cost credits.",
    ],
    whenToContactSupport: "If you were charged credits but didn't get a result, contact support.",
    supportCategory: "credits_issue",
  },
  {
    slug: "billing-and-subscriptions",
    title: "Billing and subscriptions",
    shortAnswer:
      "VibePin offers Free, Starter, Pro, and Business plans. Your current plan and its status are shown in Settings → Billing, and you can upgrade or change plans from the Pricing page at any time.",
    commonCauses: [],
    whatToTry: [
      "Go to Settings → Billing to see your current plan and status.",
      "Visit the Pricing page to compare plans or upgrade.",
      "Check Settings → Billing for your credit balance and usage before upgrading.",
      "If a charge looks wrong or unexpected, contact support with your account email.",
    ],
    whenToContactSupport: "For billing questions we can't answer here, contact support.",
    supportCategory: "billing_or_subscription",
  },
  {
    slug: "refund-policy",
    title: "Cancellation and refund policy",
    shortAnswer:
      "You can cancel anytime from Settings → Billing. Cancelling stops future renewals, and you'll typically keep access until the end of your current paid period. Refund requests are reviewed case by case — contact support with your account email and the reason for the request.",
    commonCauses: [],
    whatToTry: [
      "Cancel your subscription from Settings → Billing.",
      "Access typically continues until the end of the period you already paid for.",
      "For a refund request, contact support with your account email and reason — each request is reviewed individually.",
      "If you see a duplicate or unexpected charge, report it to support right away.",
    ],
    whenToContactSupport: "To request a refund or cancellation, contact support.",
    supportCategory: "billing_or_subscription",
  },
  {
    slug: "how-to-report-a-bug",
    title: "How to report a bug",
    shortAnswer:
      "Use the Contact Support form to report bugs — it automatically attaches helpful details like your account, current page, and browser, so you don't need to copy any technical information yourself. The most useful reports describe what you were doing, what you expected, and what happened instead.",
    commonCauses: [],
    whatToTry: [
      "Note what you were doing right before the problem happened.",
      "Note what you expected to happen versus what actually happened.",
      "Take a screenshot if the issue is visible on screen.",
      "List the steps to reproduce the issue, if you can — this helps the most.",
      "Submit it through the Contact Support form; account and browser details are attached automatically.",
    ],
    whenToContactSupport: "Ready to report it? Contact support with steps to reproduce.",
    supportCategory: "bug_report",
  },
];

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}
