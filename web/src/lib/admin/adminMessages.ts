/**
 * Admin console UI language — independent of the client app's i18n system
 * (LocaleProvider / lib/i18n/*). Deliberately small and self-contained: this is
 * NOT the 18-locale customer i18n stack, just an EN/中文 dictionary for the
 * internal admin console's own chrome and page labels.
 *
 * Scope discipline: only pure UI prose lives here. Never put database content,
 * table/column names, IDs, URLs, or raw data values in this dictionary — those
 * must always render verbatim regardless of admin language.
 */

export type AdminLanguage = "en" | "zh";

export const ADMIN_LANGUAGE_STORAGE_KEY = "vibepin-admin-language";
export const DEFAULT_ADMIN_LANGUAGE: AdminLanguage = "en";

export function normalizeAdminLanguage(value: unknown): AdminLanguage {
  return value === "zh" ? "zh" : DEFAULT_ADMIN_LANGUAGE;
}

function ok(): boolean {
  return typeof window !== "undefined";
}

export function readLocalAdminLanguage(): AdminLanguage {
  if (!ok()) return DEFAULT_ADMIN_LANGUAGE;
  try {
    return normalizeAdminLanguage(localStorage.getItem(ADMIN_LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_ADMIN_LANGUAGE;
  }
}

export function writeLocalAdminLanguage(lang: AdminLanguage): void {
  if (!ok()) return;
  try {
    localStorage.setItem(ADMIN_LANGUAGE_STORAGE_KEY, lang);
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

const en = {
  "shell.title": "Admin Console",
  "shell.internal": "Internal",
  "shell.superAdminGated": "Super-admin gated",

  "nav.today": "Today",
  "nav.overview": "Overview",
  "nav.data": "Data Freshness",
  "nav.pipeline": "Pipeline / Jobs",
  "nav.customers": "Customers",
  "nav.support": "Support Tickets",
  "nav.generationLogs": "Generation Logs",
  "nav.visualReview": "Visual Review",
  "nav.creativeIntelligence": "Creative Intelligence",

  "data.badge": "Super Admin only · Internal",
  "data.title": "Data Freshness & Inventory",
  "data.subtitle": "Read-only totals, freshness windows, and quality counters. No mutation controls.",
  "data.inventory.title": "Data Inventory",
  "data.visualReview.title": "Visual Review candidates",
  "data.quality.title": "Quality counters",
  "data.footer": "Read-only. No crawler / apply / requeue / timer / product-supply / scoring controls on this page.",

  "stat.created24h": "Created 24h",
  "stat.created48h": "Created 48h",
  "stat.created5d": "Created 5d",
  "stat.total": "Total",

  "status.fresh": "FRESH",
  "status.stale": "STALE",
  "status.unknown": "UNKNOWN",

  // ── Today (operator console) ─────────────────────────────────────────────
  "today.badge": "Super Admin only · Internal",
  "today.title": "Today",
  "today.subtitle": "What needs attention right now, and how activation is trending. Read-only.",
  "today.footer": "Read-only. No requeue / reconnect / token-grant / messaging controls on this page.",

  "today.actionCenter.title": "Today's Blocker List",
  "today.actionCenter.col.user": "User",
  "today.actionCenter.col.blocker": "Blocker",
  "today.actionCenter.col.firstSeen": "First seen",
  "today.actionCenter.col.reason": "Reason",
  "today.actionCenter.col.suggestedAction": "Suggested action",
  "today.actionCenter.empty.title": "No blockers today",
  "today.actionCenter.empty.subtitle": "Every user is unblocked as of this snapshot. Nice.",
  "today.actionCenter.unavailable": "Action Center unavailable — one or more required data sources could not be read.",
  "today.actionCenter.windowNote": "Blocker window: last {hours}h.",

  "today.funnel.title": "Activation Funnel (last 30d cohort)",
  "today.funnel.cohortNote": "Cohort: {count} users who signed up in the last {days} days.",
  "today.funnel.unavailable": "Activation Funnel unavailable — one or more required data sources could not be read.",
  "today.funnel.reached": "reached",
  "today.funnel.stuck": "stuck",
  "today.funnel.splitNote": "{exact} exact · {inferred} inferred",
  "today.funnel.splitNote.empty": "No publishes yet — nothing to attribute.",

  "today.topCreators.title": "This Week's Top Creators",
  "today.topCreators.note": "Ships in P1 — not yet built.",

  "today.aiAdoption.title": "AI Adoption Rate",
  "today.aiAdoption.unavailable": "AI Adoption unavailable — one or more required data sources could not be read.",
  "today.aiAdoption.ratio": "{adopted} of {completed} completed generations",
  "today.aiAdoption.linkSplitNote": "Linkage: {exact} exact · {inferred} inferred",
  "today.aiAdoption.methodology": "Methodology: historical drafts are linked to a generation by matching image URLs (approximate). New drafts carry a direct generation id (exact).",
  "today.aiAdoption.trend.up": "Improving vs. the prior 7 days",
  "today.aiAdoption.trend.down": "Declining vs. the prior 7 days",
  "today.aiAdoption.trend.flat": "Flat vs. the prior 7 days",

  "today.dataQuality.inferred": "Inferred",
  "today.dataQuality.exact": "Exact",

  "time.relative.justNow": "just now",
  "time.relative.minutesAgo": "{n}m ago",
  "time.relative.hoursAgo": "{n}h ago",
  "time.relative.daysAgo": "{n}d ago",

  "blocker.publish_failure.label": "Publish failure",
  "blocker.pinterest_disconnected.label": "Pinterest disconnected",
  "blocker.generation_failures.label": "Generation failures",
  "blocker.signup_not_connected.label": "Signed up, not connected",
  "blocker.connected_not_creating.label": "Connected, not creating",

  "blocker.publish_failure.action": "Check the error code, fix or reply to the user",
  "blocker.pinterest_disconnected.action": "Send a reconnect email",
  "blocker.generation_failures.action": "Check generation logs; consider a token credit",
  "blocker.signup_not_connected.action": "Send a connect-Pinterest email",
  "blocker.connected_not_creating.action": "Send an onboarding nudge",

  "blocker.evidence.publishFailure": "{count} failed publish attempt(s)",
  "blocker.evidence.publishFailureWithCode": "{count} failed publish attempt(s) · code {code}",
  "blocker.evidence.generationFailuresWithType": "{count} failed generation(s) in the last 24h · latest: {typeLabel}",

  "genError.rate_limited": "Rate limited",
  "genError.safety_blocked": "Blocked by safety filter",
  "genError.image_load_failed": "Image failed to load",
  "genError.model_returned_text": "Model returned text, not an image",
  "genError.api_auth_error": "Provider auth error",
  "genError.api_payload_error": "Invalid request to provider",
  "genError.api_server_error": "Provider server error",
  "genError.provider_busy": "Provider busy",
  "genError.user_generation_limit": "User generation limit reached",
  "genError.configuration_error": "Configuration error",
  "genError.unknown_error": "Unknown error",
  "blocker.evidence.pinterestDisconnected.disconnected": "Account disconnected",
  "blocker.evidence.pinterestDisconnected.needsReconnect": "Needs reconnect",
  "blocker.evidence.generationFailures": "{count} failed generation(s) in the last 24h",
  "blocker.evidence.signupNotConnected": "Signed up {hours}h ago, never connected Pinterest",
  "blocker.evidence.connectedNotCreating": "Connected {hours}h ago, zero generations and zero drafts",

  "funnel.stage.signup": "Signup",
  "funnel.stage.pinterestConnected": "Connected Pinterest",
  "funnel.stage.firstGeneration": "First generation",
  "funnel.stage.firstPublish": "First publish",
  "funnel.stage.repeatPublish": "Repeat publish",

  "today.accounts.excluded": "Excluded {test} test account(s) and {internal} internal account(s)",
  "today.accounts.showAll": "Show all",
  "today.accounts.includingAll": "Showing test and internal accounts",
  "today.accounts.customersOnly": "Real customers only",
  "today.accountKind.test": "Test",
  "today.accountKind.internal": "Internal",

  // ── Customer 360 additions ───────────────────────────────────────────────
  "c360.alerts.title": "Open Blockers",
  "c360.alerts.none": "No open blockers",
  "c360.health.band.green": "Healthy",
  "c360.health.band.yellow": "Needs attention",
  "c360.health.band.red": "At risk",
  "c360.health.driversPrefix": "Why:",
  "c360.health.driver.activeLast7d": "Not active in the last 7 days",
  "c360.health.driver.publishedLast14d": "No publish in the last 14 days",
  "c360.health.driver.pinterestHealthy": "Pinterest connection unhealthy",
  "c360.health.driver.noOpenBlockers": "Has open blockers",

  // ── Instagram comment → DM (super-admin, own accounts) ─────────────────
  "nav.igAutoDm": "IG Comment → DM",
  "igdm.badge": "Super Admin only · Your own accounts",
  "igdm.title": "Instagram comment → auto DM",
  "igdm.subtitle": "When someone comments a keyword on your post, send them one private reply (DM). Polled every 5 minutes; one DM per comment, within 7 days.",
  "igdm.loading": "Loading…",
  "igdm.loadFailed": "Could not load",
  "igdm.refresh": "Refresh",
  "igdm.connections.title": "My Instagram accounts",
  "igdm.connections.empty": "No Instagram account connected to your user yet.",
  "igdm.scopes.granted": "Comment + DM permissions granted",
  "igdm.scopes.missing": "Comment + DM permissions NOT granted",
  "igdm.scopes.grantButton": "Reconnect with comment + DM permissions",
  "igdm.scopes.help": "After approving, you will land on Settings → Social; come back to this page. In the Instagram app also turn on Settings → Messages and story replies → Message controls → Connected tools → \"Allow access to messages\".",
  "igdm.connections.lastRun": "Last run",
  "igdm.connections.never": "never",
  "igdm.rules.title": "Rules",
  "igdm.rules.empty": "No rules for this account yet.",
  "igdm.rules.add": "New rule",
  "igdm.rules.edit": "Edit",
  "igdm.rules.delete": "Delete",
  "igdm.rules.deleteConfirm": "Delete this rule? Its event history is kept.",
  "igdm.rules.save": "Save",
  "igdm.rules.cancel": "Cancel",
  "igdm.rules.saving": "Saving…",
  "igdm.rules.enabled": "Enabled",
  "igdm.rules.disabled": "Disabled",
  "igdm.rules.enable": "Enable",
  "igdm.rules.disable": "Disable",
  "igdm.rules.keywords": "Keywords (comma separated, any one matches, case-insensitive)",
  "igdm.rules.media": "Post",
  "igdm.rules.allPosts": "All posts",
  "igdm.rules.loadMedia": "Load recent posts",
  "igdm.rules.dmText": "DM text",
  "igdm.rules.publicReply": "Also reply publicly under the comment (only after the DM succeeds)",
  "igdm.rules.publicReplyText": "Public reply text",
  "igdm.rules.startAfter": "Only comments at/after",
  "igdm.rules.newDefaultsOff": "New rules start disabled. Run Preview first, then enable.",
  "igdm.preview.button": "Preview matches",
  "igdm.preview.running": "Scanning comments…",
  "igdm.preview.title": "Preview (nothing is sent)",
  "igdm.preview.none": "No comment would receive a DM right now.",
  "igdm.preview.note": "Preview treats all rules of this account as enabled.",
  "igdm.col.user": "User",
  "igdm.col.comment": "Comment",
  "igdm.col.rule": "Rule / keyword",
  "igdm.col.time": "Time",
  "igdm.col.status": "Status",
  "igdm.col.error": "Error",
  "igdm.col.publicReply": "Public reply",
  "igdm.retryFailed.button": "Retry failed items",
  "igdm.retryFailed.confirm": "Put this account's failed DMs that are still within 7 days back in the queue? They are retried on the next run (within 5 minutes).",
  "igdm.retryFailed.done": "{count} item(s) queued for retry on the next run.",
  "igdm.retryFailed.running": "Queuing…",
  "igdm.events.title": "Recent events",
  "igdm.events.empty": "No events yet.",
  "igdm.footer": "Comment webhooks need Meta Advanced Access, so this polls. Meta allows exactly one private reply per comment, within 7 days.",
} as const;

const zh: Record<keyof typeof en, string> = {
  "shell.title": "管理后台",
  "shell.internal": "内部",
  "shell.superAdminGated": "仅限超级管理员",

  "nav.today": "今日",
  "nav.overview": "概览",
  "nav.data": "数据新鲜度",
  "nav.pipeline": "任务流水线",
  "nav.customers": "客户",
  "nav.support": "支持工单",
  "nav.generationLogs": "生成日志",
  "nav.visualReview": "视觉审核",
  "nav.creativeIntelligence": "创意智能",

  "data.badge": "仅限超级管理员 · 内部",
  "data.title": "数据新鲜度与库存",
  "data.subtitle": "只读统计、新鲜度窗口与质量计数器。无写入操作。",
  "data.inventory.title": "数据库存",
  "data.visualReview.title": "视觉审核候选项",
  "data.quality.title": "质量计数器",
  "data.footer": "只读页面。此页不包含爬虫 / 应用 / 重新入队 / 定时任务 / 商品供给 / 评分等操作控件。",

  "stat.created24h": "近24小时新增",
  "stat.created48h": "近48小时新增",
  "stat.created5d": "近5天新增",
  "stat.total": "总计",

  "status.fresh": "新鲜",
  "status.stale": "过期",
  "status.unknown": "未知",

  // ── Today (operator console) ─────────────────────────────────────────────
  "today.badge": "仅限超级管理员 · 内部",
  "today.title": "今日",
  "today.subtitle": "当前需要关注的问题，以及激活趋势。只读页面。",
  "today.footer": "只读页面。此页不包含重新入队 / 重连 / 发放token / 发送消息等操作控件。",

  "today.actionCenter.title": "今日阻塞名单",
  "today.actionCenter.col.user": "用户",
  "today.actionCenter.col.blocker": "阻塞类型",
  "today.actionCenter.col.firstSeen": "首次发现",
  "today.actionCenter.col.reason": "原因",
  "today.actionCenter.col.suggestedAction": "建议操作",
  "today.actionCenter.empty.title": "今日无阻塞",
  "today.actionCenter.empty.subtitle": "截至本次快照，所有用户均无阻塞。",
  "today.actionCenter.unavailable": "阻塞名单不可用 —— 一个或多个所需数据源无法读取。",
  "today.actionCenter.windowNote": "阻塞窗口：近 {hours} 小时。",

  "today.funnel.title": "激活漏斗（近30天同期群组）",
  "today.funnel.cohortNote": "同期群组：近 {days} 天内注册的 {count} 名用户。",
  "today.funnel.unavailable": "激活漏斗不可用 —— 一个或多个所需数据源无法读取。",
  "today.funnel.reached": "已到达",
  "today.funnel.stuck": "卡在此",
  "today.funnel.splitNote": "{exact} 精确 · {inferred} 推断",
  "today.funnel.splitNote.empty": "尚无发布数据可归因。",

  "today.topCreators.title": "本周 Top 创作者",
  "today.topCreators.note": "将在 P1 上线 —— 尚未构建。",

  "today.aiAdoption.title": "AI 采用率",
  "today.aiAdoption.unavailable": "AI 采用率不可用 —— 一个或多个所需数据源无法读取。",
  "today.aiAdoption.ratio": "{completed} 次已完成生成中的 {adopted} 次",
  "today.aiAdoption.linkSplitNote": "关联方式：{exact} 精确 · {inferred} 推断",
  "today.aiAdoption.methodology": "方法说明：历史草稿通过匹配图片 URL 与生成记录关联（近似值）。新草稿携带直接的生成 ID（精确值）。",
  "today.aiAdoption.trend.up": "较前7天上升",
  "today.aiAdoption.trend.down": "较前7天下降",
  "today.aiAdoption.trend.flat": "较前7天持平",

  "today.dataQuality.inferred": "推断",
  "today.dataQuality.exact": "精确",

  "time.relative.justNow": "刚刚",
  "time.relative.minutesAgo": "{n} 分钟前",
  "time.relative.hoursAgo": "{n} 小时前",
  "time.relative.daysAgo": "{n} 天前",

  "blocker.publish_failure.label": "发布失败",
  "blocker.pinterest_disconnected.label": "Pinterest 已断开",
  "blocker.generation_failures.label": "生成失败",
  "blocker.signup_not_connected.label": "已注册未连接",
  "blocker.connected_not_creating.label": "已连接未创作",

  "blocker.publish_failure.action": "查错误码修复/回复用户",
  "blocker.pinterest_disconnected.action": "引导重连邮件",
  "blocker.generation_failures.action": "查生成日志/送token补偿",
  "blocker.signup_not_connected.action": "引导连接邮件",
  "blocker.connected_not_creating.action": "发送 onboarding 引导",

  "blocker.evidence.publishFailure": "{count} 次发布失败",
  "blocker.evidence.publishFailureWithCode": "{count} 次发布失败 · 错误码 {code}",
  "blocker.evidence.generationFailuresWithType": "{count} 次生成失败 · 最近：{typeLabel}",

  "genError.rate_limited": "触发频率限制",
  "genError.safety_blocked": "被安全策略拦截",
  "genError.image_load_failed": "图片加载失败",
  "genError.model_returned_text": "模型返回了文本而非图片",
  "genError.api_auth_error": "服务商鉴权失败",
  "genError.api_payload_error": "请求参数不合法",
  "genError.api_server_error": "服务商服务端错误",
  "genError.provider_busy": "服务商繁忙",
  "genError.user_generation_limit": "已达用户生成上限",
  "genError.configuration_error": "配置错误",
  "genError.unknown_error": "未知错误",
  "blocker.evidence.pinterestDisconnected.disconnected": "账号已断开连接",
  "blocker.evidence.pinterestDisconnected.needsReconnect": "需要重新连接",
  "blocker.evidence.generationFailures": "近24小时内 {count} 次生成失败",
  "blocker.evidence.signupNotConnected": "注册于 {hours} 小时前，从未连接 Pinterest",
  "blocker.evidence.connectedNotCreating": "连接于 {hours} 小时前，零生成且零草稿",

  "funnel.stage.signup": "注册",
  "funnel.stage.pinterestConnected": "连接 Pinterest",
  "funnel.stage.firstGeneration": "首次生成",
  "funnel.stage.firstPublish": "首次发布",
  "funnel.stage.repeatPublish": "重复发布",

  "today.accounts.excluded": "已排除 {test} 个测试账号、{internal} 个内部账号",
  "today.accounts.showAll": "显示全部",
  "today.accounts.includingAll": "正在显示测试与内部账号",
  "today.accounts.customersOnly": "只看真实客户",
  "today.accountKind.test": "测试",
  "today.accountKind.internal": "内部",

  // ── Customer 360 additions ───────────────────────────────────────────────
  "c360.alerts.title": "未解决阻塞",
  "c360.alerts.none": "无阻塞",
  "c360.health.band.green": "健康",
  "c360.health.band.yellow": "需关注",
  "c360.health.band.red": "高风险",
  "c360.health.driversPrefix": "原因：",
  "c360.health.driver.activeLast7d": "近7天未活跃",
  "c360.health.driver.publishedLast14d": "近14天无发布",
  "c360.health.driver.pinterestHealthy": "Pinterest 连接状态异常",
  "c360.health.driver.noOpenBlockers": "存在未解决阻塞",

  // ── Instagram comment → DM (super-admin, own accounts) ─────────────────
  "nav.igAutoDm": "IG 评论私信",
  "igdm.badge": "仅超管 · 仅限你自己的账号",
  "igdm.title": "Instagram 评论关键词自动私信",
  "igdm.subtitle": "有人在你的帖子下评论关键词时，自动给他发一条私信。每 5 分钟轮询一次；每条评论只发一次，且须在 7 天内。",
  "igdm.loading": "加载中…",
  "igdm.loadFailed": "加载失败",
  "igdm.refresh": "刷新",
  "igdm.connections.title": "我的 Instagram 账号",
  "igdm.connections.empty": "你的账号下还没有连接 Instagram。",
  "igdm.scopes.granted": "已授予评论 + 私信权限",
  "igdm.scopes.missing": "尚未授予评论 + 私信权限",
  "igdm.scopes.grantButton": "重新连接并授予评论 + 私信权限",
  "igdm.scopes.help": "授权完成后会跳到 设置 → 社交账号，请再回到本页。另外须在 Instagram App 中打开：设置 → 消息和快拍回复 → 消息控制 → 已连接的工具 →「允许访问消息」。",
  "igdm.connections.lastRun": "最近运行",
  "igdm.connections.never": "从未",
  "igdm.rules.title": "规则",
  "igdm.rules.empty": "该账号还没有规则。",
  "igdm.rules.add": "新建规则",
  "igdm.rules.edit": "编辑",
  "igdm.rules.delete": "删除",
  "igdm.rules.deleteConfirm": "删除这条规则？历史记录会保留。",
  "igdm.rules.save": "保存",
  "igdm.rules.cancel": "取消",
  "igdm.rules.saving": "保存中…",
  "igdm.rules.enabled": "已启用",
  "igdm.rules.disabled": "已停用",
  "igdm.rules.enable": "启用",
  "igdm.rules.disable": "停用",
  "igdm.rules.keywords": "关键词（逗号分隔，命中任一即可，不区分大小写）",
  "igdm.rules.media": "帖子",
  "igdm.rules.allPosts": "全部帖子",
  "igdm.rules.loadMedia": "加载最近帖子",
  "igdm.rules.dmText": "私信内容",
  "igdm.rules.publicReply": "同时在评论下公开回复（仅私信成功后）",
  "igdm.rules.publicReplyText": "公开回复内容",
  "igdm.rules.startAfter": "只处理此时间及之后的评论",
  "igdm.rules.newDefaultsOff": "新规则默认停用。请先预览，再启用。",
  "igdm.preview.button": "预览匹配",
  "igdm.preview.running": "正在扫描评论…",
  "igdm.preview.title": "预览（不会发送任何消息）",
  "igdm.preview.none": "当前没有会收到私信的评论。",
  "igdm.preview.note": "预览时该账号的所有规则都按已启用计算。",
  "igdm.col.user": "用户",
  "igdm.col.comment": "评论",
  "igdm.col.rule": "规则 / 关键词",
  "igdm.col.time": "时间",
  "igdm.col.status": "状态",
  "igdm.col.error": "错误",
  "igdm.col.publicReply": "公开回复",
  "igdm.retryFailed.button": "重试失败项",
  "igdm.retryFailed.confirm": "把该账号 7 天内仍可发送的失败私信放回队列？下一轮运行（5 分钟内）会重试。",
  "igdm.retryFailed.done": "已放回 {count} 条，下一轮运行时重试。",
  "igdm.retryFailed.running": "处理中…",
  "igdm.events.title": "最近记录",
  "igdm.events.empty": "暂无记录。",
  "igdm.footer": "评论 webhook 需要 Meta 高级权限，所以这里用轮询。Meta 规定每条评论只能私信一次，且须在 7 天内。",
};

export type AdminMessageKey = keyof typeof en;

const CATALOGS: Record<AdminLanguage, Record<AdminMessageKey, string>> = { en, zh };

export function adminT(lang: AdminLanguage, key: AdminMessageKey): string {
  return CATALOGS[lang][key] ?? CATALOGS.en[key] ?? key;
}

/**
 * Simple `{token}` interpolation over an adminT() result. Only for the small
 * set of catalog strings that carry placeholders (counts, hours, etc.) — never
 * used to inject database content or free text, only numbers/enums the caller
 * already controls.
 */
export function adminTFmt(
  lang: AdminLanguage,
  key: AdminMessageKey,
  vars: Record<string, string | number>,
): string {
  const template = adminT(lang, key);
  return template.replace(/\{(\w+)\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match,
  );
}
