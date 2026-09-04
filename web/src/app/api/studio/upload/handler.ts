export const DEFAULT_DRAFT_BUCKET = "generated-private";
export const MAX_STUDIO_UPLOAD_BYTES = 12 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export type StudioUploadProvenance = {
  owner_user_id: string;
  bucket_id: string;
  object_path: string;
  source_type: "upload";
  intent_id: null;
};

export type StudioUploadHandlerDeps = {
  getUserId(req: Request): Promise<string | null>;
  configured: boolean;
  bucket?: string;
  pathFactory?: (ownerUserId: string, extension: string) => string;
  uploadObject(input: {
    bucket: string;
    path: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ error: string | null }>;
  registerProvenance(input: StudioUploadProvenance): Promise<boolean>;
  removeObject(bucket: string, path: string): Promise<void>;
  recordCleanup?: (input: { owner_user_id: string; bucket_id: string; object_path: string; reason: string }) => Promise<void>;
};

function requestIdFrom(req: Request): string {
  return (req.headers.get("x-request-id") ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 128);
}

function defaultPath(ownerUserId: string, extension: string): string {
  return `studio/uploads/${ownerUserId}/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${extension}`;
}

export async function handleStudioUpload(req: Request, deps: StudioUploadHandlerDeps): Promise<Response> {
  const requestId = requestIdFrom(req);
  const uid = await deps.getUserId(req);
  if (!uid) {
    return Response.json({ error: "Unauthorized", code: "unauthorized", requestId }, { status: 401 });
  }
  if (!deps.configured) {
    return Response.json({ error: "Storage is not configured", code: "config_error", requestId }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data", code: "bad_request", requestId }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing file", code: "bad_request", requestId }, { status: 400 });
  }
  const extension = EXT_BY_TYPE[file.type];
  if (!extension) {
    return Response.json({ error: "Unsupported image type", code: "invalid_type", requestId }, { status: 415 });
  }
  if (file.size <= 0 || file.size > MAX_STUDIO_UPLOAD_BYTES) {
    return Response.json({ error: "Image too large (max 12MB)", code: "too_large", requestId }, { status: 413 });
  }

  const bucket = deps.bucket ?? DEFAULT_DRAFT_BUCKET;
  const path = (deps.pathFactory ?? defaultPath)(uid, extension);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const uploaded = await deps.uploadObject({ bucket, path, bytes, contentType: file.type }).catch(() => ({ error: "upload threw" }));
  if (uploaded.error) {
    return Response.json({ error: "Upload failed. Please try again.", code: "upload_failed", requestId }, { status: 502 });
  }

  let registered = false;
  try {
    registered = await deps.registerProvenance({
      owner_user_id: uid,
      bucket_id: bucket,
      object_path: path,
      source_type: "upload",
      intent_id: null,
    });
  } catch { registered = false; }
  if (!registered) {
    try {
      await deps.removeObject(bucket, path);
    } catch (error) {
      console.error("[studio/upload] compensation remove failed", { bucket, path, error });
      if (deps.recordCleanup) {
        try {
          await deps.recordCleanup({ owner_user_id: uid, bucket_id: bucket, object_path: path, reason: "provenance_registration_failed" });
        } catch (recorderError) {
          console.error("[studio/upload] durable cleanup recording failed", { bucket, path, error: recorderError });
        }
      }
    }
    return Response.json({ error: "Upload could not be secured.", code: "provenance_unavailable", requestId }, { status: 503 });
  }

  const proxyUrl = `/api/storage-image?path=${encodeURIComponent(path)}`;
  return Response.json({ ok: true, path, publicUrl: proxyUrl, proxyUrl, requestId }, { status: 201 });
}
