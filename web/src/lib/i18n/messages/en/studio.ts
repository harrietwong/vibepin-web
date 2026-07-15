// Studio (Create Pins) page-specific i18n keys.
// Namespace: "studio.*"
// This file is spread into the main en.ts catalog by the i18n coordinator.
// Interpolation convention: English values use {placeholder} tokens; call sites do
// tr("studio.x").replace("{n}", String(value)).
export const studioMessages = {
  // ── Header ──
  "studio.header.title": "Create Pins",
  "studio.header.saveDraft": "Save draft",
  "studio.header.history": "History",
  "studio.header.submitting": "Submitting…",

  // ── Asset entry (product/reference remove buttons) ──
  "studio.asset.removeProduct": "Remove product {n}",
  "studio.asset.removeReference": "Remove reference {n}",

  // ── Opportunity drawer ──
  "studio.oppDrawer.title": "Choose Opportunity",
  "studio.oppDrawer.subtitle": "Add an optional market angle for this generation.",
  "studio.oppDrawer.tabRecommended": "Recommended",
  "studio.oppDrawer.tabRecent": "Recent",
  "studio.oppDrawer.searchPlaceholder": "Search opportunities…",
  "studio.oppDrawer.noRecent": "No recent opportunities yet",
  "studio.oppDrawer.noContextMatch": "No matching opportunities found for this upload. You can search all opportunities or generate without one.",
  "studio.oppDrawer.noResults": "No results",

  // ── Opportunity tier labels ──
  "studio.tier.bestBet": "Best Bet",
  "studio.tier.steady": "Steady",
  "studio.tier.competitive": "Competitive",

  // ── Batch toolbar ──
  "studio.batch.selectedCount": "{n} selected",
  "studio.batch.generatePinDetails": "Generate Pin Details",
  "studio.batch.editDetails": "Batch Edit Details",
  "studio.batch.addSelectedToPlan": "Add selected to Plan",
  "studio.batch.clearSelection": "Clear selection",

  // ── Feed ──
  "studio.feed.noGenerationsInTab": "No generations in this tab yet.",

  // ── Pin card status badges ──
  "studio.badge.failed": "Failed",
  "studio.badge.queued": "Queued",
  "studio.badge.generating": "Generating",
  "studio.badge.posted": "Posted",
  "studio.badge.scheduled": "Scheduled",
  "studio.badge.scheduledOn": "Scheduled {date}",
  "studio.badge.unscheduled": "Unscheduled",

  // ── Pin card counts / footer ──
  "studio.count.products": "{n} product",
  "studio.count.refs": "{n} ref",
  "studio.footer.postedOn": "Posted {date}",
  "studio.footer.scheduledOn": "Scheduled {date}",

  // ── Pin card placeholder states ──
  "studio.placeholder.stillGenerating": "Still generating",
  "studio.placeholder.failedToGenerate": "Failed to generate",
  "studio.placeholder.retrying": "Retrying…",

  // ── Pin card chrome ──
  "studio.card.generatedSetTitle": "Generated Set {id}",
  "studio.card.generatedPinAlt": "Generated pin",
  "studio.card.outputOfTotal": "Output {n} of {total}",
  "studio.card.batchOfOne": "Batch · 1 pin",
  "studio.card.batchOfTotal": "Batch · {total} pins",

  // ── Confirm dialogs ──
  "studio.confirm.overwriteTitle": "Overwrite edited title?",
  "studio.confirm.overwriteDescription": "Overwrite edited description?",

  // ── Product ──
  "studio.product.amazonProduct": "Amazon product",

  // ── Settings panel ──
  "studio.settings.model": "Model:",
  "studio.settings.results": "Results:",
  "studio.settings.similarOptions": "Similar options",
  "studio.settings.moreVariety": "More variety",
  "studio.settings.moreVarietyHint": "Keeps the same products and direction, but changes pose and composition.",
  "studio.settings.recommendedRatio": "Recommended: 2:3",
  "studio.settings.overLimitWarning": "{n} Pins. Consider reducing references or count.",

  // ── Developer-only debug panels ──
  "studio.debug.aiDirection": "AI Direction",
  "studio.debug.scene": "Scene",
  "studio.debug.style": "Style",
  "studio.debug.layout": "Layout",
  "studio.debug.products": "Products",
  "studio.debug.willAnalyze": "AI will analyze your products and references when generating.",
  "studio.debug.developerDebug": "Developer Debug",
  "studio.debug.referenceMode": "Reference mode:",
  "studio.debug.imagesCount": "{n} images",
  "studio.debug.productsWeight": "Products weight",
  "studio.debug.referencesWeight": "References weight",

  // ── Errors (getReadableGenerationError) ──
  "studio.error.imageProcessFailed.title": "Couldn’t process an input image",
  "studio.error.imageProcessFailed.body": "Try generating this Pin again. If it continues, remove and re-upload the affected product or reference image.",
  "studio.error.generationBusy.title": "Generation is busy",
  "studio.error.generationBusy.body": "Please try again shortly.",
  "studio.error.generationAlreadyRunning.title": "A generation is already running",
  "studio.error.generationAlreadyRunning.body": "You already have a generation running. Please wait for it to finish.",
  "studio.error.misconfigured.title": "Generation is not configured correctly",
  "studio.error.misconfigured.body": "Please check server settings.",
  "studio.error.safetyBlocked.title": "Blocked by safety filters",
  "studio.error.safetyBlocked.body": "Adjust the products, reference, or direction and try again.",
  "studio.error.serviceBusy.title": "The image service is busy",
  "studio.error.serviceBusy.body": "Wait a moment, then try this Pin again.",
  "studio.error.serviceUnavailable.title": "Image service unavailable",
  "studio.error.serviceUnavailable.body": "This is a configuration issue on our side — please try again later.",
  "studio.error.generateFailed.title": "Couldn’t generate this Pin",
  "studio.error.generateFailed.body": "Try again. If it continues, edit the inputs and regenerate.",

  // ── VibePin Assistant contexts ──
  "studio.assistant.pinEdit": "Pin Edit",
  "studio.assistant.oneProduct": "1 product",
  "studio.assistant.nProducts": "{n} products",
  "studio.assistant.oneReference": "1 reference",
  "studio.assistant.nReferences": "{n} references",
  "studio.assistant.createPinsGreeting": "Hi, I'm VibePin Assistant. Ask me anything about your creative setup, products, references, or how to get stronger Pins.",
  "studio.assistant.checkMySetup": "Check my setup",
  "studio.assistant.suggestAngles": "Suggest Pinterest angles",
  "studio.assistant.reviewDirection": "Review my creative direction",
  "studio.assistant.editingTitle": "Editing “{title}”",
  "studio.assistant.singlePinGreeting": "Ask me anything about this Pin — title, description, destination URL, or schedule readiness.",
  "studio.assistant.readyToSchedule": "Is this ready to schedule?",
  "studio.assistant.improveDescription": "Improve the description",

  // ── Toasts ──
  "studio.toast.needInputFirst": "Add a prompt, product image, or reference first.",
  "studio.toast.limitedToOneImage": "Limited to 1 image for this request",
  "studio.toast.limitedToNImages": "Limited to {n} images for this request",
  "studio.toast.providerProtectionActive": "Provider protection is active for this batch.",
  "studio.toast.oneImageDidntGenerate": "1 image didn't generate — tap retry to top up.",
  "studio.toast.nImagesDidntGenerate": "{n} images didn't generate — tap retry to top up.",
  "studio.toast.nOfTotalGenerated": "{n} of {total} generated",
  "studio.toast.noImagesReturned": "No images returned",
  "studio.toast.referenceNFailed": "Reference {n} failed",
  "studio.toast.networkError": "Network error",
  "studio.toast.oneGenerated": "1 pin generated",
  "studio.toast.nGenerated": "{n} pins generated",
  "studio.toast.savedAsReference": "Saved as reference.",
  "studio.toast.pinDetailsGeneratedForN": "Pin Details generated for {n} pins",
  "studio.toast.addedOnePinToPlan": "Added 1 pin to plan",
  "studio.toast.addedPinsToPlan": "Added {n} pins to plan",
  "studio.toast.skippedCount": "{n} skipped",
  "studio.toast.oneAlreadyScheduled": "1 Pin is already scheduled",
  "studio.toast.nAlreadyScheduled": "{n} Pins are already scheduled",
  "studio.toast.scheduledOnePin": "Scheduled 1 Pin",
  "studio.toast.scheduledNPins": "Scheduled {n} Pins",
  "studio.toast.nAlreadyScheduledSuffix": "{n} already scheduled",
  "studio.toast.promptLoadedLegacy": "Prompt loaded — original assets unavailable for this older generation",
  "studio.toast.setupLoadedIntoComposer": "Setup loaded into composer",
  "studio.toast.oneNewGenerated": "1 new pin generated",
  "studio.toast.nNewGenerated": "{n} new pins generated",
  "studio.toast.addedToPlan": "Added to Weekly Plan",
  "studio.toast.alreadyAddedToPlan": "Already added to plan",
  "studio.toast.addedToPlanNeedsDate": "Added to Weekly Plan · Needs date",
  "studio.toast.readyForPublishOn": "Ready for publish · {date}.",
  "studio.toast.readyForPublish": "Ready for publish.",
  "studio.toast.needsReviewScheduledOn": "Needs review · scheduled {date}.",
  "studio.toast.assignDateHint": "Assign a date in Weekly Plan to schedule it.",
  "studio.toast.viewInWeeklyPlan": "View in Weekly Plan",
  "studio.toast.retrySuccess": "Retried successfully — added to this set",
  "studio.toast.networkErrorRetry": "Network error during retry",
  "studio.toast.tryAgainShortly": "Please try again shortly.",
  "studio.toast.newVariationAdded": "New variation added",
  "studio.toast.networkErrorRegen": "Network error during regeneration",
  "studio.toast.allAlreadyAdded": "All pins are already added to plan",
  "studio.toast.addedOnePinToWeeklyPlan": "Added 1 pin to Weekly Plan",
  "studio.toast.addedPinsToWeeklyPlan": "Added {n} pins to Weekly Plan",
  "studio.toast.skippedNotCompleted": "{n} skipped (already added or not completed).",
  "studio.toast.draftSaved": "Draft saved",
  "studio.toast.readyOn": "Ready · {date}",
  "studio.toast.scheduled": "scheduled",
  "studio.toast.needsReview": "Needs review",
} as const;
