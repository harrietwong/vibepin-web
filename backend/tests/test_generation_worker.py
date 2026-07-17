"""
Unit tests for the WP3-P1 durable generation worker (api/app/worker.py).

Everything is mocked — no network, no real Supabase, no LinAPI:
  * A small in-memory FakeSupabase reproduces the PostgREST filter/order/limit +
    conditional-UPDATE (CAS) semantics the worker relies on. Its .update() applies
    the accumulated .eq()/.lt() filters BEFORE writing and returns only the rows it
    actually changed — exactly what makes claim_next_job's CAS work.
  * generator.generate_slot / prepare_generation are patched per-test so no image is
    ever generated for real.

Covered: claim CAS (two workers, one winner) / orphan reclaim (stale heartbeat) /
per-slot idempotency (reclaim skips 'done') / partial terminal status / error
sanitisation (no secret leak) / worker_status heartbeat.
"""
import copy
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

# Make `import app.worker` resolve — the worker package lives under api/.
_API_DIR = Path(__file__).resolve().parents[2] / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

import app.worker as worker  # noqa: E402


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


# ── Minimal in-memory PostgREST-ish client ──────────────────────────────────────

class _Query:
    def __init__(self, store: dict, table: str):
        self._store = store
        self._table = table
        self._filters: list = []       # (op, col, val)
        self._order = None             # (col, desc)
        self._limit = None
        self._mode = None              # 'select' | 'update' | 'upsert'
        self._payload = None
        self._on_conflict = None

    # -- builders --
    def select(self, *_cols):
        self._mode = "select"
        return self

    def update(self, payload: dict):
        self._mode = "update"
        self._payload = payload
        return self

    def upsert(self, payload: dict, on_conflict: str | None = None):
        self._mode = "upsert"
        self._payload = payload
        self._on_conflict = on_conflict
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def lt(self, col, val):
        self._filters.append(("lt", col, val))
        return self

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    # -- matching --
    def _matches(self, row: dict) -> bool:
        for op, col, val in self._filters:
            cur = row.get(col)
            if op == "eq":
                if cur != val:
                    return False
            elif op == "lt":
                if cur is None or not (str(cur) < str(val)):
                    return False
        return True

    def execute(self):
        rows = self._store.setdefault(self._table, [])
        if self._mode == "select":
            out = [copy.deepcopy(r) for r in rows if self._matches(r)]
            if self._order:
                col, desc = self._order
                out.sort(key=lambda r: str(r.get(col) or ""), reverse=desc)
            if self._limit is not None:
                out = out[: self._limit]
            return _Result(out)
        if self._mode == "update":
            changed = []
            for r in rows:
                if self._matches(r):        # filters applied BEFORE write == CAS
                    r.update(self._payload)
                    changed.append(copy.deepcopy(r))
            return _Result(changed)
        if self._mode == "upsert":
            key = self._on_conflict or "id"
            existing = next((r for r in rows if r.get(key) == self._payload.get(key)), None)
            if existing:
                existing.update(self._payload)
                return _Result([copy.deepcopy(existing)])
            rows.append(dict(self._payload))
            return _Result([copy.deepcopy(self._payload)])
        return _Result([])


class _Result:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    def __init__(self, seed: dict | None = None):
        # store: table_name -> list[row dict]
        self._store: dict = {"generation_jobs": [], "generation_worker_status": []}
        if seed:
            for k, v in seed.items():
                self._store[k] = [dict(r) for r in v]

    def table(self, name: str) -> _Query:
        return _Query(self._store, name)

    # convenience for assertions
    def job(self, job_id):
        return next((r for r in self._store["generation_jobs"] if r["id"] == job_id), None)

    def worker_rows(self):
        return self._store["generation_worker_status"]


def _seed_job(job_id="j1", status="queued", count=2, results=None, created_at=None,
              heartbeat=None):
    return {
        "id": job_id,
        "vibepin_user_id": "u1",
        "status": status,
        "params": {"keyword": "boho", "count": count},
        "results": results if results is not None else [],
        "claimed_at": None,
        "worker_heartbeat_at": heartbeat,
        "created_at": created_at or _iso(datetime.now(timezone.utc)),
        "updated_at": None,
        "finished_at": None,
    }


# Fake plans/slots so no real generation happens. ────────────────────────────────
def _fake_prepare_ok(count=2):
    async def _p(_params):
        return {"ok": True, "plan": {"count": count}}
    return _p


class GenerationWorkerTest(unittest.IsolatedAsyncioTestCase):

    # ── CAS claim: two workers race, exactly one wins ────────────────────────
    def test_claim_cas_single_winner(self):
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("j1", "queued")]})
        w1 = worker.claim_next_job(client=db)
        w2 = worker.claim_next_job(client=db)
        self.assertIsNotNone(w1)
        self.assertIsNone(w2, "second concurrent claim must lose the CAS race")
        self.assertEqual(db.job("j1")["status"], "running")
        self.assertIsNotNone(db.job("j1")["claimed_at"])

    def test_claim_picks_oldest_first(self):
        old = _seed_job("old", "queued", created_at=_iso(datetime(2020, 1, 1, tzinfo=timezone.utc)))
        new = _seed_job("new", "queued", created_at=_iso(datetime(2030, 1, 1, tzinfo=timezone.utc)))
        db = FakeSupabase(seed={"generation_jobs": [new, old]})
        claimed = worker.claim_next_job(client=db)
        self.assertEqual(claimed["id"], "old")

    def test_no_claimable_returns_none(self):
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("done1", "done")]})
        self.assertIsNone(worker.claim_next_job(client=db))

    # ── Orphan reclaim: stale-heartbeat running row is reclaimed ──────────────
    def test_orphan_reclaim_when_heartbeat_stale(self):
        stale = _iso(datetime.now(timezone.utc) - timedelta(minutes=10))
        db = FakeSupabase(seed={"generation_jobs": [
            _seed_job("orphan", "running", heartbeat=stale),
        ]})
        claimed = worker.claim_next_job(client=db)
        self.assertIsNotNone(claimed, "stale running job must be reclaimable")
        self.assertEqual(claimed["id"], "orphan")
        # heartbeat refreshed by the claim
        self.assertGreater(db.job("orphan")["worker_heartbeat_at"], stale)

    def test_fresh_running_not_reclaimed(self):
        fresh = _iso(datetime.now(timezone.utc) - timedelta(seconds=5))
        db = FakeSupabase(seed={"generation_jobs": [
            _seed_job("live", "running", heartbeat=fresh),
        ]})
        self.assertIsNone(worker.claim_next_job(client=db),
                          "a running job with a fresh heartbeat must NOT be reclaimed")

    # ── Per-slot idempotency: reclaim skips already-'done' slots ──────────────
    async def test_reclaim_skips_done_slot(self):
        prior = [
            {"slot": 0, "status": "done", "imageUrl": "https://x/0.png", "error": None},
            {"slot": 1, "status": "failed", "imageUrl": None, "error": "boom"},
        ]
        db = FakeSupabase(seed={"generation_jobs": [
            _seed_job("j1", "running", count=2, results=prior),
        ]})
        called_slots = []

        async def _slot(_plan, slot):
            called_slots.append(slot)
            return f"https://y/{slot}.png"

        with patch.object(worker.generator, "prepare_generation", _fake_prepare_ok(2)), \
             patch.object(worker.generator, "generate_slot", _slot):
            status = await worker.process_job(db.job("j1"), client=db)

        self.assertEqual(called_slots, [1], "only the not-done slot may be regenerated")
        self.assertEqual(status, "done")
        row = db.job("j1")
        self.assertEqual(row["results"][0]["imageUrl"], "https://x/0.png")  # preserved
        self.assertEqual(row["results"][1]["status"], "done")
        self.assertIsNotNone(row["finished_at"])

    # ── Partial terminal status ───────────────────────────────────────────────
    async def test_partial_terminal_status(self):
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("j1", "running", count=2)]})

        async def _slot(_plan, slot):
            if slot == 1:
                raise ValueError("api_server_error::provider exploded")
            return f"https://y/{slot}.png"

        with patch.object(worker.generator, "prepare_generation", _fake_prepare_ok(2)), \
             patch.object(worker.generator, "generate_slot", _slot):
            status = await worker.process_job(db.job("j1"), client=db)

        self.assertEqual(status, "partial")
        row = db.job("j1")
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["results"][0]["status"], "done")
        self.assertEqual(row["results"][1]["status"], "failed")

    async def test_all_fail_terminal_failed(self):
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("j1", "running", count=2)]})

        async def _slot(_plan, _slot):
            raise ValueError("api_server_error::down")

        with patch.object(worker.generator, "prepare_generation", _fake_prepare_ok(2)), \
             patch.object(worker.generator, "generate_slot", _slot):
            status = await worker.process_job(db.job("j1"), client=db)
        self.assertEqual(status, "failed")

    async def test_all_done_terminal_done(self):
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("j1", "running", count=2)]})

        async def _slot(_plan, slot):
            return f"https://y/{slot}.png"

        with patch.object(worker.generator, "prepare_generation", _fake_prepare_ok(2)), \
             patch.object(worker.generator, "generate_slot", _slot):
            status = await worker.process_job(db.job("j1"), client=db)
        self.assertEqual(status, "done")

    # ── Error sanitisation: the LINAPI_KEY value never lands in results ────────
    async def test_error_sanitized_no_secret_leak(self):
        secret = "sk-supersecretlinapikey-1234567890"
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("j1", "running", count=1)]})

        async def _slot(_plan, _slot):
            # Simulate an upstream error body that echoed the auth header.
            raise ValueError(
                f"api_auth_error::HTTP 401 — check LINAPI_KEY: Bearer {secret} rejected"
            )

        with patch.dict(os.environ, {"LINAPI_KEY": secret}), \
             patch.object(worker.generator, "prepare_generation", _fake_prepare_ok(1)), \
             patch.object(worker.generator, "generate_slot", _slot):
            await worker.process_job(db.job("j1"), client=db)

        err = db.job("j1")["results"][0]["error"]
        self.assertIsNotNone(err)
        self.assertNotIn(secret, err, "the raw LINAPI_KEY value must be redacted")
        self.assertIn("[REDACTED]", err)

    def test_sanitize_error_masks_bearer_and_value(self):
        secret = "abcd1234efgh5678ijkl"
        with patch.dict(os.environ, {"LINAPI_KEY": secret}):
            out = worker.sanitize_error(ValueError(f"boom Bearer {secret} tail"))
        self.assertNotIn(secret, out)

    # ── prepare-level failure fails every not-done slot, terminal ─────────────
    async def test_prepare_failure_fails_slots(self):
        db = FakeSupabase(seed={"generation_jobs": [_seed_job("j1", "running", count=2)]})

        async def _prep(_params):
            return {"ok": False, "phase": "prepare",
                    "emit": {"ok": False, "error": "keyword is required", "urls": []}}

        with patch.object(worker.generator, "prepare_generation", _prep):
            status = await worker.process_job(db.job("j1"), client=db)
        self.assertEqual(status, "failed")
        self.assertTrue(all(r["status"] == "failed" for r in db.job("j1")["results"]))
        self.assertIn("keyword is required", db.job("j1")["results"][0]["error"])

    # ── worker_status heartbeat upsert ────────────────────────────────────────
    def test_worker_status_upsert(self):
        db = FakeSupabase()
        worker.upsert_worker_status(client=db)
        rows = db.worker_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], worker.WORKER_NAME)
        self.assertIsNotNone(rows[0]["last_seen"])
        # a second upsert updates in place, not appends
        worker.upsert_worker_status(client=db)
        self.assertEqual(len(db.worker_rows()), 1)

    # ── init_results normalisation ────────────────────────────────────────────
    def test_init_results_preserves_done_pads_pending(self):
        prior = [{"slot": 0, "status": "done", "imageUrl": "u", "error": None}]
        out = worker.init_results(prior, 3)
        self.assertEqual(len(out), 3)
        self.assertEqual(out[0]["status"], "done")
        self.assertEqual(out[1]["status"], "pending")
        self.assertEqual(out[2]["status"], "pending")

    def test_terminal_status_logic(self):
        self.assertEqual(worker.terminal_status(
            [{"status": "done"}, {"status": "done"}]), "done")
        self.assertEqual(worker.terminal_status(
            [{"status": "done"}, {"status": "failed"}]), "partial")
        self.assertEqual(worker.terminal_status(
            [{"status": "failed"}, {"status": "failed"}]), "failed")


if __name__ == "__main__":
    unittest.main()
