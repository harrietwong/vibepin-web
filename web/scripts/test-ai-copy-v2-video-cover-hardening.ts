import assert from "node:assert/strict";

// This test intentionally owns its inert config before importing any module that
// initializes the server client, so it remains a standalone core-test process.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";

async function main() {
  const { resolveOwnedMediaEvidence, buildVideoCoverObservationPrompt } = await import("../src/lib/ai-copy/v2/videoCoverEvidence");
  const { createFact, createFactCardV1 } = await import("../src/lib/ai-copy/v2/factCard");
  const { validateCopy } = await import("../src/lib/ai-copy/v2/validateCopy");

  const calls: string[] = [];
  const video = await resolveOwnedMediaEvidence({ userId: "owner", draftId: "video" }, {
    loadOwnedDraft: async (owner, draft) => {
      calls.push(`draft:${owner}:${draft}`);
      return { media: [{ kind: "video", url: "private://raw-video.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fowner%2Fcover.png" }] };
    },
    findProvenance: async (owner, bucket, path) => {
      calls.push(`provenance:${owner}:${bucket}:${path}`);
      return { owner_user_id: owner, bucket_id: bucket, object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "ready" };
    },
    fetchStorageObject: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    analyzePoster: async ({ dataUrl, prompt }) => {
      calls.push(`provider:${dataUrl}`);
      assert.match(prompt, /static/i, "provider receives the strict static-frame protocol");
      return { objects: ["mug", "Nike shoes", "person walking"], colors: ["blue"], composition: "still_life", layout: "centered" };
    },
  });
  assert.equal(video.kind, "video", "persisted media kind determines the safety path even with no client hint");
  if (video.kind !== "video") throw new Error("video branch required");
  assert.equal(video.analysis.degradedMode, "none");
  assert.deepEqual(video.analysis.imageObserved?.objects, ["mug"], "only taxonomy-approved static objects become facts");
  assert.equal(calls.some(call => call.includes("raw-video")), false, "raw video URL is never dispatched");
  assert.deepEqual(calls.slice(0, 2), [
    "draft:owner:video",
    "provenance:owner:generated-private:studio/uploads/owner/cover.png",
  ], "production selector preserves owner, bucket, and exact path checks");

  for (const [label, loadOwnedDraft] of [
    ["loader failure", async () => { throw new Error("temporary DB failure"); }],
    ["not found", async () => null],
    ["malformed payload", async () => ({ media: "not-an-array" })],
  ] as const) {
    const unknown = await resolveOwnedMediaEvidence({ userId: "owner", draftId: label }, {
      loadOwnedDraft,
      findProvenance: async () => { throw new Error("unknown media must not inspect provenance"); },
      fetchStorageObject: async () => { throw new Error("unknown media must not download"); },
      analyzePoster: async () => { throw new Error("unknown media must not call provider"); },
    });
    assert.equal(unknown.kind, "unknown", `${label} is not treated as a confirmed image`);
    if (unknown.kind !== "unknown") throw new Error("unknown media branch required");
    assert.equal(unknown.analysis.degradedMode, "video_cover_unavailable", `${label} fails closed without client observations`);
  }

  for (const raw of [null, {}, { objects: ["person singing", "真皮", "Nike shoes"], colors: ["ultraviolet"], composition: "unknown", layout: "unknown" }] as const) {
    const unavailable = await resolveOwnedMediaEvidence({ userId: "owner", draftId: "invalid-observation" }, {
      loadOwnedDraft: async () => ({ media: [{ kind: "video", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fowner%2Fcover.png" }] }),
      findProvenance: async () => ({ owner_user_id: "owner", bucket_id: "generated-private", object_path: "studio/uploads/owner/cover.png", source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
      fetchStorageObject: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
      analyzePoster: async () => raw,
    });
    assert.equal(unavailable.kind, "video");
    if (unavailable.kind !== "video") throw new Error("video branch required");
    assert.equal(unavailable.analysis.degradedMode, "video_cover_unavailable", "empty or rejected observation never invents static facts");
    assert.equal(unavailable.analysis.imageObserved, undefined, "empty or rejected observation produces no visual evidence");
  }

  const partial = await resolveOwnedMediaEvidence({ userId: "owner", draftId: "partial-observation" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fowner%2Fcover.png" }] }),
    findProvenance: async () => ({ owner_user_id: "owner", bucket_id: "generated-private", object_path: "studio/uploads/owner/cover.png", source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
    fetchStorageObject: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    analyzePoster: async () => ({ objects: ["mug"], colors: [], composition: "unknown", layout: "unknown" }),
  });
  assert.equal(partial.kind, "video");
  if (partial.kind !== "video") throw new Error("video branch required");
  assert.equal(partial.analysis.degradedMode, "none", "valid literal fields remain usable");
  assert.deepEqual(partial.analysis.imageObserved?.objects, ["mug"]);
  assert.equal(partial.analysis.imageObserved?.summary, "", "missing composition is not invented");
  assert.equal(partial.analysis.imageObserved?.style, "", "missing layout is not invented");

  let missingPosterProviderCalls = 0;
  const missingPoster = await resolveOwnedMediaEvidence({ userId: "owner", draftId: "no-poster" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://raw.mp4" }] }),
    findProvenance: async () => { throw new Error("missing poster must not resolve provenance"); },
    fetchStorageObject: async () => { throw new Error("missing poster must not download"); },
    analyzePoster: async () => { missingPosterProviderCalls++; throw new Error("missing poster must not analyze"); },
  });
  assert.equal(missingPoster.kind, "video");
  if (missingPoster.kind !== "video") throw new Error("video branch required");
  assert.equal(missingPoster.analysis.degradedMode, "video_cover_unavailable", "actual video without a poster degrades safely");
  assert.equal(missingPosterProviderCalls, 0, "missing poster reaches zero provider calls");

  for (const lifecycle_state of ["failed", "unresolved"] as const) {
    let providerCalls = 0;
    const unavailable = await resolveOwnedMediaEvidence({ userId: "owner", draftId: lifecycle_state }, {
      loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://raw.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fowner%2Fcover.png" }] }),
      findProvenance: async () => ({ owner_user_id: "owner", bucket_id: "generated-private", object_path: "studio/uploads/owner/cover.png", source_type: "upload", intent_id: null, lifecycle_state }),
      fetchStorageObject: async () => { throw new Error("must not download"); },
      analyzePoster: async () => { providerCalls++; throw new Error("must not analyze"); },
    });
    if (unavailable.kind !== "video") throw new Error("video branch required");
    assert.equal(unavailable.analysis.degradedMode, "video_cover_unavailable", `${lifecycle_state} provenance is concealed`);
    assert.equal(providerCalls, 0, `${lifecycle_state} provenance reaches no provider`);
  }

  let overLimitProviderCalls = 0;
  const oversized = await resolveOwnedMediaEvidence({ userId: "owner", draftId: "large" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://raw.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fowner%2Fcover.png" }] }),
    findProvenance: async () => ({ owner_user_id: "owner", bucket_id: "generated-private", object_path: "studio/uploads/owner/cover.png", source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
    fetchStorageObject: async () => new Response(new Uint8Array(12 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
    analyzePoster: async () => { overLimitProviderCalls++; throw new Error("must not analyze"); },
  });
  if (oversized.kind !== "video") throw new Error("video branch required");
  assert.equal(oversized.analysis.degradedMode, "video_cover_unavailable", "bounded download rejects an oversized poster");
  assert.equal(overLimitProviderCalls, 0, "oversized poster reaches no provider");

  const prompt = buildVideoCoverObservationPrompt();
  for (const forbidden of ["motion", "audio", "brand", "material", "price", "inventory", "quantity"]) {
    assert.match(prompt.toLowerCase(), new RegExp(forbidden), `strict protocol explicitly forbids ${forbidden}`);
  }

  const card = createFactCardV1({
    sessionId: "s", draftId: "d", locale: "en", mediaEvidence: { mode: "video_cover", degradedMode: "none" },
    facts: [createFact({ id: "f", key: "visible_objects", value: "mug", source: "image_observed", trustLevel: "observed", category: "visual_description" })],
  });
  for (const type of ["video_motion", "video_audio", "video_temporal"] as const) {
    const report = validateCopy({
      title: "A harmless mug", description: "A blue mug.", altText: "Blue mug", factCard: card,
      claimDetection: { status: "completed", claims: [{ type, value: type === "video_audio" ? "歌っている" : "walking across the room", field: "description" }] },
    });
    assert.equal(report.valid, false, `${type} is rejected in generated/repair validation even across languages`);
  }

  console.log("AI Copy v2 video-cover hardening tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
