"use client";
/**
 * AssistantPanel — the compact contextual panel.
 *
 * Desktop: bottom-right floating panel. Mobile (≤640px): bottom sheet. Chat-first by
 * default — a short greeting + subtle example prompts, no cards. Real, proactive
 * findings (and capabilities the user revealed via chat) render above the chat input.
 * Header wording only claims to have "found" things when there are real issues.
 */
import { useEffect, useState } from "react";
import { X, Sparkles } from "lucide-react";
import { useAssistant } from "@/lib/assistant/useAssistant";
import { AUI, Z } from "./theme";
import { AssistantFindingCard } from "./AssistantFindingCard";
import { AssistantChat } from "./AssistantChat";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

export function AssistantPanel() {
  // Ask VibePin is currently disabled in production. It is an AI page assistant, not the Customer Support MVP.
  const enableAskVibePin = process.env.NEXT_PUBLIC_ENABLE_ASK_VIBEPIN === "true";
  if (!enableAskVibePin) return null;

  return <AskVibePinPanel />;
}

function AskVibePinPanel() {
  const { open, setOpen, context, visibleFindings, issueCount, chatLog, dismissFinding, sendChat } = useAssistant();
  const mobile = useIsMobile();

  if (!open) return null;

  // Header wording is honest: only claim "found … need attention" for real issues.
  const header = issueCount > 0
    ? `I found ${issueCount} thing${issueCount === 1 ? "" : "s"} that need${issueCount === 1 ? "s" : ""} attention`
    : visibleFindings.length > 0 ? "Here's what I opened" : "";
  const bottomOffset = 24 + (context.footerOffset ?? 0);

  const shell: React.CSSProperties = mobile
    ? {
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: Z.panel,
        maxHeight: "82vh", borderRadius: "18px 18px 0 0",
      }
    : {
        position: "fixed", right: 20, bottom: bottomOffset + 56, zIndex: Z.panel,
        width: 380, maxHeight: "min(620px, calc(100vh - 120px))", borderRadius: 18,
      };

  return (
    <>
      {mobile && (
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: Z.panel - 1, background: "rgba(0,0,0,0.4)" }} />
      )}
      <section
        role="dialog"
        aria-label="VibePin assistant"
        data-testid="assistant-panel"
        style={{
          ...shell,
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: AUI.card, border: `1px solid ${AUI.borderHi}`,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", borderBottom: `1px solid ${AUI.border}` }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, background: AUI.gradient, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Sparkles style={{ width: 16, height: 16, color: "#fff" }} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: AUI.text, lineHeight: 1.1 }}>Ask VibePin</p>
            <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 600, color: AUI.textSec }}>{context.label}</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close assistant" style={{ background: "none", border: "none", cursor: "pointer", color: AUI.textSec, padding: 4 }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {visibleFindings.length > 0 ? (
            <>
              {context.summary && (
                <p style={{ margin: 0, fontSize: 12, color: AUI.textSec, lineHeight: 1.4 }}>{context.summary}</p>
              )}
              {header && (
                <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: AUI.textMuted }}>{header}</p>
              )}
              {visibleFindings.map((f) => (
                <AssistantFindingCard key={f.id} finding={f} onDismiss={dismissFinding} onClosePanel={() => setOpen(false)} />
              ))}
            </>
          ) : (
            // Chat-first default: a short greeting + subtle example prompts, no cards.
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "6px 2px" }}>
              <p style={{ margin: 0, fontSize: 13, color: AUI.text, lineHeight: 1.5 }}>
                {context.greeting ?? "Hi, I'm VibePin Assistant. Ask me anything about this page, your Pins, scheduling, products, boards, or setup."}
              </p>
              {context.examplePrompts && context.examplePrompts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: AUI.textMuted }}>Try asking</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {context.examplePrompts.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => sendChat(p)}
                        style={{
                          padding: "6px 11px", borderRadius: 16, cursor: "pointer",
                          border: `1px solid ${AUI.border}`, background: AUI.bg2, color: AUI.textSec,
                          fontSize: 12, fontWeight: 600,
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — chat */}
        <AssistantChat log={chatLog} onSend={sendChat} />
      </section>
    </>
  );
}
