// Opportunity card / drawer i18n keys (OpportunityCard, OpportunityDetailDrawer,
// OpportunityBriefDrawer). Namespace: "opportunity.*"
// This file is spread into the main en.ts catalog by the i18n coordinator.
//
// Note: market-tag labels (e.g. "Best Bet", "Steady", "High Demand, Hidden Supply")
// and their tooltip copy are pre-existing product-decision wording under the
// Opportunity/Score/Fit compliance rule. Keys below preserve that wording verbatim —
// only the plumbing (hardcoded string -> tr(key)) changed, not the copy itself.
export const opportunityMessages = {
  // ── OpportunityCard ──
  "opportunity.card.estVolume": "Est. Volume",
  "opportunity.card.momentum": "Momentum",
  "opportunity.card.commercial": "Commercial",
  "opportunity.card.densitySuffix": "% density",
  "opportunity.card.analyze": "Analyze",
  "opportunity.card.createPin": "Create Pin",
  "opportunity.momentum.surging": "Surging",
  "opportunity.momentum.steady": "Steady",
  "opportunity.momentum.declining": "Declining",
  "opportunity.tierLabel.bestBet": "Best Bet",
  "opportunity.tierLabel.steady": "Steady",
  "opportunity.trendLabel.rising": "Rising",
  "opportunity.trendLabel.evergreen": "Evergreen",

  // ── Market tag tooltip copy ──
  "opportunity.tag.hiddenSupply.explain": "High audience interest, but almost no sellers have pins here yet.",
  "opportunity.tag.hiddenSupply.action": "Create now — first-mover advantage before others catch on.",
  "opportunity.tag.newAccountFriendly.explain": "Trending up fast and not yet crowded with competing sellers.",
  "opportunity.tag.newAccountFriendly.action": "Ideal for new accounts — post consistently to ride the growth curve.",
  "opportunity.tag.oversaturated.explain": "Too many sellers already targeting this with similar-looking content.",
  "opportunity.tag.oversaturated.action": "Find a sub-niche angle or use a very distinctive visual style.",
  "opportunity.tag.lowVolume.explain": "Small, consistent audience with limited reach potential.",
  "opportunity.tag.lowVolume.action": "Good for testing or supporting content — not your main focus.",

  // ── OpportunityDetailDrawer ──
  "opportunity.detail.nicheIntelligence": "Niche Intelligence",
  "opportunity.detail.estMonthlyVolume": "Est. Monthly Volume",
  "opportunity.detail.commercialDensity": "Commercial Density",
  "opportunity.detail.rawDataPrefix": "Raw data:",
  "opportunity.detail.savesSuffix": "saves",
  "opportunity.detail.pinsSuffix": "pins",
  "opportunity.detail.productsSuffix": "products",
  "opportunity.detail.linkedViralPins": "Linked Viral Pins",
  "opportunity.detail.noLinkedPins": "No linked pins yet — run the scraper to link pins to this keyword.",
  "opportunity.detail.linkedProducts": "Linked Products",
  "opportunity.detail.noLinkedProducts": "No linked products found for this keyword.",
  "opportunity.detail.dataPrefix": "Data:",
  "opportunity.detail.savesLower": "saves",
  "opportunity.detail.createPinForPrefix": "Create Pin for “",
  "opportunity.detail.createPinForSuffix": "”",

  // ── OpportunityBriefDrawer ──
  "opportunity.brief.eyebrow": "Keyword Opportunity Brief",
  "opportunity.brief.scoredBadge": "✓ Scored",
  "opportunity.brief.notAvailableTitle": "Intelligence data not available yet",
  "opportunity.brief.notAvailableBody": "Run pipeline scoring to unlock full opportunity intelligence. Showing trend data below.",
  "opportunity.brief.pinsSeparatorProducts": "pins",
  "opportunity.brief.productsLabel": "products",
  "opportunity.brief.statWeeklyDelta": "Weekly Δ",
  "opportunity.brief.statYoyDelta": "YoY Δ",
  "opportunity.brief.statTotalSaves": "Total Saves",
  "opportunity.brief.statSaveVelocity": "Save Velocity",
  "opportunity.brief.statVolume": "Volume",
  "opportunity.brief.whyRising": "Why This Is Rising",
  "opportunity.brief.topViralPins": "Top Viral Pins",
  "opportunity.brief.noLinkedPins": "No linked pins yet — scraper will populate these automatically.",
  "opportunity.brief.viewAllViralPins": "View all viral pins",
  "opportunity.brief.similar": "Similar",
  "opportunity.brief.productOpportunities": "Product Opportunities",
  "opportunity.brief.liveBadge": "● LIVE",
  "opportunity.brief.productsLinkedSuffix": "products linked to this keyword in database",
  "opportunity.brief.signalLabel": "Signal:",
  "opportunity.brief.shopSignals": "Shop Signals",
  "opportunity.brief.recommendedContentIdeas": "Recommended Content Ideas",
  "opportunity.brief.useIdea": "Use Idea",
  "opportunity.brief.createPinFromOpportunity": "Create Pin From This Opportunity",
} as const;
