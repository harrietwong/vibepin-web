-- v59: unify Pinterest connections into social_connections (multi-account ready).
--
-- Additive and idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING) — safe to re-run.
-- Apply with
--   backend/scripts/run_migration.py --apply
-- (Management API over HTTPS; the "run this in the Supabase SQL Editor" note on
-- older migrations is stale — direct 5432/pooler access is not reachable.)
--
-- Requires PostgreSQL 15+ for `NULLS NOT DISTINCT` (Supabase is on 15+).
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- Pinterest was split across two tables: OAuth tokens lived in the private
-- `pinterest_connections` table (unique index on vibepin_user_id — one Pinterest
-- account per VibePin user, enforced physically), while the user's default board
-- lived in the metadata of a provider='pinterest' row in `social_connections`.
-- Two half-records for one connection, and a hard cap of one Pinterest account.
--
-- This migration makes `social_connections` the single home for a Pinterest
-- connection: identity + encrypted tokens + scopes + expiry + default board on ONE
-- row, keyed by (user_id, provider, provider_account_id) so a user can hold N
-- Pinterest accounts that never overwrite each other.
--
-- ── Rollback anchor ──────────────────────────────────────────────────────────
-- `pinterest_connections` is deliberately NOT dropped. It is marked deprecated and
-- the application stops writing to it; the rows stay as a byte-exact rollback point
-- (the token ciphertext is copied, not moved). A later migration may drop it once
-- the unified path has run in production for a full refresh cycle.

-- ── 1. Columns social_connections needs to carry a Pinterest connection ───────

-- Cross-instance refresh CAS guard, moved from pinterest_connections (v49).
-- Pinterest rotates the refresh token on every refresh: the old token dies the
-- instant a new one is issued, so two instances refreshing the same connection
-- concurrently would invalidate each other. updateTokens() writes only WHERE
-- token_version = <value read before the refresh> and bumps it by one; zero rows
-- matched means another instance already rotated, and the caller adopts its tokens.
-- v49 scoped this per USER; here it is per CONNECTION, which is the correct
-- granularity once one user can hold several accounts.
ALTER TABLE social_connections
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

-- Pinterest's needs_reconnect semantics, carried over verbatim. Facebook/Instagram
-- keep expressing the same idea through connection_status; the application maps
-- both onto one 4-state model, so this column is Pinterest-specific but harmless
-- (default false) for the other providers.
ALTER TABLE social_connections
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false;

-- Refresh-token expiry. social_connections already has token_expires_at for the
-- ACCESS token; the refresh token has its own, independent lifetime.
ALTER TABLE social_connections
  ADD COLUMN IF NOT EXISTS refresh_token_expires_at timestamptz;

-- When the user disconnected this connection. A disconnected row keeps its identity
-- (so history and Pin references still resolve) but has its tokens nulled out and is
-- ignored by every "active connection" read. Reconnecting revives the SAME row.
ALTER TABLE social_connections
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

-- ── 2. One row per (user, provider, account) ─────────────────────────────────
-- NULLS NOT DISTINCT is the load-bearing part: without it, every row whose
-- provider_account_id is still NULL (a connection persisted before its profile was
-- fetched) would be mutually distinct, so a user could accumulate unlimited
-- identity-less Pinterest rows — exactly the duplicate the constraint exists to
-- stop. With it, at most ONE not-yet-identified row per (user, provider) can exist,
-- and the identity sync fills it in place.
--
-- Created NOT CONCURRENTLY: the migration runner wraps statements in a transaction,
-- and these tables are small enough that the brief write lock is irrelevant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'social_connections_user_provider_account_unique'
  ) THEN
    CREATE UNIQUE INDEX social_connections_user_provider_account_unique
      ON social_connections (user_id, provider, provider_account_id) NULLS NOT DISTINCT;
  END IF;
END$$;

-- Hot path: "the active connections this user has on this provider".
CREATE INDEX IF NOT EXISTS social_connections_user_provider_active
  ON social_connections (user_id, provider)
  WHERE disconnected_at IS NULL;

-- ── 3. Copy live Pinterest connections across ────────────────────────────────
-- Two shapes have to end up as ONE row per account:
--   (a) the token row in pinterest_connections, and
--   (b) an existing provider='pinterest' row in social_connections that today holds
--       only metadata (default_board_id / default_board_name) and no tokens.
-- Step 3a merges (a) into (b) when (b) exists; step 3b inserts the rest.
-- Both steps are re-runnable: 3a only writes rows that still have no token, 3b only
-- inserts accounts that are not present yet.

-- 3a. Fold tokens into the pre-existing metadata-only row (default board preserved).
--     Matched on (user, provider) alone because the metadata row never had an account
--     id; that is safe precisely because such a row can only exist once per user.
UPDATE social_connections sc
SET
  provider_account_id       = COALESCE(sc.provider_account_id, pc.pinterest_user_id),
  provider_account_username = COALESCE(sc.provider_account_username, pc.pinterest_username),
  provider_account_name     = COALESCE(
                                sc.provider_account_name,
                                CASE WHEN pc.pinterest_username IS NOT NULL
                                     THEN '@' || pc.pinterest_username END
                              ),
  access_token_encrypted    = pc.access_token_encrypted,
  refresh_token_encrypted   = pc.refresh_token_encrypted,
  token_expires_at          = pc.access_token_expires_at,
  refresh_token_expires_at  = pc.refresh_token_expires_at,
  scopes                    = pc.scopes,
  token_version             = pc.token_version,
  needs_reconnect           = pc.needs_reconnect,
  disconnected_at           = pc.disconnected_at,
  connection_status         = CASE
                                WHEN pc.disconnected_at IS NOT NULL THEN 'not_connected'
                                WHEN pc.access_token_encrypted IS NULL THEN 'not_connected'
                                WHEN pc.needs_reconnect THEN 'expired'
                                ELSE 'connected'
                              END,
  auth_provider             = COALESCE(sc.auth_provider, 'official'),
  metadata                  = COALESCE(sc.metadata, '{}'::jsonb)
                              || CASE WHEN pc.pinterest_account_type IS NOT NULL
                                      THEN jsonb_build_object('accountType', pc.pinterest_account_type)
                                      ELSE '{}'::jsonb END,
  updated_at                = now()
FROM pinterest_connections pc
WHERE sc.provider = 'pinterest'
  AND sc.user_id = pc.vibepin_user_id
  AND sc.access_token_encrypted IS NULL   -- only the metadata-only shell; never clobber a migrated row
  AND pc.access_token_encrypted IS NOT NULL;

-- 3b. Insert the Pinterest connections that had no social_connections row at all.
INSERT INTO social_connections (
  user_id, provider, provider_account_id, provider_account_name, provider_account_username,
  connection_status, auth_provider, scopes,
  access_token_encrypted, refresh_token_encrypted, token_expires_at, refresh_token_expires_at,
  token_version, needs_reconnect, disconnected_at, metadata, created_at, updated_at
)
SELECT
  pc.vibepin_user_id,
  'pinterest',
  pc.pinterest_user_id,
  CASE WHEN pc.pinterest_username IS NOT NULL THEN '@' || pc.pinterest_username END,
  pc.pinterest_username,
  CASE
    WHEN pc.disconnected_at IS NOT NULL THEN 'not_connected'
    WHEN pc.access_token_encrypted IS NULL THEN 'not_connected'
    WHEN pc.needs_reconnect THEN 'expired'
    ELSE 'connected'
  END,
  'official',
  COALESCE(pc.scopes, '{}'),
  pc.access_token_encrypted,
  pc.refresh_token_encrypted,
  pc.access_token_expires_at,
  pc.refresh_token_expires_at,
  pc.token_version,
  pc.needs_reconnect,
  pc.disconnected_at,
  CASE WHEN pc.pinterest_account_type IS NOT NULL
       THEN jsonb_build_object('accountType', pc.pinterest_account_type)
       ELSE '{}'::jsonb END,
  COALESCE(pc.created_at, now()),
  now()
FROM pinterest_connections pc
WHERE pc.access_token_encrypted IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM social_connections sc
    WHERE sc.user_id = pc.vibepin_user_id
      AND sc.provider = 'pinterest'
  )
ON CONFLICT DO NOTHING;

-- ── 4. Mark the old table deprecated (kept, not dropped) ─────────────────────
COMMENT ON TABLE pinterest_connections IS
  'DEPRECATED as of migration v59 — Pinterest connections now live in social_connections '
  '(provider = ''pinterest''). This table is read-only rollback state: the application no '
  'longer writes to it. Do not add columns; do not resume writes.';
