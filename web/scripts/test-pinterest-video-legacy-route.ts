import assert from "node:assert/strict";
import Module from "node:module";

const uid = "11111111-1111-4111-8111-111111111111";
const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const destinationId = `pinterest:${connectionId}`;
let legacyProviderCalls = 0;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-key";
const moduleLoader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (id: string, ...args: unknown[]) {
  if (id === "@/lib/server/authUser") return { getUserIdFromBearerOrCookies: async () => uid };
  if (id === "@/lib/supabase") return { createServerClient: () => { throw new Error("durable DB must not run"); } };
  if (id === "@/lib/server/pinterest/publishPin") return {
    publishPinForUser: async () => { legacyProviderCalls += 1; throw new Error("legacy provider must not run"); },
  };
  return originalLoad.call(this, id, ...args);
};

async function main() {
  const { buildPublishConfirmation, confirmPublishSnapshot } = await import("../src/lib/studio/publishConfirmation");
  const media = [
    { id: "video-1", kind: "video" as const, source: "upload" as const, url: `/api/storage-media?path=${uid}%2Fuploads%2Fvideo.mp4`, durationMs: 8_000 },
    { id: "image-1", kind: "image" as const, source: "upload" as const, url: "https://images.example.test/pin.jpg" },
  ];
  const snapshot = buildPublishConfirmation({
    id: "legacy-bypass",
    contentId: "legacy-bypass",
    updatedAt: new Date().toISOString(),
    title: "Mixed media",
    description: "",
    altText: "",
    destinationUrl: "",
    media,
    imageUrl: media[0].url,
    scheduledDestinations: [{ provider: "pinterest", socialConnectionId: connectionId, boardId: "board-1" }],
  } as never, { mode: { kind: "now" }, actionId: "routebypass0001" });
  const confirmation = confirmPublishSnapshot(snapshot);
  const { POST } = await import("../src/app/api/pinterest/pins/route");
  const response = await POST(new Request("https://vibepin.invalid/api/pinterest/pins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draftId: "legacy-bypass",
      boardId: "board-1",
      connectionId,
      destinationId,
      title: "Mixed media",
      imageUrls: media.map(item => item.url),
      confirmation,
    }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "materialization_required");
  assert.equal(legacyProviderCalls, 0);
  console.log("OK actual POST route rejects video/mixed legacy bypass before provider");

  // The same frozen receipt must be rejected by the feature kill switch before any
  // durable DB/storage/provider work, even if an older client reaches this route.
  process.env.VIDEO_PIN_UPLOAD_ENABLED = "false";
  const disabledSnapshot = buildPublishConfirmation({
    id: "video-disabled",
    contentId: "video-disabled",
    updatedAt: new Date().toISOString(),
    title: "Video Pin",
    description: "",
    altText: "",
    destinationUrl: "",
    media: [media[0]],
    imageUrl: media[0].url,
    scheduledDestinations: [{ provider: "pinterest", socialConnectionId: connectionId, boardId: "board-1" }],
  } as never, { mode: { kind: "now" }, actionId: "videodisabled01" });
  const disabled = await POST(new Request("https://vibepin.invalid/api/pinterest/pins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      draftId: "video-disabled", boardId: "board-1", connectionId, destinationId,
      title: "Video Pin", imageUrls: [media[0].url], confirmation: confirmPublishSnapshot(disabledSnapshot),
    }),
  }));
  assert.equal(disabled.status, 404);
  assert.equal((await disabled.json()).code, "video_upload_disabled");
  assert.equal(legacyProviderCalls, 0);
  console.log("OK immediate video publishing kill switch blocks before durable work");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  moduleLoader._load = originalLoad;
});
