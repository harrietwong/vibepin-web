import assert from "node:assert/strict";
import { analyzeOwnedVideoCover } from "../src/lib/ai-copy/v2/videoCoverEvidence";
import { createFact, createFactCardV1 } from "../src/lib/ai-copy/v2/factCard";
import { validateCopy } from "../src/lib/ai-copy/v2/validateCopy";

async function main() {
  const providerInputs: string[] = [];
  const analyzed = await analyzeOwnedVideoCover({ userId: "user-1", draftId: "draft-1" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://video-bytes.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fuser-1%2Fposter.png" }] }),
    resolveOwnedPoster: async () => ({ dataUrl: "data:image/png;base64,POSTER" }),
    analyzePoster: async ({ dataUrl }) => {
      providerInputs.push(dataUrl);
      return { imageSummary: "A blue ceramic mug on a cream table", visibleObjects: ["mug"], colors: ["blue", "cream"], style: "minimal", ocrText: "", category: "decor" };
    },
  });
  assert.equal(analyzed.mode, "video_cover");
  assert.equal(analyzed.degradedMode, "none");
  assert.deepEqual(providerInputs, ["data:image/png;base64,POSTER"], "only poster bytes reach vision");
  assert.ok(!providerInputs.join(" ").includes("video-bytes"), "video URL never reaches vision");
  assert.deepEqual(analyzed.imageObserved?.objects, ["mug"]);

  let providerCalled = false;
  const concealed = await analyzeOwnedVideoCover({ userId: "user-1", draftId: "draft-1" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://other-owner-video.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fother-owner%2Fposter.png" }] }),
    resolveOwnedPoster: async () => null,
    analyzePoster: async () => { providerCalled = true; throw new Error("must not run"); },
  });
  assert.equal(concealed.degradedMode, "video_cover_unavailable");
  assert.equal(concealed.imageObserved, undefined);
  assert.equal(providerCalled, false, "cross-owner poster is concealed before provider work");

  const isolatedInputs: string[] = [];
  const [firstRequest, secondRequest] = await Promise.all(["alpha", "bravo"].map(draftId => analyzeOwnedVideoCover({ userId: "user-1", draftId }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: `private://${draftId}.mp4`, posterUrl: `/api/storage-image?path=studio%2Fuploads%2Fuser-1%2F${draftId}.png` }] }),
    resolveOwnedPoster: async () => ({ dataUrl: `data:image/png;base64,${draftId}` }),
    analyzePoster: async ({ dataUrl }) => {
      isolatedInputs.push(dataUrl);
      return { imageSummary: draftId, visibleObjects: [], colors: [], style: "", ocrText: "", category: "decor" };
    },
  })));
  assert.equal(firstRequest.imageObserved?.summary, "alpha");
  assert.equal(secondRequest.imageObserved?.summary, "bravo");
  assert.deepEqual(isolatedInputs.sort(), ["data:image/png;base64,alpha", "data:image/png;base64,bravo"], "injected dependencies are request-local");

  const forbidden = await analyzeOwnedVideoCover({ userId: "user-1", draftId: "draft-1" }, {
    loadOwnedDraft: async () => ({ media: [{ kind: "video", url: "private://video.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fuser-1%2Fcover.png" }] }),
    resolveOwnedPoster: async () => ({ dataUrl: "data:image/png;base64,COVER" }),
    analyzePoster: async () => ({ imageSummary: "A moving silk mug costs $10", visibleObjects: ["person dancing", "mug"], colors: ["blue"], style: "high performance", ocrText: "in stock", category: "decor" }),
  });
  assert.equal(forbidden.imageObserved?.summary, "", "motion/material/price inference is removed from a cover summary");
  assert.deepEqual(forbidden.imageObserved?.objects, ["mug"], "action inference is removed while literal objects remain");
  assert.deepEqual(forbidden.imageObserved?.colors, ["blue"], "neutral visual facts remain usable");
  assert.equal(forbidden.imageObserved?.style, "", "performance inference is removed");
  assert.deepEqual(forbidden.imageObserved?.ocrText, [], "commercial availability text is not a cover fact");

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
