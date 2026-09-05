-- Safe v76 rollback.  v76 may already contain publish evidence, so rollback
-- never drops tables, columns, indexes, rows, leases, or provider evidence.
-- It removes RPC execution grants and keeps asset/delivery ledgers read-only
-- to service callers; re-applying v76 restores the callable RPC surface.
begin;
-- Retain inspection access, but never leave a direct ledger-write bypass.
revoke all on public.publish_assets,public.publish_asset_deliveries from public,anon,authenticated,service_role;
grant select on public.publish_assets,public.publish_asset_deliveries to service_role;
revoke execute on function public.publish_intent_prepare(uuid,text,text,text,jsonb,timestamptz,jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.publish_intent_confirm_prepare(uuid,jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.publish_asset_lease_materialization(uuid,text,text,uuid,integer) from public,anon,authenticated,service_role;
revoke execute on function public.publish_asset_settle_materialization(uuid,text,text,uuid,text,text,text,text,bigint,text,text) from public,anon,authenticated,service_role;
revoke execute on function public.publish_asset_claim_ready(uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.publish_asset_settle_item(uuid,text,text,uuid,text,integer,text,text,text,bigint,text) from public,anon,authenticated,service_role;
revoke execute on function public.publish_intent_cancel(uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function public.publish_cleanup_lease(bigint,uuid,integer) from public,anon,authenticated,service_role;
revoke execute on function public.publish_cleanup_settle(bigint,uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function public.publish_provider_attempt_start(uuid,text,text,uuid,integer) from public,anon,authenticated,service_role;
revoke execute on function public.publish_provider_attempt_settle(uuid,uuid,uuid,text,integer,text,text,jsonb) from public,anon,authenticated,service_role;
notify pgrst, 'reload schema';
commit;
