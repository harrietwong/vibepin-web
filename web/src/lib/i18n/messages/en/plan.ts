// Weekly Plan (web/src/app/app/plan/page.tsx) — new i18n keys not yet merged into
// the main en.ts catalog / index.ts. See task notes: this file is intentionally
// NOT wired into getMessages() yet.
export const planMessages = {
  // ── Day-of-week short labels (DAY_SHORT) ──
  "plan.day.mon": "MON",
  "plan.day.tue": "TUE",
  "plan.day.wed": "WED",
  "plan.day.thu": "THU",
  "plan.day.fri": "FRI",
  "plan.day.sat": "SAT",
  "plan.day.sun": "SUN",

  // ── Status labels (draftStatusDisplay / railStatus) ──
  "plan.status.published": "Published",
  "plan.status.unscheduled": "Unscheduled",
  "plan.status.scheduled": "Scheduled",

  // ── View Pins modal ──
  "plan.viewPins.pinCountSuffix": "pin{plural} added to plan",
  "plan.viewPins.readySuffix": "ready",
  "plan.viewPins.createMore": "✦ Create More",
  "plan.viewPins.downloadAll": "↓ Download all",
  "plan.viewPins.selectedCount": "{n} selected",
  "plan.viewPins.downloadSelected": "↓ Download selected",
  "plan.viewPins.removeSelected": "Remove selected",
  "plan.viewPins.deselect": "Deselect",
  "plan.viewPins.selectAll": "Select all",
  "plan.viewPins.emptyTitle": "No pins added yet",
  "plan.viewPins.emptySub": "Generate pins in Create Pin and add them to this plan item.",
  "plan.viewPins.createPins": "✦ Create Pins",
  "plan.viewPins.edit": "Edit",
  "plan.viewPins.download": "↓ DL",
  "plan.viewPins.remove": "Remove",

  // ── Summary bar ──
  "plan.summary.thisWeek": "This week:",
  "plan.summary.scheduled": "scheduled",
  "plan.summary.scheduledTip": "Pins scheduled in this week",
  "plan.summary.published": "published",
  "plan.summary.publishedTip": "Pins published to Pinterest",
  "plan.summary.unscheduled": "unscheduled",
  "plan.summary.unscheduledTip": "Generated Pins not placed on the calendar",
  "plan.summary.batchEditTip": "Open Batch Edit for these Pins",

  // ── Select checkbox ──
  "plan.select.select": "Select",
  "plan.select.deselect": "Deselect",

  // ── Draggable pin card ──
  "plan.card.lockTitle": "Time locked — kept when rebalancing",
  "plan.card.lockAria": "Time locked",
  "plan.card.removeTitle": "Remove from plan (back to unscheduled)",

  // ── Slot placeholder ──
  "plan.slot.past": "Past",
  "plan.slot.dropHere": "Drop pin here",

  // ── Day column ──
  "plan.day.noSlots": "No posting slots for this day",
  "plan.day.addPin": "+ Add Pin",

  // ── Day detail drawer (month view) ──
  "plan.dayDetail.pinsScheduledCount": "{n} Pin{plural} scheduled · times in your local zone",
  "plan.dayDetail.closeAria": "Close",
  "plan.dayDetail.empty": "No Pins scheduled for this day.",
  "plan.dayDetail.published": "Published",
  "plan.dayDetail.scheduled": "Scheduled",
  "plan.dayDetail.editDetails": "Edit details",
  "plan.dayDetail.reschedule": "Reschedule",
  "plan.dayDetail.publishNow": "Publish now",

  // ── Month cell ──
  "plan.month.more": "+{n} more",

  // ── Header ──
  "plan.header.defaultWorkspace": "Default workspace",
  "plan.header.filteringTitle": "Filtering by category — click to show all",
  "plan.header.today": "Today",
  "plan.header.exportCsv": "↓ Export CSV",
  "plan.header.smartSchedule": "Smart Schedule",
  "plan.header.editDone": "✓ Done",
  "plan.header.editPlan": "✏️ Edit Plan",
  "plan.header.keywordPlanTitle": "Edit keyword plan",
  "plan.header.keywordPlan": "Keyword plan",
  "plan.header.createPin": "✦ Create Pin",
  "plan.header.allCategories": "All categories",

  // ── View mode / scope toggles ──
  "plan.viewMode.calendar": "Calendar",
  "plan.viewMode.list": "List",
  "plan.scope.week": "week",
  "plan.scope.month": "month",
  "plan.unscheduledToggle": "Unscheduled ({n})",
  "plan.filters.button": "⚙ Filters",
  "plan.filters.title": "Filters",
  "plan.filters.clear": "Clear",
  "plan.filters.category": "Category",
  "plan.filters.footer": "Boards, status, and opportunity filters coming soon. Category is optional — Pins of any category plan in the same calendar.",

  // ── Content area ──
  "plan.load.error": "Could not load your plan.",
  "plan.load.retry": "Retry",
  "plan.empty.allCategoriesPrefix": "Nothing scheduled this week yet. Add Pins from the unscheduled list",
  "plan.empty.allCategoriesOnRight": " on the right",
  "plan.empty.allCategoriesBelow": " below",
  "plan.empty.allCategoriesSuffix": ", or ",
  "plan.empty.createNewPins": "create new Pins →",
  "plan.empty.categoryPrefix": "No keyword plan for ",
  "plan.empty.categorySuffix": " this week yet. Add Pins from the unscheduled list, or ",
  "plan.empty.buildKeywordPlan": "build a keyword plan →",
  "plan.footer.timezoneNote": "🕐 All times are in your local time zone · Schedule uses Smart Schedule · drag Pins to reschedule manually",

  // ── Selection bar ──
  "plan.selectionBar.hint": "Select Pins to perform actions.",
  "plan.selectionBar.selectedCount": "{n} selected",
  "plan.selectionBar.batchEdit": "Batch edit",
  "plan.selectionBar.schedule": "Schedule",
  "plan.selectionBar.publishNow": "Publish now",
  "plan.selectionBar.publishNowTitle": "Publish the selected Pins",
  "plan.selectionBar.publishNowDisabledTitle": "Select at least one Pin to publish",
  "plan.selectionBar.moveDate": "Move date",
  "plan.selectionBar.removeFromPlan": "Remove from plan",
  "plan.selectionBar.clear": "Clear",

  // ── Move date modal ──
  "plan.moveDate.title": "Move {n} Pin{plural} to…",
  "plan.moveDate.cancel": "Cancel",
  "plan.moveDate.move": "Move",

  // ── Added, needs date section ──
  "plan.needsDate.heading": "Added to plan · assign a date",
  "plan.needsDate.helper": "These pins are in your plan but not on the calendar yet. Assign a date to place them on a day above.",
  "plan.needsDate.assignDate": "Assign date",
  "plan.needsDate.editDetails": "Edit details",
  "plan.needsDate.remove": "Remove",

  // ── Unscheduled generated section ──
  "plan.unscheduledSection.heading": "Generated Pins · Not added to plan",
  "plan.unscheduledSection.viewAllHistory": "View all in History →",
  "plan.unscheduledSection.dropToRemove": "Drop here to remove from plan",
  "plan.unscheduledSection.scheduleTitle": "Schedule into the next available Smart Schedule slot",
  "plan.unscheduledSection.schedule": "Schedule",
  "plan.unscheduledSection.editDetails": "Edit details",

  // ── Unscheduled rail ──
  "plan.rail.title": "Unscheduled Pins",
  "plan.rail.history": "History →",
  "plan.rail.dropToRemove": "Drop here to remove from plan",
  "plan.rail.emptyPrefix": "No unscheduled Pins. ",
  "plan.rail.createPins": "Create Pins",
  "plan.rail.emptyOr": " or view your ",
  "plan.rail.pinHistory": "Pin history",
  "plan.rail.emptySuffix": ".",
  "plan.rail.viewAll": "View all {n} unscheduled Pins",
  "plan.rail.viewAllDrawerTitle": "All unscheduled Pins · {n}",
  "plan.rail.scheduleTitle": "Schedule into the next available Smart Schedule slot",
  "plan.rail.schedule": "Schedule",
  "plan.rail.editDetails": "Edit details",
  "plan.rail.generatedFallback": "Generated",

  // ── Restore notice / toasts ──
  "plan.restore.pinterestConnectedContinue": "Pinterest connected. You can continue publishing this Pin.",
  "plan.restore.pinterestCancelled": "Pinterest connection was cancelled. You can try again when ready.",
  "plan.restore.pinterestFailed": "Pinterest couldn't be connected. Please try again from the Pin.",
  "plan.restore.connectedSelectAgain": "Pinterest connected. Please select the Pin again to continue publishing.",
  "plan.restore.notCompletedSelectAgain": "Pinterest connection was not completed. Please select the Pin again.",

  // ── Errors / validation ──
  "plan.error.pinNotFound": "Could not find this Pin.",
  "plan.error.needsImage": "This Pin needs an image before it can be scheduled.",
  "plan.error.needsTitle": "This Pin needs a title before it can be scheduled.",
  "plan.error.needsDescription": "This Pin needs a description before it can be scheduled.",
  "plan.error.needsBoard": "Add a board before publishing.",

  // ── Drop-block toasts (assignToDate) ──
  "plan.dropBlock.editSmartSchedule": "Edit Smart Schedule",
  "plan.dropBlock.allPastTitle": "No open time left on {date}.",
  "plan.dropBlock.allPastDesc": "{date}'s remaining Smart Schedule slots have already passed. Pick a later custom time today, or choose another day.",
  "plan.dropBlock.noSlotsTitle": "No Smart Schedule slots on {date}.",
  "plan.dropBlock.noSlotsDesc": "{date} has no Smart Schedule time slots yet. Add a slot in Smart Schedule, or choose another day.",
  "plan.dropBlock.fullTitle": "No available slots on {date}.",
  "plan.dropBlock.fullDesc": "This day already has {n} scheduled Pin{plural} filling every Smart Schedule slot. Increase pins per day or choose another day.",

  // ── Other toasts ──
  "plan.toast.timeLocked": "Time locked — kept during rebalancing.",
  "plan.toast.timeUnlocked": "Time unlocked.",
  "plan.toast.blockedNeedsDetails": "{n} Pin{plural} need an image, title, or description before scheduling.",
  "plan.toast.alreadyScheduled": "{n} Pin{plural} already scheduled",
  "plan.toast.couldNotSchedule": "Could not schedule selected Pins.",
  "plan.toast.scheduledCount": "Scheduled {n} Pin{plural}{alreadySuffix}",
  "plan.toast.alreadyScheduledSuffix": " · {n} already scheduled",
  "plan.toast.generatedMissingDetails": "Generated missing details",
  "plan.toast.movedPins": "Moved {n} Pin{plural} to {date}",
  "plan.toast.removedPins": "Removed {n} Pin{plural} from plan",
  "plan.toast.selectedNeedDetails": "Selected Pins need an image, title, or description before scheduling.",
  "plan.toast.noUnscheduledSelected": "No unscheduled Pins selected — already scheduled Pins are skipped.",
} as const;
