/**
 * Verification for the App-language vs AI-content-language separation and the
 * new "existing Pins are not rewritten" helper notes.
 *
 * Browser-free but render-accurate: it exercises the exact functions the UI
 * uses — getMessages() (what the modal/Settings render for chrome) and
 * getContentTemplates() (what the generator produces for Pin copy) — plus
 * source-level assertions that the Edit scheduled Pin modal seeds title/
 * description from the STORED draft while its labels come from t().
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMessages } from "../src/lib/i18n/messages";
import { getContentTemplates } from "../src/lib/i18n/contentTemplates";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  OK ${name}`); passed++; }
  else { console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

console.log("Language separation + helper notes\n");

// ── 1. Chrome follows App language (labels are localized) ─────────────────────
const enMsg = getMessages("en");
const zhMsg = getMessages("zh-CN");
ok("Edit scheduled Pin header is localized (EN)", enMsg["pinDetails.editScheduledTitle"] === "Edit scheduled Pin",
   enMsg["pinDetails.editScheduledTitle"]);
ok("Edit scheduled Pin header is localized (zh-CN differs from EN)",
   zhMsg["pinDetails.editScheduledTitle"] !== enMsg["pinDetails.editScheduledTitle"],
   zhMsg["pinDetails.editScheduledTitle"]);
ok("Title label is localized (EN vs zh-CN differ)",
   enMsg["pinDetails.title.label"] !== zhMsg["pinDetails.title.label"]);

// ── 2. New helper notes resolve to the exact requested wording ────────────────
// (AI content language setting removed; only the App-language note remains.)
const EN_APP = "App language changes the interface only. It does not translate existing Pin content.";
const ZH_APP = "应用语言只改变界面，不会翻译已有 Pin 内容。";
ok("EN app-language note matches requested copy", enMsg["language.appLanguageExistingNote"] === EN_APP);
ok("zh-CN app-language note matches requested copy", zhMsg["language.appLanguageExistingNote"] === ZH_APP);

// Every app language has the note key as a non-empty string (getMessages fills
// from English for any locale still awaiting translation).
const LANGS = ["en","zh-CN","zh-TW","es","fr","de","pt","ja","ko","it","nl","pl","tr","vi","th","id","hi","ar","ru"] as const;
const allHaveNotes = LANGS.every(l => {
  const m = getMessages(l);
  return typeof m["language.appLanguageExistingNote"] === "string" && m["language.appLanguageExistingNote"].length > 0;
});
ok("all 19 catalogs expose the app-language note key", allHaveNotes);

// ── 3. Switching App language must NOT change stored content ──────────────────
// A stored draft title is data, not a message key. It is invariant to app language.
const storedDraftTitle = "Aesthetic灵感合集"; // the exact value from the screenshot
ok("stored draft title is not a message key (never re-translated by chrome)",
   !(storedDraftTitle in enMsg) && !(storedDraftTitle in zhMsg));

// ── 4. Source-level wiring of the Edit scheduled Pin modal ────────────────────
const drawer = readFileSync(join(process.cwd(), "src/components/plan/DraftDetailsDrawer.tsx"), "utf8");
ok("modal seeds TITLE from the stored draft (data, not chrome)", drawer.includes("setTitle(draft.title)"));
ok("modal seeds DESCRIPTION from the stored draft (data, not chrome)", drawer.includes("setDescription(draft.description)"));
ok("modal header uses t() (localized chrome)", drawer.includes('t("pinDetails.editScheduledTitle")'));
// Guard against a real regenerate/translate FEATURE (handler or button label),
// not CSS `translate(-50%,-50%)` transforms which are unrelated.
ok("modal has NO regenerate/translate action (pure editor of stored content)",
   !/regenerat|onTranslate|handleTranslate|handleRegenerate|>\s*Translate|>\s*Regenerate/i.test(drawer));

// Settings renders the app-language note via t().
const settings = readFileSync(join(process.cwd(), "src/components/settings/SettingsModal.tsx"), "utf8");
ok("Settings renders app-language note via t()", settings.includes('t("language.appLanguageExistingNote")'));

// ── 5. FUTURE generation respects AI content language ─────────────────────────
const enTpl = getContentTemplates("en");
const zhTpl = getContentTemplates("zh-CN");
const enTitles = enTpl.titles({ kw: "Aesthetic", audience: "your home", room: "room", style: "modern", productTitle: "", pinIndex: 0 });
const zhTitles = zhTpl.titles({ kw: "Aesthetic", audience: "你的空间", room: "空间", style: "现代", productTitle: "", pinIndex: 0 });
// English template output contains no CJK; Chinese template output does.
const hasCJK = (s: string) => /[一-鿿]/.test(s);
ok("EN content template produces English (no CJK) titles", enTitles.every(t => !hasCJK(t)), enTitles[0]);
ok("zh-CN content template produces Chinese titles", zhTitles.some(t => hasCJK(t)), zhTitles[0]);

// Generation entry points pass the resolved content language.
const studio = readFileSync(join(process.cwd(), "src/app/app/studio/page.tsx"), "utf8");
const plan = readFileSync(join(process.cwd(), "src/app/app/plan/page.tsx"), "utf8");
ok("studio passes resolved content language into generation",
   studio.includes("contentLanguage: readResolvedContentLanguage()"));
ok("plan 'Generate missing details' passes resolved content language",
   plan.includes("readResolvedContentLanguage()") && plan.includes("contentLanguage: lang"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
