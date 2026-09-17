export type PricingAuthState = {
  sessionHint: boolean;
  verifiedUserId: string | null;
  verification: "pending" | "ready";
};

export type PricingAuthAction =
  | { type: "verification-start"; sessionHint: boolean }
  | { type: "verified"; userId: string | null }
  | { type: "signed-out" };

export function createPricingAuthState(sessionHint: boolean): PricingAuthState {
  return { sessionHint, verifiedUserId: null, verification: "pending" };
}

export function pricingAuthReducer(state: PricingAuthState, action: PricingAuthAction): PricingAuthState {
  if (action.type === "verification-start") {
    return { sessionHint: action.sessionHint, verifiedUserId: null, verification: "pending" };
  }
  if (action.type === "verified") {
    return { sessionHint: action.userId !== null, verifiedUserId: action.userId, verification: "ready" };
  }
  return { sessionHint: false, verifiedUserId: null, verification: "ready" };
}

export function getPricingHeaderState(state: PricingAuthState): { showLogIn: boolean; showStudio: boolean } {
  const showStudio = state.verification === "ready"
    ? state.verifiedUserId !== null
    : state.sessionHint;
  return { showLogIn: state.verification === "ready" && !showStudio, showStudio };
}

/** A checkout may only use the result of a completed `auth.getUser()` readback. */
export function getVerifiedPricingUserId(state: PricingAuthState): string | null {
  return state.verification === "ready" ? state.verifiedUserId : null;
}
