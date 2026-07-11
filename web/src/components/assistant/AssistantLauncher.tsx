"use client";
/**
 * AssistantLauncher — fixed bottom-right button, present on every app page.
 *
 * Stays above every drawer/modal (Z.launcher) so "Ask VibePin" is reachable from any
 * workflow state. States: normal / suggestions / issues / loading. Only real `issue`
 * findings produce a numeric badge; lightweight suggestion contexts show a dot at most.
 * The bottom offset lifts the button above a page's Save/Schedule footer.
 */
import { Sparkles, Loader2 } from "lucide-react";
import { useAssistant } from "@/lib/assistant/useAssistant";
import { AUI, Z } from "./theme";

export function AssistantLauncher() {
  // Ask VibePin is currently disabled in production. It is an AI page assistant, not the Customer Support MVP.
  const enableAskVibePin = process.env.NEXT_PUBLIC_ENABLE_ASK_VIBEPIN === "true";
  if (!enableAskVibePin) return null;

  return <AskVibePinLauncher />;
}

function AskVibePinLauncher() {
  const { open, toggle, launcherState, issueCount, visibleFindings, context } = useAssistant();

  if (open) return null; // panel replaces the button while open

  const bottom = 24 + (context.footerOffset ?? 0);
  const hasSuggestions = launcherState === "suggestions";
  const isIssues = launcherState === "issues";
  const isLoading = launcherState === "loading";
  // A dot (no number) when there are non-issue findings worth a glance.
  const showDot = hasSuggestions && visibleFindings.length > 0;

  return (
    <button
      type="button"
      onClick={toggle}
      data-testid="assistant-launcher"
      data-state={launcherState}
      aria-label="Open VibePin assistant"
      style={{
        position: "fixed", right: 20, bottom, zIndex: Z.launcher,
        display: "flex", alignItems: "center", gap: 8,
        height: 48, padding: "0 16px 0 14px", borderRadius: 26,
        border: `1px solid ${isIssues ? "rgba(239,68,68,0.5)" : AUI.borderHi}`,
        background: AUI.gradient, color: "#fff", cursor: "pointer",
        boxShadow: isIssues
          ? "0 8px 28px rgba(239,68,68,0.32)"
          : "0 8px 28px rgba(124,58,237,0.34)",
        fontSize: 14, fontWeight: 750,
      }}
    >
      <span style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {isLoading ? (
          <Loader2 style={{ width: 20, height: 20, animation: "spin 1s linear infinite" }} />
        ) : (
          <Sparkles style={{ width: 20, height: 20 }} />
        )}

        {/* Issue badge — numeric, only for real issues. */}
        {!isLoading && isIssues && issueCount > 0 && (
          <span
            data-testid="assistant-badge"
            style={{
              position: "absolute", top: -8, right: -10,
              minWidth: 18, height: 18, padding: "0 4px", borderRadius: 9,
              background: "#EF4444", color: "#fff", fontSize: 11, fontWeight: 800,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: `2px solid ${AUI.card}`,
            }}
          >
            {issueCount}
          </span>
        )}

        {/* Suggestion dot — no number. */}
        {!isLoading && showDot && (
          <span
            data-testid="assistant-dot"
            style={{
              position: "absolute", top: -5, right: -6,
              width: 10, height: 10, borderRadius: "50%",
              background: AUI.suggestion, border: `2px solid ${AUI.card}`,
            }}
          />
        )}
      </span>
      <span>Ask VibePin</span>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </button>
  );
}
