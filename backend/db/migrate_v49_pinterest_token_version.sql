-- v49: pinterest_connections.token_version — cross-instance refresh CAS guard.
-- Additive and idempotent (IF NOT EXISTS). Apply with
--   backend/scripts/run_migration.py --apply   (Management API; see the migration
-- runner memo — the "run in the SQL Editor" note on older migrations is stale).
--
-- Business context: Pinterest rotates the refresh token on every refresh — the old
-- token is invalidated the instant a new one is issued. In-process coalescing
-- (service.ts _refreshInFlight Map) only dedupes within ONE Node process. On Vercel,
-- two serverless instances each hold their own Map, so both can send the SAME old
-- refresh token concurrently: the loser gets invalid_grant, the connection is wrongly
-- marked needs_reconnect, auto-publish stops, and the user must re-authorize.
--
-- Fix: an integer version column enables a compare-and-swap persist. updateTokens
-- writes only WHERE token_version = <value read before the refresh> and bumps it by
-- one. If the CAS matches zero rows, another instance already rotated the token — the
-- caller re-reads the connection and adopts the fresh tokens instead of failing.
--
-- Existing rows get 0; every subsequent successful refresh increments it.

ALTER TABLE pinterest_connections
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
