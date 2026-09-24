"use client";

/**
 * AmazonRiskNoticeBanner — the one-time, NON-blocking Amazon notice (design §5,
 * ruling 8). Shown above the card grid while any card links to Amazon and this
 * account has not acknowledged the current notice version. "Got it" stores the
 * acknowledgement on the synced amazon_affiliate_settings singleton; it never
 * reappears unless AMAZON_RISK_NOTICE_VERSION is bumped.
 *
 * Wording is informational ("告知"), never a compliance guarantee.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { Info } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import {
  AMAZON_AFFILIATE_SETTINGS_EVENT,
  acknowledgeAmazonRiskNotice,
  hasAcknowledgedAmazonRiskNotice,
} from "@/lib/affiliate/amazonAffiliateSettings";
import { BUI } from "@/components/studio/boardUI";

const AMAZON_POLICY_URL = "https://affiliate-program.amazon.com/help/operating/policies";

function subscribe(listener: () => void): () => void {
  window.addEventListener(AMAZON_AFFILIATE_SETTINGS_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(AMAZON_AFFILIATE_SETTINGS_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function AmazonRiskNoticeBanner({ hasAmazonCard }: { hasAmazonCard: boolean }) {
  const { t: tr } = useLocale();
  // Server snapshot = acknowledged, so SSR never flashes the banner.
  const acknowledged = useSyncExternalStore(subscribe, () => hasAcknowledgedAmazonRiskNotice(), () => true);
  const [copied, setCopied] = useState(false);
  const bioText = tr("amazonRiskNotice.bioText");
  const copyBio = useCallback(() => {
    try { void navigator.clipboard?.writeText(bioText); } catch { /* clipboard blocked — non-fatal */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [bioText]);

  if (!hasAmazonCard || acknowledged) return null;
  return (
    <div data-testid="amazon-risk-notice" role="note"
      style={{ gridColumn: "1 / -1", display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, border: `1px solid ${BUI.info}33`, background: `${BUI.info}0D`, color: BUI.text }}>
      <Info style={{ width: 15, height: 15, flexShrink: 0, marginTop: 2, color: BUI.info }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5, lineHeight: 1.5 }}>
        <strong style={{ fontSize: 12.5 }}>{tr("amazonRiskNotice.title")}</strong>
        <span style={{ color: BUI.textSec }}>{tr("amazonRiskNotice.body")}</span>
        <span style={{ color: BUI.textSec }}>{tr("amazonRiskNotice.disclosure")}</span>
        <span style={{ color: BUI.textSec }}>
          {tr("amazonRiskNotice.bioLabel")} <em style={{ color: BUI.text }}>{bioText}</em>{" "}
          <button type="button" data-testid="amazon-risk-notice-copy" onClick={copyBio}
            style={{ border: "none", background: "none", padding: 0, color: BUI.purple, fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
            {copied ? tr("amazonRiskNotice.copied") : tr("amazonRiskNotice.copyBio")}
          </button>
        </span>
        <a href={AMAZON_POLICY_URL} target="_blank" rel="noopener noreferrer" style={{ color: BUI.info, fontWeight: 700, width: "fit-content" }}>
          {tr("amazonRiskNotice.policyLink")}
        </a>
      </div>
      <button type="button" data-testid="amazon-risk-notice-ack" onClick={() => acknowledgeAmazonRiskNotice()}
        style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.text, fontSize: 11.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
        {tr("amazonRiskNotice.acknowledge")}
      </button>
    </div>
  );
}
