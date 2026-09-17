export type ProductOpportunityFamily = "all" | "physical" | "digital";

const PRODUCT_FAMILY_VALUES: ProductOpportunityFamily[] = ["all", "physical", "digital"];

export function productFamilyKeyboardTarget(
  current: ProductOpportunityFamily,
  key: string,
): ProductOpportunityFamily | null {
  const index = PRODUCT_FAMILY_VALUES.indexOf(current);
  if (index < 0) return null;
  if (key === "Home") return PRODUCT_FAMILY_VALUES[0];
  if (key === "End") return PRODUCT_FAMILY_VALUES[PRODUCT_FAMILY_VALUES.length - 1];
  const delta = key === "ArrowRight" || key === "ArrowDown"
    ? 1
    : key === "ArrowLeft" || key === "ArrowUp"
      ? -1
      : 0;
  if (!delta) return null;
  return PRODUCT_FAMILY_VALUES[(index + delta + PRODUCT_FAMILY_VALUES.length) % PRODUCT_FAMILY_VALUES.length];
}

export function productFamilyTabIndex(
  selected: ProductOpportunityFamily,
  value: ProductOpportunityFamily,
): 0 | -1 {
  return selected === value ? 0 : -1;
}
