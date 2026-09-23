/**
 * NEXT_PUBLIC_HIDE_IG_FB — product decision to hide Instagram and Facebook from
 * every customer-facing entry point (destination pickers, Settings "Social
 * accounts", Studio, Pricing/Landing copy) while leaving the backend chain
 * untouched: existing connections, `/api/social/*`, the publish/cron fan-out,
 * and `destinationCapability.ts`'s server-side validation all keep working
 * exactly as before. This is a rendering-layer filter only — it does not
 * remove i18n keys, delete components, or touch `platforms.ts`'s canonical
 * provider catalog.
 *
 * Default: off (both platforms show, current behavior). Set
 * NEXT_PUBLIC_HIDE_IG_FB="true" to hide them.
 */
import { VISIBLE_SOCIAL_PROVIDERS, type SocialProvider } from "./platforms";

const HIDE_IG_FB = process.env.NEXT_PUBLIC_HIDE_IG_FB === "true";

const HIDDEN_WHEN_FLAGGED: ReadonlySet<SocialProvider> = new Set(["instagram", "facebook"]);

/**
 * The provider list customer-facing UI should render.
 *
 * When the flag is on, Instagram and Facebook are dropped UNLESS `keep`
 * includes them — e.g. a Pin already scheduled to Instagram before the flag
 * flipped must keep showing that row; silently dropping it on re-open would
 * discard the merchant's existing destination selection (see
 * PublishDestinations.tsx's own "would be lies" precedent for connected-but-
 * hidden platforms). Passing no `keep` list yields the plain filtered set,
 * which is what static surfaces (Settings, Pricing, Studio filters) want.
 */
export function customerVisibleSocialProviders(
  keep?: readonly SocialProvider[],
): readonly SocialProvider[] {
  if (!HIDE_IG_FB) return VISIBLE_SOCIAL_PROVIDERS;
  const keepSet = new Set(keep ?? []);
  return VISIBLE_SOCIAL_PROVIDERS.filter(
    provider => !HIDDEN_WHEN_FLAGGED.has(provider) || keepSet.has(provider),
  );
}

export function isHiddenSocialProvider(provider: SocialProvider): boolean {
  return HIDE_IG_FB && HIDDEN_WHEN_FLAGGED.has(provider);
}

/** Plain boolean form of the flag, for render-site ternaries that don't need a provider check. */
export function igFbHidden(): boolean {
  return HIDE_IG_FB;
}
