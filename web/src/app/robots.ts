import type { MetadataRoute } from "next";

/**
 * /robots.txt — generated via the Next.js `robots` file convention
 * (app/robots.ts returning MetadataRoute.Robots).
 *
 * Public marketing and legal pages (/, /pricing, /terms, /privacy,
 * /acceptable-use-policy, /refund-policy) are crawlable — payment and
 * compliance reviewers need to reach them without an account.
 *
 * Only non-public surfaces are disallowed: the admin console and the API
 * routes. Neither is useful to a crawler and neither should appear in search
 * results.
 *
 * No `sitemap` key: this app does not generate a sitemap, and pointing at a
 * URL that 404s is worse than omitting the directive.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin/", "/api/"],
    },
  };
}
