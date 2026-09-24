/**
 * The one set of outbound headers for product-URL import (generic AND Amazon channel).
 * Honest VibePin UA — never a browser impersonation (design §2.1: Amazon's own bot
 * page asks automated access to use its API; we do not disguise ourselves).
 */
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "Mozilla/5.0 (compatible; VibePin/1.0; +https://vibepin.app)",
  Accept:       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
