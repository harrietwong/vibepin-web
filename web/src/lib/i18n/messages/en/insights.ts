export const insightsMessages = {
  // ── Page frame ──
  "insights.eyebrow": "Insights",
  "insights.title": "See what brings people to your business.",
  "insights.subtitleSuffix": "Clear results from the last 30 days",
  "insights.connectedAccount": "Connected account",
  "insights.period": "Last 30 days",
  "insights.platformLabel": "Platform",
  "insights.platform.pinterest": "Pinterest",
  "insights.platform.instagram": "Instagram",

  // ── Account switcher (multi-account Pinterest) ──
  //    Accounts are never summed: "All accounts" shows one card per account.
  "insights.accounts.label": "Account",
  "insights.accounts.all": "All accounts",
  "insights.accounts.allHelp": "Each account is shown on its own. Numbers from different accounts are never added together.",
  "insights.accounts.subtitleAll": "{n} connected accounts",
  "insights.accounts.needsReconnect": "Needs reconnect",

  // ── Summary metrics ──
  "insights.metric.seen": "Seen",
  "insights.metric.seenHelpPinterest": "Times your Pins appeared on screen",
  "insights.metric.seenHelpInstagram": "Times your Instagram content was viewed",
  "insights.metric.wentToWebsite": "Went to website",
  "insights.metric.wentToWebsiteHelp": "Clicks that left Pinterest",
  "insights.metric.profileLinkTaps": "Profile link taps",
  "insights.metric.profileLinkTapsHelp": "Account total — not tied to one image",
  "insights.metric.clicksPer100": "Clicks per 100 views",
  "insights.metric.clicksPer100Help": "Your traffic rate, shown as a simple count",
  "insights.metric.savedAndShared": "Saved & shared",
  "insights.metric.savedAndSharedHelp": "Strong signals that people want to keep the content",
  "insights.metric.saved": "Saved",
  "insights.metric.savedHelp": "People who kept a Pin for later",
  "insights.metric.contentInteractions": "Content interactions",
  "insights.metric.contentInteractionsHelp": "Likes, comments, saves and shares",

  // ── Heatmap ──
  "insights.heatmap.title": "Your last 30 days",
  "insights.heatmap.help": "Darker days brought more {metric}.",
  "insights.heatmap.metricAria": "Heatmap metric",
  "insights.heatmap.seen": "Seen",
  "insights.heatmap.interacted": "Interacted",
  "insights.heatmap.wentToSite": "Went to site",
  "insights.heatmap.legendLess": "Less",
  "insights.heatmap.legendMore": "More",
  "insights.heatmap.perAccountHelp": "One 30-day strip per account. Rows are shown separately, never combined.",
  "insights.heatmap.metricLabel.views": "Seen",
  "insights.heatmap.metricLabel.interactions": "Interactions",
  "insights.heatmap.metricLabel.websiteClicks": "Website clicks",

  // ── Weekday initials for the heatmap grid ──
  "insights.weekday.sun": "Sun",
  "insights.weekday.mon": "Mon",
  "insights.weekday.tue": "Tue",
  "insights.weekday.wed": "Wed",
  "insights.weekday.thu": "Thu",
  "insights.weekday.fri": "Fri",
  "insights.weekday.sat": "Sat",

  // ── Scope (Pinterest only) ──
  //    Two readings of the same account, never mixed: the VibePin publish whitelist,
  //    and everything the collector has registered for the account.
  "insights.scope.label": "View",
  "insights.scope.vibepin": "Published via VibePin",
  "insights.scope.account": "Your account (all Pins)",
  "insights.scope.accountHelp": "Every Pin registered on this account, including Pins published outside VibePin.",

  // ── Data state (v64 collection layer) ──
  //    A number with no collection time behind it is a number nobody can check.
  "insights.collection.dataUpdated": "Data updated {time}",
  "insights.collection.liveSample": "Nightly collection has not run for this account yet — showing a live sample.",
  "insights.collection.awaitingFirstRun": "Nightly collection has not run for this account yet. This view fills in after the first run.",
  "insights.collection.skipped": "The last collection run stopped early: {reason}",
  "insights.collection.reason.rateLimited": "Pinterest rate limit reached",
  "insights.collection.reason.budgetExhausted": "the daily call budget was used up",
  "insights.collection.reason.deadline": "the run ran out of time",
  "insights.collection.reason.noPermission": "a permission is missing on this account",
  "insights.collection.reason.other": "reason not recorded",

  // ── Content table ──
  "insights.content.title": "Content performance",
  "insights.content.helpPinterest": "All {count} Pins verified from VibePin publish records. Metrics cover the selected 30 days.",
  "insights.content.helpInstagram": "Recent images and videos. Website clicks cannot be assigned to a normal feed image.",
  "insights.content.emptyPinterestTitle": "No published VibePin Pins yet",
  "insights.content.emptyPinterestBody": "Only Pins with a successful VibePin publish record appear here.",
  "insights.content.emptyInstagramTitle": "No content data yet",
  "insights.content.emptyInstagramBody": "Publish content on this account, then return here after the platform has processed its insights.",
  "insights.content.colContent": "Content",
  "insights.content.colAccount": "Account",
  "insights.content.colSeen": "Seen",
  "insights.content.colSaved": "Saved",
  "insights.content.colSavedShared": "Saved / shared",
  "insights.content.colWentToSite": "Went to site",
  "insights.content.colWebsiteClicks": "Website clicks",
  "insights.content.colTrafficRate": "Traffic rate",
  "insights.content.colPost": "Post",
  "insights.content.filterAccount": "Filter by account",
  "insights.content.filterAllAccounts": "All accounts",
  "insights.content.helpAccount": "All {count} Pins registered on this account. Numbers come from the nightly collection.",
  "insights.content.emptyAccountTitle": "No Pins registered yet",
  "insights.content.emptyAccountBody": "Pins appear here once the nightly collection has read this account.",
  "insights.content.awaitingPinterest": "Awaiting Pinterest",
  "insights.content.notCollected": "Not collected yet",
  "insights.content.noPermission": "Permission needed",
  "insights.content.stale": "Not confirmed in the latest collection run",
  "insights.content.originVibePin": "VibePin",
  "insights.content.originPinterest": "Pinterest",
  "insights.content.notAvailableForFeedImages": "Not available for feed images",
  "insights.content.openPost": "Open post",
  "insights.content.previewUnavailable": "Published Pin — preview unavailable",

  // ── Per-content diagnosis ──
  //    diagnoseContent() runs on the server, where there is no locale, so it returns
  //    one of these keys rather than a sentence. Every branch of the rule needs a key
  //    here and in all 18 locale catalogs.
  "insights.diagnosis.efficientButSmallReach": "Good at sending people to your website, but not many have seen it yet. Worth publishing more like this.",
  "insights.diagnosis.seenButFewClicks": "Plenty of people saw it, but few went to your website. Start with the selling point and the call to action on the image.",
  "insights.diagnosis.seenAndConverts": "Seen by many and it brings people to your website. Use it as the reference for your next batch.",
  "insights.diagnosis.savedInstagram": "People are saving or sharing this. Keep watching whether similar images bring interaction consistently.",
  "insights.diagnosis.savedPinterest": "People want to keep this image. Try a clearer call to action to your website next.",
  "insights.diagnosis.tooEarly": "It has views, but not enough data yet. Let more collect before judging.",
  "insights.diagnosis.noData": "Not enough data yet. Numbers start building up here after you publish.",
  "insights.diagnosis.awaitingMetrics": "Confirmed published by VibePin. Pinterest has not returned metrics for this image yet.",
  //    The three ways "no numbers" happens, kept apart because each needs a
  //    different action: reconnect, wait for the next run, or wait for Pinterest.
  "insights.diagnosis.awaitingPlatform": "Pinterest has not returned metrics for this Pin yet.",
  "insights.diagnosis.notCollected": "Not collected yet. Numbers appear after the next nightly collection.",
  "insights.diagnosis.noPermission": "VibePin cannot read numbers for this Pin. Reconnect the account to restore access.",

  // ── Connection / empty states ──
  "insights.state.businessRequired": "Pinterest Business account needed",
  "insights.state.reconnectPinterest": "Reconnect Pinterest",
  "insights.state.reconnectInstagram": "Reconnect Instagram",
  "insights.state.connectPinterest": "Connect Pinterest",
  "insights.state.connectInstagram": "Connect Instagram",
  "insights.state.unavailable": "Insights are temporarily unavailable",
  "insights.state.connectPinterestBody": "Connect a Pinterest Business account to see per-Pin views, saves, website clicks and traffic rate.",
  "insights.state.connectInstagramBody": "Connect an Instagram Business or Creator account to see media views, saves, shares and account-level profile link taps.",
  "insights.state.openSettings": "Open account settings",
  "insights.state.signInTitle": "Sign in to view Insights",
  "insights.state.signInBody": "Your local session has ended. Sign in again to load analytics from your connected accounts.",
  "insights.state.signIn": "Sign in",
  "insights.state.loadFailedTitle": "Insights could not be loaded",
  "insights.state.loadFailedBody": "Refresh the page and try again.",
  "insights.state.accountFailed": "This account could not be loaded",
  "insights.state.accountFailedBody": "The other accounts on this page are unaffected.",
} as const;
