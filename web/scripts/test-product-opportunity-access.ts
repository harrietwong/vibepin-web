process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";

import {
  canAccessProductOpportunity,
  canAccessSavedProductHistory,
  productCatalogLimit,
  productCatalogScope,
} from "../src/lib/server/productOpportunityAccess";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(productCatalogLimit("free") === 10, "Free must be limited to 10 complete products");
for (const plan of ["starter", "pro", "business"] as const) {
  assert(productCatalogLimit(plan) === null, `${plan} must see the full catalog`);
}

assert(
  canAccessProductOpportunity("free", { free_preview_rank: 1, lifecycle_status: "active" }),
  "Free should access rank 1",
);
assert(
  canAccessProductOpportunity("free", { free_preview_rank: 10, lifecycle_status: "active" }),
  "Free should access rank 10",
);
assert(
  !canAccessProductOpportunity("free", { free_preview_rank: null, lifecycle_status: "active" }),
  "Free must not bypass the curated set through a direct id",
);
assert(
  !canAccessProductOpportunity("free", { free_preview_rank: 1, lifecycle_status: "retired" }),
  "Retired products are not discoverable",
);
assert(
  canAccessProductOpportunity("starter", { free_preview_rank: null, lifecycle_status: "active" }),
  "Every paid plan should access the full active catalog",
);
assert(productCatalogScope("free").requiresFreePreviewRank, "Free query must be rank-scoped");
assert(!productCatalogScope("pro").requiresFreePreviewRank, "Paid query must not be truncated");
assert(
  !canAccessSavedProductHistory("free", { free_preview_rank: 1, lifecycle_status: "retired" }),
  "Free Saved Products must not accumulate details outside the current curated ten",
);
assert(
  canAccessSavedProductHistory("starter", { free_preview_rank: null, lifecycle_status: "retired" }),
  "Paid users should retain a read-only saved history after a product leaves the catalog",
);

console.log("product opportunity access: PASS");
