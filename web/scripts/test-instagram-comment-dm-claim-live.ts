/**
 * LIVE concurrency proof for the Instagram comment → DM claim, against the TEST
 * Supabase project ONLY (never production).
 *
 * Run (env comes from web/.env.test.local; nothing is read from .env.local):
 *   TEST_SUPABASE_URL=… TEST_SUPABASE_SERVICE_ROLE_KEY=… TEST_SUPABASE_PROJECT_REF=snulmwprsahzqvdbyenc \
 *     npx tsx scripts/test-instagram-comment-dm-claim-live.ts
 *
 * What it proves: N parallel `claimCommentEvent` calls for the same
 * (connection_id, comment_id) against the REAL v83 unique constraint return exactly
 * one row id — the same code path the cron uses, so two overlapping polling runs
 * can send at most one DM.
 *
 * Data hygiene: creates ONE social_connections row labelled with an @example.test
 * username (random user_id, provider=instagram, not_connected, no token) and the
 * event rows it claims; afterwards deletes exactly those ids and nothing else.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { claimCommentEvent, EVENTS_TABLE } from "../src/lib/server/instagram/commentDmRun";

const PRODUCTION_REF = "jaxteelkecvlozdrdoog";
const PARALLEL = 8;
const ROUNDS = 5;

async function main(): Promise<void> {
  const url = process.env.TEST_SUPABASE_URL ?? "";
  const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
  const expectedRef = process.env.TEST_SUPABASE_PROJECT_REF ?? "";
  const ref = url.replace(/^https:\/\//, "").split(".")[0];
  console.log(`TARGET_REF=${ref}`);
  if (!url || !key || !expectedRef) throw new Error("TEST_SUPABASE_URL / _SERVICE_ROLE_KEY / _PROJECT_REF required");
  if (ref === PRODUCTION_REF) throw new Error("ABORT: target is PRODUCTION");
  if (ref !== expectedRef) throw new Error(`ABORT: URL ref ${ref} != TEST_SUPABASE_PROJECT_REF ${expectedRef}`);
  console.log(`ASSERT OK: ${ref} != ${PRODUCTION_REF}`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const connectionId = randomUUID();
  const createdEventIds = new Set<string>();

  const { error: connErr } = await db.from("social_connections").insert({
    id: connectionId,
    user_id: randomUUID(),
    provider: "instagram",
    connection_status: "not_connected",
    provider_account_id: `cdm-probe-${connectionId.slice(0, 8)}`,
    provider_account_username: "ig-comment-dm-probe@example.test",
    scopes: [],
  });
  if (connErr) throw new Error(`seed connection failed: ${connErr.message}`);
  console.log(`created social_connections ${connectionId}`);

  try {
    for (let round = 0; round < ROUNDS; round++) {
      const commentId = `probe-comment-${round}-${randomUUID().slice(0, 8)}`;
      const nowIso = new Date().toISOString();
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          claimCommentEvent(
            db,
            {
              connection_id: connectionId,
              rule_id: null, // nullable (fk on delete set null); no rule row needed for the claim
              comment_id: commentId,
              media_id: "probe-media",
              commenter_id: `probe-user-${i}`,
              commenter_username: "probe@example.test",
              comment_text: "price",
              comment_timestamp: nowIso,
            },
            nowIso,
          ),
        ),
      );
      const winners = results.filter((r): r is string => typeof r === "string");
      winners.forEach(id => createdEventIds.add(id));
      const { data: rows, error } = await db
        .from(EVENTS_TABLE)
        .select("id")
        .eq("connection_id", connectionId)
        .eq("comment_id", commentId);
      if (error) throw new Error(error.message);
      for (const r of (rows as Array<{ id: string }>) ?? []) createdEventIds.add(r.id);
      console.log(`round ${round + 1}: ${PARALLEL} parallel claims → ${winners.length} winner(s), ${rows?.length ?? 0} row(s)`);
      assert.equal(winners.length, 1, "exactly one claim wins");
      assert.equal(rows?.length, 1, "exactly one event row exists");
    }
    console.log(`\nLIVE claim concurrency: ${ROUNDS}/${ROUNDS} rounds passed (exactly one winner each)`);
  } finally {
    if (createdEventIds.size) {
      const { error } = await db.from(EVENTS_TABLE).delete().in("id", [...createdEventIds]);
      console.log(`cleanup: deleted ${createdEventIds.size} event row(s) by id${error ? ` — ERROR ${error.message}` : ""}`);
    }
    const { error } = await db.from("social_connections").delete().eq("id", connectionId);
    console.log(`cleanup: deleted social_connections ${connectionId}${error ? ` — ERROR ${error.message}` : ""}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
