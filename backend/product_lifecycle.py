"""
product_lifecycle.py — the single source of truth for the pin_products lifecycle
filter used by every dedup / "does this URL already exist?" query in the backend.

WHY THIS EXISTS
---------------
migrate_v46 added `pin_products.lifecycle_status`; T10 soft-retired 798 historical
`outbound_link_bootstrap` rows by setting `lifecycle_status = 'retired'` (+
retirement_batch_id='T10'). The rows stay in the table as evidence — their
discovery_method / parent_pin_id / source_url are byte-for-byte untouched.

Every harvester dedups new candidates against "URLs already in pin_products". If
that existence check scans the WHOLE table, the 798 retired source_urls count as
"already exists" and the harvesters can NEVER re-collect them — the retirement
would become a permanent blacklist instead of a soft retirement. Dedup must
therefore ask "does a NON-RETIRED row with this URL exist?".

THE NULL TRAP (do not "simplify" this)
--------------------------------------
Retirement semantics are `lifecycle_status IS DISTINCT FROM 'retired'`:
NULL = never touched by a lifecycle action = ACTIVE. Every non-T10 row has NULL.
PostgREST's `neq` does NOT match NULL rows, so a bare
    lifecycle_status=neq.retired
would drop the ENTIRE active corpus (every NULL row) from the "existing" set —
turning dedup into a no-op and re-inserting the whole table. The filter MUST be
the OR form below. This mirrors web/src/lib/productTopTiers.ts `excludeRetired()`.

GRACEFUL DEGRADATION
--------------------
If migrate_v46 is somehow not applied, PostgREST returns 400 ("column
lifecycle_status does not exist"). Callers that must not hard-fail can use
`select_active_products()`, which falls back to the unfiltered read and reports it.
"""
from __future__ import annotations

LIFECYCLE_STATUS_COLUMN = "lifecycle_status"
LIFECYCLE_RETIRED = "retired"

# Raw PostgREST `or=` payload — NULL-safe "not retired".
# Equivalent SQL: lifecycle_status IS DISTINCT FROM 'retired'
NOT_RETIRED_OR_EXPR = (
    f"{LIFECYCLE_STATUS_COLUMN}.is.null,"
    f"{LIFECYCLE_STATUS_COLUMN}.neq.{LIFECYCLE_RETIRED}"
)

# Ready-to-merge filter dict for db.select_many(filters=...) /
# httpx query params (the query-string `or=` form needs the parentheses).
NOT_RETIRED_FILTER: dict[str, str] = {"or": f"({NOT_RETIRED_OR_EXPR})"}


def with_not_retired(filters: dict | None = None) -> dict:
    """Merge the NULL-safe not-retired filter into a PostgREST filter dict."""
    merged = dict(filters or {})
    merged.update(NOT_RETIRED_FILTER)
    return merged


def is_retired(row: dict) -> bool:
    """Client-side mirror of the same predicate, for already-fetched rows."""
    return (row.get(LIFECYCLE_STATUS_COLUMN) or None) == LIFECYCLE_RETIRED
