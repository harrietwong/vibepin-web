export const planViewsMessages = {
  // ── PlanListView: status labels ──
  "planViews.list.status.scheduled": "Scheduled",
  "planViews.list.status.unscheduled": "Unscheduled",
  "planViews.list.status.published": "Published",
  "planViews.list.status.failed": "Failed",
  "planViews.list.status.allStatuses": "All statuses",

  // ── PlanListView: toolbar ──
  "planViews.list.searchPlaceholder": "Search pins",
  "planViews.list.columns": "Columns",
  "planViews.list.columnBoard": "Board",
  "planViews.list.columnUrl": "Destination URL",
  "planViews.list.columnProduct": "Product",
  "planViews.list.selectedCount": "{n} selected",
  "planViews.list.batchEdit": "Batch edit",
  "planViews.list.schedule": "Schedule",
  "planViews.list.publishNow": "Publish now",
  "planViews.list.publishSelectedTitle": "Publish selected Pins",
  "planViews.list.publishSelectedDisabledTitle": "No selected Pin can be published",
  "planViews.list.clear": "Clear",

  // ── PlanListView: header row ──
  "planViews.list.selectAllAria": "Select all",
  "planViews.list.selectPinAria": "Select pin",
  "planViews.list.headerPin": "Pin",
  "planViews.list.headerPublishTime": "Publish time",
  "planViews.list.headerStatus": "Status",
  "planViews.list.headerBoard": "Board",
  "planViews.list.headerDestinationUrl": "Destination URL",
  "planViews.list.headerProduct": "Product",
  "planViews.list.headerActions": "Actions",

  // ── PlanListView: empty state ──
  "planViews.list.emptyState": "No Pins match. Create Pins or adjust filters.",

  // ── PlanListView: product / board / url cells ──
  "planViews.list.noProduct": "No product",
  "planViews.list.oneProduct": "1 product",
  "planViews.list.nProducts": "{n} products",
  "planViews.list.selectBoard": "Select board",
  "planViews.list.addUrl": "Add URL",

  // ── PlanListView: row actions ──
  "planViews.list.editDetails": "Edit details",
  "planViews.list.view": "View",
  "planViews.list.reschedule": "Reschedule",
  "planViews.list.scheduleSlotTitle": "Schedule into the next available Smart Schedule slot",

  // ── PlanListView: toasts ──
  "planViews.list.toast.scheduledOne": "Scheduled 1 Pin to upcoming Smart Schedule slots.",
  "planViews.list.toast.scheduledMany": "Scheduled {n} Pins to upcoming Smart Schedule slots.",

  // ── SmartScheduleDrawer (modal) ──
  "planViews.drawer.ariaLabel": "Smart Schedule",
  "planViews.drawer.title": "Smart Schedule",
  "planViews.drawer.subtitle": "Choose how often VibePin should publish, then preview reusable weekly time slots.",
  "planViews.drawer.closeAria": "Close",
  "planViews.drawer.cancel": "Cancel",
  "planViews.drawer.save": "Save",

  // ── SmartScheduleConfigForm: validation toasts ──
  "planViews.form.toast.chooseTimezone": "Choose a publishing timezone.",
  "planViews.form.toast.selectActiveDay": "Select at least one active day.",
  "planViews.form.toast.endAfterStart": "End time must be later than start time.",
  "planViews.form.toast.noSlotsGenerated": "No publishing slots generated. Check your active days and time windows.",

  // ── SmartScheduleConfigForm: save / rebalance toasts ──
  "planViews.form.toast.saved": "Smart Schedule saved.",
  "planViews.form.toast.savedUnchanged": "Smart Schedule saved. Existing planned Pins were unchanged.",
  "planViews.form.toast.rebalancedOne": "Rebalanced 1 planned Pin.",
  "planViews.form.toast.rebalancedMany": "Rebalanced {n} planned Pins.",
  "planViews.form.toast.undoAction": "Undo",
  "planViews.form.toast.rebalanceUndone": "Rebalance undone.",
  "planViews.form.toast.invalidTime": "Enter a valid time (HH:mm).",

  // ── SmartScheduleConfigForm: Section 1 — Publishing timezone ──
  "planViews.form.timezoneTitle": "Publishing timezone",
  "planViews.form.localTimezone": "Local timezone ({tz})",
  "planViews.form.customTimezone": "Custom…",
  "planViews.form.customTimezonePlaceholder": "e.g. America/New_York",
  "planViews.form.timezoneHelp": "Your schedule uses this timezone for future Pins.",

  // ── SmartScheduleConfigForm: Section 2 — Posting rhythm ──
  "planViews.form.rhythmTitle": "Posting rhythm",
  "planViews.form.modeRecommended": "Recommended",
  "planViews.form.modeSameEveryDay": "Same every day",
  "planViews.form.recommendedHelp": "VibePin will generate a balanced weekly posting rhythm based on your active days and preferred time windows.",
  "planViews.form.pinsPerActiveDay": "Pins per active day",
  "planViews.form.pinsPerDayHelpOne": "Every active day will generate exactly {n} publishing slot.",
  "planViews.form.pinsPerDayHelpMany": "Every active day will generate exactly {n} publishing slots.",
  "planViews.form.volumeSameEveryDay": "Same every day · {n} pins/day",
  "planViews.form.volumeRecommended": "Recommended rhythm",

  // ── SmartScheduleConfigForm: Section 3 — Active days ──
  "planViews.form.activeDaysTitle": "Active days",
  "planViews.form.validationSelectActiveDay": "Select at least one active day.",

  // ── SmartScheduleConfigForm: Section 4 — Preferred time windows ──
  "planViews.form.timeWindowsTitle": "Preferred time windows",
  "planViews.form.validationEndAfterStart": "End time must be later than start time.",

  // ── SmartScheduleConfigForm: Section 5 — Generated weekly slots ──
  "planViews.form.generatedSlotsTitle": "Generated weekly slots",
  "planViews.form.unsavedChanges": "Unsaved changes",
  "planViews.form.livePreview": "Live preview",
  "planViews.form.dayHeaderOne": "{day} · 1 slot",
  "planViews.form.dayHeaderMany": "{day} · {n} slots",
  "planViews.form.noSlotsForDay": "No slots for this day.",
  "planViews.form.removeSlotAria": "Remove {time}",
  "planViews.form.validationNoSlots": "No publishing slots generated. Check your active days and time windows.",
  "planViews.form.regenerateTimes": "Regenerate times",
  "planViews.form.resetToRecommended": "Reset to recommended",
  "planViews.form.dayTabTitle": "{day}",
  "planViews.form.dayTabTitleWithSlots": "{day} · {n} slots",

  // ── SmartScheduleConfigForm: Section 6 — Advanced ──
  "planViews.form.advanced": "Advanced",
  "planViews.form.addCustomSlotTitle": "Add custom slot",
  "planViews.form.addCustomSlot": "Add custom slot",
  "planViews.form.customSlotsHelp": "Custom slots are kept when the preview regenerates.",

  // ── SmartScheduleConfigForm: Rebalance confirmation dialog ──
  "planViews.form.rebalance.title": "Smart Schedule updated",
  "planViews.form.rebalance.bodyIntro": "Your new Smart Schedule will be used for all future scheduled Pins.",
  "planViews.form.rebalance.bodyCountOne": "You already have 1 planned Pin. Do you want to update its publish date and time to match the new schedule?",
  "planViews.form.rebalance.bodyCountMany": "You already have {n} planned Pins. Do you want to update their publish dates and times to match the new schedule?",
  "planViews.form.rebalance.bulletUnlockedOnly": "Only unlocked planned Pins will be updated.",
  "planViews.form.rebalance.bulletExclusions": "Locked, posted, past, and manually scheduled Pins will not be changed.",
  "planViews.form.rebalance.bulletDatesChange": "Dates and times may change.",
  "planViews.form.rebalance.bulletUndo": "You can undo this after rebalancing.",
  "planViews.form.rebalance.confirmButton": "Rebalance planned Pins",
  "planViews.form.rebalance.keepButton": "Keep current times",
};
