import assert from "node:assert/strict";

// Keep this script independently runnable: supabase clients initialize at import time.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";

async function main() {
  const { analyzeOwnedVideoCover } = await import("../src/lib/ai-copy/v2/videoCoverEvidence");
  const { createFact, createFactCardV1 } = await import("../src/lib/ai-copy/v2/factCard");
  const { validateCopy } = await import("../src/lib/ai-copy/v2/validateCopy");

  const providerInputs: string[] = [];
  const analyzed = await analyzeOwnedVideoCover({ userId: "user-1", draftId: "draft-1" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://video-bytes.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fuser-1%2Fposter.png" }] }),
    findProvenance: async () => ({ owner_user_id: "user-1", bucket_id: "generated-private", object_path: "studio/uploads/user-1/poster.png", source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
    fetchStorageObject: async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }),
    analyzePoster: async ({ dataUrl }) => {
      providerInputs.push(dataUrl);
      return { objects: ["mug"], colors: ["blue", "cream"], composition: "still_life", layout: "minimal" };
    },
  });
  assert.equal(analyzed.mode, "video_cover");
  assert.equal(analyzed.degradedMode, "none");
  assert.equal(providerInputs.length, 1, "only poster bytes reach vision");
  assert.ok(providerInputs[0].startsWith("data:image/png;base64,"));
  assert.ok(!providerInputs.join(" ").includes("video-bytes"), "video URL never reaches vision");
  assert.deepEqual(analyzed.imageObserved?.objects, ["mug"]);

  let providerCalled = false;
  const concealed = await analyzeOwnedVideoCover({ userId: "user-1", draftId: "draft-1" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://other-owner-video.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fother-owner%2Fposter.png" }] }),
    findProvenance: async () => { throw new Error("cross owner must not resolve provenance"); },
    fetchStorageObject: async () => { throw new Error("cross owner must not fetch"); },
    analyzePoster: async () => { providerCalled = true; throw new Error("must not run"); },
  });
  assert.equal(concealed.degradedMode, "video_cover_unavailable");
  assert.equal(concealed.imageObserved, undefined);
  assert.equal(providerCalled, false, "cross-owner poster is concealed before provider work");

  const isolatedInputs: string[] = [];
  const [firstRequest, secondRequest] = await Promise.all(["alpha", "bravo"].map(draftId => analyzeOwnedVideoCover({ userId: "user-1", draftId }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", posterUrl: `/api/storage-image?path=studio%2Fuploads%2Fuser-1%2F${draftId}.png` }] }),
    findProvenance: async () => ({ owner_user_id: "user-1", bucket_id: "generated-private", object_path: `studio/uploads/user-1/${draftId}.png`, source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
    fetchStorageObject: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    analyzePoster: async ({ dataUrl }) => {
      isolatedInputs.push(dataUrl);
      return { objects: [], colors: [], composition: "still_life", layout: "minimal" };
    },
  })));
  assert.equal(firstRequest.imageObserved?.summary, "still_life composition");
  assert.equal(secondRequest.imageObserved?.summary, "still_life composition");
  assert.equal(isolatedInputs.length, 2, "injected dependencies remain request-local under concurrency");

  const restricted = await analyzeOwnedVideoCover({ userId: "user-1", draftId: "draft-1" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fuser-1%2Fcover.png" }] }),
    findProvenance: async () => ({ owner_user_id: "user-1", bucket_id: "generated-private", object_path: "studio/uploads/user-1/cover.png", source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
    fetchStorageObject: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    analyzePoster: async () => ({ objects: ["Nike shoes", "person dancing", "mug"], colors: ["blue", "ultraviolet"], composition: "action scene", layout: "minimal" }),
  });
  assert.deepEqual(restricted.imageObserved?.objects, ["mug"], "only static taxonomy objects survive");
  assert.deepEqual(restricted.imageObserved?.colors, ["blue"], "only static taxonomy colors survive");
  assert.equal(restricted.imageObserved?.summary, "", "unallowlisted composition cannot become a fact");

  const coverCard = createFactCardV1({
    sessionId: "cover-session", draftId: "draft-1", locale: "en",
    mediaEvidence: { mode: "video_cover", degradedMode: "none" },
    facts: [createFact({ id: "cover-visible", key: "visible_objects", value: "blue mug", source: "image_observed", trustLevel: "observed", category: "visual_description" })],
  });
  assert.equal(coverCard.version, "fact-card-v2", "media evidence versions the serialized fact card");
  assert.equal(coverCard.facts[0].claimPolicy, "descriptive_only", "cover facts stay descriptive only");
  for (const [type, value] of [
    ["material", "silk"], ["brand", "Acme"], ["price", "$10"], ["availability", "in stock"],
    ["efficacy", "improves performance"], ["numeric_commercial", "50% more"],
    ["video_motion", "person walking"], ["video_audio", "歌っている"], ["video_temporal", "before and after"],
  ] as const) {
    const report = validateCopy({
      title: `Cover ${value}`, description: `The cover shows ${value}.`, altText: "Blue mug on a table", factCard: coverCard,
      claimDetection: { status: "completed", claims: [{ type, value, field: "title" }] },
    });
    assert.equal(report.valid, false, `${type} cannot be authorized by a cover observation`);
  }

  console.log("AI Copy v2 video-cover tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
