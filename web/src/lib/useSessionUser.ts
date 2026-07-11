"use client";

import useSWR from "swr";
import { createBrowserClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";

function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

export const SESSION_USER_SWR_KEY = "auth:session-user";

async function fetchSessionUser(): Promise<User | null> {
  // This hook drives app-shell and Plan-page rendering. `getUser()` performs a
  // Supabase Auth network verification round trip and was adding 2-4s before
  // Plan could even start loading its rows. For client-side UI gating we only
  // need the current cookie-backed session; protected writes/routes still verify
  // auth server-side before doing privileged work.
  const { data } = await createClient().auth.getSession();
  return data.session?.user ?? null;
}

/**
 * Shared, SWR-cached lookup of the current Supabase auth user. Every consumer
 * (app shell, useWeeklyPlan, ...) reads the same cache entry keyed by
 * SESSION_USER_SWR_KEY, so only the first caller in a session pays for the
 * `auth.getUser()` round trip — later callers (e.g. navigating to a page that
 * calls this after the app shell already resolved it) get the cached result
 * synchronously instead of firing a second network request.
 */
export function useSessionUser() {
  const { data, isLoading } = useSWR<User | null>(SESSION_USER_SWR_KEY, fetchSessionUser, {
    revalidateOnFocus: false,
  });
  return { user: data ?? null, loading: isLoading };
}
