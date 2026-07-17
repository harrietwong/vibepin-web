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
