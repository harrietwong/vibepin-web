export const studioBoardMessages = {
  // ── Header ──
  "studioBoard.title": "Create Pins",
  "studioBoard.subtitle": "Create, edit, schedule and publish Pinterest Pins.",
  "studioBoard.selectProduct": "Select product",
  "studioBoard.history": "History",
  "studioBoard.uploadMore": "Upload more",
  "studioBoard.uploadingProgress": "Uploading {done}/{total}…",

  // ── Video upload placeholder cards + compact status chip ──
  "studioBoard.videoUpload.waiting": "Waiting…",
  "studioBoard.videoUpload.uploading": "Uploading…",
  "studioBoard.videoUpload.failedGeneric": "Upload failed",
  "studioBoard.videoUpload.retry": "Retry",
  "studioBoard.videoUpload.cancelAria": "Cancel this upload",
  "studioBoard.videoUpload.chip": "Uploading {done}/{total}",
  "studioBoard.videoUpload.chipFailed": "{n} failed",
  "studioBoard.videoUpload.cancelAll": "Cancel all",
  "studioBoard.videoUpload.dismiss": "Dismiss",

  // ── Video cover: edit bar under a single-video card + frame picker dialog ──
  "studioBoard.videoCover.edit": "Edit cover image",
  "studioBoard.videoCover.title": "Select video cover image",
  "studioBoard.videoCover.subtitle": "Drag along the frames to choose the cover for this Pin.",
  "studioBoard.videoCover.previewAria": "Video cover preview",
  "studioBoard.videoCover.frameTime": "Cover frame time",
  "studioBoard.videoCover.cancel": "Cancel",
  "studioBoard.videoCover.done": "Done",
  "studioBoard.videoCover.saving": "Saving cover…",
  "studioBoard.videoCover.saveFailed": "Could not save this cover. Your previous cover is unchanged. Please retry.",
  "studioBoard.videoCover.loadFailed": "Could not load the video. Close and reopen to retry.",

  // ── Status navigation and quiet exception notice ──
  "studioBoard.filters.drafts": "Drafts",
  "studioBoard.filters.scheduled": "Scheduled",
  "studioBoard.filters.posted": "Posted",
  "studioBoard.filters.failed": "Failed",
  "studioBoard.filters.all": "All",
  "studioBoard.attention.onePin": "1 Pin needs attention",
  "studioBoard.attention.manyPins": "{n} Pins need attention",
  "studioBoard.attention.review": "Review",
  "studioBoard.failedFilters.publish": "Publish failures",
  "studioBoard.failedFilters.generation": "Generation failures",
  "studioBoard.failedFilters.all": "All",

  // ── Saved indicator ──
  "studioBoard.failedToSaveRetry": "Failed to save · Retry",
  "studioBoard.saving": "Saving…",
  "studioBoard.savedOnDevice": "Saved on this device",

  // ── Empty states ──
  "studioBoard.empty.dragDropTitle": "Drag and drop images here",
  "studioBoard.empty.dragDropSub": "Upload one or more images to create editable Pin drafts.",
  "studioBoard.empty.uploading": "Uploading…",
  "studioBoard.empty.uploadImages": "Upload images",
  "studioBoard.empty.noImageCreateWithAi": "No image yet? Create with AI",
  "studioBoard.empty.createFromStoreSelectProduct": "Create from your store? Select a product",
  "studioBoard.empty.allScheduledTitle": "All pins are scheduled",
  "studioBoard.empty.allScheduledSub": "View them in Plan, or upload more Pins to keep creating.",
  "studioBoard.empty.openPlanScheduled": "Open Plan / Scheduled",
  "studioBoard.empty.nothingHereTitle": "Nothing here yet",
  "studioBoard.empty.nothingHereSub": "Try a different filter, or upload more Pins.",

  // ── AI drawer titles ──
  "studioBoard.aiDrawer.generateAiImage": "Generate AI Image",
  "studioBoard.aiDrawer.createWithAi": "Create with AI",

  // ── Product picker modal ──
  "studioBoard.productPicker.title": "Select product",
  "studioBoard.productPicker.subtitle": "Create a Pin from a product in your store.",
  "studioBoard.productPicker.attachSubtitle": "Link a product to this Pin. Its URL fills Website URL only when that field is empty.",

  // ── Toasts (StudioBoard) ──
  "studioBoard.toast.uploadedOne": "Uploaded 1 Pin.",
  "studioBoard.toast.uploadedMany": "Uploaded {n} Pins.",
  "studioBoard.toast.uploadFailedPrefix": "Failed to upload ",
  "studioBoard.toast.uploadFailedAndMore": " and {n} more",
  "studioBoard.toast.uploadFailedSuffix": ". Try those files again.",
  "studioBoard.toast.chooseBoardToSchedule": "Choose a Pinterest board to schedule this Pin.",
  "studioBoard.toast.completeDetailsToSchedule": "Add an image and choose a board to schedule this Pin.",
  "studioBoard.toast.openInPlan": "Open in Plan",
  "studioBoard.toast.imageUnavailable": "Image unavailable — upload the image again before publishing.",
  "studioBoard.toast.completeDetailsToPublish": "Add an image and choose a board to publish this Pin.",
  "studioBoard.toast.fieldTooLong": "Shorten the title or description before scheduling or publishing.",
  "studioBoard.toast.publishSuccess": "Pin published successfully.",
  "studioBoard.toast.publishPartial": "{published} destination(s) published; {failed} need attention.",
  "studioBoard.toast.ambiguousAccount": "Choose which {platform} account to publish as.",
  "studioBoard.toast.publishFailed": "Failed to publish. Please try again.",
  "studioBoard.toast.nothingToRetry": "Everything is already published.",
  "studioBoard.toast.splitCreated": "Created {n} separate posts.",
  "studioBoard.toast.productNoImage": "That product has no image to use yet.",
  "studioBoard.toast.createdPinFromProduct": "Created a Pin from your product.",
  "studioBoard.toast.linkedProduct": "Product linked to this Pin.",
  "studioBoard.toast.customTimeScheduled": "Scheduled for {date} at {time}.",
  "studioBoard.toast.generatingOne": "Generating 1 Pin…",
  "studioBoard.toast.generatingMany": "Generating {n} Pins…",
  "studioBoard.toast.generationUnknown": "We’re confirming the result. Recheck this generation before trying again.",
  "studioBoard.toast.generationAlreadyActive": "A generation is still active. Recheck it before starting another.",
  "studioBoard.toast.generationSetupSaveFailed": "Your generation setup could not be saved. Nothing was submitted.",
  // Serial reference-group queue: one /api/generate call per reference.
  "studioBoard.toast.generatingReferenceProgress": "Generating reference {current} of {total}…",
  "studioBoard.toast.generatedSomeFailedSome": "{okCount} Pin{okPlural} generated, {failCount} failed.",
  "studioBoard.toast.createdAiPinsKeptOriginal": "Created {n} AI Pin{plural}. Original upload kept as a separate Pin.",
  "studioBoard.toast.createdAiPins": "Created {n} AI Pin{plural}.",
  "studioBoard.toast.noAiPinsGenerated": "No AI Pins were generated. Please try again.",
  "studioBoard.toast.couldNotGenerate": "Couldn't generate. Please try again.",
  "studioBoard.confirm.deleteDraft": "Delete this Pin draft? This cannot be undone.",

  // ── Bulk actions (PRD §19): the selection bar, the publish sheet, the delete dialog ──
  "studioBoard.bulk.selectedCount": "{n} selected",
  "studioBoard.bulk.selectAll": "Select all",
  "studioBoard.bulk.clearSelection": "Clear selection",
  "studioBoard.bulk.edit": "Edit",
  "studioBoard.bulk.publish": "Publish",
  "studioBoard.bulk.delete": "Delete",
  "studioBoard.bulk.untitled": "Untitled Pin",
  "studioBoard.bulk.cancel": "Cancel",
  "studioBoard.bulk.close": "Close",

  // Publish confirm sheet
  "studioBoard.bulkPublish.title": "Publish {n} Pin{plural}",
  "studioBoard.bulkPublish.readyCount": "{n} ready to publish now.",
  "studioBoard.bulkPublish.noneReady": "None of the selected Pins can be published yet.",
  "studioBoard.bulkPublish.scheduledNotice": "{n} of these are scheduled for later. Publishing now sends them immediately instead of waiting for their scheduled time.",
  "studioBoard.bulkPublish.scheduledNoticeOne": "1 of these is scheduled for later. Publishing now sends it immediately instead of waiting for its scheduled time.",
  "studioBoard.bulkPublish.blockedHeading": "{n} can't be published yet",
  "studioBoard.bulkPublish.alreadyPublishedHeading": "{n} already published — these will be skipped",
  "studioBoard.bulkPublish.generatingHeading": "{n} still generating — these will be skipped",
  "studioBoard.bulkPublish.confirm": "Publish",
  "studioBoard.bulkPublish.publishing": "Publishing {current} of {total}…",
  "studioBoard.bulkPublish.resultsTitle": "Publish results",
  "studioBoard.bulkPublish.resultAllPublished": "All {n} Pin{plural} published.",
  "studioBoard.bulkPublish.resultPartial": "{published} published, {problems} need attention.",
  "studioBoard.bulkPublish.resultNonePublished": "Nothing was published.",
  "studioBoard.bulkPublish.statusPublished": "Published",
  "studioBoard.bulkPublish.statusFailed": "Failed",
  "studioBoard.bulkPublish.statusSkipped": "Skipped",
  "studioBoard.bulkPublish.alreadyPublishing": "Already publishing from another screen. Try again when it finishes.",
  "studioBoard.bulkPublish.publishedTo": "Published to {providers}.",

  // Blocker reasons — keyed by code so the sheet never shows a raw English message.
  "studioBoard.blocker.no_destinations": "Choose where to publish (a Pinterest board or a connected account).",
  "studioBoard.blocker.missing_board": "Choose a Pinterest board.",
  "studioBoard.blocker.no_account": "Choose which {provider} account to publish as.",
  "studioBoard.blocker.no_media": "Add an image.",
  "studioBoard.blocker.too_few": "Add more images for {provider}.",
  "studioBoard.blocker.too_many": "Too many images for {provider}. Remove some and try again.",
  "studioBoard.blocker.aspect_mismatch": "{provider} needs every image in the same shape. Match the aspect ratios and try again.",
  "studioBoard.blocker.unknown": "This Pin can't be published yet.",

  // Delete confirm dialog — one dialog, used by bulk delete AND single-card delete.
  "studioBoard.bulkDelete.titleOne": "Delete this Pin?",
  "studioBoard.bulkDelete.title": "Delete {n} Pins?",
  "studioBoard.bulkDelete.impactDrafts": "{n} draft{plural} will be deleted from VibePin.",
  "studioBoard.bulkDelete.impactScheduled": "{n} scheduled Pin{plural} will be unscheduled first, then deleted. They will not publish.",
  "studioBoard.bulkDelete.impactPosted": "{n} published Pin{plural} will be removed from VibePin. Posts already published to Pinterest, Instagram or Facebook are not deleted.",
  "studioBoard.bulkDelete.cannotUndo": "This cannot be undone.",
  "studioBoard.bulkDelete.confirm": "Delete",
  "studioBoard.bulk.toast.deleted": "Deleted {n} Pin{plural}.",
  "studioBoard.toast.draftDeleted": "Draft deleted.",
  "studioBoard.toast.archived": "Archived. This will not delete the published Pin from Pinterest.",
  "studioBoard.toast.duplicated": "Duplicated.",
  "studioBoard.toast.unscheduled": "Unscheduled. The Pin stays on your Create Pins board.",
  "studioBoard.toast.movedToUnscheduled": "Moved to Unscheduled.",
  "studioBoard.toast.noImageToDownload": "No image to download yet.",
  "studioBoard.toast.noImageToSave": "No image to save yet.",
  "studioBoard.toast.savedToReferences": "Saved to My References.",
  "studioBoard.toast.saved": "Saved.",
  "studioBoard.toast.stillCouldNotSave": "Still couldn't save on this device. Free up storage and retry.",

  // ── PinBoardCard: badges / status ──
  "studioBoard.card.qualityHiddenTitle": "Didn't meet the quality bar",
  "studioBoard.card.qualityHiddenBody": "Our automatic check flagged this result. You can still keep it.",
  "studioBoard.card.showAnyway": "Show anyway",
  "studioBoard.card.topPick": "Top pick",
  "studioBoard.card.untitledPin": "Untitled Pin",
  "studioBoard.card.noBoardYet": "No board yet",
  "studioBoard.card.previouslyScheduledFor": "Previously scheduled for {time}",
  "studioBoard.card.keywords": "Keywords",
  "studioBoard.card.keywordChipsTitle": "High-search Pinterest keywords for this pin — click to copy",
  "studioBoard.card.copyKeywordTitle": "Copy “{keyword}”",
  "studioBoard.card.copied": "Copied",
  "studioBoard.card.removeKeywordAria": "Remove keyword {keyword}",
  "studioBoard.card.moreActionsAria": "More actions",
  "studioBoard.card.pinImageAlt": "Pin image",
  // Alt text for the neutral placeholder shown when no image candidate resolves.
  "studioBoard.card.pinImageUnavailable": "Pin image unavailable",
  // Shown only when EVERY real source in the fallback chain is unrecoverable.
  // Deliberately not "No image" (PRD 0816 §13): that reads as a bare technical
  // absence, and a publish failure in particular means the image did exist.
  "studioBoard.card.noImage": "Image unavailable",
  "studioBoard.card.generationFailedPlaceholder": "Generation failed",
  // Badge on a failed card that is showing an INPUT image (product / reference /
  // parent) instead of a generated result — it must not read as a success.
  "studioBoard.card.originalImageFallback": "Original image",
  "studioBoard.card.destinations": "Destinations",
  "studioBoard.card.customTime": "Custom time",
  "studioBoard.card.customTimeHint": "Optional: choose a specific time instead of Smart Schedule",
  "studioBoard.card.customDate": "Custom date",
  "studioBoard.card.apply": "Apply",

  // ── PinBoardCard: user-facing publish-failure reason (NEVER the raw API error) ──
  "studioBoard.card.publishError.auth": "Pinterest connection expired. Reconnect and retry.",
  "studioBoard.card.publishError.board": "This Pinterest board is no longer available. Choose another board and retry.",
  "studioBoard.card.publishError.image": "Pinterest couldn't use this image. Review the image and retry.",
  "studioBoard.card.publishError.link": "The destination link isn't valid. Update the link and retry.",
  "studioBoard.card.publishError.timeout": "Pinterest didn't respond in time. Try publishing again.",
  "studioBoard.card.publishError.content": "This Pin's board, image, or link has a problem. Edit the Pin and retry.",
  "studioBoard.card.publishError.transient": "Publishing failed due to a temporary error. You can retry.",
  "studioBoard.card.publishError.unknown": "Publishing failed, but detailed error information was not recorded.",

  // ── PinBoardCard: user-facing GENERATION-failure reason (image never finished) ──
  "studioBoard.card.generationError.generic": "We couldn't generate this image. Review the source images and try again.",

  // ── PinBoardCard: recommended fix copy ──
  "studioBoard.card.fix.auth": "Your Pinterest connection needs to be reconnected before this Pin can publish.",
  "studioBoard.card.fix.transient": "Pinterest or the connection failed while publishing. Try again now, or move this Pin back to Unscheduled.",
  "studioBoard.card.fix.default": "Something in this Pin needs attention before it can publish. Review the details and fix the issue.",

  // ── PinBoardCard: More menu items ──
  "studioBoard.menu.moveToUnscheduled": "Move to Unscheduled",
  "studioBoard.menu.delete": "Delete",
  "studioBoard.menu.regenerate": "Regenerate",
  "studioBoard.menu.duplicate": "Duplicate",
  "studioBoard.menu.download": "Download",
  "studioBoard.menu.unschedule": "Unschedule",
  "studioBoard.menu.saveAsReference": "Save as reference",
  "studioBoard.menu.archive": "Archive",
  "studioBoard.menu.publishNow": "Publish now",

  // ── PinBoardCard: compact action buttons ──
  "studioBoard.action.generating": "Generating…",
  "studioBoard.action.edit": "Edit",
  "studioBoard.action.retryPublish": "Retry publish",
  "studioBoard.action.tryAgain": "Try again",
  "studioBoard.action.viewPlan": "View Plan",
  "studioBoard.action.viewPin": "View Pin",
  "studioBoard.action.details": "Details",
  "studioBoard.action.schedule": "Schedule",

  // ── PinBoardCard: lifecycle card (PRD 0826 §3–§6, §20) ──
  // §20: EVERY real publish action reads exactly "Publish". "Publish now" and
  // "Retry publish" are gone from the card — the scope difference (retry re-sends
  // only what failed) is carried by the separate Retry action, not by the wording.
  "studioBoard.actions.publish": "Publish",
  "studioBoard.actions.retry": "Retry",
  "studioBoard.actions.edit": "Edit",
  "studioBoard.actions.done": "Done",
  "studioBoard.actions.cancel": "Cancel",
  "studioBoard.actions.continue": "Continue",
  "studioBoard.actions.unschedule": "Unschedule",
  "studioBoard.actions.viewResults": "View results",
  "studioBoard.actions.hideResults": "Hide results",
  // Publishing a scheduled Content early is a real decision, so it is confirmed.
  "studioBoard.card.publishConfirmTitle": "Publish now?",
  "studioBoard.card.publishConfirmBody": "This will publish now instead of waiting for {date} {time}.",
  "studioBoard.card.fields.title": "Title",
  "studioBoard.card.fields.description": "Description",
  "studioBoard.card.fields.descriptionPlaceholder": "Tell people what this content is about",
  "studioBoard.card.fields.websiteUrl": "Website URL",
  "studioBoard.card.linkCopy.placeholder": "Paste a product link",
  "studioBoard.card.linkCopy.generating": "Generating…",
  "studioBoard.card.linkCopy.generated": "Generated",
  "studioBoard.card.linkCopy.regenerate": "Regenerate",
  "studioBoard.card.linkCopy.clear": "Clear link",
  "studioBoard.card.fields.board": "Board",
  "studioBoard.card.fields.boardPlaceholder": "Choose a board",
  // ── Instagram caption (mixed Pinterest+Instagram single-video split, T3) ──
  // Shown only when a single video is going to BOTH Pinterest and Instagram — the
  // video is split into two posts on Schedule, and this text becomes the
  // Instagram-only child's caption (its description field).
  "studioBoard.card.instagramCaption.label": "Instagram caption",
  "studioBoard.card.instagramCaption.help": "Instagram will post this video separately, using this caption instead of the description above. Links aren't allowed — try a comment-keyword call to action instead.",
  "studioBoard.card.instagramCaption.placeholder": "Comment SHOP and I'll DM you the link",
  "studioBoard.card.instagramCaption.errorRequired": "Add an Instagram caption before scheduling.",
  "studioBoard.card.instagramCaption.errorLink": "Instagram captions can't contain links. Remove the link and try again.",
  "studioBoard.card.instagramCaption.splitNotice": "Split into 2 posts: one for Pinterest, one for Instagram.",
  "studioBoard.card.instagramCaption.splitAction": "Split & schedule",
  "studioBoard.actions.viewDetails": "View details",
  "studioBoard.card.publishTo": "Destinations",
  "studioBoard.card.editDestinations": "Edit destinations",
  "studioBoard.card.noSavedDestination": "Choose publishing destinations",
  "studioBoard.card.destinationNeedsSetup": "Needs setup",
  "studioBoard.card.publishBlocked.imageUnavailable": "This image is not ready to publish. Review the media before continuing.",
  "studioBoard.card.publishBlocked.fieldTooLong": "Shorten the title or description before publishing.",
  "studioBoard.card.publishBlocked.review": "Review",
  "studioBoard.card.aiGenerated": "AI generated",
  "studioBoard.card.mediaCounter": "{index} / {total}",
  "studioBoard.card.regenerateImage": "Regenerate image",
  // ── Media compatibility notice (PRD §9/§13) ──
  // One compact amber line per failing platform. It never removes an image or unticks a
  // platform: it reports the platform's own rule and offers the split as the way out.
  "studioBoard.card.mediaNotice.headline": "{platform} needs review",
  "studioBoard.card.mediaNotice.aspectMismatch": "{n} image needs adjustment",
  "studioBoard.card.mediaNotice.aspectMismatchPlural": "{n} images need adjustment",
  "studioBoard.card.mediaNotice.tooMany": "{platform} carousels hold up to {max} images",
  "studioBoard.card.mediaNotice.tooFew": "{platform} carousels need {min}–{max} images",
  "studioBoard.card.mediaNotice.noMedia": "Add an image before publishing to {platform}",
  "studioBoard.card.mediaNotice.splitSeparate": "Publish separately",
  "studioBoard.card.dropHint": "Drop to add to this content",
  // Save state, shown as light text at the bottom of the card.
  "studioBoard.card.saveState.saved": "Saved",
  "studioBoard.card.saveState.saving": "Saving…",
  "studioBoard.card.saveState.failed": "Couldn't save",
  "studioBoard.card.saveState.retry": "Retry",
  // Posted card.
  "studioBoard.card.publishedRelative": "Published {when}",
  "studioBoard.card.relative.now": "just now",
  "studioBoard.card.relative.minutes": "{n}m ago",
  "studioBoard.card.relative.hours": "{n}h ago",
  "studioBoard.card.relative.days": "{n}d ago",
  "studioBoard.card.resultPublished": "Published",
  "studioBoard.card.resultFailed": "Failed",
  "studioBoard.card.resultPending": "Not published yet",
  "studioBoard.card.viewOn": "View on {platform}",
  "studioBoard.card.earlierPublishes": "Earlier publishes",
  "studioBoard.card.needsAttention": "Needs attention",
  // The one actionable next step per failure category — never a raw message.
  "studioBoard.card.nextStep.reconnect": "Reconnect",
  "studioBoard.card.nextStep.chooseBoard": "Choose another board",
  "studioBoard.card.nextStep.edit": "Edit",
  "studioBoard.card.scheduledFor": "Scheduled for {time}",
  "studioBoard.card.publishFailedBadge": "Publish failed",
  "studioBoard.card.generationFailedBadge": "Generation failed",
  "studioBoard.card.wasScheduled": "Was scheduled: {time}",
  "studioBoard.card.fix.reconnect": "Reconnect Pinterest, then retry.",
  "studioBoard.card.fix.temporary": "Usually temporary — try publishing again.",
  "studioBoard.card.fix.editDetails": "Fix the Pin details, then retry.",

  // ── PinBoardCard: expanded card ──
  "studioBoard.expanded.collapseAria": "Collapse",
  // Retained for the aiDrawer title (a NEW generation from an existing pin).
  "studioBoard.expanded.generateAiImage": "Generate AI Image",
  // Existing-draft action: replaces THIS draft's image. "Generate AI Image" read as
  // if it created another Pin (PRD Section I naming).
  "studioBoard.expanded.regenerateImage": "Regenerate image",
  "studioBoard.expanded.moreDetails": "More details",
  "studioBoard.expanded.productOptional": "Product · Optional",
  "studioBoard.expanded.noLinkedProduct": "No linked product",
  "studioBoard.expanded.selectProduct": "Select a product",
  "studioBoard.expanded.chooseProduct": "Choose",
  "studioBoard.expanded.changeProduct": "Change",
  "studioBoard.expanded.altTextOptional": "Alt text · Optional",
  "studioBoard.expanded.altTextPlaceholder": "Describe the image for accessibility",
  "studioBoard.expanded.tagsOptional": "Tags · Optional",
  "studioBoard.expanded.tagsPlaceholder": "#handmade #diy #giftideas",
  "studioBoard.expanded.saved": "Saved",
  "studioBoard.expanded.scheduledForPrefix": "Scheduled for {time}",
  "studioBoard.expanded.scheduled": "Scheduled",
  "studioBoard.expanded.openInPlan": "Open in Plan",
  "studioBoard.expanded.moveToUnscheduled": "Move to Unscheduled",
  "studioBoard.expanded.retryPublish": "Retry publish",
  "studioBoard.expanded.tryAgain": "Try again",
  "studioBoard.expanded.posted": "Posted",
  "studioBoard.expanded.schedule": "Schedule",

  // ── Publish target: which connected Pinterest account this Pin publishes to ──
  // Only ever rendered when the user has more than one connected account (a single
  // account has nothing to choose, so the picker stays invisible).
  "studioBoard.target.accountLabel": "Pinterest account",
  "studioBoard.target.publishingTo": "Publishing to {account}",
  // Shown the moment the account is switched: board ids belong to one account, so the
  // previously chosen Board cannot carry over and is cleared.
  "studioBoard.target.switchClearsBoard": "Changing the Pinterest account will clear the selected Board.",
  // ── Retry guards (PRD §17) ──
  // The Pin is pinned to an account that is no longer connected. It is NOT re-routed to
  // another account — that would publish to the wrong Pinterest profile.
  "studioBoard.target.reconnectToRetry": "Reconnect {account} to retry publishing.",
  // The Pin's Board no longer exists on the target account (deleted / made secret).
  "studioBoard.target.boardUnavailable": "This Board is no longer available. Choose another Board before retrying.",
  // Fallback when the pinned account's username is unknown (identity never synced).
  "studioBoard.target.thisAccount": "this account",

  // ── Right-side Plan sidebar (PRD 0826 §23–§24) ──────────────────────────────
  // A peek at the week's schedule without leaving Create Pins. It can be hovered
  // open, or pinned so it stays as a column beside the board.
  "studioBoard.plan.title": "Plan",
  "studioBoard.plan.open": "Keep Plan open",
  "studioBoard.plan.close": "Close Plan",
  "studioBoard.plan.previewHint": "Hover to preview; click to keep Plan open",
  "studioBoard.plan.unpinAndClose": "Unpin and close Plan",
  // PRD 0809 §IX — tablet/mobile open Plan as an overlay, which pins nothing, so the
  // trigger there says "Open Plan" rather than the docked panel's "Keep Plan open".
  "studioBoard.plan.openPanel": "Open Plan",
  "studioBoard.plan.previousWeek": "Previous week",
  "studioBoard.plan.nextWeek": "Next week",
  "studioBoard.plan.today": "Today",
  "studioBoard.plan.openFullPlanner": "Open full planner",
  // Week header count. Counts what still has to go out (upcoming + needs attention);
  // already-posted history is deliberately excluded so the number means "work left".
  "studioBoard.plan.scheduledThisWeek": "{n} scheduled this week",
  "studioBoard.plan.oneScheduledThisWeek": "1 scheduled this week",
  "studioBoard.plan.nothingScheduledThisWeek": "Nothing scheduled this week",
  // Per-item accessible name: what a screen reader announces for the link.
  "studioBoard.plan.itemLabel": "{time} · {title}",
  "studioBoard.plan.untitled": "Untitled",
  // The three item states (also the marker tooltips).
  "studioBoard.plan.statusScheduled": "Scheduled",
  "studioBoard.plan.statusPosted": "Posted",
  "studioBoard.plan.statusFailed": "Needs attention",
  // Trigger badge: how many schedules landed while the panel was closed. It never
  // opens the panel by itself — it only counts, and clears the next time it opens.
  "studioBoard.plan.newSinceLastOpen": "{n} newly scheduled since you last opened Plan",

  // ── Usage limits (PRD v3.2 §4.3 / §6.4, product decision #6) ────────────────
  // Shown when the server refuses a metered action for lack of remaining quota.
  //
  // The two "allUsed" sentences are the PRD's own frontend copy, quoted verbatim
  // from §4.3 (images) and §6.4 (text) — they are product-approved wording, not
  // paraphrases, so do not "improve" them here. The server sends its own, different
  // English prose in the 402 body; we deliberately render THESE instead.
  "studioBoard.limit.image.allUsed":
    "You have used all AI images included in your current plan. Upgrade your plan to generate more images.",
  "studioBoard.limit.text.allUsed":
    "You have used all AI text generations included in your current plan. Upgrade your plan to continue generating AI content.",
  // Scheduled posts: PRD §5 defines the metering rule but gives no frontend
  // sentence (unlike §4.3/§6.4), so this mirrors their two-sentence shape using the
  // server's own noun ("scheduled post limit") to stay consistent with the API.
  "studioBoard.limit.post.allUsed":
    "You have used all scheduled posts included in your current plan. Upgrade your plan to schedule or publish more posts.",
  // The shared call to action next to each message; opens Settings → Billing.
  "studioBoard.limit.upgradeCta": "View plans",
  // Dialog heading for the zero-balance case (nothing left to adjust down to). The
  // over-request heading below is a different situation and must not be reused: there
  // the user still HAS images, just fewer than they asked for.
  "studioBoard.limit.reachedTitle": "Plan limit reached",

  // Over-request confirmation (decision #6, option B): the user asked for more
  // images than remain. We NEVER silently generate fewer and NEVER exceed the
  // limit — we ask, and offer a one-click adjustment to exactly what is left.
  "studioBoard.limit.image.overRequestTitle": "Not enough AI images left",
  // {requested} = what they asked for, {remaining} = what the plan has left.
  "studioBoard.limit.image.overRequestBody":
    "You asked for {requested} images but only {remaining} remain in your current plan. Generate the remaining images instead, or upgrade your plan for more.",
  // The one-click adjustment. Singular/plural split because "Generate 1 images" is
  // wrong in English and several locales inflect the noun differently.
  "studioBoard.limit.image.generateRemaining": "Generate {remaining} instead",
  "studioBoard.limit.image.generateOneRemaining": "Generate 1 instead",
  "publishConfirm.title": "Confirm publishing destinations",
  "publishConfirm.close": "Close publish confirmation",
  "publishConfirm.mediaCount": "{n} media item(s)",
  "publishConfirm.caption": "Caption:",
  "publishConfirm.modeLabel": "Mode:",
  "publishConfirm.modeNow": "Publish now",
  "publishConfirm.modeSchedule": "Schedule for {time} ({timezone})",
  "publishConfirm.destinations": "Destinations",
  "publishConfirm.missingBoard": "Board required",
  "publishConfirm.noDestinations": "No saved publishing destination.",
  "publishConfirm.editDestinations": "Return to Edit destinations to resolve this before publishing.",
  "publishConfirm.cancel": "Cancel",
  "publishConfirm.confirmNow": "Publish now to {n} destination(s)",
  "publishConfirm.confirmSchedule": "Schedule to {n} destination(s)",
  "publishResults.deliveryUnknown": "Checking delivery",
  "publishResults.recoveryHint": "Do not publish again yet. Check the original attempt first to avoid a duplicate post.",
  // ── Amazon link on a card (T3; English only — other locales are T5) ──
  "studioBoard.amazon.sectionTitle": "Amazon product",
  "studioBoard.amazon.fetching": "Getting product details from Amazon…",
  "studioBoard.amazon.fetched": "Product details found on Amazon. Check them before generating copy.",
  "studioBoard.amazon.notFetched": "Product details have not been fetched yet.",
  "studioBoard.amazon.fetchButton": "Get product details",
  "studioBoard.amazon.retryButton": "Try again",
  "studioBoard.amazon.retryWait": "Try again in {s}s",
  "studioBoard.amazon.manualIntro": "Amazon didn't return product details. Enter them below — your other fields are unchanged.",
  "studioBoard.amazon.manualReason.no_title": "Amazon returned no product name. Enter it below.",
  "studioBoard.amazon.manualReason.not_product_page": "This isn't an Amazon product page link. Enter the product details below.",
  "studioBoard.amazon.manualReason.short_link_unexpanded": "This short link couldn't be expanded. Paste the full Amazon link, or enter the product details below.",
  "studioBoard.amazon.manualReason.unsupported_marketplace": "Details can't be fetched from this Amazon site. Enter them below.",
  "studioBoard.amazon.productName": "Product name",
  "studioBoard.amazon.productNameRequired": "Add the product name to generate copy for this Amazon link.",
  "studioBoard.amazon.copyRequiresV2": "Amazon affiliate copy requires the new AI copy generator. Enable it before generating.",
  "studioBoard.amazon.sellingPoints": "Selling points (optional, one per line)",
  "studioBoard.amazon.brand": "Brand (optional)",
  "studioBoard.amazon.material": "Material (optional)",
  "studioBoard.amazon.size": "Size / quantity (optional)",
  "studioBoard.amazon.structuredHint": "Copy only mentions a brand, material or size you confirm here.",
  "studioBoard.amazon.fetchedBullets": "{n} product details from the page will be used as context.",
  "studioBoard.amazon.useCleanLink": "Use clean link",
  "studioBoard.amazon.cleanLinkHint": "Suggested: {url}",
  "studioBoard.amazon.warning.no_tag_no_commission": "This link has no Associates tag, so it won't earn commission.",
  "studioBoard.amazon.warning.marketplace_mismatch": "Your default tag is for another Amazon site, so it isn't applied to this link.",
  "studioBoard.amazon.warning.tag_differs_from_default": "This link's tag differs from your default tag. We keep the tag in your link.",
  "studioBoard.amazon.warning.invalid_tag": "The tag in this link isn't valid and was ignored.",
  "studioBoard.amazon.warning.no_asin": "This isn't a product page link.",
  "studioBoard.amazon.claimHint": "The copy mentioned “{value}”. Confirm it in {field} and try again.",
  "studioBoard.amazon.disclosureMissing": "This Pin has no #ad disclosure. Affiliate Pins should disclose the relationship.",
  "studioBoard.amazon.addDisclosure": "Add #ad",
  // ── Manual-entry marketplace card (FR-04, 2026-09-25; translated in all 18 locales — no fetch, no UA) ──
  "studioBoard.marketplace.sectionTitle.temu": "Temu product",
  "studioBoard.marketplace.sectionTitle.shein": "Shein product",
  "studioBoard.marketplace.sectionTitle.aliexpress": "AliExpress product",
  "studioBoard.marketplace.sectionTitle.tiktok_shop": "TikTok Shop product",
  "studioBoard.marketplace.intro": "This platform doesn't allow automatic product reads. Upload a product photo and fill in the name and selling points below — the link stays as the destination.",
  "studioBoard.marketplace.productName": "Product name",
  "studioBoard.marketplace.productNameRequired": "Add the product name to generate copy for this link.",
  // ── One-time Amazon risk notice (board banner) ──
  "amazonRiskNotice.title": "Before you post Amazon affiliate Pins",
  "amazonRiskNotice.body": "Pinterest is not on Amazon Associates' list of approved social networks, so promoting Associates links there is a grey area. Review Amazon's policies and decide for yourself. This notice is information, not a compliance guarantee.",
  "amazonRiskNotice.disclosure": "VibePin adds #ad to the end of AI-written descriptions for Amazon links. You can move it, but removing it may break disclosure rules.",
  "amazonRiskNotice.bioLabel": "Suggested line for your Pinterest profile:",
  "amazonRiskNotice.bioText": "As an Amazon Associate I earn from qualifying purchases.",
  "amazonRiskNotice.copyBio": "Copy",
  "amazonRiskNotice.copied": "Copied",
  "amazonRiskNotice.policyLink": "Amazon Associates policies",
  "amazonRiskNotice.acknowledge": "Got it",
  // ── Bulk Generate copy (T4; English only — other locales are T5) ──
  "studioBoard.bulkCopy.button": "Generate copy",
  "studioBoard.bulkCopy.title": "Generate copy for {n} selected",
  "studioBoard.bulkCopy.intro": "Each Pin gets its own copy from its own image and link. Nothing is scheduled or published.",
  "studioBoard.bulkCopy.groupReady": "{n} will be generated",
  "studioBoard.bulkCopy.groupNeedsProductName": "{n} Amazon Pins need a product name first (skipped)",
  "studioBoard.bulkCopy.groupGenerating": "{n} already generating (skipped)",
  "studioBoard.bulkCopy.groupComplete": "{n} contain only text you wrote (skipped)",
  "studioBoard.bulkCopy.editedKeptNotice": "{n} of these Pins have text you wrote. It is kept unless you choose to replace it.",
  "studioBoard.bulkCopy.quotaEnough": "Uses {n} AI copy generations. {remaining} left this period.",
  "studioBoard.bulkCopy.quotaShort": "Uses {n} AI copy generations, but only {remaining} are left. Only the first {remaining} will be generated; the rest will not start.",
  "studioBoard.bulkCopy.quotaUnknown": "Uses up to {n} AI copy generations.",
  "studioBoard.bulkCopy.quotaUnlimited": "Uses {n} AI copy generations.",
  "studioBoard.bulkCopy.replaceToggle": "Also replace text I wrote",
  "studioBoard.bulkCopy.replaceConfirmTitle": "Replace text you wrote?",
  "studioBoard.bulkCopy.replaceConfirmBody": "AI copy will overwrite titles, descriptions and alt text you wrote on the selected Pins.",
  "studioBoard.bulkCopy.replaceConfirm": "Replace my text",
  "studioBoard.bulkCopy.start": "Generate for {n}",
  "studioBoard.bulkCopy.stop": "Stop",
  "studioBoard.bulkCopy.close": "Close",
  "studioBoard.bulkCopy.retryFailed": "Retry failed",
  "studioBoard.bulkCopy.progress": "Generating {done}/{total}…",
  "studioBoard.bulkCopy.status.queued": "Waiting",
  "studioBoard.bulkCopy.status.running": "Writing copy…",
  "studioBoard.bulkCopy.status.succeeded": "Copy added",
  "studioBoard.bulkCopy.status.failed": "Failed",
  "studioBoard.bulkCopy.status.skipped": "Skipped",
  "studioBoard.bulkCopy.status.not_started": "Not started",
  "studioBoard.bulkCopy.reason.needs_product_name": "Add the product name for this Amazon link.",
  "studioBoard.bulkCopy.reason.generating": "Already generating.",
  "studioBoard.bulkCopy.reason.already_copy_complete": "Only your own text — nothing to fill.",
  "studioBoard.bulkCopy.reason.text_limit": "AI copy limit reached.",
  "studioBoard.bulkCopy.reason.rate_limited": "Too many requests.",
  "studioBoard.bulkCopy.reason.rate_limited_paused": "Paused briefly (too many requests), then continuing.",
  "studioBoard.bulkCopy.reason.cancelled": "Stopped.",
  "studioBoard.bulkCopy.keptFields": "Kept text you wrote: {title} titles, {description} descriptions, {altText} alt texts.",
  "studioBoard.bulkCopy.summary": "{succeeded} updated · {failed} failed · {skipped} skipped · {notStarted} not started",
  "studioBoard.bulkCopy.stoppedTextLimit": "Stopped: your AI copy limit is used up. The rest were not started.",
  "studioBoard.bulkCopy.stoppedRateLimited": "Stopped: too many requests. Try the rest again in a moment.",
  // ── Per-Pin confirmation list before schedule / publish (T4, ruling 4) ──
  "publishConfirm.list.heading": "Review each Pin ({n})",
  "publishConfirm.list.hint": "Remove any Pin you don't want to include, then scroll to the end to confirm.",
  "publishConfirm.list.noLink": "No destination link",
  "publishConfirm.list.aiUnedited": "AI copy not edited",
  "publishConfirm.list.aiUneditedHint": "This Pin still has AI-written copy you haven't edited. Check it before it goes out. This doesn't block it.",
  "publishConfirm.list.remove": "Remove",
  "publishConfirm.list.undo": "Add back",
  "publishConfirm.list.scrollToConfirm": "Scroll to the end of the list to confirm.",
  "publishConfirm.list.noneLeft": "Every Pin was removed. Add one back or cancel.",
  "publishConfirm.list.scheduleTitle": "Schedule {n} selected",
  "publishConfirm.list.scheduleConfirm": "Schedule {n}",
  "publishConfirm.list.publishConfirm": "Publish {n}",
} as const;
