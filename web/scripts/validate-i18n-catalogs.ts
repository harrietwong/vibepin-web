import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { en, PARTIAL } from "@/lib/i18n/messages";
import type { LanguageCode } from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/messages/en";

const MESSAGE_DIR = join(process.cwd(), "src/lib/i18n/messages");

const BAD_PATTERNS: Array<[RegExp, string]> = [
  [/\uFFFD/, "replacement character"],
  [/\u00C3|\u00C2|\u00E2\u20AC|\u00E2\u20AC\u2122|\u00E2\u20AC\u0153|\u00E2\u20AC\u009D|\u00E2\u20AC\u201C|\u00E2\u20AC\u201D|\u00E2\u20AC\u00A6/, "latin mojibake"],
  [/\u00E4\u00B8|\u00F0\u0178|\u00E5\u0160|\u00E5\u00A5|\u00E6\u20AC|\u00E6\u0153|\u00E7\u0161|\u00E8\u00AF|\u00E9\u20AC|\u00E3\u20AC/, "utf8-as-latin1 mojibake"],
  [/\u9239\u20AC|\u9225\u2122|\u922B|\u9397|\u9983|\u9241|\u9514/, "cjk mojibake"],
  [/\bundefined\b|\bnull\b|\[object Object\]/i, "raw runtime placeholder"],
];

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
}

function samePlaceholders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const errors: string[] = [];

const CATALOG_FILES = [
  ...readdirSync(MESSAGE_DIR).filter(f => f.endsWith(".ts")),
  // Per-namespace English source files live in messages/en/ and are spread into en.ts.
  ...readdirSync(join(MESSAGE_DIR, "en")).filter(f => f.endsWith(".ts")).map(f => join("en", f)),
];

for (const file of CATALOG_FILES) {
  const path = join(MESSAGE_DIR, file);
  const raw = readFileSync(path, "utf8");
  for (const [pattern, label] of BAD_PATTERNS) {
    if (pattern.test(raw)) errors.push(`${file}: contains ${label}`);
  }
}

const englishKeys = Object.keys(en) as MessageKey[];

for (const key of englishKeys) {
  const value = en[key];
  if (typeof value !== "string" || !value.trim()) errors.push(`en.${key}: missing or empty value`);
  for (const [pattern, label] of BAD_PATTERNS) {
    if (pattern.test(value)) errors.push(`en.${key}: contains ${label}`);
  }
}

for (const [locale, catalog] of Object.entries(PARTIAL) as Array<[LanguageCode, Partial<Record<MessageKey, string>>]>) {
  for (const [key, value] of Object.entries(catalog) as Array<[MessageKey, string]>) {
    if (!englishKeys.includes(key)) errors.push(`${locale}.${key}: key does not exist in English catalog`);
    if (typeof value !== "string" || !value.trim()) errors.push(`${locale}.${key}: missing or empty value`);
    for (const [pattern, label] of BAD_PATTERNS) {
      if (pattern.test(value)) errors.push(`${locale}.${key}: contains ${label}`);
    }
    const english = en[key];
    if (english && !samePlaceholders(placeholders(english), placeholders(value))) {
      errors.push(`${locale}.${key}: placeholders do not match English (${placeholders(english).join(",") || "none"})`);
    }
  }
}

if (errors.length) {
  console.error("i18n catalog validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`i18n catalog validation passed: ${englishKeys.length} English keys, ${Object.keys(PARTIAL).length} locale catalogs.`);
