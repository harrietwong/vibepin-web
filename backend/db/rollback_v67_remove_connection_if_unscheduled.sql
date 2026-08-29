-- Idempotent rollback for migrate_v67_remove_connection_if_unscheduled.sql.
--
-- Roll the application disconnect routes back before dropping this RPC.  The
-- function owns no rows or durable state, so removing its exact signature is a
-- complete schema rollback.

drop function if exists public.remove_social_connection_if_unscheduled(uuid, uuid);
