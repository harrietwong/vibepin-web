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
  // ── Evidence engine (rules name observations, never causes) ──
  //    Every string below is scanned by test-insights-engine for the vocabulary of
  //    causation. We can see that a Pin was seen less often than the middle Pin of
  //    its group; we cannot see why, and neither can Pinterest's API. A template that
  //    explained WHY would be a story the data cannot support, and the user would act
  //    on it. Keep every line to what was measured, plus one thing to try.
  "insights.evidence.finding.f1.quantified": "{matched} of {comparable} comparable Pins were seen less often than the middle Pin of their group (same format, same age).",
  "insights.evidence.finding.f1.directional": "Some Pins were seen less often than the middle Pin of their group (same format, same age). Too few comparable Pins to put a number on it.",
  "insights.evidence.finding.f2.quantified": "{matched} of {comparable} Pins were seen about as often as their group, yet fewer of those people went on to your site.",
  "insights.evidence.finding.f2.directional": "At least one Pin was seen about as often as its group while fewer of those people went on to your site. Direction only — too few comparable Pins for a number.",
  "insights.evidence.finding.f3.quantified": "{matched} of {comparable} Pins sent people to your site. What happens after the click is not visible to VibePin.",
  "insights.evidence.finding.f3.directional": "Pins are sending people to your site. What happens after the click is not visible to VibePin.",
  "insights.evidence.finding.a1.quantified": "{without} of the {checked} Pins published in the last 90 days carry none of your category's search phrases in the title or description.",
  "insights.evidence.finding.a1.directional": "Most Pins published in the last 90 days carry none of your category's search phrases in the title or description.",
  "insights.evidence.finding.a2.quantified": "You published {published} Pins on {activeDays} days in the last 30 days, up to {maxPerDay} in a single day.",
  "insights.evidence.finding.a2.directional": "Your publishing in the last 30 days is bunched into a few days.",
  "insights.evidence.finding.a3.quantified": "{matched} of {withLink} recent Pins point at a link shortener rather than your own domain.",
  "insights.evidence.finding.a3.directional": "Some recent Pins point at a link shortener rather than your own domain.",

  // ── Per-row line in the content table ──
  //    No numbers on purpose: the row already shows Seen, Saved and Went to site in
  //    the columns beside it. These come from the same evidence as the panel above,
  //    so the table and the panel can never disagree.
  "insights.evidence.row.impressionsBelow": "Seen less often than the middle Pin of its group (same format, same age).",
  "insights.evidence.row.outboundBelow": "Seen about as often as its group, but fewer of those people went on to your site.",
  "insights.evidence.row.clicksPresent": "Sent people to your site. What happens after the click is not visible here.",
  "insights.evidence.row.outboundAbove": "More of the people who saw it went on to your site than for its group.",
  "insights.evidence.row.impressionsAbove": "Seen more often than the middle Pin of its group.",
  "insights.evidence.row.savesAbove": "Saved more often than the middle Pin of its group.",
  "insights.evidence.row.typical": "In line with its group (same format, same age).",
  "insights.evidence.row.insufficient": "Not enough comparable Pins yet to place this one.",

  // ── Sample-size caveat (always shown) ──
  //    The line that says what the rest is worth. Age-pinned readings exist only for
  //    Pins collected through their day 1 / 7 / 30; everything older is compared as a
  //    lifetime total inside its age band, and that difference is stated, not hidden.
  "insights.evidence.caveat.lifetime": "Based on {comparable} of {pins} Pins, compared as lifetime totals within groups of the same format and age. Pins published from now on will also carry day-1, day-7 and day-30 readings.",
  "insights.evidence.caveat.agePinned": "Based on {comparable} of {pins} Pins, compared at the same age (day-1, day-7 and day-30 readings).",
  "insights.evidence.caveat.mixed": "Based on {comparable} of {pins} Pins. Some are compared at a fixed age (day-1, day-7, day-30 readings), the rest as lifetime totals.",

  // ── Headlines ──
  "insights.recommendation.headline.f1": "Some Pins were seen less often than the rest of their group.",
  "insights.recommendation.headline.f2": "Your Pins are getting seen — fewer of those people go on to your site.",
  "insights.recommendation.headline.f3": "Your Pins are sending people to your site.",
  "insights.recommendation.headline.a1": "Most recent Pins carry none of your category's search phrases.",
  "insights.recommendation.headline.a2": "Your publishing is bunched into a few days.",
  "insights.recommendation.headline.a3": "Some destination links go through a shortener.",
  "insights.recommendation.headline.fallback": "Nothing stands out yet — here is what we have so far.",

  // ── Keep / Change / Test ──
  //    One variable per recommendation: two changes at once produce a result nobody
  //    can attribute, and the next 30 days teach the user nothing.
  "insights.recommendation.f1.keep": "Keep publishing to the same boards — that is the set these Pins are compared against.",
  "insights.recommendation.f1.change": "Change one thing: the words. Put a phrase people search in your category into the title and the first line of the description.",
  "insights.recommendation.f1.test": "Publish three Pins carrying a search phrase, change nothing else, and compare their Seen count with these after 7 days.",
  "insights.recommendation.f2.keep": "Keep the images and boards of the Pins that get seen — reach is not the gap here.",
  "insights.recommendation.f2.change": "Change one thing: the call to action. Say what is on the other side of the click, on the image and in the first line of the description.",
  "insights.recommendation.f2.test": "Publish three Pins with the new call to action, keep everything else the same, and compare Went to site after 7 days.",
  "insights.recommendation.f3.keep": "Keep the Pins that are sending people to your site.",
  "insights.recommendation.f3.change": "Change one thing: the link. Point it at the page you want measured and add a tracking parameter so your own analytics can see the visit.",
  "insights.recommendation.f3.test": "Tag the links on your next five Pins, then look for those visits in your site analytics after 7 days.",
  "insights.recommendation.a1.keep": "Keep the images that already earn saves.",
  "insights.recommendation.a1.change": "Change one thing: the words. Write one of your category's search phrases into the title and description of your next batch.",
  "insights.recommendation.a1.test": "Do that for the next five Pins, then compare their Seen count with the previous five after 7 days.",
  "insights.recommendation.a2.keep": "Keep the content you are making.",
  "insights.recommendation.a2.change": "Change one thing: when you publish. Spread the same number of Pins across more days.",
  "insights.recommendation.a2.test": "Spread the next two weeks evenly, then compare Seen on those days with the bunched weeks.",
  "insights.recommendation.a3.keep": "Keep the Pins as they are.",
  "insights.recommendation.a3.change": "Change one thing: the link. Point it at your own domain instead of a shortener.",
  "insights.recommendation.a3.test": "Publish the next five Pins with direct links and compare Went to site after 7 days.",

  // ── Panel chrome ──
  "insights.diagnosisPanel.title": "Insights for this account",
  "insights.diagnosisPanel.findings": "What the numbers show",
  "insights.diagnosisPanel.recommendations": "What to try next",
  "insights.diagnosisPanel.keep": "Keep",
  "insights.diagnosisPanel.change": "Change",
  "insights.diagnosisPanel.test": "Test",
  "insights.diagnosisPanel.noFindings": "Nothing stands out in the numbers yet.",
  "insights.diagnosisPanel.confidence.insufficient": "Not enough comparable Pins",
  "insights.diagnosisPanel.confidence.directional": "Direction only",
  "insights.diagnosisPanel.confidence.quantified": "Measured",
  "insights.diagnosisPanel.category": "Category: {category}",
  "insights.diagnosisPanel.categoryUnknown": "Category not set yet",
  "insights.diagnosisPanel.categoryInferred": "Guessed from your boards and Pin titles",
  "insights.diagnosisPanel.variable.hook": "Hook",
  "insights.diagnosisPanel.variable.cta": "Call to action",
  "insights.diagnosisPanel.variable.first_image": "First image",
  "insights.diagnosisPanel.variable.publish_time": "Publishing time",
  "insights.diagnosisPanel.variable.keyword": "Keywords",
  "insights.diagnosisPanel.variable.format": "Format",
  "insights.diagnosisPanel.variable.link": "Destination link",
} as const;
