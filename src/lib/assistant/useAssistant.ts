"use client";
/**
 * Consumer hooks for the assistant.
 *
 * - `useAssistant()`               → read/act on the assistant from any component.
 * - `usePublishAssistantContext()` → pages/drawers push a live context while active.
 *
 * Stale-state protection: the published context is rebuilt whenever `deps` change, so
 * findings and their action closures always reflect current live state. When `active`
 * becomes false (drawer/modal closed) or the component unmounts, the context is cleared
 * so a stale drawer context can never linger over the page.
 */
import { useEffect } from "react";
import { useAssistantContext } from "./AssistantProvider";
import type { AssistantContext, AssistantContextValue } from "./types";

export function useAssistant(): AssistantContextValue {
  return useAssistantContext();
}

/**
 * Publish `ctx` while `active`. Pass every piece of live state the findings depend on
 * (selected pins, rowEdits, product/board/schedule state, …) in `deps` so the context
 * recomputes — never let a stale closure back an assistant action.
 *
 * `ctx` should be memoized by the caller (e.g. `useMemo`) over the same `deps`.
 */
export function usePublishAssistantContext(
  ctx: AssistantContext,
  active: boolean,
  deps: React.DependencyList,
): void {
  const { publishContext, clearContext } = useAssistantContext();

  useEffect(() => {
    if (!active) {
      clearContext(ctx.id);
      return;
    }
    publishContext(ctx);
    return () => clearContext(ctx.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-owned deps drive recompute; ctx is memoized over them.
  }, [active, ctx.id, publishContext, clearContext, ...deps]);
}
