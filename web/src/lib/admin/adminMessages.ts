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

  "pipeline.badge": "Super Admin only · Internal",
  "pipeline.title": "Pipeline / Jobs",
  "pipeline.subtitle": "Latest run per job — status, timing, row counts, and errors. Read-only.",
  "pipeline.stat.runsToday": "Runs today",
  "pipeline.stat.failedToday": "Failed today",
  "pipeline.unavailable": "Pipeline job history table not available yet.",
  "pipeline.col.job": "Job",
  "pipeline.col.status": "Status",
  "pipeline.col.started": "Started",
  "pipeline.col.ended": "Ended",
  "pipeline.col.duration": "Duration",
  "pipeline.col.processed": "Processed",
  "pipeline.col.skipped": "Skipped",
  "pipeline.col.failed": "Failed",
  "pipeline.col.retryable": "Retryable",
  "pipeline.col.lastSuccess": "Last success",
  "pipeline.col.error": "Error",
  "pipeline.retryable.yes": "Yes",
  "pipeline.retryable.no": "No",
  "pipeline.empty": "pipeline_runs is present but has no rows yet.",
  "pipeline.footer.note": "Skipped rows, failed rows, error code, and retryable are read from run metadata when present (otherwise —). “Today” is since 00:00 UTC.",
  "pipeline.footer.readOnly": "Read-only. No run / requeue / apply / timer / product-supply / scoring controls on this page.",

  "genLogs.badge.superAdmin": "Super Admin · Internal",
  "genLogs.badge.support": "Support · Internal",
  "genLogs.title": "Generation Logs",
  "genLogs.subtitle": "Debug AI generation failures, safety blocks, and irrelevant outputs. Read-only.",
  "genLogs.loaded": "{n} loaded",
  "genLogs.unavailable": "Generation logs unavailable — pin_generations could not be read.",
  "genLogs.col.created": "Created",
  "genLogs.col.user": "User",
  "genLogs.col.workspace": "Workspace",
  "genLogs.col.type": "Type",
  "genLogs.col.status": "Status",
  "genLogs.col.source": "Source",
  "genLogs.footer.notRecorded": "Latency, token counts, cost, prompt version, copy/export/publish, and user feedback are not recorded on generations yet (shown as —).",
  "genLogs.footer.windowSaturated": "Showing the most recent 500 generations.",

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
  "time.relative.never": "never",

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

  // ── Usage & Plan (Customer 360 card, users list, quota watch) ────────────
  "usage.card.title": "Usage & Plan",
  "usage.plan": "Plan",
  "usage.period": "Billing period",
  "usage.period.none": "Not metered yet",
  "usage.metric.aiImages": "AI images",
  "usage.metric.aiTextGenerations": "AI copy",
  "usage.metric.scheduledPosts": "Scheduled posts",
  "usage.bonusImages": "Bonus images",
  "usage.used": "used",
  "usage.remaining": "{n} left",
  "usage.overage": "{n} over",
  "usage.unlimited": "Unlimited",
  "usage.included": "{n} included",
  "usage.included.unlimited": "Unlimited on this plan",
  "usage.badge.unmetered": "Not metered",
  "usage.badge.unavailable": "Sync error",
  "usage.state.unmetered": "This user has never triggered metering, so there is nothing measured yet. The allowances below are what the plan includes.",
  "usage.state.unavailable": "Usage could not be read, so these numbers are unknown — this is not the same as the user having no usage.",
  "usage.planDrift": "Plan mismatch: the enforced allowance snapshot says {account}, billing metadata says {app}. The snapshot is shown.",
  "usage.anomaly": "Data quality: {codes}",
  "usage.footer": "Read-only. Viewing this page never creates or changes a usage account.",

  "users.col.plan": "Plan",
  "users.filter.plan.all": "All plans",
  "users.filter.plan.unknown": "Unknown plan",
  "users.plan.unmetered": "not metered",
  "users.plan.unavailable": "unknown",
  "users.plan.drift": "mismatch",
  "users.plan.unknown": "unrecognized plan value",

  "today.quotaWatch.title": "Quota Watch",
  "today.quotaWatch.subtitle": "Metered users at or above {pct}% of a finite allowance. An upgrade signal, not a fault — these users are not blocked.",
  "today.quotaWatch.empty": "Nobody is close to an allowance limit right now.",
  "today.quotaWatch.unavailable": "Quota Watch unavailable — usage_accounts could not be read.",
  "today.quotaWatch.col.user": "User",
  "today.quotaWatch.col.plan": "Plan",
  "today.quotaWatch.col.quota": "Allowance",
  "today.quotaWatch.col.usage": "Used",
  "today.quotaWatch.col.remaining": "Remaining",
  "today.quotaWatch.col.periodEnds": "Period ends",
  "today.quotaWatch.periodEnded": "period ended",
  "today.quotaWatch.daysLeft": "in {n}d",
  "today.quotaWatch.hoursLeft": "in {n}h",
  "today.quotaWatch.excludedNote": "Excludes unlimited allowances, users with no usage account, and users whose usage could not be read.",

  // ── Feature Adoption Summary (only rendered when there is an anomaly) ────
  "today.featureAdoption.title": "Feature adoption",
  "today.featureAdoption.unavailable": "Feature adoption unavailable — analytics_events could not be read for:",
  "today.featureAdoption.zeroUsage": "had zero real-customer usage in the last {days} days ({total} customer(s) tracked).",
  "today.featureAdoption.footer": "Only shown when a feature is flagged — no anomalies means no card. Absolute counts only, never a percentage.",
  "today.featureAdoption.feature.aiImageGeneration": "AI image generation",
  "today.featureAdoption.feature.referenceRecommendations": "Reference recommendations",
  "today.featureAdoption.feature.creativeDirection": "Creative direction",
  "today.featureAdoption.feature.aiCopy": "AI copy",
  "today.featureAdoption.feature.imageAnalysis": "Image analysis",
  "today.featureAdoption.feature.keywordRecommendations": "Keyword recommendations",
  "today.featureAdoption.feature.publish": "Publish",
  "today.featureAdoption.feature.scheduling": "Scheduling",
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

  "pipeline.badge": "仅限超级管理员 · 内部",
  "pipeline.title": "数据管道 / 任务",
  "pipeline.subtitle": "每个任务的最新一次运行——状态、耗时、处理行数与错误。只读页面。",
  "pipeline.stat.runsToday": "今日运行次数",
  "pipeline.stat.failedToday": "今日失败次数",
  "pipeline.unavailable": "数据管道任务历史表暂不可用。",
  "pipeline.col.job": "任务",
  "pipeline.col.status": "状态",
  "pipeline.col.started": "开始时间",
  "pipeline.col.ended": "结束时间",
  "pipeline.col.duration": "耗时",
  "pipeline.col.processed": "已处理",
  "pipeline.col.skipped": "已跳过",
  "pipeline.col.failed": "失败数",
  "pipeline.col.retryable": "可重试",
  "pipeline.col.lastSuccess": "上次成功",
  "pipeline.col.error": "错误",
  "pipeline.retryable.yes": "是",
  "pipeline.retryable.no": "否",
  "pipeline.empty": "pipeline_runs 表已存在，但暂无数据。",
  "pipeline.footer.note": "跳过行数、失败行数、错误码与可重试状态取自运行元数据（不存在时显示为 —）。“今日”按 UTC 00:00 起算。",
  "pipeline.footer.readOnly": "只读页面。此页不包含运行 / 重新入队 / 应用 / 定时任务 / 商品供给 / 评分等操作控件。",

  "genLogs.badge.superAdmin": "超级管理员 · 内部",
  "genLogs.badge.support": "客服 · 内部",
  "genLogs.title": "生成日志",
  "genLogs.subtitle": "排查 AI 生成失败、安全拦截与不相关输出。只读页面。",
  "genLogs.loaded": "已加载 {n} 条",
  "genLogs.unavailable": "生成日志不可用 —— 无法读取 pin_generations。",
  "genLogs.col.created": "创建时间",
  "genLogs.col.user": "用户",
  "genLogs.col.workspace": "工作区",
  "genLogs.col.type": "类型",
  "genLogs.col.status": "状态",
  "genLogs.col.source": "来源",
  "genLogs.footer.notRecorded": "延迟、token 数、成本、prompt 版本、复制/导出/发布、用户反馈目前未记录在生成记录上（显示为 —）。",
  "genLogs.footer.windowSaturated": "仅显示最近 500 条生成记录。",

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
  "time.relative.never": "从未",

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

  // ── Usage & Plan (Customer 360 card, users list, quota watch) ────────────
  "usage.card.title": "用量与套餐",
  "usage.plan": "套餐",
  "usage.period": "计费周期",
  "usage.period.none": "尚未计量",
  "usage.metric.aiImages": "AI 图片",
  "usage.metric.aiTextGenerations": "AI 文案",
  "usage.metric.scheduledPosts": "排期发布",
  "usage.bonusImages": "赠送图片",
  "usage.used": "已用",
  "usage.remaining": "剩余 {n}",
  "usage.overage": "超出 {n}",
  "usage.unlimited": "不限量",
  "usage.included": "套餐含 {n}",
  "usage.included.unlimited": "此套餐不限量",
  "usage.badge.unmetered": "未计量",
  "usage.badge.unavailable": "同步异常",
  "usage.state.unmetered": "该用户从未触发计量，因此没有任何实测数据。下方显示的是套餐包含的额度。",
  "usage.state.unavailable": "用量读取失败，这些数字目前未知 —— 这与「该用户没有用量」不是一回事。",
  "usage.planDrift": "套餐数据不一致：实际生效的额度快照是 {account}，计费元数据是 {app}。此处按快照显示。",
  "usage.anomaly": "数据质量：{codes}",
  "usage.footer": "只读页面。查看本页不会创建或修改任何用量账户。",

  "users.col.plan": "套餐",
  "users.filter.plan.all": "全部套餐",
  "users.filter.plan.unknown": "未知套餐",
  "users.plan.unmetered": "未计量",
  "users.plan.unavailable": "未知",
  "users.plan.drift": "不一致",
  "users.plan.unknown": "套餐值无法识别",

  "today.quotaWatch.title": "配额关注",
  "today.quotaWatch.subtitle": "已计量且某项有限额度用量达到 {pct}% 及以上的用户。这是升级信号，不是故障 —— 这些用户并未被阻塞。",
  "today.quotaWatch.empty": "当前没有用户接近额度上限。",
  "today.quotaWatch.unavailable": "配额关注不可用 —— 无法读取 usage_accounts。",
  "today.quotaWatch.col.user": "用户",
  "today.quotaWatch.col.plan": "套餐",
  "today.quotaWatch.col.quota": "额度项",
  "today.quotaWatch.col.usage": "已用",
  "today.quotaWatch.col.remaining": "剩余",
  "today.quotaWatch.col.periodEnds": "周期结束",
  "today.quotaWatch.periodEnded": "周期已结束",
  "today.quotaWatch.daysLeft": "还有 {n} 天",
  "today.quotaWatch.hoursLeft": "还有 {n} 小时",
  "today.quotaWatch.excludedNote": "不含不限量额度、没有用量账户的用户，以及用量读取失败的用户。",

  // ── 功能采用摘要（只在存在异常信号时出现） ──────────────────────────────
  "today.featureAdoption.title": "功能采用",
  "today.featureAdoption.unavailable": "功能采用数据不可用 —— 以下功能的 analytics_events 读取失败：",
  "today.featureAdoption.zeroUsage": "在最近 {days} 天内没有任何真实客户使用（共追踪 {total} 个客户）。",
  "today.featureAdoption.footer": "仅在有异常标记时显示 —— 无异常则不出现此卡片。全部为绝对数，绝不显示百分比。",
  "today.featureAdoption.feature.aiImageGeneration": "AI 图片生成",
  "today.featureAdoption.feature.referenceRecommendations": "参考图推荐",
  "today.featureAdoption.feature.creativeDirection": "创意方向",
  "today.featureAdoption.feature.aiCopy": "AI 文案",
  "today.featureAdoption.feature.imageAnalysis": "图片分析",
  "today.featureAdoption.feature.keywordRecommendations": "关键词推荐",
  "today.featureAdoption.feature.publish": "发布",
  "today.featureAdoption.feature.scheduling": "排期",
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
