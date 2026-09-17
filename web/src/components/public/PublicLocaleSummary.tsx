"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  getPublicCopy,
  type PublicRouteCopy,
  type PublicRouteCopyKey,
} from "./publicLocaleCopy";

export {
  getPublicCopy,
  PUBLIC_ROUTE_COPY_KEYS,
  PUBLIC_SUPPORTED_LOCALES,
} from "./publicLocaleCopy";
export type {
  PublicRouteCopy,
  PublicRouteCopyKey,
  PublicSupportedLocale,
} from "./publicLocaleCopy";

export function usePublicRouteCopy(route: PublicRouteCopyKey): PublicRouteCopy {
  const { preferences } = useLocale();
  return getPublicCopy(preferences.appLanguage, route);
}

export function PublicLocaleText({
  route,
  field,
}: {
  route: PublicRouteCopyKey;
  field: keyof Pick<PublicRouteCopy, "eyebrow" | "title" | "body" | "cta">;
}) {
  return <>{usePublicRouteCopy(route)[field]}</>;
}
