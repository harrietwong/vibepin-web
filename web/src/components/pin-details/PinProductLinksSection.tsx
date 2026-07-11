"use client";

import { X, Package, Link2, Plus, ExternalLink } from "lucide-react";
import type { AttachedProduct } from "@/lib/pinterestClient";
import { toProxyUrl } from "@/lib/imageProxy";
import { getPinDisplayContext, type PinDisplayInput } from "@/lib/studio/pinDisplayContext";
import { resolveProductLinkDisplay, isAmazonProduct, linkDomain } from "@/lib/studio/productLink";
import { extractAsin } from "@/lib/affiliate/amazon";
import { useLocale } from "@/lib/i18n/LocaleProvider";

// CSS tokens match DraftDetailsDrawer so the extracted section looks identical.
const UI = {
  surface2: "var(--app-surface-2, #1A2236)",
  surface3: "var(--app-surface-3, #0F1524)",
  border: "var(--app-border, rgba(255,255,255,0.10))",
  fieldBorder: "var(--app-border-hi, rgba(255,255,255,0.18))",
  text: "var(--app-text, #E2E8F0)",
  textSec: "var(--app-text-sec, #8892A4)",
  textMuted: "var(--app-text-muted, #5B6577)",
  purple: "#A78BFA",
  purpleBg: "rgba(139,92,246,0.16)",
  info: "#60A5FA",
  gradient: "linear-gradient(135deg,#FF4D8D 0%,#D946EF 52%,#7C3AED 100%)",
};

const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10,
  border: `1px solid ${UI.fieldBorder}`, fontSize: 13.5, color: UI.text, background: UI.surface3,
  outline: "none", lineHeight: 1.5,
};
const lbl: React.CSSProperties = { fontSize: 12.5, fontWeight: 800, color: UI.text };

export type PinProductLinksSectionProps = {
  products: AttachedProduct[];
  /** Real id of the product designated as primary. */
  primaryProductId: string;
  /** Whether the inline "add product link" form is currently open. */
  addLinkOpen: boolean;
  /** URL field value for the add-link form. */
  lpUrl: string;
  /** Name field value for the add-link form. */
  lpName: string;
  /** Called when user clicks "Make primary" on a chip. Parent updates primaryProductId + marks dirty. */
  onSetPrimary: (id: string) => void;
  /** Called when user clicks × on a chip. Parent removes the product + marks dirty. */
  onRemove: (id: string) => void;
  /** Called to open or close the inline add-link form. */
  onToggleAddLink: (open: boolean) => void;
  /** Called when the URL input in the add-link form changes. */
  onLpUrlChange: (url: string) => void;
  /** Called when the name input in the add-link form changes. */
  onLpNameChange: (name: string) => void;
  /**
   * Called when the user clicks "Add product" in the form.
   * Parent owns validation (URL required), product deduplication, and toast.
   * Destination URL auto-fill (when destinationUrl is empty) also lives in parent.
   */
  onAddLink: () => void;
  /**
   * Pin fields for the unified display-context banner (product image + title +
   * ASIN + creator affiliate URL). Read-only — never used to write destinationUrl.
   */
  pin?: PinDisplayInput;
};

/**
 * Controlled product-links section for PinDetailsModal.
 * Presentational only — no API calls, no store writes, no toast calls.
 *
 * Safety guarantees:
 * - destinationUrl is never read or written here.
 * - productUrl from a chip never overwrites destinationUrl — that decision belongs to the parent.
 * - All state changes flow out through callbacks; no internal state is kept.
 */
export function PinProductLinksSection({
  products,
  primaryProductId,
  addLinkOpen,
  lpUrl,
  lpName,
  onSetPrimary,
  onRemove,
  onToggleAddLink,
  onLpUrlChange,
  onLpNameChange,
  onAddLink,
  pin,
}: PinProductLinksSectionProps) {
  const { t } = useLocale();
  const primaryProduct = products.find(p => p.id === primaryProductId) ?? products[0] ?? null;

  // Pin-level affiliate URL (used only to label an Amazon row's link — Amazon is a
  // source badge, not a special layout). Non-Amazon rows show their own product URL.
  const ctx = pin ? getPinDisplayContext(pin) : null;
  const pinAffiliateUrl = ctx?.affiliateUrl ?? null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
        <span style={lbl}>{t("pinDetails.products.label")}</span>
        {products.length > 0 && (
          <span style={{ fontSize: 9.5, fontWeight: 800, color: UI.purple, background: UI.purpleBg, padding: "2px 7px", borderRadius: 999 }}>
            {products.length} {t("pinDetails.products.attachedSuffix")}
          </span>
        )}
      </div>

      {products.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          {products.map((p, i) => {
            const isPrimary = primaryProduct?.id === p.id;
            const amazon = isAmazonProduct({ productUrl: p.productUrl, source: p.sourceDomain });
            const link = resolveProductLinkDisplay({ productUrl: p.productUrl, source: p.sourceDomain }, amazon ? pinAffiliateUrl : null);
            const asin = amazon ? extractAsin(p.productUrl) : null;
            const domain = p.sourceDomain || linkDomain(p.productUrl);
            return (
              <div key={p.id} data-testid="draft-product-chip" style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 9px", borderRadius: 10, background: UI.surface2, border: `1px solid ${UI.border}` }}>
                <div style={{ width: 32, height: 32, borderRadius: 7, overflow: "hidden", flexShrink: 0, background: UI.surface3, border: `1px solid ${UI.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {p.imageUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={toProxyUrl(p.imageUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <Package size={14} color={UI.textMuted} />}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 11.5, fontWeight: 700, color: UI.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</p>
                    {isPrimary && <span data-testid="draft-product-primary-badge" style={{ flexShrink: 0, fontSize: 8.5, fontWeight: 800, color: UI.purple, background: UI.purpleBg, padding: "1px 6px", borderRadius: 999 }}>{t("pinDetails.products.primary")}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 1, minWidth: 0 }}>
                    {/* Small, neutral source badge — Amazon is not a special layout. */}
                    {amazon
                      ? <span data-testid="draft-product-source-badge" style={{ flexShrink: 0, fontSize: 8.5, fontWeight: 800, color: "#F59E0B", background: "rgba(245,158,11,0.14)", padding: "1px 6px", borderRadius: 999 }}>Amazon</span>
                      : domain ? <span data-testid="draft-product-source-badge" style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: UI.textMuted }}>{domain}</span> : null}
                    {asin && <span style={{ flexShrink: 0, fontSize: 9, color: UI.textMuted }}>ASIN {asin}</span>}
                    {link.url ? (
                      <a data-testid="draft-product-link" href={link.url} target="_blank" rel="noopener noreferrer"
                        style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 600, color: UI.info, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                        <ExternalLink size={9} /> {link.label}
                      </a>
                    ) : (
                      <span data-testid="draft-product-link" style={{ fontSize: 9.5, color: UI.textMuted }}>{link.label}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onSetPrimary(p.id)}
                  style={{ border: "none", borderRadius: 999, padding: "3px 7px", background: isPrimary ? UI.purpleBg : "transparent", color: isPrimary ? UI.purple : UI.textMuted, fontSize: 9, fontWeight: 800, cursor: "pointer", flexShrink: 0 }}
                >
                  {isPrimary ? t("pinDetails.products.primary") : t("pinDetails.products.makePrimary")}
                </button>
                <button
                  type="button"
                  data-testid={`draft-product-remove-${i}`}
                  onClick={() => onRemove(p.id)}
                  aria-label={t("pinDetails.products.removeAria")}
                  style={{ background: "none", border: "none", cursor: "pointer", color: UI.textMuted, padding: 2, flexShrink: 0 }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {addLinkOpen ? (
        <div data-testid="draft-add-link-form" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, background: UI.surface2, border: `1px solid ${UI.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: UI.textSec, fontWeight: 700 }}>
            <Link2 size={12} /> {t("pinDetails.products.addLinkTitle")}
          </div>
          <input
            data-testid="draft-link-url-input"
            value={lpUrl}
            onChange={e => onLpUrlChange(e.target.value)}
            placeholder="https://store.com/product"
            style={field}
          />
          <input
            data-testid="draft-link-name-input"
            value={lpName}
            onChange={e => onLpNameChange(e.target.value)}
            placeholder={t("pinDetails.products.namePlaceholder")}
            style={field}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="draft-add-link-submit"
              onClick={onAddLink}
              style={{ flex: 1, padding: "9px", borderRadius: 8, border: "none", background: UI.gradient, color: "#fff", fontSize: 11.5, fontWeight: 800, cursor: "pointer" }}
            >
              {t("pinDetails.products.addProduct")}
            </button>
            <button
              type="button"
              onClick={() => onToggleAddLink(false)}
              style={{ padding: "9px 12px", borderRadius: 8, border: `1px solid ${UI.border}`, background: "transparent", color: UI.textSec, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : products.length === 0 ? (
        // Lightweight single row: "No linked product" + a small "+ Add".
        <div data-testid="draft-products-empty" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 11px", borderRadius: 10, border: `1px solid ${UI.border}`, background: UI.surface2 }}>
          <span style={{ fontSize: 12, color: UI.textMuted }}>{t("pinDetails.products.noLinked")}</span>
          <button type="button" data-testid="draft-add-product" onClick={() => onToggleAddLink(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", color: UI.info, fontSize: 12, fontWeight: 800, cursor: "pointer", padding: 0 }}>
            <Plus size={13} /> {t("pinDetails.products.add")}
          </button>
        </div>
      ) : (
        <button type="button" data-testid="draft-add-product" onClick={() => onToggleAddLink(true)}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", color: UI.info, fontSize: 11.5, fontWeight: 800, cursor: "pointer", padding: 0 }}>
          <Plus size={13} /> {t("pinDetails.products.addAnother")}
        </button>
      )}
    </>
  );
}
