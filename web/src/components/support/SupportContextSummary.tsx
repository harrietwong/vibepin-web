"use client";

/**
 * SupportContextSummary — the checkmark list a user sees inside
 * ContactSupportModal ("Account details attached", "Publish log attached", …).
 * Never renders raw context JSON, tokens, or provider payloads — just a
 * preview of what buildSupportContext will attach server-side, using the same
 * presence-only rules (summarizeContext contains no secrets, safe to reuse
 * client-side for display purposes only; the DB write is always redacted
 * server-side regardless of what this preview shows).
 */

import { Check } from "lucide-react";
import { pickSourceFields, SOURCE_FIELDS, summarizeContext } from "@/lib/support/context";
import type { SupportSource } from "@/lib/support/types";

export function SupportContextSummary({
  source,
  ambientContext,
}: {
  source: SupportSource;
  ambientContext: Record<string, unknown>;
}) {
  const { pageUrl, browser, os, ...extra } = ambientContext;
  const sourceFields = pickSourceFields(extra, SOURCE_FIELDS[source] ?? []);
  const lines = summarizeContext({
    source,
    hasPageUrl: !!pageUrl,
    hasBrowser: !!(browser || os),
    sourceFields,
  });

  if (!lines.length) return null;

  return (
    <div data-testid="support-context-summary" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {lines.map((line) => (
        <div key={line} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--app-text-sec, #8892A4)" }}>
          <Check size={13} style={{ color: "#34D399", flexShrink: 0 }} />
          {line}
        </div>
      ))}
    </div>
  );
}
