// Pin Ideas (web/src/app/app/discover/page.tsx) — new i18n keys not yet merged
// into the main en.ts catalog / index.ts. See web/src/lib/i18n/messages/en/plan.ts
// header comment for the pattern this file follows: intentionally NOT wired into
// getMessages() yet.
export const discoverMessages = {
  // ── Content-first signal labels ──
  "discover.signal.productRelated": "Product Related",
  "discover.signal.contentOnly": "Content Only",
  "discover.signal.fastSaving": "⚡ Fast saving",

  // ── Keyword trend badge (display text; keys are internal comparison labels) ──
  "discover.badge.seasonalNow": "Seasonal now",
  "discover.badge.risingKeyword": "Rising keyword",
  "discover.badge.decliningKeyword": "Declining keyword",
  "discover.badge.evergreen": "Evergreen",

  // ── Pin insights (Why it works / Optimization / Publishing tip) ──
  "discover.insight.savingFaster": "Saving faster than 90% of {category} pins loaded right now ({velocity}/day).",
  "discover.insight.provenResonance": "{saves} users saved this pin — proven audience resonance.",
  "discover.insight.titleMatchesIntent": "Title contains the search term “{keyword}” — matches real search intent.",
  "discover.insight.verticalRatio": "2:3 vertical ratio — Pinterest's preferred format, gets full-height feed display.",
  "discover.insight.textOverlay": "Uses a text overlay, giving searchers an instant reason to save.",
  "discover.insight.trendRising": "Its trend keyword “{keyword}” is rising on Pinterest (+{percent}% year over year).",
  "discover.insight.earlyMomentum": "Collected {saves} saves within its first month — early momentum.",
  "discover.format.tutorial": "Step-by-step content earns repeat saves and long shelf life on Pinterest.",
  "discover.format.collage": "Collage layouts pack multiple ideas into one save — high reference value.",
  "discover.format.moodboard": "Moodboard-style pins are saved as planning references, extending their lifespan.",
  "discover.format.quote": "Typographic pins read instantly at feed size and travel across boards.",
  "discover.format.textOverlay": "A clear text hook tells searchers exactly what they get before they click.",
  "discover.format.productShot": "A clean product hero makes the subject unmistakable in a crowded feed.",
  "discover.format.lifestyle": "In-context scenes help users picture the idea in their own life — a strong save trigger.",
  "discover.format.beforeAfter": "Transformations create instant curiosity and are highly re-saved.",
  "discover.format.checklist": "Checklist formats promise actionable value — a classic save-for-later trigger.",
  "discover.format.infographic": "Dense, skimmable information earns saves as a reference to return to.",
  "discover.optimize.writeDescriptiveTitle": "Write a descriptive title (30–60 chars) that includes “{keyword}”.",
  "discover.optimize.workSearchTermIntoTitle": "Work the search term “{keyword}” into your title and description.",
  "discover.optimize.useVerticalCanvas": "Use a 2:3 vertical canvas (e.g. 1000×1500) — this pin's ratio loses feed real estate.",
  "discover.optimize.considerTextOverlay": "Consider a short text overlay — a headline or list hook lifts saves for discovery content.",
  "discover.optimize.attachProductLink": "This is a product-related pin — attach your product/destination link so demand can convert.",
  "discover.optimize.timeSeasonalWindow": "Time your publication to the seasonal window for “{keyword}”.",
  "discover.publishingTip.rising": "Good timing — this topic's searches are rising, publishing a similar pin now can ride the trend.",
  "discover.publishingTip.declining": "This topic's searches are declining — consider a fresher angle or a related rising keyword.",
  "discover.publishingTip.seasonal": "Seasonal topic — publish ahead of the peak window for the best reach.",
  "discover.publishingTip.fastSaving": "This style is gaining saves quickly right now — a strong moment to publish your version.",

  // ── Pin drawer ──
  "discover.drawer.viewEvidence": "View Evidence",
  "discover.drawer.discoveredVia": "Discovered via",
  "discover.drawer.trendKeyword": "Trend keyword",
  "discover.drawer.searchKeyword": "Search keyword",
  "discover.drawer.dropdownRank": "Dropdown rank",
  "discover.drawer.dropdownRankValue": "#{n} in Pinterest search suggestions",
  "discover.drawer.savesPerDay": "Saves/day",
  "discover.drawer.age": "Age",
  "discover.drawer.reactions": "Reactions",
  "discover.drawer.pinTitle": "Pin Title",
  "discover.drawer.whyItWorks": "Why it works",
  "discover.drawer.optimizationSuggestions": "Optimization Suggestions",
  "discover.drawer.createPinFromIdea": "Create Pin from this idea",
  "discover.drawer.useAsPinReference": "Use as Pin Reference",
  "discover.drawer.similarPins": "Similar Pins",
  "discover.drawer.similarPinsCaption": "Pins discovered via the same keyword, from the currently loaded set.",
  "discover.drawer.relatedProducts": "Related Products",
  "discover.drawer.savesSuffix": " saves",

  // ── Gallery card ──
  "discover.card.untitledPin": "Untitled pin",
  "discover.card.removeFromReferenceLibrary": "Remove from Reference Library",
  "discover.card.saveToReferenceLibrary": "Save to Reference Library",
  "discover.card.searchKeywordTitlePrefix": "Search keyword: ",
  "discover.toast.removedFromReferenceLibrary": "Removed from Reference Library",
  "discover.toast.savedToReferenceLibrary": "Saved to Reference Library",

  // ── Pagination ──
  "discover.pagination.show": "Show",
  "discover.pagination.perPage": "per page",

  // ── Analysis table ──
  "discover.table.category": "Category",
  "discover.table.searchKeyword": "Search keyword",
  "discover.table.format": "Format",
  "discover.table.signal": "Signal",
  "discover.table.saves": "Saves",
  "discover.table.savesPerDay": "Saves/day",
  "discover.table.createPinFromIdea": "Create Pin from this idea",
  "discover.table.useAsPinReference": "Use as Pin Reference",
  "discover.table.evidence": "Evidence",

  // ── Demo: email capture modal ──
  "discover.capture.onTheList": "You're on the list.",
  "discover.capture.confirmBody": "We'll use your {n} selections to prepare your weekly Pinterest plan when beta access opens.",
  "discover.capture.continueDemo": "Continue demo",
  "discover.capture.eyebrow": "Weekly Pin Plan · {n} of 7 selected",
  "discover.capture.heading": "Get your 7-day Pinterest plan",
  "discover.capture.body": "We'll send a weekly plan with 7 trend-backed Pin ideas, title angles, and monetization signals — based on your Home Decor selections.",
  "discover.capture.emailPlaceholder": "your@email.com",
  "discover.capture.sending": "Sending…",
  "discover.capture.sendPlan": "Send my weekly plan",

  // ── Demo banner ──
  "discover.demo.banner": "Demo · Home Decor · 10 of 48 opportunities shown",
  "discover.demo.bannerSelectHint": "Select 7 to build your weekly Pin plan",

  // ── Demo analysis row ──
  "discover.demoRow.selected": "✓ Selected",
  "discover.demoRow.selectForPlan": "+ Select for weekly plan",
  "discover.demoRow.hideEvidence": "Hide ▲",
  "discover.demoRow.whyThis": "Why this? ▼",
  "discover.demoRow.viewPins": "🖼️ View Pins",
  "discover.demoRow.evidence.demand": "Demand",
  "discover.demoRow.evidence.saturation": "Saturation",
  "discover.demoRow.evidence.monetization": "Monetization",

  // ── Demo progress bar ──
  "discover.progress.complete": "✅ Weekly plan complete",
  "discover.progress.title": "📋 Weekly plan",
  "discover.progress.selectedSuffix": "selected",
  "discover.progress.selectMoreOpportunity": "· Select {n} more opportunity to build your plan",
  "discover.progress.selectMoreOpportunities": "· Select {n} more opportunities to build your plan",
  "discover.progress.getPlan": "Get my 7-day Pin plan →",

  // ── Header (non-demo) ──
  "discover.header.saved": "Saved ({n})",
  "discover.header.howItWorks": "How it works",
  "discover.header.filters": "Filters",
  "discover.header.testMetrics": "Test Metrics",
  "discover.help.body1Prefix": "Pin Ideas",
  "discover.help.body1Suffix": " are visual references and content angles — layouts, formats, and creative inspiration.",
  "discover.help.body2Prefix": "Filter by ",
  "discover.help.body2Mid": "Format",
  "discover.help.body2Mid2": " to find a style, then ",
  "discover.help.body2UseAsReference": "Use as Reference",
  "discover.help.body2Suffix": " to send it into Create Pins.",
  "discover.help.body3Prefix": "Looking for products to promote? Head to ",
  "discover.help.body3Link": "Product Ideas",
  "discover.help.body3Suffix": ".",

  // ── Header (demo) ──
  "discover.demoHeader.title": "Pin Ideas",
  "discover.demoHeader.subtitleSuffix": "— Home Decor · Demo",
  "discover.demoHeader.subtitle": "Top Home Decor opportunities · tier + monetization + title template per pin · 10 of 48 shown",
  "discover.demoHeader.homeDecor": "🏠 Home Decor",
  "discover.demoHeader.moreLocked": "17 more categories locked",

  // ── Search + toolbar ──
  "discover.search.placeholder": "Search pin ideas, topics, styles, or keywords...",
  "discover.manageNiches": "Manage niches",

  // ── Keyword breadcrumb ──
  "discover.breadcrumb.fromPrefix": "From ",
  "discover.breadcrumb.keywordTrends": "Keyword Trends",
  "discover.breadcrumb.suffix": " — showing pins discovered via this keyword.",
  "discover.breadcrumb.clear": "Clear",

  // ── Filter strip ──
  "discover.stats.ideasFound": "Ideas found",
  "discover.stats.fastSaving": "Fast saving",
  "discover.stats.productRelated": "Product related",
  "discover.stats.withKeyword": "With keyword",
  "discover.view.gallery": "Gallery",
  "discover.view.analysis": "Analysis",
  "discover.filter.format": "Format",
  "discover.filter.all": "All",
  "discover.filter.niche": "Niche",
  "discover.filter.allNiches": "All Niches",
  "discover.filter.signal": "Signal",
  "discover.filter.freshness": "Freshness",
  "discover.filter.last7Days": "Last 7 days",
  "discover.filter.last30Days": "Last 30 days",
  "discover.filter.last90Days": "Last 90 days",
  "discover.filter.trendKeyword": "Trend keyword",
  "discover.filter.searchKeyword": "Search keyword",
  "discover.filter.sortBy": "Sort by",
  "discover.sort.mostSaved": "Most saved",
  "discover.sort.fastestSaving": "Fastest saving",
  "discover.sort.newestFound": "Newest found",

  // ── Empty / loading states ──
  "discover.empty.noPinsForNiches": "No viral pins found for your selected niches.",
  "discover.empty.tryAllTrends": "Try switching to All Trends or a different category.",
  "discover.empty.showAllTrends": "Show All Trends",
  "discover.empty.noPinsMatchFilters": "No pins match the current filters.",
  "discover.empty.clearFilters": "Clear Filters",
  "discover.empty.noPinsInCategory": "No viral pins in this category yet.",

  // ── Demo locked teaser cards ──
  "discover.locked.blueOcean.title": "1 more Blue Ocean hidden",
  "discover.locked.blueOcean.sub": "Low competition · High save velocity",
  "discover.locked.shoppable.title": "8 shoppable product signals locked",
  "discover.locked.shoppable.sub": "Etsy + Amazon affiliate opportunities",
  "discover.locked.unlockMore.title": "Unlock 40+ more weekly opportunities",
  "discover.locked.unlockMore.sub": "Build 14-day and 30-day Pin plans",
  "discover.locked.signUpFree": "Sign up free →",

  // ── Selected-references action bar ──
  "discover.refBar.referenceSingular": "reference",
  "discover.refBar.referencesPlural": "references",
  "discover.refBar.selectedSuffix": " selected",
  "discover.refBar.clear": "Clear",
  "discover.refBar.addToCreatePins": "Add to Create Pins",

  // ── Demo mode: monetization hint / saturation evidence / monetization route ──
  "discover.mon.hiddenSupply": "Affiliate Products (Etsy + Amazon) — High ROI",
  "discover.mon.newAccountFriendly": "Product Roundups — Growing Demand",
  "discover.mon.oversaturated": "Niche Sub-category Affiliate",
  "discover.mon.lowVolume": "Low-volume Testing Ground",
  "discover.sat.hiddenSupply": "Blue Ocean — few sellers in feed, low competition density. Good entry window right now.",
  "discover.sat.newAccountFriendly": "Early Trend — still accessible for new accounts. Competition will intensify within 30–60 days.",
  "discover.sat.oversaturated": "Red Sea — high competition, conversion efficiency declining. Consider long-tail sub-niches instead.",
  "discover.sat.lowVolume": "Low volume — limited search demand. High risk, limited return.",
  "discover.route.hiddenSupply": "Etsy + Amazon affiliate — high-ROI products confirmed in top-saving Pins.",
  "discover.route.newAccountFriendly": "Amazon product roundups — growing category, easier to rank for new accounts.",
  "discover.route.oversaturated": "Niche sub-category affiliate — avoid broad terms, go specific to convert.",
  "discover.route.lowVolume": "Low-volume test market — validate interest before committing budget.",

  // ── Demo title templates (demoTitleTemplate) ──
  "discover.titleTpl.homeDecor": "10 {category} Ideas That Will Transform Your Space",
  "discover.titleTpl.fashion": "The {category} Look for 2026: Everything Worth Pinning",
  "discover.titleTpl.beauty": "{category} Essentials: A Curated Pinterest Guide",
  "discover.titleTpl.wedding": "{category} Inspiration: Ideas Every Planner Is Saving",
  "discover.titleTpl.default": "The Best {category} Ideas Worth Pinning This Season",

  // ── Demo analysis row evidence text ──
  "discover.evidence.demandHigh": "{saves} saves · {velocity}/day velocity — high confirmed demand",
  "discover.evidence.demandGrowing": "{saves} saves · {velocity}/day velocity — growing demand",
  "discover.evidence.demandEarly": "{saves} saves — early-stage interest, monitor for growth",
  "discover.demoRow.blurredTeaserTitle": "How to Style {category} on a Budget: Expert Tips",
  "discover.demoRow.unlock": "Unlock",
} as const;
