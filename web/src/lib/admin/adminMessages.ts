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
} as const;

const zh: Record<keyof typeof en, string> = {
  "shell.title": "管理后台",
  "shell.internal": "内部",
  "shell.superAdminGated": "仅限超级管理员",

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
};

export type AdminMessageKey = keyof typeof en;

const CATALOGS: Record<AdminLanguage, Record<AdminMessageKey, string>> = { en, zh };

export function adminT(lang: AdminLanguage, key: AdminMessageKey): string {
  return CATALOGS[lang][key] ?? CATALOGS.en[key] ?? key;
}
