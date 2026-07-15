export const queueMessages = {
  // ── Status badges ──
  "queue.status.pending": "Pending",
  "queue.status.processing": "Processing",
  "queue.status.done": "Published",
  "queue.status.failed": "Failed",

  // ── Relative time formatting ──
  "queue.time.lessThanHour": "< 1h",
  "queue.time.inHours": "In {n}h",
  "queue.time.hoursAgo": "{n}h ago",

  // ── Day labels (Mon–Sun) ──
  "queue.day.mon": "Mon",
  "queue.day.tue": "Tue",
  "queue.day.wed": "Wed",
  "queue.day.thu": "Thu",
  "queue.day.fri": "Fri",
  "queue.day.sat": "Sat",
  "queue.day.sun": "Sun",

  // ── List row ──
  "queue.row.updateFailed": "Update failed",
  "queue.row.viewOnPinterest": "View on Pinterest",

  // ── Calendar view ──
  "queue.calendar.today": "Today",
  "queue.calendar.createPinForDay": "Create a pin for this day",
  "queue.calendar.addCreate": "+ Create",

  // ── Page header ──
  "queue.header.title": "Content Calendar",
  "queue.header.subtitle": "Plan · Schedule · Publish",
  "queue.header.viewCalendar": "Calendar",
  "queue.header.viewList": "List",
  "queue.header.pendingSuffix": "pending",
  "queue.header.refresh": "Refresh",
  "queue.header.createPin": "Create Pin",

  // ── Table-not-exist state ──
  "queue.notSetUp.title": "Queue not set up yet",
  "queue.notSetUp.descPrefix": "The",
  "queue.notSetUp.descSuffix": "table needs to be created in Supabase first.",
  "queue.notSetUp.runSqlPrefix": "Run the SQL from the error response of",

  // ── Calendar empty banner ──
  "queue.emptyBanner.message": "No scheduled pins yet — generate a pin in Studio, fill in the product URL, then click Schedule to Pinterest.",
  "queue.emptyBanner.openStudio": "Open Studio →",

  // ── List view: status tabs ──
  "queue.tab.upcoming": "Upcoming",
  "queue.tab.published": "Published",
  "queue.tab.failed": "Failed",
  "queue.tab.autoRefresh": "Auto-refreshes every 30s",

  // ── List view: empty states ──
  "queue.listEmpty.generateHint": "Generate a pin in Studio, fill in product URL + caption, then click Schedule.",
  "queue.listEmpty.openStudio": "Open Studio",
  "queue.listEmpty.browseTrends": "Browse Trends",
  "queue.listEmpty.noPinsInTab": "No {tab} pins.",
} as const;
