"use client";
/**
 * AssistantChat — manual input routed to the local heuristic responder (no LLM).
 * Placeholder is intentionally page-scoped ("Ask about this page…"), never
 * "Ask me anything…", because this is not a general chatbot in this version.
 */
import { useState } from "react";
import { Send } from "lucide-react";
import type { ChatMessage } from "@/lib/assistant/types";
import { AUI } from "./theme";

export function AssistantChat({
  log,
  onSend,
}: {
  log: ChatMessage[];
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <div style={{ borderTop: `1px solid ${AUI.border}`, padding: "10px 12px", background: AUI.card }}>
      {log.length > 0 && (
        <div style={{ maxHeight: 168, overflowY: "auto", marginBottom: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {log.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "7px 10px", borderRadius: 10, fontSize: 12, lineHeight: 1.4,
                background: m.role === "user" ? AUI.gradient : AUI.bg2,
                color: m.role === "user" ? "#fff" : AUI.text,
                border: m.role === "user" ? "none" : `1px solid ${AUI.border}`,
              }}
            >
              {m.text}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Ask about this page…"
          rows={1}
          data-testid="assistant-chat-input"
          style={{
            flex: 1, resize: "none", maxHeight: 96,
            padding: "9px 11px", borderRadius: 10,
            border: `1px solid ${AUI.border}`, background: AUI.bg2, color: AUI.text,
            fontSize: 13, fontFamily: "inherit", lineHeight: 1.4, outline: "none",
          }}
        />
        <button
          type="button"
          onClick={submit}
          aria-label="Send"
          disabled={!text.trim()}
          style={{
            width: 38, height: 38, flexShrink: 0, borderRadius: 10, border: "none", cursor: text.trim() ? "pointer" : "not-allowed",
            background: text.trim() ? AUI.gradient : AUI.bg2, color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", opacity: text.trim() ? 1 : 0.5,
          }}
        >
          <Send style={{ width: 16, height: 16 }} />
        </button>
      </div>
    </div>
  );
}
