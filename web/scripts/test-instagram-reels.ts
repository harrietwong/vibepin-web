import assert from "node:assert/strict";
import { publishToInstagram, buildInstagramCaption } from "../src/lib/server/instagram/service";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; body: string }> = [];

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function run() {
  assert.equal(buildInstagramCaption("hello", "https://shop.invalid/p"), "hello", "Instagram captions must not append destination URLs");

  let pollCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (url.endsWith("/media")) return response({ id: "reel-container" });
    if (url.includes("reel-container?")) return response({ status_code: ++pollCount > 1 ? "FINISHED" : "IN_PROGRESS" });
    if (url.endsWith("/media_publish")) return response({ id: "published-reel" });
    if (url.includes("published-reel?")) return response({ permalink: "https://instagram.com/reel/p" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const result = await publishToInstagram({
    accessToken: "token", igUserId: "ig-1", videoUrl: "https://cdn.invalid/video.mp4", caption: "hello",
  });
  assert.equal(result.mediaId, "published-reel");
  assert.ok(calls.some(call => call.body.includes("media_type=REELS") && call.body.includes("video_url=https%3A%2F%2Fcdn.invalid%2Fvideo.mp4")));
  assert.equal(calls.filter(call => call.url.endsWith("/media_publish")).length, 1);
  for (const terminal of ["ERROR", "EXPIRED"] as const) {
    calls.length = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/media")) return response({ id: "terminal-container" });
      if (url.includes("terminal-container?")) return response({ status_code: terminal });
      throw new Error(`unexpected fetch ${url}`);
    };
    await assert.rejects(() => publishToInstagram({ accessToken: "token", igUserId: "ig-1", videoUrl: "https://cdn.invalid/video.mp4" }));
    assert.equal(calls.some(call => call.url.endsWith("/media_publish")), false, `${terminal} must not publish`);
  }
  globalThis.fetch = originalFetch;
}

run().then(() => console.log("test-instagram-reels: ok"), error => { globalThis.fetch = originalFetch; throw error; });
