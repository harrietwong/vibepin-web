/**
 * URL shorteners the evidence engine can recognise in a Pin's destination link.
 *
 * Versioned and kept in its own module because it is a THRESHOLD, not a fact: the
 * observation "this link points at a redirect domain" is only as complete as this
 * list, and a set of numbers produced under `redirect-domains-1` must be
 * distinguishable from one produced after somebody added a domain. The engine
 * records `listVersion` in the A3 details for that reason.
 *
 * The rule names what it sees — a redirecting host — and nothing beyond it. Whether a
 * shortener costs reach, breaks attribution, or does neither is not something this
 * data can settle, so no template built on A3 may claim it.
 */

export const REDIRECT_DOMAINS_VERSION = "redirect-domains-1";

export const REDIRECT_DOMAINS: readonly string[] = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "is.gd",
  "shorturl.at",
];
