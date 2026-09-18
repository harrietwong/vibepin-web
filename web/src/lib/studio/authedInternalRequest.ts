"use client";

import { freshAccessToken, refreshSessionOnce } from "@/lib/supabaseBrowser";

export type InternalApiPath = `/api/${string}`;

function rejectInvalidRequest(): never {
  throw Object.assign(new Error("internal_api_request_invalid"), { code: "internal_api_request_invalid" });
}

function assertReplayableInternalRequest(input: unknown, init: RequestInit): asserts input is InternalApiPath {
  if (typeof input !== "string" || !input.startsWith("/api/") || input.startsWith("//")) rejectInvalidRequest();
  const body = init.body;
  if (body == null || typeof body === "string" || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return;
  rejectInvalidRequest();
}

function withBearer(init: RequestInit, token: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * Dispatch one same-origin app request with the shared browser session. A 401 gets
 * exactly one shared refresh-and-replay; signed Storage capability PUTs do not use
 * this helper because they remain queue-managed item failures.
 */
export async function authedInternalRequest(
  input: InternalApiPath,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertReplayableInternalRequest(input, init);
  const originalToken = await freshAccessToken();
  let response = await fetchImpl(input, withBearer(init, originalToken));
  if (response.status !== 401) return response;

  const currentToken = await freshAccessToken();
  const retryToken = currentToken && currentToken !== originalToken
    ? currentToken
    : await refreshSessionOnce();
  if (retryToken) response = await fetchImpl(input, withBearer(init, retryToken));
  return response;
}
