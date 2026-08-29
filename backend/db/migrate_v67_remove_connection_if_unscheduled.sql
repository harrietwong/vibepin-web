-- Migration v67: remove_social_connection_if_unscheduled()
--
-- ADDITIVE and IDEMPOTENT. It creates nothing but one function, with
-- `create or replace function`, so re-running it is a no-op that overwrites the
-- body with the same body. No table, column, index, constraint or row is touched;
-- rolling back is `drop function`. Safe to apply while the app is serving.
--
-- NUMBER: v66 is taken by the creem_subscription_units migration in this same
-- worktree; v64/v65 are held by the Insights worktree. v67 was verified free
-- against `git log --all -- "backend/db/migrate_v*.sql"` AND every sibling
-- worktree on disk (D:/wt/*, D:/代码/wt-*) — an on-disk scan alone has already
-- missed a double-booked number once (see v66's header).
--
-- WHY
-- Removing a social account and checking whether anything is still scheduled
-- through it were two separate round trips: the route counted, and some
-- milliseconds later it deleted. A schedule created in another tab inside that
-- window survived, pointing at an account row that no longer exists — the cron
-- then picks it up forever and fails, and no screen in the product can explain
-- why, because the account it names is gone.
--
-- The window cannot be closed from the application: PostgREST offers no
-- read-modify-write transaction. So the check and the delete become ONE
-- statement, evaluated against one snapshot, inside the database. The route's
-- pre-count survives as UX (it opens the keep/cancel dialog early); THIS is the
-- authority that decides whether the row dies.
--
-- WHAT COUNTS AS "STILL SCHEDULED"
-- Exactly what the cron's due-scan would pick up, which is also what the two JS
-- readers use (lib/server/social/scheduledForSocialConnection.ts
-- `candidateScheduledQuery` and lib/server/pinterest/scheduledForConnection.ts
-- `scheduledForConnectionQuery`): this user's pin_drafts rows with a non-null
-- scheduled_at, deleted_at null, archived_at null. Both target 口径 are covered:
--   • payload->>'targetConnectionId'  — the legacy single Pinterest target every
--     historical Pin carries.
--   • payload->'scheduledDestinations' containing an element with this
--     socialConnectionId — the multi-platform record, the only place a Facebook
--     or Instagram target has ever been written.
--
-- The containment predicate is deliberately BROADER than the JS
-- `payloadTargetsSocialConnection`, which additionally requires
-- `isUsableDestination` (a recognised provider). A destination entry naming this
-- account with a bogus provider blocks the delete here but would not be counted
-- there. That asymmetry is the safe direction — SQL refuses more than JS would,
-- never less — and replicating `isUsableDestination` in SQL would put the rule in
-- two places where it could drift into refusing LESS.
--
-- RETURN CONTRACT (one row, always)
--   deleted=true,  scheduled_count=0  → the row was deleted.
--   deleted=false, scheduled_count>0  → refused; N live schedules still target it.
--   deleted=false, scheduled_count=0  → nothing matched: the row was already gone
--                                       (or belongs to another user). Both remove
--                                       routes are documented idempotent, so the
--                                       caller treats this as success, not a
--                                       refusal.
-- A bare `delete … returning` could not express the middle case: it returns zero
-- rows on refusal, indistinguishable from "already gone". Hence the CTE that
-- always projects one row.

create or replace function public.remove_social_connection_if_unscheduled(
  p_user_id       uuid,
  p_connection_id uuid
)
returns table(deleted boolean, scheduled_count integer)
language sql
security definer
set search_path = public
as $$
  with blocking as (
    select count(*)::int as cnt
    from pin_drafts d
    where d.vibepin_user_id = p_user_id
      and d.scheduled_at is not null
      and d.deleted_at is null
      and d.archived_at is null
      and (
        d.payload->>'targetConnectionId' = p_connection_id::text
        or d.payload->'scheduledDestinations' @> jsonb_build_array(
             jsonb_build_object('socialConnectionId', p_connection_id::text)
           )
      )
  ),
  del as (
    -- The delete reads `blocking` in the SAME statement, so the count and the
    -- delete see one snapshot. A schedule inserted after this statement starts
    -- cannot slip between them; it either predates the snapshot (and blocks) or
    -- lands after the row is already gone (and is refused by the route's
    -- destination validation on the write side).
    delete from social_connections c
    where c.id = p_connection_id
      and c.user_id = p_user_id
      and (select cnt from blocking) = 0
    returning c.id
  )
  select exists(select 1 from del) as deleted,
         (select cnt from blocking) as scheduled_count;
$$;

-- Functions default to EXECUTE for PUBLIC, so granting service_role is not by
-- itself a restriction. This is `security definer` over another user's rows —
-- the revoke is the part that makes "service_role only" true.
revoke all on function public.remove_social_connection_if_unscheduled(uuid, uuid) from public;
revoke all on function public.remove_social_connection_if_unscheduled(uuid, uuid) from anon;
revoke all on function public.remove_social_connection_if_unscheduled(uuid, uuid) from authenticated;
grant execute on function public.remove_social_connection_if_unscheduled(uuid, uuid) to service_role;

comment on function public.remove_social_connection_if_unscheduled(uuid, uuid) is
  'Delete one social_connections row only if no live pin_drafts schedule still targets it. Check and delete are one statement so the two cannot race. Returns (deleted, scheduled_count); deleted=false with scheduled_count=0 means the row was already gone.';
