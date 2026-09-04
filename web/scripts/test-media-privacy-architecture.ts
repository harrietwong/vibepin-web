import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  OK ${name}`);
}

function uploadRequest(file?: File): Request {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("https://app.test/api/studio/upload", {
    method: "POST",
    headers: { "x-request-id": "safe_req-1" },
    body: form,
  });
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role";

  const { toProxyUrl } = await import("../src/lib/imageProxy");
  const { handleStorageImageGet } = await import("../src/lib/server/storageImageHandler");
  const { handleHistoryStorageGet } = await import("../src/lib/server/historyStorageHandler");
  const { handleStudioUpload } = await import("../src/app/api/studio/upload/handler");
  const { requiresPublishAsset } = await import("../src/lib/server/publishMedia");
  const { canonicalStorageReference, generationJobImageProxyUrls } = await import("../src/lib/server/storagePathAuth");
  const { CopyError, fetchImageAsDataUrl } = await import("../src/lib/ai-copy/visionServer");

  await test("protected proxy is never rewritten to a public generated URL", () => {
    const proxy = "/api/storage-image?path=studio%2Fuploads%2Fu1%2Fa.png";
    assert.equal(toProxyUrl(proxy), proxy);
    assert.equal(toProxyUrl("https://example.supabase.co/storage/v1/object/public/generated/studio/a.png"), "https://example.supabase.co/storage/v1/object/public/generated/studio/a.png");
    assert.equal(toProxyUrl("https://example.supabase.co/storage/v1/object/generated-private/studio/a.avif"), "/api/storage-image?path=studio%2Fa.avif");
  });

  await test("missing or unresolved provenance rejects before Storage fetch", async () => {
    for (const record of [null, { owner_user_id: "u1", object_path: "studio/legacy.png", source_type: "legacy", intent_id: null, lifecycle_state: "unresolved" }]) {
      let storageCalls = 0;
      const response = await handleStorageImageGet(new Request("https://app.test/api/storage-image?path=studio%2Flegacy.png"), {
        getUserId: async () => "u1",
        findProvenance: async () => record,
        fetchImpl: async () => { storageCalls += 1; return new Response("unexpected", { headers: { "content-type": "image/png" } }); },
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "test-only",
      });
      assert.equal(response.status, 403);
      assert.equal(storageCalls, 0);
    }
  });

  await test("resolved exact owner/path provenance permits bounded private response", async () => {
    let storageCalls = 0;
    const response = await handleStorageImageGet(new Request("https://app.test/api/storage-image?path=studio%2Fuploads%2Fu1%2Fa.png"), {
      getUserId: async () => "u1",
      findProvenance: async (owner, objectPath) => ({ owner_user_id: owner, object_path: objectPath, source_type: "upload", intent_id: null, lifecycle_state: "draft" }),
      fetchImpl: async () => {
        storageCalls += 1;
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png", "content-length": "4" } });
      },
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "test-only",
    });
    assert.equal(response.status, 200);
    assert.equal(storageCalls, 1);
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  await test("history keeps only exact resolved provenance and returns proxy URLs", async () => {
    const response = await handleHistoryStorageGet(new Request("https://app.test/api/history-storage"), {
      getUserId: async () => "u1",
      loadGenerationJobs: async () => ({ error: false, data: [{
        id: "job1", status: "completed", created_at: "2026-09-04T00:00:00Z", params: {},
        results: [
          { status: "done", imageUrl: "/api/storage-image?path=studio%2Fone.png" },
          { status: "done", imageUrl: "/api/storage-image?path=studio%2Ftwo.png" },
        ],
      }] }),
      findProvenance: async (_owner, objectPath) => ({ object_path: objectPath, lifecycle_state: objectPath === "studio/one.png" ? "draft" : "unresolved" }),
    });
    const payload = await response.json() as { entries: Array<{ groups: Array<{ images: string[] }> }> };
    assert.deepEqual(payload.entries.flatMap(entry => entry.groups.flatMap(group => group.images)), ["/api/storage-image?path=studio%2Fone.png"]);
  });

  await test("upload registers provenance before returning a protected proxy", async () => {
    const calls: string[] = [];
    const response = await handleStudioUpload(uploadRequest(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })), {
      getUserId: async () => "00000000-0000-4000-8000-000000000001",
      configured: true,
      pathFactory: () => "studio/uploads/00000000-0000-4000-8000-000000000001/a.png",
      uploadObject: async () => { calls.push("upload"); return { error: null }; },
      registerProvenance: async input => { calls.push(`register:${input.owner_user_id}`); return true; },
      removeObject: async () => { calls.push("remove"); },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(calls, ["upload", "register:00000000-0000-4000-8000-000000000001"]);
    const payload = await response.json() as { publicUrl: string; proxyUrl: string };
    assert.equal(payload.publicUrl, payload.proxyUrl);
    assert.match(payload.proxyUrl, /^\/api\/storage-image\?path=/);
  });

  await test("provenance failure compensates the uploaded object and fails closed", async () => {
    const calls: string[] = [];
    const response = await handleStudioUpload(uploadRequest(new File([new Uint8Array([1])], "a.png", { type: "image/png" })), {
      getUserId: async () => "00000000-0000-4000-8000-000000000001",
      configured: true,
      pathFactory: () => "studio/uploads/00000000-0000-4000-8000-000000000001/a.png",
      uploadObject: async () => { calls.push("upload"); return { error: null }; },
      registerProvenance: async () => { calls.push("register"); return false; },
      removeObject: async () => { calls.push("remove"); },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(calls, ["upload", "register", "remove"]);
    assert.equal((await response.json() as { code: string }).code, "provenance_unavailable");
  });

  await test("registration throw plus remove failure is durably recorded", async () => {
    let recorded: unknown = null;
    const response = await handleStudioUpload(uploadRequest(new File([new Uint8Array([1])], "a.png", { type: "image/png" })), {
      getUserId: async () => "u1", configured: true, pathFactory: () => "studio/uploads/u1/a.png",
      uploadObject: async () => ({ error: null }), registerProvenance: async () => { throw new Error("db down"); },
      removeObject: async () => { throw new Error("storage down"); },
      recordCleanup: async input => { recorded = input; },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(recorded, { owner_user_id: "u1", bucket_id: "generated-private", object_path: "studio/uploads/u1/a.png", reason: "provenance_registration_failed" });
  });

  await test("publish routes recognize relative, same-origin and private-bucket media", () => {
    assert.equal(requiresPublishAsset("/api/storage-image?path=studio%2Fa.png", "https://app.test"), true);
    assert.equal(requiresPublishAsset("https://app.test/api/storage-image?path=studio%2Fa.png", "https://app.test"), true);
    assert.equal(requiresPublishAsset("https://example.supabase.co/storage/v1/object/generated-private/studio/a.png", "https://app.test"), true);
    assert.equal(requiresPublishAsset("https://cdn.example.com/a.png", "https://app.test"), false);
  });

  await test("all exact-origin private object/render URL forms stay protected", () => {
    const base = "https://example.supabase.co";
    for (const suffix of [
      "/storage/v1/object/generated-private/studio/a.png?download=1",
      "/storage/v1/object/public/generated-private/studio/a.png?token=x",
      "/storage/v1/object/authenticated/generated-private/studio/a.png?x=1",
      "/storage/v1/object/sign/generated-private/studio/a.png?token=x",
      "/storage/v1/render/image/public/generated-private/studio/a.png?width=200",
      "/storage/v1/render/image/authenticated/generated-private/studio/a.png?width=200",
      "/storage/v1/render/image/sign/generated-private/studio/a.png?token=x",
      "/storage/v1/object/sign/generated-private/studio/a.png?token=x#ignored",
    ]) {
      const url = base + suffix;
      const ref = canonicalStorageReference(url, base);
      assert.deepEqual(ref, { bucket: "generated-private", path: "studio/a.png", legacy: false }, suffix);
      assert.equal(requiresPublishAsset(url, "https://app.test"), true, suffix);
      assert.equal(requiresPublishAsset(url.replace(base, "https://evil.test"), "https://app.test"), false, "cross-origin");
    }
    for (const variant of [
      "https://EXAMPLE.SUPABASE.CO:443/storage/v1/object/sign/generated-private/studio/a.png?token=x#ignored",
      "http://example.supabase.co/storage/v1/object/sign/generated-private/studio/a.png?token=x#ignored",
    ]) {
      assert.deepEqual(canonicalStorageReference(variant, base), { bucket: "generated-private", path: "studio/a.png", legacy: false });
      assert.equal(requiresPublishAsset(variant, "https://app.test"), true);
    }
  });

  await test("legacy public history compatibility remains strict-origin only", () => {
    const row = (imageUrl: string) => ({ results: [{ status: "done", imageUrl }] });
    const canonical = "https://example.supabase.co/storage/v1/object/public/generated/studio/a.png";
    assert.deepEqual(generationJobImageProxyUrls(row(canonical), "u1", "https://example.supabase.co"), [canonical]);
    assert.deepEqual(generationJobImageProxyUrls(row(canonical + "#ignored"), "u1", "https://example.supabase.co"), []);
    assert.deepEqual(generationJobImageProxyUrls(row(canonical.replace("https://", "http://")), "u1", "https://example.supabase.co"), []);
  });

  await test("AI analysis reads protected media only through the authenticated owner path", async () => {
    let seenOwner = "";
    let seenPath = "";
    const image = await fetchImageAsDataUrl("/api/storage-image?path=studio%2Fone.png", {
      ownerUserId: "u1",
      privateFetch: async (owner, objectPath) => {
        seenOwner = owner;
        seenPath = objectPath;
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      },
    });
    assert.equal(seenOwner, "u1");
    assert.equal(seenPath, "studio/one.png");
    assert.equal(image.bytes, 3);
    await assert.rejects(
      () => fetchImageAsDataUrl("/api/storage-image?path=studio%2Fone.png"),
      (error: unknown) => error instanceof CopyError && error.code === "protected_image_owner_required",
    );
  });

  await test("all authenticated AI image routes pass the verified owner", () => {
    const root = path.resolve(import.meta.dirname, "..");
    for (const relative of ["src/app/api/quality-judge/route.ts", "src/app/api/ai-copy/analyze/route.ts", "src/app/api/ai-copy/route.ts"]) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      assert.match(source, /fetchImageAsDataUrl\(body\.imageUrl, \{ ownerUserId: userId \}\)/, relative);
    }
  });

  await test("public AI image fetch uses the DNS/redirect-safe transport", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/lib/ai-copy/visionServer.ts"), "utf8");
    assert.match(source, /fetchWithSafeRedirects\(rawUrl\)/);
    assert.doesNotMatch(source, /await fetch\(url,/);
  });

  await test("publish fail-closed check occurs after confirmation and before provider work", () => {
    const root = path.resolve(import.meta.dirname, "..");
    for (const relative of ["src/app/api/pinterest/pins/route.ts", "src/app/api/publish/social/route.ts"]) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      const confirmation = source.indexOf("if (!confirmation.ok)");
      const assetGate = source.indexOf("if (imageUrls.some(url => requiresPublishAsset", confirmation) >= 0
        ? source.indexOf("if (imageUrls.some(url => requiresPublishAsset", confirmation)
        : source.indexOf("if (post.imageUrls.some(url =>", confirmation);
      const postGateWork = relative.includes("pinterest/")
        ? source.indexOf("let durableDb", assetGate)
        : source.indexOf("let summaries", assetGate);
      assert(confirmation >= 0 && assetGate > confirmation, `${relative}: asset gate must follow confirmation`);
      assert(postGateWork > assetGate, `${relative}: asset gate must precede destination, usage, job and provider work`);
    }
  });

  await test("generation uses authenticated raw owner while lock keeps scoped limiter identity", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const route = fs.readFileSync(path.join(root, "src/app/api/generate/route.ts"), "utf8");
    const generator = fs.readFileSync(path.resolve(root, "../backend/generator.py"), "utf8");
    assert.match(route, /generationRequestId, generationOwnerId: userId/);
    assert.match(route, /const generationOwnerId = authUserId \?\? "";/);
    assert.match(route, /acquireTtlLock\("active-generation", rateLimitIdentity,/);
    assert.match(route, /url\.startsWith\("\/api\/storage-image\?"\)/);
    assert.match(generator, /STORAGE_BUCKET\s+= os\.environ\.get\("VIBEPIN_DRAFT_BUCKET", "generated-private"\)/);
    assert.match(generator, /generation_owner_id: str = ""/);
    assert.match(generator, /"owner_user_id": owner_id/);
    assert.match(generator, /cleanup\.delete/);
  });

  await test("v75 creates only the private bucket and indexed owner/path ledger", () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../backend/db/migrate_v75_media_provenance.sql"), "utf8");
    assert.match(sql, /values \('generated-private', 'generated-private', false\)/);
    assert.doesNotMatch(sql, /values \('generated', 'generated'/);
    assert.match(sql, /primary key \(bucket_id, object_path\)/);
    assert.match(sql, /media_cleanup_outbox/);
    assert.match(sql, /intent_id text/);
    assert.match(sql, /enable row level security/);
  });

  console.log(`\nMedia privacy architecture: ${passed} passed, 0 failed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
