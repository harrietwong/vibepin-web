import { en, PARTIAL } from "@/lib/i18n/messages";
import { ALL_APP_LANGUAGES, type LanguageCode } from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/messages/en";

const BAD_TEXT = /\uFFFD|\u00E2\u20AC|\u9239|\u9225|\u922B|\u9397|\u9983|\u9241|\u9514|\bundefined\b|\bnull\b|\[object Object\]/i;

const englishBlocked: MessageKey[] = [
  "page.products.drawer.productOpportunity",
  "page.products.drawer.productAssessment",
  "page.products.drawer.estMonthlyVol",
  "page.products.drawer.commercialDensity",
  "page.products.drawer.evidence",
  "page.products.drawer.productSaves",
  "page.products.drawer.sourcePinSaves",
  "page.products.drawer.viewOn",
  "page.products.drawer.useInCreatePins",
  "settings.title",
  "common.saveChanges",
  "common.cancel",
  "nav.createPins",
  "nav.weeklyPlan",
  "page.products.title",
  "page.products.heading",
];

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
}

function samePlaceholders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const errors: string[] = [];
const englishKeys = Object.keys(en) as MessageKey[];

for (const language of ALL_APP_LANGUAGES.map(l => l.code)) {
  if (language === "en") continue;
  const catalog = PARTIAL[language] as Record<MessageKey, string> | undefined;
  if (!catalog) {
    errors.push(`${language}: missing locale catalog`);
    continue;
  }

  for (const key of englishKeys) {
    const value = catalog[key];
    if (typeof value !== "string") {
      errors.push(`${language}.${key}: missing key`);
      continue;
    }
    if (!value.trim()) errors.push(`${language}.${key}: empty value`);
    if (BAD_TEXT.test(value)) errors.push(`${language}.${key}: corrupted or runtime-placeholder text`);
    if (!samePlaceholders(placeholders(en[key]), placeholders(value))) {
      errors.push(`${language}.${key}: placeholders do not match English`);
    }
  }

  for (const key of Object.keys(catalog)) {
    if (!englishKeys.includes(key as MessageKey)) errors.push(`${language}.${key}: orphan key`);
  }

  for (const key of englishBlocked) {
    if (catalog[key] === en[key]) errors.push(`${language}.${key}: visible English fallback is not allowed`);
  }
}

if (errors.length) {
  console.error("i18n coverage validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`i18n coverage validation passed: ${ALL_APP_LANGUAGES.length} languages, ${englishKeys.length} keys per non-English catalog.`);
