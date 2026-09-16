import type { VideoObjectStorage } from "./videoUploadHandler";

function objectUrl(base: string, bucket: string, path: string) {
  return `${base.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A narrow, injected service-role Storage adapter. It never creates public URLs. */
export function createSupabaseVideoStorage(input: { supabaseUrl: string; serviceRoleKey: string; fetchImpl?: typeof fetch }): VideoObjectStorage {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${input.serviceRoleKey}`, apikey: input.serviceRoleKey };
  return {
    async stat({ bucket, path }) {
      const response = await fetchImpl(objectUrl(input.supabaseUrl, bucket, path), { method: "HEAD", headers });
      if (response.status === 404) return { exists: false };
      if (!response.ok) throw new Error("storage_stat_failed");
      const size = Number(response.headers.get("content-length"));
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      // Supabase-compatible object stores may expose an authoritative SHA-256
      // as object metadata. When unavailable the v77 declared checksum is retained
      // as an explicitly declared fact; bytes are never buffered to hash them here.
      const checksumSha256 = response.headers.get("x-amz-meta-sha256") ?? undefined;
      return { exists: true, contentType, byteSize: Number.isSafeInteger(size) ? size : undefined, checksumSha256 };
    },
    readRange({ bucket, path, start, end }) {
      return fetchImpl(objectUrl(input.supabaseUrl, bucket, path), { headers: { ...headers, Range: `bytes=${start}-${end}` } });
    },
    async remove({ bucket, path }) {
      const response = await fetchImpl(`${input.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}`, {
        method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefixes: [path] }),
      });
      if (!response.ok) throw new Error("storage_remove_failed");
    },
  };
}
