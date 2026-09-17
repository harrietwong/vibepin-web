import type { MessageKey } from "./messages/en";

type Translate = (key: MessageKey) => string;

const MONTHLY_ALLOWANCE = /^([\d,]+) \/ month$/;

/**
 * Converts canonical comparison tokens into locale-aware display text without
 * changing the entitlement values that produced them.
 */
export function formatPublicPricingComparisonValue(value: string, translate: Translate): string {
  if (value === "Limited") return translate("public.pricing.compare.limited");
  if (value === "Basic") return translate("public.pricing.compare.basic");
  if (value === "Unlimited") return translate("public.pricing.compare.unlimited");

  const monthly = MONTHLY_ALLOWANCE.exec(value);
  if (monthly) {
    return translate("public.pricing.compare.monthlyValue").replace("{count}", monthly[1]);
  }

  return value;
}
