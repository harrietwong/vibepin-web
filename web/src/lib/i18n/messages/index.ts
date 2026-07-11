import type { LanguageCode } from "../config";
import type { MessageKey } from "./en";
import en from "./en";
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";
import es from "./es";
import fr from "./fr";
import de from "./de";
import pt from "./pt";
import ja from "./ja";
import ko from "./ko";
import it from "./it";
import nl from "./nl";
import pl from "./pl";
import tr from "./tr";
import id from "./id";
import vi from "./vi";
import th from "./th";
import hi from "./hi";
import ar from "./ar";
import ru from "./ru";

// Every non-English catalog is a Partial of the English source of truth. Keys
// missing from a locale fall back to English in getMessages(), so adding a new
// English key never breaks another locale at build time — it just shows English
// until translated.
const PARTIAL: Partial<Record<LanguageCode, Partial<Record<MessageKey, string>>>> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  es,
  fr,
  de,
  pt,
  ja,
  ko,
  it,
  nl,
  pl,
  tr,
  id,
  vi,
  th,
  hi,
  ar,
  ru,
};

export function getMessages(lang: LanguageCode): Record<MessageKey, string> {
  const partial = PARTIAL[lang] ?? {};
  return { ...en, ...partial };
}

/** All locales that ship at least a partial catalog (English always present). */
export const TRANSLATED_LOCALES: LanguageCode[] = ["en", ...(Object.keys(PARTIAL) as LanguageCode[])];

export { PARTIAL, en };
