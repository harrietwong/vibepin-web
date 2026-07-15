# T2 harvest batch — 2026-07-14 — ROLLBACK HANDLE

19 rows written by `t2_harvest.py --apply --confirm-write --limit 18`.
All four red lines verified PASS against the DB after the write (see report).

created_at (single batch timestamp): 2026-07-14 09:17:46.55509+00
discovery_method: outbound_link

## Roll the whole batch back
py t2_harvest.py --rollback-window '2026-07-14T09:17:46Z' '2026-07-14T09:17:47Z'

## Equivalent SQL (via backend/scripts/run_migration.py --apply)
DELETE FROM pin_products
 WHERE discovery_method = 'outbound_link'
   AND created_at BETWEEN '2026-07-14 09:17:46+00' AND '2026-07-14 09:17:47+00';
-- expect: DELETE 19
