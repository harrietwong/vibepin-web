-- Migration v66: creem_subscriptions.units
--
-- NUMBER: renumbered v63 -> v66 on 2026-08-27 because v63 was DOUBLE-BOOKED — the
-- v3.7 product-opportunities line already owns backend/db/migrate_v63_product_opportunities_v1.sql
-- (in git history, not in this worktree, which is exactly why the on-disk scan
-- that picked v63 missed it). v64/v65 are held by the Insights worktree
-- (D:/wt/insights-on-live: migrate_v64_insights_collection.sql,
-- migrate_v65_insights_keyword_set.sql), so v66 is the first free number.
--
-- Taking a number requires checking BOTH: every sibling worktree on disk AND
-- `git log --all -- "backend/db/migrate_v*.sql"`. v60/v61 were held by in-flight
-- drafts when v62 was written and stay burned — a number ever drafted is not reused.
--
-- WHY
-- The "extra account slots" add-on is one Creem subscription with a QUANTITY: one
-- unit = one extra connectable social account, drawn from a shared any-platform
-- pool. Everything else we mirror is a plan, where quantity is always 1 and never
-- read, so the mirror never stored it.
--
-- The number has to live here rather than be recomputed: the entitlement read
-- (web/src/lib/server/social/accountAllowance.ts) sums units over the user's
-- access-granting add-on subscriptions on the connect path, and must not call the
-- Creem API to answer "may I connect one more account?".
--
-- WHAT
-- One nullable-free integer column, default 1, on the existing mirror table. Every
-- existing row is a plan subscription, and 1 is exactly right for those — so the
-- default backfills correctly with no data migration and no downtime.
--
-- Idempotent: `add column if not exists` — re-running is a no-op.
--
-- DEPLOY ORDER (matters): the webhook writes `units` on every subscription event
-- once the code that accompanies this migration ships. Apply this FIRST, or every
-- Creem webhook mirror write fails with 42703 (undefined column) and Creem retries
-- until it is applied.
--
-- STATUS: NOT APPLIED. Apply with
--   python backend/scripts/run_migration.py --file backend/db/migrate_v66_creem_subscription_units.sql --apply
-- against the intended project ref (production is jaxteelkecvlozdrdoog).

alter table creem_subscriptions
  add column if not exists units integer not null default 1;

comment on column creem_subscriptions.units is
  'Quantity on the Creem subscription (items[].units). 1 for every plan subscription; for the extra-account-slots add-on it is the number of extra connectable social accounts the user bought. Summed over access-granting add-on rows by lib/server/social/accountAllowance.ts.';
