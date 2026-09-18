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

async function finishesWithin<T>(promise: Promise<T>, milliseconds = 50): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`adapter remained pending beyond ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  await test("cover time milliseconds become precise Pinterest seconds; invalid times never dispatch", async () => {
    for (const [time, seconds] of [[undefined, 1], [0, 0], [1000, 1], [1250.5, 1.2505], [4000, 4]]) {
      const { deps, calls } = dependencies([
        response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
        new Response(null, { status: 204 }), response({ status: "succeeded" }), response({ id: "pin-1" }, 201),
      ]);
      const result = await publishPinterestVideo(input({ coverFrameTimeMs: time, durationMs: 4000 }), deps);
      assert.equal(result.outcome, "succeeded");
      const payload = JSON.parse(String(calls.at(-1)!.init.body));
      assert.equal(payload.media_source.cover_image_key_frame_time, seconds);
    }
    for (const time of [-1, NaN, Infinity, 4001, "1000"]) {
      const { deps, calls } = dependencies([]);
      const result = await publishPinterestVideo(input({ coverFrameTimeMs: time, durationMs: 4000 }), deps);
      assert.equal(result.evidence.classification, "definite_validation");
      assert.equal(calls.length, 0);
    }
  });
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

  await test("preserves every returned multipart parameter including an own __proto__ key", async () => {
    const uploadParameters = JSON.parse('{"__proto__":"provider-value","key":"k"}') as Record<string, string>;
    const { deps, calls } = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: uploadParameters }),
      new Response(null, { status: 204 }),
      response({ status: "succeeded" }),
      response({ id: "pin-1" }, 201),
    ]);
    await publishPinterestVideo(input(), deps);
    const entries = Array.from((calls[1].init.body as FormData).entries());
    assert.deepEqual(entries.map(([key]) => key), ["__proto__", "key", "file"]);
    assert.equal(entries[0][1], "provider-value");
  });

  await test("requires 204 from the unauthenticated multipart upload", async () => {
    const { deps } = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response("accepted", { status: 202 }),
    ]);
    const result = await publishPinterestVideo(input(), deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "uploaded", classification: "unknown", mediaId: "media-1", providerStatus: 202 } });
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

  await test("filters a malformed registration RID that echoes an otherwise-valid upload parameter", async () => {
    const secret = "upload-secret-456"; // scan-secrets: allow — deliberate fake used to assert redaction
    const source = dependencies([
      response({ upload_url: "https://upload.example.test/form", upload_parameters: { policy: secret, invalid: 7 } }, 200, { "x-pinterest-rid": secret }),
    ]);
    const result = await publishPinterestVideo(input(), source.deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "registered", classification: "unknown" } });
    assert.equal(source.calls.length, 1);
    assert.ok(!JSON.stringify(result).includes(secret));
  });

  await test("definitely rejects provider 4xx and explicit failed poll states", async () => {
    const register4xx = dependencies([response({ secret: "provider body" }, 401)]);
    const rejected = await publishPinterestVideo(input(), register4xx.deps);
    assert.deepEqual(rejected, { outcome: "failed", evidence: { stage: "registered", classification: "definite_rejection", providerStatus: 401 } });
    assert.ok(!JSON.stringify(rejected).includes("provider body"));

    const explicitFailure = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "failed", diagnostic: "do not leak" }),
    ]);
    const failedPoll = await publishPinterestVideo(input(), explicitFailure.deps);
    assert.deepEqual(failedPoll, { outcome: "failed", evidence: { stage: "polled", classification: "definite_rejection", mediaId: "media-1", providerStatus: 200 } });
    assert.ok(!JSON.stringify(failedPoll).includes("diagnostic"));
  });

  await test("preserves redacted provider status evidence and stable codes for 4xx failures", async () => {
    const register = dependencies([
      response({ code: "bad.media", message: "do not persist", token: TOKEN }, 400, { "x-request-id": "req-register" }),
    ]);
    assert.deepEqual(await publishPinterestVideo(input(), register.deps), {
      outcome: "failed",
      evidence: {
        stage: "registered",
        classification: "definite_rejection",
        providerStatus: 400,
        providerCode: "bad.media",
        requestId: "req-register",
      },
    });

    const poll = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ code: 422, message: "do not persist", upload_url: "https://private.invalid" }, 422, { "x-pinterest-rid": "req-poll" }),
    ]);
    assert.deepEqual(await publishPinterestVideo(input(), poll.deps), {
      outcome: "failed",
      evidence: {
        stage: "polled",
        classification: "definite_rejection",
        mediaId: "media-1",
        providerStatus: 422,
        providerCode: "422",
        requestId: "req-poll",
      },
    });

    const create = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "succeeded" }),
      response({ code: "board.invalid", message: "do not persist", access_token: TOKEN }, 400, { "x-request-id": "req-create" }),
    ]);
    assert.deepEqual(await publishPinterestVideo(input(), create.deps), {
      outcome: "failed",
      evidence: {
        stage: "created",
        classification: "definite_rejection",
        mediaId: "media-1",
        providerStatus: 400,
        providerCode: "board.invalid",
        requestId: "req-create",
      },
    });

    const failedPoll = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "failed", code: "processing.failed", message: "do not persist", body: { secret: "do not persist" } }, 200, { "x-request-id": "req-failed" }),
    ]);
    const failed = await publishPinterestVideo(input(), failedPoll.deps);
    assert.deepEqual(failed, {
      outcome: "failed",
      evidence: {
        stage: "polled",
        classification: "definite_rejection",
        mediaId: "media-1",
        providerStatus: 200,
        providerCode: "processing.failed",
        requestId: "req-failed",
      },
    });
    const serialized = JSON.stringify({ register: await publishPinterestVideo(input(), dependencies([
      response({ code: "unsafe.code", message: "secret-message", raw: TOKEN }, 400),
    ]).deps), failed });
    for (const forbidden of ["secret-message", TOKEN, "private.invalid", "upload_url", "raw"]) {
      assert.ok(!serialized.includes(forbidden), `provider evidence leaked ${forbidden}`);
    }
  });

  await test("network, provider 5xx, and poll deadline are unknown rather than safe-to-retry failures", async () => {
    const network = dependencies([new Error("socket hang up")]);
    assert.deepEqual(await publishPinterestVideo(input(), network.deps), {
      outcome: "unknown", evidence: { stage: "registered", classification: "unknown" },
    });

    const serverError = dependencies([response({ message: "untrusted provider detail" }, 503)]);
    assert.deepEqual(await publishPinterestVideo(input(), serverError.deps), {
      outcome: "unknown", evidence: { stage: "registered", classification: "unknown", providerStatus: 503 },
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

  await test("bounds a never-resolving polling fetch to the remaining deadline and aborts it", async () => {
    let pollSignal: AbortSignal | undefined;
    const { deps } = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
    ], [0, 0, 0]);
    deps.pollDeadlineMs = 5;
    deps.fetch = async (url, init = {}) => {
      if (String(url).endsWith("/media/media-1")) {
        pollSignal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      throw new Error("test setup expected helper fetches only");
    };
    // Keep register/upload deterministic while making only the polling boundary stall.
    const original = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
    ], [0, 0, 0]);
    let call = 0;
    deps.fetch = async (url, init = {}) => {
      call++;
      if (call <= 2) return original.deps.fetch(url, init);
      pollSignal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    const result = await finishesWithin(publishPinterestVideo(input(), deps));
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "polled", classification: "unknown", mediaId: "media-1" } });
    assert.ok(pollSignal?.aborted, "deadline must abort a still-running poll request when AbortSignal is supported");
  });

  await test("bounds a stalled polling response body to the remaining deadline", async () => {
    let originalPollSignal: AbortSignal | undefined;
    const stalledBody = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => new Promise<unknown>(() => {}),
    } as unknown as Response;
    const source = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      stalledBody,
    ], [0, 0, 0]);
    source.deps.pollDeadlineMs = 5;
    const fetch = source.deps.fetch;
    source.deps.fetch = async (url, init = {}) => {
      if (String(url).endsWith("/media/media-1")) originalPollSignal = init.signal ?? undefined;
      return fetch(url, init);
    };
    const result = await finishesWithin(publishPinterestVideo(input(), source.deps));
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "polled", classification: "unknown", mediaId: "media-1" } });
    assert.ok(originalPollSignal?.aborted, "a stalled response body must abort the controller originally attached to fetch");
  });

  await test("rechecks the deadline after a successful polling body before creating a Pin", async () => {
    let clock = 0;
    const lateSuccess = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        clock = 11;
        return { status: "succeeded" };
      },
    } as unknown as Response;
    const source = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      lateSuccess,
      response({ id: "must-not-create" }, 201),
    ]);
    source.deps.now = () => clock;
    source.deps.pollDeadlineMs = 10;
    const result = await publishPinterestVideo(input(), source.deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "polled", classification: "unknown", mediaId: "media-1" } });
    assert.equal(source.calls.length, 3, "an expired successful poll must never dispatch /pins");
  });

  await test("caps a polling sleep to the remaining deadline when its interval is longer", async () => {
    const source = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
      new Response(null, { status: 204 }),
      response({ status: "processing" }),
    ], [0, 0, 0, 0, 0, 5]);
    source.deps.pollDeadlineMs = 5;
    source.deps.pollIntervalMs = 100;
    const result = await publishPinterestVideo(input(), source.deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "polled", classification: "unknown", mediaId: "media-1" } });
    assert.deepEqual(source.sleeps, [5], "sleep must not consume more than the remaining polling budget");
  });

  await test("fails malformed input before dispatch and never leaks secret input or provider credentials", async () => {
    const invalid = dependencies([]);
    const result = await publishPinterestVideo(input({ boardId: "", accessToken: "super-secret-token" }), invalid.deps); // scan-secrets: allow — deliberate fake used to assert redaction
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
      outcome: "unknown", evidence: { stage: "created", classification: "unknown", mediaId: "media-1", providerStatus: 200 },
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
      response({ error: "provider response must remain private", access_token: "never-return" }, 503), // scan-secrets: allow — deliberate fake used to assert redaction
    ]);
    const result = await publishPinterestVideo(input(), create5xx.deps);
    assert.deepEqual(result, {
      outcome: "unknown", evidence: { stage: "created", classification: "unknown", mediaId: "media-1", providerStatus: 503 },
    });
    assert.ok(!JSON.stringify(result).includes("never-return"));
  });

  await test("filters echoed tokens and registration secrets from every final evidence field", async () => {
    const token = "secret-token-123";
    const registerRejection = dependencies([response({}, 401, { "x-pinterest-rid": token })]);
    const rejected = await publishPinterestVideo(input({ accessToken: token }), registerRejection.deps);
    assert.deepEqual(rejected, { outcome: "failed", evidence: { stage: "registered", classification: "definite_rejection", providerStatus: 401 } });

    const echoed = dependencies([
      response({ media_id: "media-1", upload_url: "https://upload.example.test/form", upload_parameters: { policy: "upload-secret-456" } }),
      new Response(null, { status: 204 }),
      response({ status: "succeeded" }),
      response({ id: "upload-secret-456", url: "https://www.pinterest.com/pin/upload-secret-456/" }, 201, { "x-request-id": token }),
    ]);
    const result = await publishPinterestVideo(input({ accessToken: token }), echoed.deps);
    assert.deepEqual(result, {
      outcome: "succeeded",
      evidence: { stage: "created", classification: "succeeded", mediaId: "media-1" },
    });
    const receipt = JSON.stringify(result);
    for (const secret of [token, "upload-secret-456", "upload.example.test/form"]) {
      assert.ok(!receipt.includes(secret), `final evidence leaked ${secret}`);
    }
  });

  await test("does not dispatch a media identifier that echoes an access token", async () => {
    const token = "secret-token-123";
    const source = dependencies([
      response({ media_id: token, upload_url: "https://upload.example.test/form", upload_parameters: { key: "a" } }),
    ]);
    const result = await publishPinterestVideo(input({ accessToken: token }), source.deps);
    assert.deepEqual(result, { outcome: "unknown", evidence: { stage: "registered", classification: "unknown" } });
    assert.equal(source.calls.length, 1, "a credential-shaped media id must not be sent back to provider paths");
    assert.ok(!JSON.stringify(result).includes(token));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
