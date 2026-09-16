/**
 * Contract tests for the injectable Pinterest video adapter.
 *
 * Every provider interaction is a local fetch mock; this script never contacts
 * Pinterest, a database, or Storage.
 */

import assert from "node:assert/strict";
import { publishPinterestVideo, type PinterestVideoAdapterDependencies } from "../src/lib/server/pinterest/videoPinAdapter";

const TOKEN = "access-token-that-must-never-escape";
const BASE = "https://api.pinterest.test/v5";

type Call = { url: string; init: RequestInit };

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function dependencies(responses: Array<Response | Error>, nowValues: number[] = [0, 1, 2, 3]): {
  deps: PinterestVideoAdapterDependencies;
  calls: Call[];
  sleeps: number[];
} {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let nowIndex = 0;
  return {
    calls,
    sleeps,
    deps: {
      apiBase: BASE,
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const next = responses.shift();
        if (!next) throw new Error("unexpected fetch");
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
      pollIntervalMs: 10,
      pollDeadlineMs: 100,
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: TOKEN,
    accountId: "account-1",
    boardId: "board-1",
    title: "Video Pin",
    description: "A strictly mocked video publish",
    link: "https://shop.test/item",
    altText: "Short looping demo",
    file: new Blob(["video-bytes"], { type: "video/mp4" }),
    fileName: "demo.mp4",
    ...overrides,
  };
}

function auth(init: RequestInit): string | null {
  return new Headers(init.headers).get("authorization");
}

async function json(init: RequestInit): Promise<unknown> {
  return JSON.parse(String(init.body));
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

async function main(): Promise<void> {
  await test("registers video with exact Bearer request, uploads fields then file, polls, and creates exact video Pin", async () => {
    const { deps, calls, sleeps } = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "uploads/a", policy: "p" } }, 200, { "x-pinterest-rid": "register-rid" }),
      new Response(null, { status: 204 }),
      response({ status: "registered" }, 200),
      response({ status: "processing" }, 200),
      response({ status: "succeeded" }, 200),
      response({ id: "pin-1", url: "https://www.pinterest.com/pin/pin-1/" }, 201, { "x-request-id": "create-rid" }),
    ]);

    const result = await publishPinterestVideo(input(), deps);

    assert.deepEqual(result, {
      outcome: "succeeded",
      evidence: {
        stage: "created",
        classification: "succeeded",
        mediaId: "media-1",
        pinId: "pin-1",
        pinUrl: "https://www.pinterest.com/pin/pin-1/",
        requestId: "create-rid",
      },
    });
    assert.equal(calls.length, 6);
    assert.equal(calls[0].url, `${BASE}/media`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(auth(calls[0].init), `Bearer ${TOKEN}`);
    assert.deepEqual(await json(calls[0].init), { media_type: "video" });

    assert.equal(calls[1].url, "https://upload.example.test/form");
    assert.equal(auth(calls[1].init), null, "presigned upload must never inherit Pinterest authorization");
    assert.ok(calls[1].init.body instanceof FormData);
    const entries = Array.from((calls[1].init.body as FormData).entries());
    assert.deepEqual(entries.map(([key]) => key), ["key", "policy", "file"], "provider fields preserve insertion order and file is last");
    assert.equal(entries[0][1], "uploads/a");
    assert.equal(entries[1][1], "p");
    assert.ok(entries[2][1] instanceof Blob, "last multipart part is the video file");

    for (const call of calls.slice(2)) assert.equal(auth(call.init), `Bearer ${TOKEN}`, "one token must authenticate poll and create");
    assert.deepEqual(sleeps, [10, 10]);
    assert.equal(calls[5].url, `${BASE}/pins`);
    assert.equal(calls[5].init.method, "POST");
    assert.deepEqual(await json(calls[5].init), {
      board_id: "board-1",
      title: "Video Pin",
      description: "A strictly mocked video publish",
      link: "https://shop.test/item",
      alt_text: "Short looping demo",
      media_source: { source_type: "video_id", media_id: "media-1", cover_image_key_frame_time: 1 },
    });
    assert.ok(!String(calls[5].init.body).includes("cover_image_url"));
  });

  await test("requires 204 from the unauthenticated multipart upload", async () => {
    const { deps } = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response("accepted", { status: 202 }),
    ]);
    const result = await publishPinterestVideo(input(), deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "uploaded", classification: "unknown", mediaId: "media-1" } });
  });

  await test("treats malformed registration as unknown and redacts presigned URL and upload parameters", async () => {
    const { deps, calls } = dependencies([
      response({
        media_id: "media-1",
        upload_url: "https://upload.example.test/very-private-form",
        upload_parameters: { key: 7, policy: "super-private-policy" },
      }),
    ]);
    const result = await publishPinterestVideo(input(), deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "registered", classification: "unknown" } });
    assert.equal(calls.length, 1, "malformed registration must not attempt an upload");
    const receipt = JSON.stringify(result);
    for (const forbidden of ["very-private-form", "upload_parameters", "super-private-policy", "media-1"]) {
      assert.ok(!receipt.includes(forbidden), `receipt leaked ${forbidden}`);
    }
  });

  await test("definitely rejects provider 4xx and explicit failed poll states", async () => {
    const register4xx = dependencies([response({ secret: "provider body" }, 401)]);
    const rejected = await publishPinterestVideo(input(), register4xx.deps);
    assert.deepEqual(rejected, { outcome: "failed", evidence: { stage: "registered", classification: "definite_rejection" } });
    assert.ok(!JSON.stringify(rejected).includes("provider body"));

    const explicitFailure = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "failed", diagnostic: "do not leak" }),
    ]);
    const failedPoll = await publishPinterestVideo(input(), explicitFailure.deps);
    assert.deepEqual(failedPoll, { outcome: "failed", evidence: { stage: "polled", classification: "definite_rejection", mediaId: "media-1" } });
    assert.ok(!JSON.stringify(failedPoll).includes("diagnostic"));
  });

  await test("network, provider 5xx, and poll deadline are unknown rather than safe-to-retry failures", async () => {
    const network = dependencies([new Error("socket hang up")]);
    assert.deepEqual(await publishPinterestVideo(input(), network.deps), {
      outcome: "unknown", evidence: { stage: "registered", classification: "unknown" },
    });

    const serverError = dependencies([response({ message: "untrusted provider detail" }, 503)]);
    assert.deepEqual(await publishPinterestVideo(input(), serverError.deps), {
      outcome: "unknown", evidence: { stage: "registered", classification: "unknown" },
    });

    const deadline = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "processing" }),
    ], [0, 1, 101]);
    assert.deepEqual(await publishPinterestVideo(input(), deadline.deps), {
      outcome: "unknown", evidence: { stage: "polled", classification: "unknown", mediaId: "media-1" },
    });
  });

  await test("fails malformed input before dispatch and never leaks secret input or provider credentials", async () => {
    const invalid = dependencies([]);
    const result = await publishPinterestVideo(input({ boardId: "", accessToken: "super-secret-token" }), invalid.deps);
    assert.deepEqual(result, { outcome: "failed", evidence: { stage: "validated", classification: "definite_validation" } });
    assert.equal(invalid.calls.length, 0, "pre-dispatch validation must not call the provider");
    const text = JSON.stringify(result);
    for (const forbidden of ["super-secret-token", "upload_parameters", "upload_url", "video-bytes"]) assert.ok(!text.includes(forbidden));
  });

  await test("does not produce a success result without a 201 Pin response", async () => {
    const { deps } = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "succeeded" }),
      response({ id: "pin-1" }, 200),
    ]);
    assert.deepEqual(await publishPinterestVideo(input(), deps), {
      outcome: "unknown", evidence: { stage: "created", classification: "unknown", mediaId: "media-1" },
    });
  });

  await test("create network and 5xx outcomes stay unknown and do not echo provider bodies", async () => {
    const createNetwork = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "succeeded" }),
      new Error("connection reset after dispatch"),
    ]);
    assert.deepEqual(await publishPinterestVideo(input(), createNetwork.deps), {
      outcome: "unknown", evidence: { stage: "created", classification: "unknown", mediaId: "media-1" },
    });

    const create5xx = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "succeeded" }),
      response({ error: "provider response must remain private", access_token: "never-return" }, 503),
    ]);
    const result = await publishPinterestVideo(input(), create5xx.deps);
    assert.deepEqual(result, {
      outcome: "unknown", evidence: { stage: "created", classification: "unknown", mediaId: "media-1" },
    });
    assert.ok(!JSON.stringify(result).includes("never-return"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
