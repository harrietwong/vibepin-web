// Workspace category page-specific i18n keys.
// Namespace: "workspace.*"
// This file is spread into the main en.ts catalog by the i18n coordinator.
export const workspaceMessages = {
  // ── Digital idea banner ──
  "workspace.digitalIdea.eyebrow": "Digital Product Idea",
  "workspace.digitalIdea.add": "Add to Weekly Plan",
  "workspace.digitalIdea.adding": "Adding…",
  "workspace.digitalIdea.addedToast": "Added to Weekly Plan",
  "workspace.digitalIdea.addErrorPrefix": "Could not add to plan: ",

  // ── Coming soon state ──
  "workspace.comingSoon.titleSoonSuffix": "is Coming Soon",
  "workspace.comingSoon.titleUnavailableSuffix": "is Not Yet Available",
  "workspace.comingSoon.bodyPrefix": "We're still collecting enough trend, pin, and product signals to build reliable weekly plans for",
  "workspace.comingSoon.bodySuffix": "Once the data reaches our readiness threshold this workspace will activate automatically.",
  "workspace.comingSoon.pipelineNote": "This category is in our pipeline — check back in the next update.",
  "workspace.comingSoon.goToHomeDecor": "Go to Home Decor Workspace →",
  "workspace.comingSoon.requestPrefix": "Request ",
  "workspace.comingSoon.comingSoonHeading": "Coming Soon",
  "workspace.comingSoon.requestEarlyAccess": "Collecting signals — request early access",

  // ── Beta banner ──
  "workspace.betaBanner": "Beta category · signals still expanding — opportunities may be limited",

  // ── Feed states ──
  "workspace.feed.loadFailedToast": "Failed to load more opportunities",
  "workspace.feed.tryHomeDecor": "Try Home Decor",
  "workspace.feed.loadingMore": "Loading…",
  "workspace.feed.loadMore": "Load more opportunities",
  "workspace.feed.endOfList": "You've reached the end of this week's recommendations.",

  // ── Upgrade prompt toast ──
  "workspace.upgrade.title": "Upgrade to Pro to plan 14 or 21 keywords per week.",
  "workspace.upgrade.description": "Free plan is limited to 7 keywords.",
  "workspace.upgrade.action": "Upgrade",

  // ── Category tabs ──
  "workspace.tabs.workspaceSuffix": "Workspace",
} as const;
