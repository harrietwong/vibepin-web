/**
 * Prefill → AI drawer seed.
 *
 * Every "Generate from this…" button in the app (Insights, Discover, Products,
 * Workspace, Trends, Plan) hands Create Pins a prefill through sessionStorage and
 * navigates to `/app/studio?prefillKey=…`. The LEGACY Studio read that key; the
 * default board-v2 Studio never did, so on the default experience the user's
 * opportunity, brief and reference image were silently dropped the moment the page
 * rendered. This module is the pure half of closing that gap: it converts a prefill
 * into exactly the shape the existing AiVersionDrawer already accepts, so the board
 * can open a seeded drawer without any new drawer prop or redesign.
 *
 * Two rules this file exists to keep.
 *
 * **The drawer's own defaults, not invented ones.** `AiVersionDrawerSetup` has no
 * optional fields, so a seed must fill every one. The values below are copied from
 * the drawer's `useState` initialisers for the no-initialSetup case (count 2,
 * FORMATS[0], gemini_image, "distinct"). If those ever drift, the seeded drawer
 * would silently differ from a hand-opened one — hence the shared constants.
 *
 * **The brief must survive.** `briefManuallyEdited: true` is what makes the drawer
 * treat `directionBrief` as authoritative instead of overwriting it with its own
 * derived brief (AiVersionDrawer: `effectiveDirectionBrief = briefManuallyEdited ?
 * directionBrief : derivedBrief`). A seeded insight brief with this flag false is a
 * brief the user never sees, which is the whole defect being fixed.
 */

import type { AiVersionDrawerSetup } from "@/components/studio/AiVersionDrawer";
import type { CreatePinsPrefill } from "@/lib/createPinsPrefill";
import { buildPromptFromPrefill } from "@/lib/createPinsPrefill";
import type { CanonicalProductSelection } from "@/lib/studio/productSelection";
import type { SelectedReference } from "@/lib/studio/selectedReferences";

/**
 * Where a Pin generated from this prefill is meant to publish.
 *
 * Carried on the seed so the board can stamp it onto the drafts it creates. It is
 * deliberately part of the per-open drawer state and never global: a destination
 * that outlived its drawer would attach account B's target to a Pin the user later
 * started by hand, which is the wrong-account bug this exists to prevent.
 */
export type PrefillDestination = {
  socialConnectionId: string;
  boardId?: string;
  boardName?: string;
};

export type PrefillDrawerSeed = {
  setup: AiVersionDrawerSetup;
  /** Prefilled product for the drawer's `initialProductSelection` (null when none). */
  product: CanonicalProductSelection | null;
  destination: PrefillDestination | null;
};

/** The drawer's own no-initialSetup defaults. Kept here so a seed cannot drift from them. */
export const DRAWER_SEED_DEFAULTS = {
  count: 2,
  format: "Pinterest 2:3",
  modelKey: "gemini_image",
  variationMode: "distinct",
} as const;

/**
 * The draft patch that makes a generated Pin publish where the prefill said.
 *
 * Without this the destination is decorative: a Pin generated from account B's
 * Insights would carry no `targetConnectionId` and publish as whatever account the
 * publish path picks by default — account A in a two-account workspace. Returns
 * null for a missing destination so a caller can apply it unconditionally without
 * ever writing an empty target over a real one.
 */
export function destinationDraftPatch(
  destination: PrefillDestination | null | undefined,
): { targetConnectionId: string; boardId?: string; boardName?: string } | null {
  if (!destination?.socialConnectionId) return null;
  return {
    targetConnectionId: destination.socialConnectionId,
    ...(destination.boardId ? { boardId: destination.boardId } : {}),
    ...(destination.boardName ? { boardName: destination.boardName } : {}),
  };
}

/**
 * Map a prefill onto the drawer's existing seed shape.
 *
 * Returns null when there is nothing worth opening a drawer for — no brief, no
 * product and no reference. An empty drawer popping open on arrival would be a
 * worse experience than the board the user asked for.
 */
export function prefillToDrawerSeed(prefill: CreatePinsPrefill | null | undefined): PrefillDrawerSeed | null {
  if (!prefill) return null;

  // The brief the user is meant to read. creativeDirectionSeed is what the Insights
  // builder writes; promptSeed is what the older sources write; buildPromptFromPrefill
  // is the shared fallback the legacy path already used for prefills carrying only an
  // opportunity, so a keyword-only prefill still arrives with something to generate from.
  const directionBrief =
    prefill.creativeDirectionSeed?.trim()
    || prefill.promptSeed?.trim()
    || buildPromptFromPrefill(prefill).trim();

  const firstProduct = prefill.productImages?.[0];
  const product: CanonicalProductSelection | null = firstProduct?.imageUrl
    ? {
        ...(firstProduct.id ? { id: firstProduct.id } : {}),
        title: firstProduct.title ?? "",
        imageUrl: firstProduct.imageUrl,
        ...(firstProduct.productUrl ? { publicUrl: firstProduct.productUrl } : {}),
        // A prefilled product came from a page the user acted on, so it is an explicit
        // choice — the same standing as picking it in the product picker.
        source: "my_products",
        asPrimary: true,
        ...(firstProduct.category ? { category: firstProduct.category } : {}),
      }
    : null;

  // pinReferences map cleanly onto SelectedReference: the prefill already carries an
  // id, image, title and category. `source: "saved"` is the honest label — the drawer
  // reserves "recommended_pin" for its own recommendation grid, which requires a
  // linkback (sourceUrl) that a prefill does not carry.
  const references: SelectedReference[] = (prefill.pinReferences ?? [])
    .filter(r => !!r.imageUrl)
    .slice(0, 1)
    .map(r => ({
      id: r.id ?? r.imageUrl,
      imageUrl: r.imageUrl,
      source: "saved" as const,
      ...(r.title ? { title: r.title } : {}),
      role: "style_reference" as const,
    }));

  if (!directionBrief && !product && references.length === 0) return null;

  const setup: AiVersionDrawerSetup = {
    productImages: product?.imageUrl ? [product.imageUrl] : [],
    referenceImages: references.map(r => r.imageUrl),
    referenceSelections: references,
    count: DRAWER_SEED_DEFAULTS.count,
    format: DRAWER_SEED_DEFAULTS.format,
    modelKey: DRAWER_SEED_DEFAULTS.modelKey,
    variationMode: DRAWER_SEED_DEFAULTS.variationMode,
    selectedDirectionId: null,
    selectedTagIds: [],
    directionBrief,
    // Authoritative: keeps the seeded brief from being replaced by the derived one.
    briefManuallyEdited: !!directionBrief,
  };

  const dest = prefill.defaultDestination;
  const destination: PrefillDestination | null =
    dest?.provider === "pinterest" && dest.socialConnectionId
      ? {
          socialConnectionId: dest.socialConnectionId,
          ...(dest.boardId ? { boardId: dest.boardId } : {}),
          ...(dest.boardName ? { boardName: dest.boardName } : {}),
        }
      : null;

  return { setup, product, destination };
}
