"use client";

import {
  currentSessionIdentity,
  freshSessionIdentity,
  refreshSessionIdentityOnce,
  type BrowserSessionIdentity,
} from "@/lib/supabaseBrowser";

export type InternalApiPath = `/api/${string}`;

function rejectInvalidRequest(): never {
  throw Object.assign(new Error("internal_api_request_invalid"), { code: "internal_api_request_invalid" });
}

function rejectInvalidOwner(): never {
  throw Object.assign(new Error("internal_api_auth_owner_invalid"), { code: "internal_api_auth_owner_invalid" });
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

function isSameOwner(
  identity: BrowserSessionIdentity | null,
  ownerUserId: string,
): identity is BrowserSessionIdentity {
  return identity?.ownerUserId === ownerUserId;
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
  const requestIdentity = await currentSessionIdentity();
  if (!requestIdentity) rejectInvalidOwner();

  const originalIdentity = await freshSessionIdentity();
  if (!isSameOwner(originalIdentity, requestIdentity.ownerUserId)) rejectInvalidOwner();

  let response = await fetchImpl(input, withBearer(init, originalIdentity.accessToken));
  if (response.status !== 401) return response;

  const currentIdentity = await currentSessionIdentity();
  if (!isSameOwner(currentIdentity, requestIdentity.ownerUserId)) return response;

  let retryIdentity = currentIdentity;
  if (currentIdentity.accessToken === originalIdentity.accessToken) {
    const refreshedIdentity = await refreshSessionIdentityOnce();
    if (!isSameOwner(refreshedIdentity, requestIdentity.ownerUserId)) return response;
    const postRefreshIdentity = await currentSessionIdentity();
    if (!isSameOwner(postRefreshIdentity, requestIdentity.ownerUserId)) return response;
    retryIdentity = postRefreshIdentity;
  }

  response = await fetchImpl(input, withBearer(init, retryIdentity.accessToken));
  return response;
}
