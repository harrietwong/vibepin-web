"""
Durable AI-generation worker (WP3-P1) — DB-as-queue, no HTTP port.

Entry point:  python -m app.worker

A pure polling loop (it exposes NO HTTP endpoint; the FastAPI app is untouched).
Every POLL_INTERVAL seconds it:

  1. CAS-claims the oldest ``queued`` generation_jobs row
     (UPDATE … SET status='running' WHERE id=? AND status='queued' — zero rows
     returned means another worker won the race), OR reclaims an orphaned
     ``running`` row whose worker_heartbeat_at is older than ORPHAN_TIMEOUT.
  2. Processes the job slot-by-slot, IDEMPOTENTLY: slots already marked 'done'
     in ``results`` are skipped, only 'pending'/'failed' slots are (re)generated.
     Each slot → generator.generate_slot() → the URL is written incrementally back
     into results[slot] so a partial success is never lost on a crash + reclaim.
  3. Keeps worker_heartbeat_at fresh (≈every HEARTBEAT_INTERVAL) while working, and
     upserts a generation_worker_status row so the Next enqueue path can gate on
     worker liveness.
  4. Sets the terminal status (done / partial / failed) + finished_at.

The prompt engine (backend/generator.py, 2000+ lines) is REUSED, never copied:
prepare_generation(params) builds the per-slot plan once, generate_slot(plan, i)
runs one slot. Both were extracted from generator.run_from_stdin as importable
seams with identical behavior.

Secrets (LINAPI_KEY, SUPABASE_SERVICE_ROLE_KEY) come from the process env
(systemd EnvironmentFile on the VPS). Nothing secret is ever written to results.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ── Make the shared prompt engine importable ────────────────────────────────────
# generator.py lives in backend/ (sibling of api/). On the VPS the systemd unit
# also puts /opt/vibepin/backend on PYTHONPATH; this insert makes local dev + tests
# work without that env. Behaviour of generator.py is unchanged — we only import
# the prepare_generation / generate_slot seams it now exposes.
_BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
if _BACKEND_DIR.is_dir() and str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

import generator  # noqa: E402  (path set above)

# ── Tunables ────────────────────────────────────────────────────────────────────
POLL_INTERVAL_S      = float(os.environ.get("GENERATION_WORKER_POLL_INTERVAL_S", "3") or "3")
HEARTBEAT_INTERVAL_S = float(os.environ.get("GENERATION_WORKER_HEARTBEAT_INTERVAL_S", "30") or "30")
ORPHAN_TIMEOUT_S     = int(os.environ.get("GENERATION_WORKER_ORPHAN_TIMEOUT_S", "300") or "300")  # 5 min
SLOT_CONCURRENCY     = max(1, int(os.environ.get("GENERATION_WORKER_SLOT_CONCURRENCY", "2") or "2"))
WORKER_NAME          = os.environ.get("GENERATION_WORKER_NAME", "generation-worker")

JOBS_TABLE          = "generation_jobs"
WORKER_STATUS_TABLE = "generation_worker_status"

# Substrings that must NEVER appear in a slot error surfaced to the client row.
# Values, not just the env-var names — a stray "Bearer <key>" in an httpx error
# body would otherwise leak. We redact the actual secret values at runtime.
_SECRET_ENV_KEYS = (
    "LINAPI_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_MIGRATION_TOKEN",
    "OPENAI_API_KEY",
)

_SAFE_ERROR_CATEGORIES = frozenset({
    "rate_limited",
    "safety_blocked",
    "api_auth_error",
    "api_payload_error",
    "api_server_error",
    "model_returned_text",
    "image_load_failed",
    "provider_busy",
    "invalid_model_key",
    "configuration_error",
    "unknown_error",
})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Supabase client (lazy, service-role) ────────────────────────────────────────
_client = None


def get_client():
    """Return a cached service-role Supabase client built from process env.

    Kept lazy + module-level so tests can monkeypatch app.worker.get_client with a
    fake before the loop ever runs, and so a missing env only fails when actually
    used (never at import time).
    """
    global _client
    if _client is None:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
        _client = create_client(url, key)
    return _client


# ── Error sanitisation ──────────────────────────────────────────────────────────

def sanitize_error(exc: BaseException) -> str:
    """Return only a stable, allowlisted error category for the results row.

    generator.py encodes classified errors as ``type::detail``. The detail is
    deliberately discarded so provider bodies, prompts, URLs, credentials and
    exception text can never cross the worker result boundary.
    """
    msg = str(exc) if exc is not None else "unknown_error"
    category = msg.split("::", 1)[0].strip().lower() if "::" in msg else type(exc).__name__.lower()
    category = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in category).strip("_")
    # Redact any secret VALUE that may have been echoed into an error string.
    for env_key in _SECRET_ENV_KEYS:
        val = os.environ.get(env_key)
        if val and len(val) >= 8 and val in msg:
            msg = msg.replace(val, "[REDACTED]")
    # Defence in depth: mask an obvious "Bearer <token>" fragment if present.
    import re as _re
    msg = _re.sub(r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}", "Bearer [REDACTED]", msg)
    return category if category in _SAFE_ERROR_CATEGORIES else "unknown_error"


# ── Phase 4I: usage metering (settle per slot; release on terminal pre-slot fail) ─
# The route reserves image-slot capacity via usage_reserve_generation_job, which
# writes generation_jobs.usage_reservation_id. This worker settles that reservation
# per slot as each image succeeds or terminally fails.
#
# SLOT-KEY CONTRACT (load-bearing — mirrored in
# web/src/lib/server/usage/meterGeneration.ts): the reservation was created with slot
# keys ["s0","s1",...,"s{count-1}"]. The worker's per-slot loop uses INTEGER slot
# indices, so the settle key is reconstructed as "s" + str(slot). If either side
# changes the shape, settlement silently stops matching — keep the two in lockstep.
#
# SAFETY RULES:
#   * A settle/release failure must NEVER fail the job — it is logged and swallowed.
#     The v55 expiry sweeper is the safety net for anything left unsettled.
#   * v55's settle RPC is idempotent per (reservation_id, slot_key): a reclaimed job
#     re-runs ONLY its non-done slots, and any slot already settled by the prior
#     attempt is a no-op replay. So double-settle on reclaim cannot occur.
#   * A job with no usage_reservation_id (predates metering, or was enqueued via the
#     plain off-mode insert) is simply not metered — every helper below no-ops on a
#     falsy reservation id, logging once.

def _slot_key(slot: int) -> str:
    """The reservation slot key for an integer slot index. MUST match the TS side's
    ["s0","s1",...] convention (see meterGeneration.slotKeysForCount)."""
    return f"s{slot}"


def settle_slot(reservation_id, slot: int, succeeded: bool, client=None) -> None:
    """Settle ONE slot of a reservation. No-op when there is no reservation id.

    Idempotent by v55's per-(reservation, slot) guard, so a reclaim that re-runs a
    slot already settled by a prior attempt is a harmless replay. Never raises: a
    settle hiccup must not fail the job (the expiry sweeper reclaims anything unsettled).
    """
    if not reservation_id:
        return
    outcome = "succeeded" if succeeded else "terminal_failed"
    try:
        (client or get_client()).rpc(
            "usage_settle_reservation_item",
            {
                "p_reservation_id": reservation_id,
                "p_slot_key": _slot_key(slot),
                "p_outcome": outcome,
            },
        ).execute()
    except Exception as exc:  # noqa: BLE001 — log, never propagate
        print(
            f"[gen-worker] settle failed reservation={reservation_id} slot={slot} "
            f"outcome={outcome}: {sanitize_error(exc)}",
            file=sys.stderr,
        )


def release_reservation(reservation_id, reason: str = "generation_failed", client=None) -> None:
    """Release every still-pending slot of a reservation (terminal failure before any
    slot ran). No-op without a reservation id; idempotent; never raises."""
    if not reservation_id:
        return
    try:
        (client or get_client()).rpc(
            "usage_release_reservation",
            {"p_reservation_id": reservation_id, "p_reason": reason},
        ).execute()
    except Exception as exc:  # noqa: BLE001 — log, never propagate
        print(
            f"[gen-worker] release failed reservation={reservation_id}: {sanitize_error(exc)}",
            file=sys.stderr,
        )


# ── Results helpers ─────────────────────────────────────────────────────────────

def init_results(existing, count: int) -> list[dict]:
    """Return a normalized per-slot results list of length `count`.

    Preserves any already-'done' slot (and its imageUrl) from a prior attempt so a
    reclaim is idempotent; unknown/short lists are padded with 'pending' slots.
    """
    by_slot: dict[int, dict] = {}
    if isinstance(existing, list):
        for item in existing:
            if isinstance(item, dict) and isinstance(item.get("slot"), int):
                by_slot[item["slot"]] = item
    out: list[dict] = []
    for i in range(max(1, count)):
        prev = by_slot.get(i)
        if isinstance(prev, dict) and prev.get("status") == "done" and prev.get("imageUrl"):
            out.append({
                "slot": i,
                "status": "done",
                "imageUrl": prev.get("imageUrl"),
                "error": None,
            })
        else:
            out.append({"slot": i, "status": "pending", "imageUrl": None, "error": None})
    return out


def terminal_status(results: list[dict]) -> str:
    """done = all slots done; failed = none done; partial = some done, some failed."""
    total = len(results)
    done = sum(1 for r in results if r.get("status") == "done")
    if done == total:
        return "done"
    if done == 0:
        return "failed"
    return "partial"


# ── Worker status / heartbeat ───────────────────────────────────────────────────

def upsert_worker_status(client=None) -> None:
    """Upsert this worker's liveness row (name → last_seen). Best-effort."""
    client = client or get_client()
    try:
        client.table(WORKER_STATUS_TABLE).upsert(
            {"name": WORKER_NAME, "last_seen": _now_iso()},
            on_conflict="name",
        ).execute()
    except Exception as exc:  # never let a status hiccup kill the loop
        print(f"[gen-worker] worker_status upsert failed: {sanitize_error(exc)}", file=sys.stderr)


def heartbeat_job(job_id: str, client=None) -> None:
    """Refresh worker_heartbeat_at for a job we're actively processing."""
    client = client or get_client()
    client.table(JOBS_TABLE).update(
        {"worker_heartbeat_at": _now_iso(), "updated_at": _now_iso()}
    ).eq("id", job_id).execute()


# ── Claim (CAS) ─────────────────────────────────────────────────────────────────

def _stale_cutoff_iso() -> str:
    return datetime.fromtimestamp(time.time() - ORPHAN_TIMEOUT_S, tz=timezone.utc).isoformat()


def claim_next_job(client=None) -> dict | None:
    """Atomically claim one job and return its row, or None if nothing claimable.

    Two candidate sources, oldest-first:
      A. a 'queued' row (fresh work);
      B. a 'running' row whose worker_heartbeat_at is stale (crashed worker → orphan).

    Claim is a conditional UPDATE that only wins when the row is STILL in the state
    we selected it in (PostgREST returns exactly the updated rows). A racing worker's
    claim excludes ours → zero returned rows → we move on. This is the same CAS the
    publish-due cron uses for pin_drafts.
    """
    client = client or get_client()
    now_iso = _now_iso()

    # ── A. oldest queued ──────────────────────────────────────────────────────
    queued = (
        client.table(JOBS_TABLE)
        .select("id")
        .eq("status", "queued")
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    for row in (queued.data or []):
        won = (
            client.table(JOBS_TABLE)
            .update({
                "status": "running",
                "claimed_at": now_iso,
                "worker_heartbeat_at": now_iso,
                "updated_at": now_iso,
            })
            .eq("id", row["id"])
            .eq("status", "queued")  # CAS guard — only if still queued
            .execute()
        )
        if won.data:
            return won.data[0]
        # lost the race — fall through to orphan reclaim

    # ── B. oldest orphaned running (stale heartbeat) ──────────────────────────
    cutoff = _stale_cutoff_iso()
    orphans = (
        client.table(JOBS_TABLE)
        .select("id")
        .eq("status", "running")
        .lt("worker_heartbeat_at", cutoff)
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    for row in (orphans.data or []):
        won = (
            client.table(JOBS_TABLE)
            .update({
                "claimed_at": now_iso,
                "worker_heartbeat_at": now_iso,
                "updated_at": now_iso,
            })
            .eq("id", row["id"])
            .eq("status", "running")          # still running …
            .lt("worker_heartbeat_at", cutoff)  # … and still stale (CAS on both)
            .execute()
        )
        if won.data:
            return won.data[0]

    return None


def _write_results(job_id: str, results: list[dict], client=None, status: str | None = None) -> None:
    patch: dict = {"results": results, "updated_at": _now_iso()}
    if status is not None:
        patch["status"] = status
    (client or get_client()).table(JOBS_TABLE).update(patch).eq("id", job_id).execute()


# ── Process one job ─────────────────────────────────────────────────────────────

async def process_job(job: dict, client=None) -> str:
    """Generate every not-yet-done slot of one claimed job. Returns terminal status.

    Idempotent per slot: slots already 'done' in the row are skipped; only
    'pending'/'failed' slots are (re)generated. Slot concurrency is capped at
    SLOT_CONCURRENCY (VPS memory). Heartbeat is refreshed on a background timer so a
    long provider call cannot let the row look orphaned.
    """
    client = client or get_client()
    job_id = str(job["id"])
    params = job.get("params") or {}
    count = max(1, int(params.get("count") or params.get("outputCount") or 1))

    # Phase 4I: the usage reservation this job settles against (None when the job
    # predates metering or was enqueued via the plain off-mode insert → not metered).
    reservation_id = job.get("usage_reservation_id")
    if not reservation_id:
        print(f"[gen-worker] job={job_id} has no usage_reservation_id — not metered", file=sys.stderr)

    # Normalize / seed the results array, preserving prior 'done' slots.
    results = init_results(job.get("results"), count)
    _write_results(job_id, results, client=client)

    # Build the per-slot plan ONCE (shared image loading + prompt engine).
    prep = await generator.prepare_generation(params)
    if not prep.get("ok"):
        # Prepare-level failure (bad keyword, unconfigured model, image load, …):
        # every not-done slot fails with the sanitized prepare error; terminal. No
        # slot ran, so RELEASE the whole reservation (capacity returns to the user)
        # rather than settling each slot as a failure — release is the primitive for
        # "nothing ran". Idempotent + swallow-on-failure.
        emit = prep.get("emit") or {}
        error_type = str(emit.get("error_type") or "api_payload_error")
        raw_error = str(emit.get("error") or "generation setup failed")
        err = sanitize_error(RuntimeError(f"{error_type}::{raw_error}"))
        for r in results:
            if r.get("status") != "done":
                r.update({"status": "failed", "imageUrl": None, "error": err})
        status = terminal_status(results)
        release_reservation(reservation_id, reason="prepare_failed", client=client)
        _finalize(job_id, results, status, client=client)
        return status

    plan = prep["plan"]
    # The plan's slot count is authoritative for the generator; align results.
    plan_count = int(plan.get("count") or count)
    if plan_count != len(results):
        results = init_results(results, plan_count)
        _write_results(job_id, results, client=client)

    pending_slots = [r["slot"] for r in results if r.get("status") != "done"]

    # ── Heartbeat timer (background) while we generate ────────────────────────
    stop = asyncio.Event()

    async def _hb():
        while not stop.is_set():
            try:
                heartbeat_job(job_id, client=client)
                upsert_worker_status(client=client)
            except Exception as exc:
                print(f"[gen-worker] heartbeat failed job={job_id}: {sanitize_error(exc)}", file=sys.stderr)
            try:
                await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_INTERVAL_S)
            except asyncio.TimeoutError:
                pass

    hb_task = asyncio.create_task(_hb())
    sem = asyncio.Semaphore(SLOT_CONCURRENCY)
    lock = asyncio.Lock()  # serialize incremental result writes

    async def _run_slot(slot: int) -> None:
        async with sem:
            try:
                url = await generator.generate_slot(plan, slot)
                new = {"slot": slot, "status": "done", "imageUrl": url, "error": None}
                succeeded = True
            except Exception as exc:  # noqa: BLE001 — classify+sanitize, never propagate
                new = {"slot": slot, "status": "failed", "imageUrl": None,
                       "error": sanitize_error(exc)}
                succeeded = False
            async with lock:
                for i, r in enumerate(results):
                    if r.get("slot") == slot:
                        results[i] = new
                        break
                # Incremental persist so a crash mid-batch keeps finished slots.
                _write_results(job_id, results, client=client)
            # Phase 4I: settle THIS slot at its terminal outcome. Outside the results
            # lock (the RPC does its own account locking) and swallow-on-failure, so a
            # metering hiccup never blocks another slot or fails the job. Idempotent per
            # (reservation, slot_key), so a reclaim that re-ran this slot is a no-op
            # replay for any slot already settled — no double-settle. Only 'pending'/
            # 'failed' slots are ever (re)run (init_results skips 'done'), so a slot the
            # prior attempt settled 'succeeded' is not re-run at all.
            settle_slot(reservation_id, slot, succeeded, client=client)

    try:
        await asyncio.gather(*[_run_slot(s) for s in pending_slots])
    finally:
        stop.set()
        try:
            await hb_task
        except Exception:
            pass

    status = terminal_status(results)
    _finalize(job_id, results, status, client=client)
    return status


def _finalize(job_id: str, results: list[dict], status: str, client=None) -> None:
    (client or get_client()).table(JOBS_TABLE).update({
        "status": status,
        "results": results,
        "finished_at": _now_iso(),
        "updated_at": _now_iso(),
    }).eq("id", job_id).execute()


# ── Main loop ───────────────────────────────────────────────────────────────────

async def run_forever() -> None:
    print(
        f"[gen-worker] starting name={WORKER_NAME!r} poll={POLL_INTERVAL_S}s "
        f"heartbeat={HEARTBEAT_INTERVAL_S}s orphan={ORPHAN_TIMEOUT_S}s "
        f"slot_concurrency={SLOT_CONCURRENCY}",
        file=sys.stderr,
    )
    client = get_client()
    upsert_worker_status(client=client)
    while True:
        try:
            upsert_worker_status(client=client)
            job = claim_next_job(client=client)
            if job is None:
                await asyncio.sleep(POLL_INTERVAL_S)
                continue
            print(f"[gen-worker] claimed job={job['id']} status→running", file=sys.stderr)
            status = await process_job(job, client=client)
            print(f"[gen-worker] finished job={job['id']} → {status}", file=sys.stderr)
        except Exception as exc:  # keep the loop alive on any transient error
            print(f"[gen-worker] loop error: {sanitize_error(exc)}", file=sys.stderr)
            await asyncio.sleep(POLL_INTERVAL_S)


def main() -> None:
    try:
        asyncio.run(run_forever())
    except KeyboardInterrupt:
        print("[gen-worker] shutting down", file=sys.stderr)


if __name__ == "__main__":
    main()
