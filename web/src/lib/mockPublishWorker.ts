/**
 * mockPublishWorker.ts
 *
 * Client-side Mock Worker for publish_jobs.
 * Simulates the Pinterest publishing lifecycle using setTimeout chains:
 *
 *   scheduled  →  pending (0 ms — immediate)
 *              →  sending (1 000 ms)
 *              →  published (3 000 ms) + random mock pinterest_pin_url written back
 *
 * Usage (from a React component):
 *   import { triggerMockWorker } from "@/lib/mockPublishWorker";
 *   await triggerMockWorker(jobId, supabaseSession.access_token);
 *
 * The worker updates the publish_jobs row directly through the browser Supabase
 * client (anon key). RLS policy allows each user to update their own rows.
 * Pass the user's access_token so Row Level Security resolves auth.uid().
 */

import { createBrowserClient } from "@supabase/ssr";
import type { PublishJobStatus } from "@/app/api/publish-jobs/route";

// ── Delays (ms) ───────────────────────────────────────────────────────────────
const DELAY_PENDING   =    0;   // immediate flip to pending
const DELAY_SENDING   = 1_000;  // 1 s  — simulates API call in flight
const DELAY_PUBLISHED = 3_000;  // 3 s  — simulates Pinterest server response

// ── Mock Pinterest URL generator ──────────────────────────────────────────────

function mockPinterestUrl(): string {
  const pinId = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;
  return `https://www.pinterest.com/pin/${pinId}/`;
}

// ── Internal state updater ────────────────────────────────────────────────────

async function setJobStatus(
  db: ReturnType<typeof createBrowserClient>,
  jobId: string,
  status: PublishJobStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from("publish_jobs")
    .update({ status, ...extra })
    .eq("id", jobId);

  if (error) {
    console.error(`[mockWorker] Failed to set status=${status} for job ${jobId}:`, error.message);
    throw new Error(error.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export type MockWorkerResult =
  | { ok: true;  pinterest_pin_url: string }
  | { ok: false; error: string };

/**
 * triggerMockWorker
 *
 * Starts the mock publishing simulation for a single `publish_jobs` row.
 * Returns a Promise that resolves when the job reaches `published` (or `failed`).
 *
 * @param jobId       UUID of the publish_jobs row (status must be 'scheduled')
 * @param accessToken Supabase session access_token for RLS auth
 * @param onStatusChange Optional callback invoked at each status transition
 */
export async function triggerMockWorker(
  jobId: string,
  accessToken: string,
  onStatusChange?: (status: PublishJobStatus) => void,
): Promise<MockWorkerResult> {
  const db = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        // Attach the user's access token so RLS resolves auth.uid() correctly
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  );

  const delay = (ms: number) =>
    new Promise<void>(resolve => setTimeout(resolve, ms));

  try {
    // ── Step 1: pending (immediate) ──────────────────────────────────────────
    await delay(DELAY_PENDING);
    await setJobStatus(db, jobId, "pending");
    onStatusChange?.("pending");

    // ── Step 2: sending ──────────────────────────────────────────────────────
    await delay(DELAY_SENDING);
    await setJobStatus(db, jobId, "sending");
    onStatusChange?.("sending");

    // ── Step 3: published + mock URL write-back ──────────────────────────────
    await delay(DELAY_PUBLISHED);
    const pinUrl = mockPinterestUrl();
    await setJobStatus(db, jobId, "published", {
      pinterest_pin_url: pinUrl,
      published_at:      new Date().toISOString(),
    });
    onStatusChange?.("published");

    return { ok: true, pinterest_pin_url: pinUrl };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Attempt to mark job as failed
    try {
      await setJobStatus(db, jobId, "failed", { error_message: message });
      onStatusChange?.("failed");
    } catch {
      // Ignore secondary failure — original error is what matters
    }
    return { ok: false, error: message };
  }
}

/**
 * triggerMockWorkerBatch
 *
 * Convenience wrapper: triggers multiple jobs concurrently with a configurable
 * stagger delay so simulated posts appear spread out over time.
 *
 * @param jobIds       Array of publish_jobs UUIDs
 * @param accessToken  Supabase session access_token
 * @param staggerMs    Milliseconds between job starts (default 800 ms)
 * @param onJobChange  Called when any individual job changes status
 */
export async function triggerMockWorkerBatch(
  jobIds: string[],
  accessToken: string,
  staggerMs = 800,
  onJobChange?: (jobId: string, status: PublishJobStatus) => void,
): Promise<MockWorkerResult[]> {
  const results: MockWorkerResult[] = [];

  for (let i = 0; i < jobIds.length; i++) {
    const jobId = jobIds[i];
    if (i > 0) {
      await new Promise<void>(r => setTimeout(r, staggerMs));
    }
    // Start each job concurrently (don't await inside loop)
    triggerMockWorker(jobId, accessToken, status => onJobChange?.(jobId, status))
      .then(r => results.push(r));
  }

  // Wait for all concurrent jobs to finish
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (results.length === jobIds.length) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });

  return results;
}
