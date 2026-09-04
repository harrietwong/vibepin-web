import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { createServerClient } from "@/lib/supabase";
import { authorizeStudioStoragePath, ownedGenerationJobsContainPath } from "@/lib/server/storagePathAuth";

const DEFAULT_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const DEFAULT_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = "generated";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

type GenerationJobResultRow = { results?: unknown };

export type StorageImageRouteDeps = {
  getUserId?: (req: Request) => Promise<string | null>;
  loadGenerationResults?: (userId: string) => Promise<{ data: GenerationJobResultRow[]; error: boolean }>;
  fetchImpl?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
};

async function loadGenerationResults(userId: string): Promise<{ data: GenerationJobResultRow[]; error: boolean }> {
  const db = createServerClient();
  const { data, error } = await db
    .from("generation_jobs")
    .select("results")
    .eq("vibepin_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  return { data: (data ?? []) as GenerationJobResultRow[], error: Boolean(error) };
}

export async function readLimitedImageBody(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handleStorageImageGet(req: Request, deps: StorageImageRouteDeps = {}) {
  const path = new URL(req.url).searchParams.get("path");
  const getUserId = deps.getUserId ?? getUserIdFromBearerOrCookies;
  const configuredUrl = deps.supabaseUrl ?? DEFAULT_SUPABASE_URL;
  const configuredKey = deps.serviceRoleKey ?? DEFAULT_SERVICE_ROLE_KEY;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const userId = await getUserId(req).catch(() => null);
  if (!userId) return new NextResponse(null, { status: 401 });
  if (!path || !configuredUrl || !configuredKey) return new NextResponse(null, { status: 404 });

  const authorization = authorizeStudioStoragePath(path, userId);
  if (!authorization.ok) return new NextResponse(null, { status: authorization.status });

  if (authorization.scope === "legacy-job") {
    const ownedResults = await (deps.loadGenerationResults ?? loadGenerationResults)(userId);
    if (ownedResults.error || !ownedGenerationJobsContainPath(ownedResults.data, authorization.path, configuredUrl)) {
      return new NextResponse(null, { status: 403 });
    }
  }

  const encodedPath = authorization.path.split("/").map(encodeURIComponent).join("/");
  const authUrl = `${configuredUrl}/storage/v1/object/${BUCKET}/${encodedPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetchImpl(authUrl, {
      headers: { Authorization: `Bearer ${configuredKey}`, apikey: configuredKey },
      signal: controller.signal,
    });
    if (!response.ok) return new NextResponse(null, { status: 404 });

    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      return new NextResponse(null, { status: 404 });
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      return new NextResponse(null, { status: 404 });
    }

    const body = await readLimitedImageBody(response);
    if (!body) return new NextResponse(null, { status: 404 });
    return new NextResponse(body.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400, immutable",
        Vary: "Authorization, Cookie",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[storage-image] fetch failed:", path, error);
    return new NextResponse(null, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
