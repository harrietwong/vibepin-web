export const historyMessages = {
  // ── Shared fallbacks ──
  "history.notAvailable": "Not available",
  "history.generatedSession": "Generated Session",

  // ── Generation status badge ──
  "history.status.pending": "Pending",
  "history.status.completed": "Completed",
  "history.status.partial": "Partial",
  "history.status.failed": "Failed",
  "history.status.running": "In progress",
  "history.status.interrupted": "Interrupted",

  // ── Error type → user-facing copy ──
  "history.error.rateLimited.label": "Rate limited",
  "history.error.rateLimited.detail": "The image API was temporarily rate limited. Try regenerating.",
  "history.error.safetyBlocked.label": "Safety blocked",
  "history.error.safetyBlocked.detail": "The model blocked this request. Try a different reference image or simplify the prompt.",
  "history.error.imageLoadFailed.label": "Product images failed",
  "history.error.imageLoadFailed.detail": "Product images could not be downloaded. Re-upload or use different URLs.",
  "history.error.modelReturnedText.label": "Model returned text",
  "history.error.modelReturnedText.detail": "The model returned a text description instead of an image. Try fewer inputs or a simpler prompt.",
  "history.error.apiAuthError.label": "Auth error",
  "history.error.apiAuthError.detail": "Check your LINAPI_KEY in web/.env.local.",
  "history.error.apiPayloadError.label": "Payload rejected",
  "history.error.apiPayloadError.detail": "Try fewer products or a shorter prompt.",
  "history.error.apiServerError.label": "API server error",
  "history.error.apiServerError.detail": "The image API returned a server error. Try again in a few minutes.",
  "history.error.unknown.label": "Unknown error",
  "history.error.unknown.detail": "Check the backend terminal for details.",

  // ── Prompt snapshot ──
  "history.prompt.collapse": "Collapse ↑",
  "history.prompt.viewFull": "View full prompt ↓",

  // ── Session modal: header ──
  "history.modal.generatingProgress": "{a} / {b} pins generating…",
  "history.modal.pinsGenerated": "{a} of {b} pins generated",
  "history.modal.addedToPlanSuffix": " · {a}/{b} added to plan",

  // ── Session modal: progress bar ──
  "history.modal.generatingLeaveHint": "Generating {a} / {b} pins — you can leave this page",

  // ── Session modal: action bar ──
  "history.modal.runningHint": "Generation in progress — pins will appear here as they complete.",
  "history.modal.retryGeneration": "↺ Retry generation",
  "history.modal.interruptedHint": "Page was refreshed or connection was lost during generation.",
  "history.modal.addSelectedToPlan": "Add {n} selected to Plan",
  "history.modal.clear": "Clear",
  "history.modal.addRemainingToPlan": "Add remaining {n} to Plan",
  "history.modal.addAllToPlan": "+ Add all to Plan",
  "history.modal.viewInWeeklyPlan": "View in Weekly Plan →",
  "history.modal.retryFailedGroups": "↺ Retry {n} failed group",
  "history.modal.retryFailedGroupsPlural": "↺ Retry {n} failed groups",
  "history.modal.createMore": "✦ Create More from this setup",
  "history.modal.downloadAll": "↓ Download all",

  // ── Session modal: left column ──
  "history.modal.sessionSummary": "Session Summary",
  "history.modal.field.opportunity": "Opportunity",
  "history.modal.field.mode": "Mode",
  "history.modal.field.status": "Status",
  "history.modal.field.expected": "Expected",
  "history.modal.field.actual": "Actual",
  "history.modal.field.imagesPerRef": "Images / ref",
  "history.modal.field.created": "Created",
  "history.modal.mode.productLed": "Product-led",
  "history.modal.mode.weeklyPlan": "Weekly plan",
  "history.modal.mode.batch": "Batch",
  "history.modal.mode.keywordLed": "Keyword-led",
  "history.modal.pinCount": "{n} pin",
  "history.modal.pinCountPlural": "{n} pins",

  "history.modal.products": "Products ({n})",
  "history.modal.productsUsed": "{n} product used",
  "history.modal.productsUsedPlural": "{n} products used",
  "history.modal.notCapturedLegacy": "Not captured in this older session",
  "history.modal.noProductsUsed": "No products used",

  "history.modal.references": "References ({n})",
  "history.modal.referencesUsed": "{n} reference used",
  "history.modal.referencesUsedPlural": "{n} references used",
  "history.modal.noReferences": "No references",
  "history.modal.refAlt": "Ref {n}",

  "history.modal.refFormat.uploaded": "Uploaded",
  "history.modal.refFormat.onBody": "On-body",
  "history.modal.refFormat.mirrorStyle": "Mirror style",
  "history.modal.refFormat.flatLay": "Flat lay",
  "history.modal.refFormat.roomScene": "Room scene",
  "history.modal.refFormat.productOnly": "Product only",
  "history.modal.refPresence.person": "Person",
  "history.modal.refPresence.noPerson": "No person",

  "history.modal.noTextOverlay": "No text overlay",

  "history.modal.promptSnapshot": "Prompt Snapshot",

  // ── Session modal: right column ──
  "history.modal.partialWarning": "This session produced fewer pins than expected ({a} of {b}).",
  "history.modal.failedWarning": "This session failed to generate any pins.",
  "history.modal.outputsByRefGroup": "Outputs by Reference Group",
  "history.modal.groupGenerated": "✓ Generated",
  "history.modal.groupMissing": "⚠ Missing",
  "history.modal.groupFailed": "✕ Failed",

  "history.modal.reference": "Reference {n}",
  "history.modal.groupProgress": "{a} of {b} generated",
  "history.modal.groupStatusGenerated": "✓ Generated",
  "history.modal.groupStatusPartial": "⚠ Partial",
  "history.modal.groupStatusMissing": "✗ Missing",

  "history.modal.pinDetails": "Details",
  "history.modal.pinView": "View",
  "history.modal.pinDownload": "↓ DL",
  "history.modal.pinPlanLink": "Plan →",
  "history.modal.pinAddPlan": "+ Plan",
  "history.modal.pinAddedBadge": "✓",

  "history.modal.noPinsYetTitle": "No pins generated yet",
  "history.modal.noPinsYetDesc": "This reference group did not produce any outputs.",
  "history.modal.retryWithSetup": "Retry with this setup",

  // ── Session card ──
  "history.card.generatingLabel": "Generating…",
  "history.card.interruptedLabel": "Interrupted",
  "history.card.productCount": "{n} product",
  "history.card.productCountPlural": "{n} products",
  "history.card.refCount": "{n} ref",
  "history.card.refCountPlural": "{n} refs",
  "history.card.generatingProgress": "Generating {a} / {b} pins",
  "history.card.generatedProgress": "{a} / {b} generated",
  "history.card.addedToPlan": "✓ Added to plan",
  "history.card.partialAdded": "{a}/{b} added",
  "history.card.notAdded": "Not added",
  "history.card.interruptedHint": "Page was refreshed or connection lost.",
  "history.card.viewProgress": "View progress →",
  "history.card.retryGeneration": "Retry generation",
  "history.card.viewInPlan": "View in Plan →",
  "history.card.addRemaining": "Add remaining {n}",
  "history.card.addAllToPlan": "Add all to Plan",
  "history.card.retrySetup": "Retry setup →",
  "history.card.retryFailed": "Retry failed",
  "history.card.open": "Open",

  // ── Page header ──
  "history.header.createPins": "+ Create Pins",
  "history.header.sessionsSelected": "{n} session selected",
  "history.header.sessionsSelectedPlural": "{n} sessions selected",
  "history.header.addSelectedToPlan": "Add selected to Plan",
  "history.header.clearSelection": "Clear selection",
  "history.header.searchPlaceholder": "Search by keyword or opportunity…",
  "history.header.deselectAll": "Deselect all",
  "history.header.selectAll": "Select all",

  // ── Filter tabs ──
  "history.tab.all": "All {n}",
  "history.tab.inProgress": "In progress {n}",
  "history.tab.pending": "Pending {n}",
  "history.tab.completed": "Completed {n}",
  "history.tab.partial": "Partial {n}",
  "history.tab.failed": "Failed {n}",
  "history.tab.interrupted": "Interrupted {n}",
  "history.tab.addedToPlan": "Added to Plan {n}",

  // ── Card grid states ──
  "history.loading": "Loading your generation history…",
  "history.noSessionsMatch": "No sessions match",
  "history.noGeneratedPinsYet": "No generated pins yet",
  "history.tryDifferentFilter": "Try a different filter",
  "history.emptyHint": "Generated pins will appear here after your first creation",
  "history.createFirstPins": "Create your first Pins →",
  "history.showingCount": "Showing {a} of {b} session",
  "history.showingCountPlural": "Showing {a} of {b} sessions",
} as const;
