import assert from "node:assert/strict";
import { Module } from "node:module";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";

type ChatInput = { messages?: Array<{ role: string; content: unknown }>; costContext?: { userId?: string; referenceId?: string } };
const databaseOps: Array<[string, ...unknown[]]> = [];
const chatInputs: ChatInput[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/supabase" || request.endsWith("/lib/supabase")) {
    const chain = {
      select(value: string) { databaseOps.push(["select", value]); return this; },
      eq(key: string, value: unknown) { databaseOps.push(["eq", key, value]); return this; },
      is(key: string, value: unknown) { databaseOps.push(["is", key, value]); return this; },
      async maybeSingle() { return { data: { payload: { media: [{ kind: "video", url: "private://raw-video.mp4", posterUrl: "/api/storage-image?path=studio%2Fuploads%2Fowner%2Fcover.png" }] } }, error: null }; },
    };
    return { createServerClient: () => ({ from(table: string) { databaseOps.push(["from", table]); return chain; } }) };
  }
  if (request.includes("ai-copy/visionServer")) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return {
      ...actual,
      providerConfig: () => ({ key: "inert", baseUrl: "https://provider.invalid", provider: "openai", visionModel: "vision-test", textModel: "text-test" }),
      chatJson: async (input: ChatInput) => {
        chatInputs.push(input);
        return { objects: ["mug"], colors: ["blue"], composition: "still_life", layout: "centered" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { resolveOwnedMediaEvidence } = await import("../src/lib/ai-copy/v2/videoCoverEvidence");
  const result = await resolveOwnedMediaEvidence({ userId: "owner", draftId: "draft-1" }, {
    findProvenance: async (owner, bucket, path) => ({ owner_user_id: owner, bucket_id: bucket, object_path: path, source_type: "upload", intent_id: null, lifecycle_state: "ready" }),
    fetchStorageObject: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  });
  assert.equal(result.kind, "video", "owned persisted draft is classified as video");
  if (result.kind !== "video") throw new Error("video evidence required");
  assert.equal(result.analysis.degradedMode, "none");
  assert.deepEqual(databaseOps, [
    ["from", "pin_drafts"], ["select", "payload"], ["eq", "vibepin_user_id", "owner"], ["eq", "draft_id", "draft-1"], ["is", "deleted_at", null],
  ], "default draft loader scopes by owner, draft id, and non-deleted state");
  assert.equal(chatInputs.length, 1, "default provider boundary is invoked once");
  const call = chatInputs[0];
  assert.equal(call.costContext?.userId, "owner", "provider cost context has authenticated owner");
  assert.equal(call.costContext?.referenceId, "draft-1", "provider cost context has draft reference");
  const userMessage = call.messages?.find(message => message.role === "user")?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  const image = userMessage.find(item => item.type === "image_url")?.image_url?.url ?? "";
  const prompt = userMessage.find(item => item.type === "text")?.text ?? "";
  assert.match(image, /^data:image\/png;base64,/, "default provider receives only bounded poster bytes");
  assert.equal(image.includes("raw-video"), false, "raw video URL is absent from default provider payload");
  assert.match(prompt, /STATIC image only/, "default provider receives strict static-frame protocol");
  console.log("AI Copy v2 video-cover production-boundary tests passed");
}

main().catch(error => { console.error(error); process.exit(1); });
