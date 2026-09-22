import assert from "node:assert/strict";
import { fetchRecentInstagramMedia } from "../src/lib/server/instagram/service";

const originalFetch = globalThis.fetch;

async function main(): Promise<void> {
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      data: [
        {
          id: "ig-new",
          permalink: "https://www.instagram.com/reel/new/",
          caption: "New reel caption",
          timestamp: "2026-09-22T05:50:00+0000",
          media_type: "VIDEO",
        },
        {
          id: "ig-old",
          permalink: "https://www.instagram.com/reel/old/",
          caption: "Old reel caption",
          timestamp: "2026-09-22T05:00:00+0000",
          media_type: "VIDEO",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await fetchRecentInstagramMedia({
      accessToken: "private-token",
      igUserId: "17841478940147145",
      since: "2026-09-22T05:40:00.000Z",
      limit: 25,
    });

    assert.deepEqual(result, [{
      id: "ig-new",
      permalink: "https://www.instagram.com/reel/new/",
      caption: "New reel caption",
      timestamp: "2026-09-22T05:50:00+0000",
      mediaType: "VIDEO",
    }]);
    assert.equal(requestedUrl.includes("fields=id%2Cpermalink%2Ccaption%2Ctimestamp%2Cmedia_type"), true);
    assert.equal(requestedUrl.includes("limit=25"), true);
    assert.equal(JSON.stringify(result).includes("private-token"), false);
    console.log("Instagram recent media: 1 passed, 0 failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
