// Staged i18n keys for web/src/components/studio/PinDetailsDrawer.tsx and
// AiVersionDrawer.tsx. NOT yet wired into en.ts / index.ts / MessageKey — this
// file exists so the new "pinDrawer.*" keys have a single source of English
// copy ready to merge. Until merged, `tr("pinDrawer.x")` calls in those two
// components will show a TS error against MessageKey; that is expected.
export const pinDrawerMessages = {
  // ── Dialog chrome ──
  "pinDrawer.dialogAriaLabel": "Pin Details",
  "pinDrawer.dialogTitle": "Generate AI Image",
  "pinDrawer.subtitle": "Full AI generation workflow, opened only when needed.",

  // ── Tabs ──
  "pinDrawer.tab.remix": "Remix",
  "pinDrawer.tab.debug": "Debug",

  // ── Title suggestions ──
  "pinDrawer.titleSuggestions.hide": "Hide suggestions",
  "pinDrawer.titleSuggestions.viewMore": "View {n} more",
  "pinDrawer.titleSuggestions.use": "Use",

  // ── Content (title/description/destination) ──
  "pinDrawer.content.regenerate": "Regenerate",
  "pinDrawer.content.titlePlaceholder": "Title will appear after generation",
  "pinDrawer.content.descriptionPlaceholder": "Description will appear after generation",
  "pinDrawer.content.lowConfidenceHint": "Add an opportunity or keyword to generate more search-informed titles.",
  "pinDrawer.content.customUrlHelper": "Custom URL — the destination this Pin sends traffic to",
  "pinDrawer.content.linkPrimaryOrPaste": "Link the primary product URL above, or paste your own.",
  "pinDrawer.content.destinationMissing": "Destination URL missing. You can still add this Pin to plan.",

  // ── Setup / Remix tab ──
  "pinDrawer.setup.productImagesUsed": "Product Images used in this batch ({n})",
  "pinDrawer.setup.pinReferencesUsed": "Pin References used as visual direction ({n})",
  "pinDrawer.setup.removeProduct": "Remove product",
  "pinDrawer.setup.removeReference": "Remove reference",
  "pinDrawer.setup.pasteImageUrl": "Paste image URL…",
  "pinDrawer.setup.add": "Add",
  "pinDrawer.setup.productAssetsHelper": "Product assets are separate from Pin references.",
  "pinDrawer.setup.opportunityKeyword": "Opportunity / Keyword",
  "pinDrawer.setup.noOpportunityUsed": "No opportunity used.",
  "pinDrawer.setup.prompt": "Prompt",
  "pinDrawer.setup.settings": "Settings",
  "pinDrawer.setup.images": "Images",
  "pinDrawer.setup.ratio": "Ratio",
  "pinDrawer.setup.model": "Model",
  "pinDrawer.setup.generateAgain": "Generate again",
  "pinDrawer.setup.reset": "Reset",

  // ── Model labels ──
  "pinDrawer.model.gptImage": "GPT Image",
  "pinDrawer.model.nanoBanana": "Nano Banana",

  // ── Recovery notices ──
  "pinDrawer.recovery.partial.title": "Some inputs were reattached below",
  "pinDrawer.recovery.partial.bodyBase": "We recovered the prompt, settings.",
  "pinDrawer.recovery.partial.bodyWithImages": "We recovered the prompt, settings, and most images.",
  "pinDrawer.recovery.missingProductSingular": "{n} product image couldn't be restored.",
  "pinDrawer.recovery.missingProductsPlural": "{n} product images couldn't be restored.",
  "pinDrawer.recovery.missingReferenceSingular": "{n} reference couldn't be restored.",
  "pinDrawer.recovery.missingReferencesPlural": "{n} references couldn't be restored.",
  "pinDrawer.recovery.reattachThenGenerate": "Reattach below, then Generate again.",
  "pinDrawer.recovery.textOnly.title": "Prompt and settings recovered",
  "pinDrawer.recovery.textOnly.body": "Some original inputs are unavailable. We recovered the prompt and settings we could find. Reattach product images or pin references below — or just Generate again with the prompt.",
  "pinDrawer.recovery.unavailable.title": "Original setup wasn't saved",
  "pinDrawer.recovery.unavailable.body": "This Pin was created before setup was saved. Rebuild it below: add product images, add pin references, or use this Pin as a reference, then Generate again.",

  // ── Counts (setup summary for compact failure panel) ──
  "pinDrawer.count.productSingular": "{n} product",
  "pinDrawer.count.productsPlural": "{n} products",
  "pinDrawer.count.referenceSingular": "{n} reference",
  "pinDrawer.count.referencesPlural": "{n} references",

  // ── Product ──
  "pinDrawer.product.fallbackTitle": "Product",

  // ── Products panel ──
  "pinDrawer.products.productLinks": "Product links",
  "pinDrawer.products.addProductLink": "Add product link",
  "pinDrawer.products.noProductHelper": "No product linked yet. Attach a product to keep this Pin connected to a product URL and future performance tracking.",
  "pinDrawer.products.setUpCatalog": "Set up Pinterest catalog",
  "pinDrawer.products.primaryProduct": "Primary product",
  "pinDrawer.products.autoLinked": "Auto-linked",
  "pinDrawer.products.manuallyLinked": "Manually linked",
  "pinDrawer.products.productUrlHelper": "Product URL — fills the Destination URL and gives the Pin context",
  "pinDrawer.products.change": "Change",
  "pinDrawer.products.useAsDestinationUrl": "Use as destination URL",
  "pinDrawer.products.editLink": "Edit link",
  "pinDrawer.products.remove": "Remove",
  "pinDrawer.products.linkedProducts": "Linked products ({n})",
  "pinDrawer.products.setPrimary": "Set primary",
  "pinDrawer.products.edit": "Edit",
  "pinDrawer.products.changeProduct": "Change product",
  "pinDrawer.products.addProduct": "Add product",
  "pinDrawer.products.replacePrimaryHelper": "Replace the primary product for this Pin",
  "pinDrawer.products.linkProductHelper": "Link a product to this Pin",

  // ── Plan tab ──
  "pinDrawer.plan.generatedPinAlt": "Generated pin",
  "pinDrawer.plan.generated": "Generated",
  "pinDrawer.plan.download": "Download",
  "pinDrawer.plan.failedToGenerate": "Failed to generate",
  "pinDrawer.plan.editAndRetry": "Edit and retry",
  "pinDrawer.plan.queued": "Queued…",
  "pinDrawer.plan.generating": "Generating…",
  "pinDrawer.plan.generatingDetails": "Generating Pin details…",
  "pinDrawer.plan.couldNotGenerateDetails": "Could not generate Pin details.",
  "pinDrawer.plan.planHeading": "Plan",
  "pinDrawer.plan.pinterestBoard": "Pinterest board",
  "pinDrawer.plan.suggestedBoardName": "Suggested board name",
  "pinDrawer.plan.boardSuggestionHelper": "Suggestion only — pick the real board when you schedule or publish in Weekly Plan.",
  "pinDrawer.plan.plannedDate": "Planned date",
  "pinDrawer.plan.planStatus": "Plan status",
  "pinDrawer.plan.status.notPlanned": "Not planned",
  "pinDrawer.plan.status.needsDate": "Needs date",
  "pinDrawer.plan.status.scheduled": "Scheduled",
  "pinDrawer.plan.status.posted": "Posted",
  "pinDrawer.plan.copy": "Copy",

  // ── Accessibility ──
  "pinDrawer.accessibility.heading": "Accessibility",
  "pinDrawer.accessibility.altTextPlaceholder": "Alt text will appear after generation",

  // ── Confirm dialogs (Shopify destination URL) ──
  "pinDrawer.confirm.replaceDestinationWithPrimary": "Replace the current destination URL with the primary product URL?",
  "pinDrawer.confirm.usePrimaryAsDestination": "Use the primary product URL as the destination?",

  // ── Shopify freshness ──
  "pinDrawer.shopify.badge.deleted": "Product no longer in your store",
  "pinDrawer.shopify.badge.archived": "Product archived",
  "pinDrawer.shopify.badge.unavailable": "Out of stock",
  "pinDrawer.shopify.warning.deleted": "This product is no longer in your store — the link may no longer work.",
  "pinDrawer.shopify.warning.archived": "This product has been archived in your store — the link may no longer work.",
  "pinDrawer.shopify.warning.unavailable": "This product is currently out of stock.",

  // ── Errors ──
  "pinDrawer.unknownGenerationError": "Unknown generation error.",

  // ── Debug panel ──
  "pinDrawer.debug.section.generationSummary": "A — Generation Summary",
  "pinDrawer.debug.section.categoryAudit": "B — Category Audit",
  "pinDrawer.debug.section.inputAssets": "C — Input Assets",
  "pinDrawer.debug.section.promptAudit": "D — Prompt Audit",
  "pinDrawer.debug.section.recoveryAudit": "E — Recovery Audit",
  "pinDrawer.debug.field.sessionBatch": "Session / batch",
  "pinDrawer.debug.field.pinId": "Pin ID",
  "pinDrawer.debug.field.createdAt": "Created at",
  "pinDrawer.debug.field.model": "Model",
  "pinDrawer.debug.field.format": "Format",
  "pinDrawer.debug.field.textOverlay": "Text overlay",
  "pinDrawer.debug.field.status": "Status",
  "pinDrawer.debug.field.frontendCategory": "Frontend category",
  "pinDrawer.debug.field.detectedVlm": "Detected (VLM)",
  "pinDrawer.debug.field.effectiveCategory": "Effective category",
  "pinDrawer.debug.field.generatorInferred": "Generator inferred",
  "pinDrawer.debug.field.categorySource": "Category source",
  "pinDrawer.debug.field.outputType": "Output type",
  "pinDrawer.debug.field.productImages": "Product images",
  "pinDrawer.debug.field.referenceImages": "Reference images",
  "pinDrawer.debug.field.products": "Products",
  "pinDrawer.debug.field.references": "References",
  "pinDrawer.debug.field.snapshotCategory": "Snapshot category",
  "pinDrawer.debug.field.snapshotKeyword": "Snapshot keyword",
  "pinDrawer.debug.field.snapshotSource": "Snapshot source",
  "pinDrawer.debug.field.recoveryQuality": "Recovery quality",
  "pinDrawer.debug.field.expectedProducts": "Expected products",
  "pinDrawer.debug.field.recoveredProducts": "Recovered products",
  "pinDrawer.debug.field.expectedRefs": "Expected refs",
  "pinDrawer.debug.field.recoveredRefs": "Recovered refs",
  "pinDrawer.debug.value.empty": "(empty)",
  "pinDrawer.debug.value.none": "(none)",
  "pinDrawer.debug.value.auto": "(auto)",
  "pinDrawer.debug.categoryAudit.notAvailable": "Not available — this Pin was created before generation audit data was saved, or the persisted record is missing category_audit.",
  "pinDrawer.debug.categorySource.frontend": "Frontend (user selected)",
  "pinDrawer.debug.categorySource.vlmPlan": "VLM plan (auto-detected)",
  "pinDrawer.debug.categorySource.generatorInference": "Generator inference",
  "pinDrawer.debug.categorySource.fallback": "Fallback (unknown)",
  "pinDrawer.debug.recoveryQuality.full": "Full recovery",
  "pinDrawer.debug.recoveryQuality.visualPartial": "Partial (some images missing)",
  "pinDrawer.debug.recoveryQuality.textOnly": "Text only (no images)",
  "pinDrawer.debug.recoveryQuality.unavailable": "Unavailable",
  "pinDrawer.debug.fashionSafety.active": "Fashion safety guardrail active",
  "pinDrawer.debug.fashionSafety.notApplied": "Fashion safety not applied",
  "pinDrawer.debug.homeDriftDetectedPrefix": "Home-decor drift detected in positive prompt body: ",
  "pinDrawer.debug.enhancerFailed": "Prompt enhancer failed — used fallback",
  "pinDrawer.debug.noneRecoveredPrefix": "{label}: none recovered",
  "pinDrawer.debug.finalPromptSummary": "Final prompt ({n} chars) — click to expand",
  "pinDrawer.debug.storedPromptSummary": "Stored prompt ({n} chars) — click to expand",
  "pinDrawer.debug.noPromptStored": "No prompt stored.",
  "pinDrawer.debug.whySkippedHeading": "Why earlier sources were skipped:",
  "pinDrawer.debug.footerNote": "Category audit is recorded per-session in memory. Reload or close the tab and the audit fields will not be available for older pins — use backend logs for historical records.",

  // ── AiVersionDrawer: asset strips ──
  "pinDrawer.asset.productImages": "Product images",
  "pinDrawer.asset.productImagesHelper": "Main subjects that should appear in the generated Pins.",
  "pinDrawer.asset.noProductImageSelected": "No product image selected.",
  "pinDrawer.asset.styleReferences": "Style references",
  "pinDrawer.asset.styleReferencesHelper": "Guide the visual style, composition, and mood. Optional.",
  "pinDrawer.asset.noReferenceSelected": "No reference selected.",
  "pinDrawer.asset.selectedImage": "Selected image",
  "pinDrawer.asset.removeImage": "Remove image",
  "pinDrawer.asset.currentPinImage": "Current Pin image",
  "pinDrawer.asset.chooseProductImages": "Choose Product Images",
  "pinDrawer.asset.choosePinReferences": "Choose Pin References",

  // ── AiVersionDrawer: recommended references ──
  "pinDrawer.recommended.heading": "Recommended for this product",
  "pinDrawer.recommended.inspirationDisclaimer": "These are style inspiration only — generation borrows visual cues like composition and mood, and never copies these images.",
  "pinDrawer.recommended.styleCuesUsed": "Style cues used:",
  "pinDrawer.recommended.viewOnPinterest": "View on Pinterest",

  // ── AiVersionDrawer: style cue labels ──
  "pinDrawer.styleCue.singleFocus": "single focus",
  "pinDrawer.styleCue.multipleProducts": "multiple products",
  "pinDrawer.styleCue.styledScene": "styled scene",
  "pinDrawer.styleCue.handsInFrame": "hands in frame",
  "pinDrawer.styleCue.personInFrame": "person in frame",
  "pinDrawer.styleCue.subtleText": "subtle text",
  "pinDrawer.styleCue.textOverlay": "text overlay",
  "pinDrawer.styleCue.boldTextOverlay": "bold text overlay",

  // ── AiVersionDrawer: recommended directions ──
  "pinDrawer.directions.heading": "Recommended directions",

  // ── AiVersionDrawer: Pin settings ──
  "pinDrawer.settings.heading": "Pin settings",
  "pinDrawer.settings.numberOfPins": "Number of Pins",
  "pinDrawer.settings.aspectRatio": "Aspect ratio",
  "pinDrawer.settings.resultVariety": "Result variety",
  "pinDrawer.settings.distinct": "Distinct",
  "pinDrawer.settings.similar": "Similar",
  "pinDrawer.settings.productsCountPrefix": "Products: ",
  "pinDrawer.settings.referencesCountPrefix": "References: ",
  "pinDrawer.settings.promptWeightPrefix": "Prompt weight: ",

  // ── AiVersionDrawer: footer ──
  "pinDrawer.footer.generatingEllipsis": "Generating...",
  "pinDrawer.footer.generateCountSingular": "Generate {n} Pin",
  "pinDrawer.footer.generateCountPlural": "Generate {n} Pins",
} as const;
