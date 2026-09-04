import { NextResponse } from "next/server";
import { getUserIdFromBearerOrCookies } from "@/lib/server/authUser";
import { authorizeStudioStoragePath } from "@/lib/server/storagePathAuth";
import { createMediaProvenanceStore, type MediaProvenance } from "@/lib/server/mediaProvenance";

const DEFAULT_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const DEFAULT_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.VIBEPIN_DRAFT_BUCKET ?? "generated-private";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export type StorageImageRouteDeps = {
  getUserId?: (req: Request) => Promise<string | null>;
  findProvenance?: (userId: string, path: string) => Promise<MediaProvenance | null>;
  fetchImpl?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
};

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
  if (total === 0) return null;
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

  // Every object, including legacy paths, requires a durable exact owner/path
  // record. Missing or unresolved provenance is fail-closed; no bounded job scan.
  const provenance = await (deps.findProvenance ?? ((owner, objectPath) =>
    createMediaProvenanceStore().findExact(owner, BUCKET, objectPath)))(userId, authorization.path).catch(() => null);
  if (!provenance || provenance.lifecycle_state === "unresolved" || provenance.lifecycle_state === "failed") {
    return new NextResponse(null, { status: 403 });
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
