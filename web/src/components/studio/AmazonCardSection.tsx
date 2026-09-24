"use client";

/**
 * AmazonCardSection — the Amazon sub-area under a card's Website URL (T3, design
 * §1.7 / §2.3 / §3.2). Shown only while the field holds an Amazon link.
 *
 *  - fetch status + "Get product details" / "Try again" (60 s cooldown per card)
 *  - manual entry: product name, selling points, Brand / Material / Size — the only
 *    way a brand/material/size claim is authorised in the copy
 *  - clean-link suggestion as a chip: the Website URL changes ONLY when clicked
 *    (ruling 6); the Pin always links to what the user pasted otherwise
 *  - tag warnings (non-blocking)
 *
 * It never writes title / description / Website URL itself; it hands the host a new
 * `amazonSource` (or, for the chip, the URL the user chose).
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Link2, Loader2 } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { suggestAmazonLinkNormalization, type AmazonLinkWarning } from "@/lib/affiliate/amazonLink";
import { AMAZON_AFFILIATE_SETTINGS_EVENT, getAmazonAffiliateSettings } from "@/lib/affiliate/amazonAffiliateSettings";
import {
  amazonCardMode,
  canGenerateAmazonCopy,
  effectiveAmazonProductName,
  type AmazonCardManual,
  type AmazonCardSource,
  type AmazonClaimHint,
} from "@/lib/studio/amazonCardSource";
import { BUI, fieldStyle, labelStyle } from "@/components/studio/boardUI";

export const AMAZON_REFETCH_COOLDOWN_MS = 60_000;

const WARNING_KEYS: Partial<Record<AmazonLinkWarning, MessageKey>> = {
  no_tag_no_commission: "studioBoard.amazon.warning.no_tag_no_commission",
  marketplace_mismatch: "studioBoard.amazon.warning.marketplace_mismatch",
  tag_differs_from_default: "studioBoard.amazon.warning.tag_differs_from_default",
  invalid_tag: "studioBoard.amazon.warning.invalid_tag",
  no_asin: "studioBoard.amazon.warning.no_asin",
};

const MANUAL_REASON_KEYS: Partial<Record<string, MessageKey>> = {
  no_title: "studioBoard.amazon.manualReason.no_title",
  not_product_page: "studioBoard.amazon.manualReason.not_product_page",
  short_link_unexpanded: "studioBoard.amazon.manualReason.short_link_unexpanded",
  unsupported_marketplace: "studioBoard.amazon.manualReason.unsupported_marketplace",
};

const FIELD_LABEL_KEYS: Record<AmazonClaimHint["field"], MessageKey> = {
  brand: "studioBoard.amazon.brand",
  material: "studioBoard.amazon.material",
  size: "studioBoard.amazon.size",
};

export type AmazonCardSectionProps = {
  draftId: string;
  source: AmazonCardSource;
  disabled?: boolean;
  fetching: boolean;
  /** ms epoch of the last fetch start on this card (cooldown). */
  lastFetchAt: number | null;
  claimHints: AmazonClaimHint[];
  onFetch: () => void;
  onManualChange: (patch: Partial<AmazonCardManual>) => void;
  onUseLink: (url: string) => void;
};

export function AmazonCardSection(props: AmazonCardSectionProps) {
  const { t: tr } = useLocale();
  const { source, disabled, fetching, claimHints } = props;
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onSettings = () => setSettingsVersion(v => v + 1);
    window.addEventListener(AMAZON_AFFILIATE_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(AMAZON_AFFILIATE_SETTINGS_EVENT, onSettings);
  }, []);

  // Tick only while a cooldown is running.
  const cooldownLeft = props.lastFetchAt ? Math.max(0, AMAZON_REFETCH_COOLDOWN_MS - (now - props.lastFetchAt)) : 0;
  useEffect(() => {
    if (!props.lastFetchAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [props.lastFetchAt]);

  // Suggestion from the expanded/resolved URL when the import produced one (short
  // links), else from what was pasted.
  const suggestion = useMemo(
    () => suggestAmazonLinkNormalization(source.resolvedUrl ?? source.pastedUrl, getAmazonAffiliateSettings()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.resolvedUrl, source.pastedUrl, settingsVersion],
  );
  const chipUrl = suggestion && suggestion.suggestedUrl !== source.pastedUrl ? suggestion.suggestedUrl : null;
  const warnings = (suggestion?.warnings ?? []).map(w => WARNING_KEYS[w]).filter((k): k is MessageKey => Boolean(k));

  const mode = amazonCardMode(source);
  const manual = source.manual;
  // Untrimmed while typing; the gate/mapping trim (effectiveAmazonProductName).
  const productName = manual.productName !== undefined ? manual.productName : effectiveAmazonProductName(source);
  const hinted = new Set(claimHints.map(h => h.field));
  const canRefetch = !fetching && cooldownLeft === 0 && source.linkStatus !== "no_asin";

  const statusText = fetching
    ? tr("studioBoard.amazon.fetching")
    : mode.mode === "fetched"
      ? tr("studioBoard.amazon.fetched")
      : mode.mode === "manual"
        ? tr(MANUAL_REASON_KEYS[mode.reason ?? ""] ?? "studioBoard.amazon.manualIntro")
        : tr("studioBoard.amazon.notFetched");

  const input = (field: keyof AmazonCardManual, label: MessageKey, value: string, highlight = false) => (
    <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 3, margin: 0 }}>
      {tr(label)}
      <input data-testid={`amazon-${field}`} value={value} disabled={disabled}
        onChange={event => props.onManualChange({ [field]: event.target.value })}
        style={{ ...fieldStyle, fontSize: 11.5, ...(highlight ? { borderColor: BUI.warning, boxShadow: `0 0 0 2px ${BUI.warning}33` } : {}) }} />
    </label>
  );

  return (
    <div data-testid="card-amazon-section" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 9px", borderRadius: 9, border: `1px solid ${BUI.border}`, background: BUI.surface2 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ ...labelStyle, margin: 0 }}>{tr("studioBoard.amazon.sectionTitle")}</span>
        {source.linkStatus !== "no_asin" && (
          <button type="button" data-testid="amazon-fetch" disabled={disabled || !canRefetch} onClick={props.onFetch}
            style={{ border: "none", background: "none", padding: 0, color: BUI.purple, fontSize: 10.5, fontWeight: 800, cursor: disabled || !canRefetch ? "default" : "pointer", opacity: disabled || !canRefetch ? 0.6 : 1, fontFamily: "inherit" }}>
            {fetching
              ? <Loader2 style={{ width: 11, height: 11 }} className="animate-spin" />
              : cooldownLeft > 0
                ? tr("studioBoard.amazon.retryWait").replace("{s}", String(Math.ceil(cooldownLeft / 1000)))
                : source.fetch.status === "not_attempted" ? tr("studioBoard.amazon.fetchButton") : tr("studioBoard.amazon.retryButton")}
          </button>
        )}
      </div>

      <p data-testid="amazon-status" data-mode={mode.mode} style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, color: mode.mode === "manual" ? BUI.warning : BUI.textSec, display: "flex", gap: 5, alignItems: "flex-start" }}>
        {mode.mode === "fetched" && !fetching ? <Check style={{ width: 11, height: 11, flexShrink: 0, marginTop: 1, color: BUI.success }} /> : null}
        {statusText}
      </p>

      {chipUrl && (
        <button type="button" data-testid="amazon-clean-link-chip" disabled={disabled} title={tr("studioBoard.amazon.cleanLinkHint").replace("{url}", chipUrl)}
          onClick={() => props.onUseLink(chipUrl)}
          style={{ alignSelf: "flex-start", maxWidth: "100%", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, border: `1px solid ${BUI.border}`, background: BUI.surface, color: BUI.purple, fontSize: 10.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <Link2 style={{ width: 11, height: 11, flexShrink: 0 }} /> {tr("studioBoard.amazon.useCleanLink")}
        </button>
      )}

      {warnings.map(key => (
        <p key={key} data-testid="amazon-link-warning" style={{ margin: 0, fontSize: 10.5, lineHeight: 1.4, color: BUI.warning, display: "flex", gap: 5, alignItems: "flex-start" }}>
          <AlertTriangle style={{ width: 11, height: 11, flexShrink: 0, marginTop: 1 }} /> {tr(key)}
        </p>
      ))}

      <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 3, margin: 0 }}>
        {tr("studioBoard.amazon.productName")}
        <input data-testid="amazon-productName" value={productName} disabled={disabled}
          onChange={event => props.onManualChange({ productName: event.target.value })}
          style={{ ...fieldStyle, fontSize: 11.5, ...(!canGenerateAmazonCopy(source) ? { borderColor: BUI.warning } : {}) }} />
      </label>
      {!canGenerateAmazonCopy(source) && (
        <p data-testid="amazon-name-required" style={{ margin: 0, fontSize: 10.5, color: BUI.warning }}>{tr("studioBoard.amazon.productNameRequired")}</p>
      )}
      {source.extracted?.bullets?.length ? (
        <p style={{ margin: 0, fontSize: 10.5, color: BUI.textMuted }}>
          {tr("studioBoard.amazon.fetchedBullets").replace("{n}", String(source.extracted.bullets.length))}
        </p>
      ) : null}
      <label style={{ ...labelStyle, display: "flex", flexDirection: "column", gap: 3, margin: 0 }}>
        {tr("studioBoard.amazon.sellingPoints")}
        <textarea data-testid="amazon-sellingPoints" value={manual.sellingPoints ?? ""} disabled={disabled} rows={2}
          onChange={event => props.onManualChange({ sellingPoints: event.target.value })}
          style={{ ...fieldStyle, fontSize: 11.5, lineHeight: 1.45, resize: "vertical", minHeight: 44 }} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 6 }}>
        {input("brand", "studioBoard.amazon.brand", manual.brand ?? "", hinted.has("brand"))}
        {input("material", "studioBoard.amazon.material", manual.material ?? "", hinted.has("material"))}
        {input("size", "studioBoard.amazon.size", manual.size ?? "", hinted.has("size"))}
      </div>
      <p style={{ margin: 0, fontSize: 10, color: BUI.textMuted }}>{tr("studioBoard.amazon.structuredHint")}</p>
      {claimHints.map(hint => (
        <p key={`${hint.field}:${hint.value}`} data-testid="amazon-claim-hint" style={{ margin: 0, fontSize: 10.5, color: BUI.warning }}>
          {tr("studioBoard.amazon.claimHint").replace("{value}", hint.value || "…").replace("{field}", tr(FIELD_LABEL_KEYS[hint.field]))}
        </p>
      ))}
    </div>
  );
}
