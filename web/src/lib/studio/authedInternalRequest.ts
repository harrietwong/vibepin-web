"use client";

import { freshAccessToken, refreshSessionOnce } from "@/lib/supabaseBrowser";

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
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let response = await fetchImpl(input, withBearer(init, await freshAccessToken()));
  if (response.status !== 401) return response;

  const refreshed = await refreshSessionOnce();
  if (refreshed) response = await fetchImpl(input, withBearer(init, refreshed));
  return response;
}
