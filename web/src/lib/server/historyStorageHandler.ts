import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { generationJobImageProxyUrls } from "@/lib/server/storagePathAuth";
import { createMediaProvenanceStore } from "@/lib/server/mediaProvenance";

type GenerationHistoryRow = {
  id: unknown;
  created_at: unknown;
  status: unknown;
  params: unknown;
  results: unknown;
};

export type HistoryStorageRouteDeps = {
  getUserId?: (req: Request) => Promise<string | null>;
  loadGenerationJobs?: (userId: string) => Promise<{ data: GenerationHistoryRow[]; error: boolean }>;
  findProvenance?: (userId: string, path: string) => Promise<{ object_path: string; lifecycle_state: string } | null>;
};

async function loadGenerationJobs(userId: string): Promise<{ data: GenerationHistoryRow[]; error: boolean }> {
  const db = createServerClient();
  const { data, error } = await db
    .from("generation_jobs")
    .select("id,created_at,status,params,results")
    .eq("vibepin_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  return { data: (data ?? []) as GenerationHistoryRow[], error: Boolean(error) };
}

export async function handleHistoryStorageGet(req: Request, deps: HistoryStorageRouteDeps = {}) {
  const getUserId = deps.getUserId ?? getUserIdFromBearerOrCookies;
  const userId = await getUserId(req).catch(() => null);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { data, error } = await (deps.loadGenerationJobs ?? loadGenerationJobs)(userId);
    if (error) return NextResponse.json({ entries: [] });

    const candidates = data.map(row => ({ row, images: generationJobImageProxyUrls(row, userId) }));
    const paths = candidates.flatMap(({ images }) => images.map(image => new URL(image, "https://vibepin.invalid").searchParams.get("path"))).filter((path): path is string => Boolean(path));
    const provenanceRows = deps.findProvenance
      ? await Promise.all(paths.map(path => deps.findProvenance!(userId, path)))
      : await createMediaProvenanceStore().findExactMany(userId, "generated-private", paths);
    const allowed = new Set(provenanceRows.filter(record => record && record.lifecycle_state !== "unresolved" && record.lifecycle_state !== "failed").map(record => record!.object_path));
    const entries = candidates.map(({ row, images: candidateImages }) => {
      // The job row supplies display metadata only. Authorization comes from the
      // indexed exact-path ledger, never from job recency or client history.
      const images = candidateImages.filter(image => {
        const path = new URL(image, "https://vibepin.invalid").searchParams.get("path");
        // Legacy public generated URLs remain visible as legacy debt; only new
        // private/proxy references require an exact ledger match.
        return !path || allowed.has(path);
      });
      if (!images.length) return [];
      const params = row.params && typeof row.params === "object"
        ? row.params as Record<string, unknown>
        : {};
      return [{
        id: `job_${row.id}`,
        savedAt: row.created_at,
        keyword: typeof params.keyword === "string" ? params.keyword : "",
        category: typeof params.category === "string" ? params.category : "",
        source: "storage",
        groups: [{ refUrl: null, images }],
        refCount: 1,
        productCount: Array.isArray(params.product_images) ? params.product_images.length : 0,
        totalPins: images.length,
        status: row.status,
      }];
    }).flat();
    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ entries: [] });
  }
}
