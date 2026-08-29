export const dynamic = "force-dynamic";

/**
 * The legacy endpoint accepted a `pin_products` id and returned percentile,
 * keyword-growth, Competition and Opportunity Score conclusions. Those ids and
 * metrics are not compatible with the stable Product Opportunity contract, so
 * guessing a redirect would risk attaching the wrong evidence or metric history.
 * Keep an explicit tombstone until old clients have migrated to the v3.7 API.
 */
export async function GET() {
  return Response.json(
    {
      error: "This older product insights view is no longer available. Open Product Opportunities for current product details.",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
