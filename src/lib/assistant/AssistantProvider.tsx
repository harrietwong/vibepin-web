"use client";
/**
 * AssistantProvider — holds the active assistant context and drives the launcher.
 *
 * Context resolution priority (highest wins): modal/drawer > page > pathname default.
 * Published contexts are stored by id; each carries a `source`. The active context is
 * the highest-priority published context, or the pathname-derived default when none is
 * published. This guarantees the Studio default never shows while Batch Edit or Single
 * Pin Edit is active.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  SOURCE_PRIORITY,
  type AssistantContext,
  type AssistantContextValue,
  type ChatMessage,
  type LauncherState,
} from "./types";
import { deriveDefaultContext } from "./pageContext";
import { respondToChat } from "./chat";

const Ctx = createContext<AssistantContextValue | null>(null);

type Entry = { ctx: AssistantContext; seq: number };

let uid = 0;
const nextId = () => `m${Date.now()}_${uid++}`;

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<Record<string, Entry>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Capability findings the user has revealed via chat, keyed by context id so they
  // reset when the surface changes.
  const [revealed, setRevealed] = useState<Record<string, Set<string>>>({});
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const seqRef = useRef(0);

  const publishContext = useCallback((ctx: AssistantContext) => {
    setPublished((prev) => {
      const existing = prev[ctx.id];
      // Preserve original seq so re-publishes (recompute on deps change) don't jump
      // the stack order; only bump seq for a brand-new source.
      const seq = existing ? existing.seq : (seqRef.current += 1);
      return { ...prev, [ctx.id]: { ctx, seq } };
    });
  }, []);

  const clearContext = useCallback((id: string) => {
    setPublished((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const defaultContext = useMemo(() => deriveDefaultContext(pathname), [pathname]);

  const context = useMemo<AssistantContext>(() => {
    const entries = Object.values(published);
    if (entries.length === 0) return defaultContext;
    entries.sort((a, b) => {
      const pa = SOURCE_PRIORITY[a.ctx.source];
      const pb = SOURCE_PRIORITY[b.ctx.source];
      if (pa !== pb) return pb - pa;
      return b.seq - a.seq; // most recently added of equal priority wins
    });
    return entries[0].ctx;
  }, [published, defaultContext]);

  // Visible = proactive (real) findings, plus any capability the user revealed via
  // chat for this context. Non-proactive findings stay hidden until asked for.
  const visibleFindings = useMemo(() => {
    const shown = revealed[context.id] ?? new Set<string>();
    return context.findings.filter(
      (f) => !dismissed.has(f.id) && (f.proactive === true || shown.has(f.id)),
    );
  }, [context, dismissed, revealed]);

  // Only real, proactive issues count toward the numeric badge.
  const issueCount = useMemo(
    () => context.findings.filter(
      (f) => f.proactive === true && f.severity === "issue" && !dismissed.has(f.id),
    ).length,
    [context, dismissed],
  );

  const launcherState = useMemo<LauncherState>(() => {
    if (busy) return "loading";
    if (issueCount > 0) return "issues";
    // Quiet by default: a dot only when there are real, proactive non-issue cards
    // (e.g. readiness confirmations). Lightweight capability-only contexts stay normal.
    if (context.findings.some((f) => f.proactive === true && f.severity !== "issue" && !dismissed.has(f.id))) {
      return "suggestions";
    }
    return "normal";
  }, [busy, issueCount, context, dismissed]);

  const dismissFinding = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const userMsg: ChatMessage = { id: nextId(), role: "user", text: trimmed };
      const { reply, revealIds } = respondToChat(trimmed, context);
      const botMsg: ChatMessage = { id: nextId(), role: "assistant", text: reply };
      setChatLog((prev) => [...prev, userMsg, botMsg]);
      if (revealIds.length > 0) {
        setRevealed((prev) => {
          const next = new Set(prev[context.id] ?? []);
          revealIds.forEach((id) => next.add(id));
          return { ...prev, [context.id]: next };
        });
      }
      setOpen(true);
    },
    [context],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({
      open,
      busy,
      context,
      visibleFindings,
      launcherState,
      issueCount,
      chatLog,
      setOpen,
      toggle: () => setOpen((v) => !v),
      publishContext,
      clearContext,
      dismissFinding,
      sendChat,
      setBusy,
    }),
    [
      open, busy, context, visibleFindings, launcherState, issueCount, chatLog,
      publishContext, clearContext, dismissFinding, sendChat,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistantContext(): AssistantContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAssistantContext must be used within <AssistantProvider>");
  return v;
}
