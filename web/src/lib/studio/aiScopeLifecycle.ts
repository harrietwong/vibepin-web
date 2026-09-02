/** Pure lifecycle transition for Studio's owner/workspace-bound ephemeral AI state. */
export type AiScopeEphemeralState<TDrawer = unknown, TLimitPrompt = unknown> = {
  scopeKey: string | null;
  drawer: TDrawer | null;
  generating: boolean;
  limitPrompt: TLimitPrompt | null;
  lock: string | null;
};

export function resetAiScopeEphemeralState<TDrawer, TLimitPrompt>(
  state: AiScopeEphemeralState<TDrawer, TLimitPrompt>,
  nextScopeKey: string | null,
): AiScopeEphemeralState<TDrawer, TLimitPrompt> {
  if (state.scopeKey === nextScopeKey) return state;
  return {
    scopeKey: nextScopeKey,
    drawer: null,
    generating: false,
    limitPrompt: null,
    lock: null,
  };
}
