"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";

export const PUBLIC_ROUTE_COPY_KEYS = ["about", "careers", "privacy", "terms", "refund", "acceptableUse", "pinterest", "welcome", "dataDeletion", "login", "signup"] as const;
export type PublicRouteCopyKey = (typeof PUBLIC_ROUTE_COPY_KEYS)[number];
export type PublicRouteCopy = {
  eyebrow: string; title: string; body: string; cta: string;
  email: string; password: string; google: string; divider: string; loading: string;
  alternatePrompt: string; alternateCta: string; legalNotice: string; passwordHint: string;
  forgotPassword: string; resetEmailRequired: string; resetSent: string;
  confirmationTitle: string; confirmationBody: string; planPrefix: string;
  signInPrompt: string; signInCta: string; termsLabel: string; privacyLabel: string;
};

const CORE_FIELDS = new Set<keyof PublicRouteCopy>(["eyebrow", "title", "body", "cta"]);
const routeKey = (route: PublicRouteCopyKey, field: keyof PublicRouteCopy) =>
  (CORE_FIELDS.has(field) ? `public.route.${route}.${field}` : `public.auth.${field}`) as MessageKey;

export function PublicCopy({ id }: { id: MessageKey }) {
  const { t } = useLocale();
  return <>{t(id)}</>;
}

export function usePublicRouteCopy(route: PublicRouteCopyKey): PublicRouteCopy {
  const { t } = useLocale();
  return Object.fromEntries(
    ["eyebrow", "title", "body", "cta", "email", "password", "google", "divider", "loading", "alternatePrompt", "alternateCta", "legalNotice", "passwordHint", "forgotPassword", "resetEmailRequired", "resetSent", "confirmationTitle", "confirmationBody", "planPrefix", "signInPrompt", "signInCta", "termsLabel", "privacyLabel"].map(field => [field, t(routeKey(route, field as keyof PublicRouteCopy))]),
  ) as PublicRouteCopy;
}

export function PublicLocaleText({
  route,
  field,
}: {
  route: PublicRouteCopyKey;
  field: keyof Pick<PublicRouteCopy, "eyebrow" | "title" | "body" | "cta">;
}) {
  return <PublicCopy id={routeKey(route, field)} />;
}
