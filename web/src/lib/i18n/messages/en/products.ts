// Product Opportunities (web/src/app/app/products/page.tsx) + Digital Product
// Ideas tab (web/src/components/digital/DigitalProductsTab.tsx) + Product Picker
// (web/src/components/products/ProductOpportunityPicker.tsx) — new i18n keys not
// yet merged into the main en.ts catalog / index.ts. See task notes: this file is
// intentionally NOT wired into getMessages() yet.
export const productsMessages = {
  // ── Source filter segmented control ──
  "products.source.all": "All",
  "products.source.productPin": "Product Pin",
  "products.source.stl": "Shop the Look",
  "products.source.productLink": "Product link",
  "products.source.amazon": "Amazon",

  // ── Pinterest Interest / Keyword Trend chips (on-image glass) ──
  // PRD v3.1 §7.6: the badge formerly called "Demand" is "Pinterest Interest" (Pinterest
  // save heat, NOT market demand) and the one called "Trend" is "Keyword Trend" (keyword
  // content heat, NOT sales). The Competition chip is DELETED (§7.6.4) — it was
  // marketplace evaluation and kept dragging the product back into being a scoring tool.
  "products.chip.demandHigh": "High Pinterest interest",
  "products.chip.demandMedium": "Medium Pinterest interest",
  "products.chip.demandLow": "Low Pinterest interest",
  "products.chip.demandNoData": "Pinterest interest: no data",
  "products.chip.trendRising": "↑ Keyword rising",
  "products.chip.trendStable": "→ Keyword stable",
  "products.chip.trendDeclining": "↓ Keyword declining",
  "products.chip.trendNoData": "Keyword trend: no data",

  // ── Product details availability (PRD v3.1 §7.3 / §6.3) ──
  // ONE string for every internal state (blocked / not_found / not_attempted). The
  // technical reason is NEVER shown to the user — no "Merchant blocks preview", no 403.
  "products.details.unavailable": "Product details unavailable",
  "products.details.viewSourceProduct": "View source product",

  // ── Source type labels (sourceTypeLabel) ──
  "products.sourceType.shopTheLook": "Shop the Look",
  "products.sourceType.productPin": "Product Pin",
  "products.sourceType.productLinkPin": "Product link Pin",
  "products.sourceType.pinterestPin": "Pinterest Pin",
  "products.sourceType.sourcePinsSuffix": "{n} source pins",

  // ── Relative time labels ──
  "products.time.justFound": "just found",
  "products.time.minsAgo": "{n}m ago",
  "products.time.hoursAgo": "{n}h ago",
  "products.time.dayAgo": "{n} day ago",
  "products.time.daysAgo": "{n} days ago",
  "products.time.moAgo": "{n} mo ago",
  "products.time.yrAgo": "{n} yr ago",
  "products.time.compactNow": "now",
  "products.time.compactMins": "{n}m",
  "products.time.compactHours": "{n}h",
  "products.time.compactDays": "{n}d",
  "products.time.compactMonths": "{n}mo",
  "products.time.compactYears": "{n}y",

  // ── Saves labels ──
  "products.saves.unavailable": "Saves unavailable",
  "products.saves.count": "{n} saves",

  // ── Product card ──
  "products.card.deselect": "Deselect product for Create Pins",
  "products.card.select": "Select this product for Create Pins",
  "products.card.savesTitle": "Pinterest saves: {n}",
  "products.card.foundTitle": "Found {time}",
  "products.card.foundTitleUnavailable": "Found date unavailable",
  "products.card.generatePin": "Generate Pin",
  "products.card.removeFromLibrary": "Remove from Product Library",
  "products.card.saveProduct": "Save Product",
  "products.card.removedFromLibrary": "Removed from Product Library",
  "products.card.savedToLibrary": "Saved to Product Library",

  // ── Drawer signal rows ──
  // "products.drawer.competition" is DELETED (v3.1 §7.6.4) — Competition is removed from
  // the Detail view too, not merely hidden from the card.
  "products.drawer.signals": "Signals",
  "products.drawer.demand": "Pinterest Interest",
  "products.drawer.trend": "Keyword Trend",
  "products.drawer.notEnoughData": "Not enough data",
  "products.drawer.levelHigh": "High",
  "products.drawer.levelMedium": "Medium",
  "products.drawer.levelLow": "Low",
  "products.drawer.trendRising": "Rising",
  "products.drawer.trendStable": "Stable",
  "products.drawer.trendDeclining": "Declining",
  "products.drawer.sourceType": "Source type",
  "products.drawer.validatingSourcePins": "Validating source pins",
  "products.drawer.trendKeyword": "Trend keyword",
  "products.drawer.searchKeyword": "Search keyword",
  "products.drawer.found": "Found",
  "products.drawer.productPinUrl": "Product Pin URL",
  "products.drawer.sourcePinUrl": "Source Pin URL",
  "products.drawer.externalProductUrl": "External Product URL",
  "products.drawer.validatingSourcePinsCount": "Validating source pins ({n})",
  "products.drawer.pinIndex": "Pin {n}",
  "products.drawer.similarProducts": "Similar Products",
  "products.drawer.similarProductsHint": "Products sharing this item's keyword or category, from the currently loaded set.",
  "products.drawer.savesSuffix": "{n} saves",
  "products.drawer.openProductPin": "Open Product Pin",
  "products.drawer.openSourcePin": "Open Source Pin",
  "products.drawer.savedProduct": "Saved Product",
  "products.drawer.saveProduct": "Save Product",

  // ── Pin Ideas CTA ──
  "products.pinIdeasCta": "Need visual inspiration? Browse Pin Ideas",

  // ── Page header ──
  "products.header.howItWorks": "How it works",
  "products.header.refresh": "Refresh",

  // ── Type cards ──
  "products.typeCard.physical": "Physical Products",
  "products.typeCard.digital": "Digital Products",
  "products.typeCard.totalOpportunities": "{n} total opportunities",

  // ── Keyword breadcrumb ──
  "products.breadcrumb.from": "From",
  "products.breadcrumb.keywordTrends": "Keyword Trends",
  "products.breadcrumb.showingMatches": "— showing matching product opportunities.",
  "products.breadcrumb.clear": "Clear",

  // ── Control row ──
  "products.search.placeholder": "Search products, keywords, or niches...",
  "products.sort.label": "Sort by",
  "products.sort.relevance": "Relevance",
  "products.sort.mostSaved": "Most saved",
  "products.sort.rising": "Rising trend",
  // "products.sort.lowCompetition" is DELETED (v3.1 §7.6.4 — the sort goes with the badge).
  "products.sort.newest": "Newest found",
  "products.sort.price": "Price",
  "products.filters.button": "Filters",
  "products.filters.category": "Category",
  "products.filters.allCategories": "All categories",
  "products.filters.platform": "Platform",
  "products.filters.allPlatforms": "All platforms",
  "products.filters.price": "Price",
  "products.filters.allPrices": "All prices",
  "products.filters.under25": "Under $25",
  "products.filters.25to100": "$25-$100",
  "products.filters.over100": "$100+",
  "products.filters.type": "Type",
  "products.filters.allTypes": "All types",
  "products.filters.printables": "Printables",
  "products.filters.templates": "Templates",
  "products.filters.affiliate": "Affiliate",
  "products.filters.urlImported": "URL Imported",
  "products.filters.editNiches": "Edit niches",
  "products.filters.closeAria": "Close",
  "products.saveView": "Save View",
  "products.saveViewToast": "View saved",
  "products.productPicker": "Product Picker",

  // ── Active filter chips ──
  "products.chipLabel.category": "Category: {value}",
  "products.chipLabel.niche": "Niche: {value}",
  "products.chipLabel.nicheSelected": "Selected",
  "products.chipLabel.platform": "Platform: {value}",
  "products.chipLabel.price": "Price: {value}",
  "products.chipLabel.type": "Type: {value}",
  "products.clearAll": "Clear all",

  // ── Empty / reduced results states ──
  "products.empty.noSourceProducts": "No {source} products found yet.",
  "products.empty.totalHint": "{n} {class} products exist - clearing filters will show them.",
  "products.empty.clearFilters": "Clear filters",
  "products.results.clearFilters": "Clear filters",

  // ── Pagination ──
  "products.pagination.selectedPrefix": "{n} selected - ",
  "products.pagination.productsCount": "{n} {class} products",
  "products.pagination.prev": "Prev",
  "products.pagination.next": "Next",
  "products.pagination.show": "Show",

  // ── Footer note ──
  "products.footerNote": "Product Opportunities use product-level Pinterest saves when available. Source Pin saves stay separate in details.",

  // ── Selected-products action bar ──
  "products.actionBar.selectedCount": "{n} product{plural} selected",
  "products.actionBar.clear": "Clear",
  "products.actionBar.createPins": "Create Pins",

  // ── Digital Product Ideas tab ──
  "products.digital.heading": "Digital Product Ideas",
  "products.digital.subtitle": "Downloadable, printable & template products by niche",
  "products.digital.viewTable": "Table",
  "products.digital.viewCards": "Cards",
  "products.digital.nicheLabel": "Niche",
  "products.digital.allNiches": "All niches",
  "products.digital.allFormats": "All formats",
  "products.digital.searchPlaceholder": "Search ideas…",
  "products.digital.ideasCount": "{n} ideas",
  "products.digital.colIdea": "Idea",
  "products.digital.colNiche": "Niche",
  "products.digital.colFormat": "Format",
  "products.digital.colValidation": "Validation",
  "products.digital.colSignal": "Signal",
  "products.digital.colTrend": "Trend",
  "products.digital.colActions": "Actions",
  "products.digital.noMatch": "No ideas match your filter",
  "products.digital.notValidated": "● Not validated",
  "products.digital.checkTrends": "Check Trends",
  "products.digital.trends": "Trends",
  "products.digital.create": "Create",
  "products.digital.plan": "Plan",
  "products.digital.planToastTitle": "Opened in Workspace for planning",

  // ── Trend Validation Drawer ──
  "products.trendDrawer.title": "Check Pinterest Trends",
  "products.trendDrawer.subtitle": "Use query variants to validate demand before creating pins.",
  "products.trendDrawer.searchQueries": "Pinterest search queries",
  "products.trendDrawer.copyQuery": "Copy query",
  "products.trendDrawer.openInTrends": "Open in Pinterest Trends",
  "products.trendDrawer.copiedQuery": "Copied query",
  "products.trendDrawer.createWithIdea": "Create Pins with this idea",
  "products.trendDrawer.addToPlan": "Add to Plan",

  // ── Product Opportunity Picker ──
  "products.picker.title": "Product Picker for Create Pins",
  "products.picker.subtitle": "Choose products to include in your pin generation.",
  "products.picker.tabMyProducts": "My Products",
  "products.picker.tabOpportunities": "Product Opportunities",
  "products.picker.tabUpload": "Upload Images",
  "products.picker.tabLink": "Use a Link",
  "products.picker.searchProducts": "Search products or niches...",
  "products.picker.categoryPrefix": "Category:",
  "products.picker.allCategories": "All categories",
  "products.picker.sortSaves": "Sort: Saves",
  "products.picker.sortPrice": "Sort: Price",
  "products.picker.noOpportunities": "No product opportunities match your search.",
  "products.picker.noSavedProducts": "No saved products yet. Add some from Product Opportunities, Upload, or a Link.",
  "products.picker.uploadCta": "Click to upload product images",
  "products.picker.uploadHint": "PNG / JPG · added to your selection and saved to My Products",
  "products.picker.productUrlLabel": "Product URL",
  "products.picker.linkPlaceholder": "https://example.com/product",
  "products.picker.fetch": "Fetch",
  "products.picker.linkHint": "We'll extract the product image, title, and store from the link and add it to your selection.",
  "products.picker.defaultProductLabel": "Product",
  "products.merchantFallback": "Shop",
  "products.picker.selectedCount": "{n} product{plural} selected",
  "products.picker.moreCount": "+{n} more",
  "products.picker.cancel": "Cancel",
  "products.picker.addSelected": "Add Selected",
  "products.picker.addSelectedToCreatePins": " to Create Pins",
  "products.picker.footerHint": "Selected products are saved to My Products for future use.",
  "products.picker.imagesAdded": "{n} image{plural} added",
  "products.picker.productAddedFromLink": "Product added from link",
  "products.picker.linkImportError": "Could not extract product data from this URL.",

  // ── Product evidence (honest save-count labels + tooltips) ──
  "products.evidence.savesAcrossPins": "{saves} saves across {n} product Pins",
  "products.evidence.savesAcrossPinsTooltip": "Saves aggregated across {n} Pinterest product Pins for this product (deduplicated by {identity}). Source: Pinterest Shop the look.",
  "products.evidence.savesOnProductPin": "{saves} saves on this product Pin",
  "products.evidence.savesOnProductPinTooltip": "Saves on this product's own Pinterest product Pin. Source: Pinterest Shop the look.",
  "products.evidence.savesOnSourcePin": "{saves} saves on source Pin",
  "products.evidence.savesOnSourcePinWithSources": "{saves} saves on source Pin · {n} Pinterest sources",
  "products.evidence.savesOnSourcePinTooltip": "Pinterest does not expose a separate save count for this product. Shown: saves on the source \"Shop the look\" Pin it was found in — source-Pin engagement, not product saves.",
};
