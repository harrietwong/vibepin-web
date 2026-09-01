/**
 * SHOW_FOOTER_LEGAL_ENTITY — controls whether the footer's low-key legal-entity
 * disclosure line (LegalEntityNotice) renders.
 *
 * This flag ONLY gates the footer line. It has no effect on the Privacy Policy,
 * Terms of Service, Contact, About, or Organization JSON-LD — those carry the
 * legal-entity disclosure permanently, independent of this flag. Turning the
 * footer line off is a display choice, not a retraction of the disclosure.
 *
 * Default: on (true). Set NEXT_PUBLIC_SHOW_FOOTER_LEGAL_ENTITY="false" to hide
 * the footer line only.
 */
export function showFooterLegalEntity(): boolean {
  return process.env.NEXT_PUBLIC_SHOW_FOOTER_LEGAL_ENTITY !== "false";
}
