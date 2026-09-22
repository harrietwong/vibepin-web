import { destinationKey, type DestinationPublishStatus, type PublishProvider } from "./contentDraftModel";
import type { ExternalPublishingPlan, PinDraft } from "./pinDraftStore";

export type PlanPublishingProvider = PublishProvider | ExternalPublishingPlan["provider"];
export type PlanPublishingStatus = DestinationPublishStatus | ExternalPublishingPlan["status"] | "scheduled";

export type PlanPublishingChannel = {
  id: string;
  provider: PlanPublishingProvider;
  status: PlanPublishingStatus;
  accountLabel?: string;
  scheduledAt?: string;
  postUrl?: string;
};

const PROVIDER_ORDER: Record<PlanPublishingProvider, number> = {
  pinterest: 0,
  instagram: 1,
  facebook: 2,
  youtube: 3,
};

/**
 * Project the native VibePin destinations and plan-only external channels into one
 * display model. External plans never become publish input; this function is read-only.
 */
export function planPublishingChannels(draft: PinDraft): PlanPublishingChannel[] {
  const results = new Map((draft.destinationResults ?? []).map(result => [result.destinationId, result]));
  const native = (draft.scheduledDestinations ?? []).flatMap(destination => {
    if (destination.provider !== "pinterest" && destination.provider !== "instagram" && destination.provider !== "facebook") {
      return [];
    }
    const provider = destination.provider as PublishProvider;
    const id = destinationKey(provider, destination.socialConnectionId);
    const result = results.get(id);
    return [{
      id,
      provider,
      status: result?.status ?? "scheduled",
      accountLabel: result?.accountLabel ?? destination.accountLabel,
      postUrl: result?.postUrl,
    } satisfies PlanPublishingChannel];
  });

  const external = (draft.externalPublishingPlans ?? []).flatMap(plan => {
    if (plan.provider !== "youtube" || !plan.id || !plan.scheduledAt) return [];
    return [{
      id: plan.id,
      provider: plan.provider,
      status: plan.status,
      accountLabel: plan.accountLabel,
      scheduledAt: plan.scheduledAt,
      postUrl: plan.postUrl,
    } satisfies PlanPublishingChannel];
  });

  return [...native, ...external]
    .filter((channel, index, all) => all.findIndex(item => item.id === channel.id) === index)
    .sort((a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider]);
}

export function planPublishingProviderLabel(provider: PlanPublishingProvider): string {
  if (provider === "pinterest") return "Pinterest";
  if (provider === "instagram") return "Instagram";
  if (provider === "facebook") return "Facebook";
  return "YouTube";
}
