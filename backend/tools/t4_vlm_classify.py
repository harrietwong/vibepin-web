"""
t4_vlm_classify.py — T4 phase A minimal VLM runner (data-side task book v1.1).

WHY A NEW RUNNER (not classify_reference_pins.py):
  The existing production classifier is HEURISTIC (token-based, no image fetch) and
  writes NINE columns including is_reference_eligible / reference_quality_score /
  watermark_detected / image_quality_band, and can flip eligibility. Task-book iron
  rule #2 forbids that for phase A. This runner does a real VISION call (LinAPI/Gemini,
  same infra as web ai-copy visionServer) and, when it writes, touches ONLY the four
  taxonomy columns: visual_format / human_presence / composition_type / text_overlay_level.

MODES:
  --mode calibrate   50 stratified P0 samples → LOCAL FILES ONLY, never writes DB.
                     Produces web/artifacts/t4-calibration/{predictions.json,index.html}.
  --mode backfill    100 eligible rows → UPDATE the four columns only. Records the
                     batch updated_at window for rollback locating. (Phase A)
  --mode full        PHASE B (decision-maker approved 2026-07-13): full backfill of the
                     remaining eligible pool (~1,848 rows), EXCLUDING every id already
                     recorded in t4_backfill_evidence.json (phase A) and in
                     t4_phaseb_evidence.json (resume safety). Runs in batches
                     (--batch-size, default 200); after EVERY batch the evidence file
                     t4_phaseb_evidence.json is rewritten with all updated_ids so far
                     (durable rollback key + resume point). If any batch's failure rate
                     exceeds 15%, that batch is NOT written and the run stops.

SAFETY:
  * Phase A: hard row cap 100 (MAX_BACKFILL). Phase B: batches, per-batch failure gate.
  * UPDATE payload is exactly the four columns; no other column is ever sent.
  * Concurrency capped at 2 VLM calls (--concurrency, max 2) to avoid crowding T1.
  * `unknown` is a compliant output (model uncertain) — not counted as an error.
  * quality band / eligibility are NEVER touched in any mode.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
import os

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "db"))
load_dotenv(_ROOT / ".env")
from db import DB  # noqa: E402

# ── The FOUR taxonomy columns this runner is allowed to write ──────────────────
FOUR_COLS = ("visual_format", "human_presence", "composition_type", "text_overlay_level")

# Allowed label vocab (matches migrate_v22 doc comments; `unknown` allowed everywhere).
VOCAB = {
    "visual_format":      {"lifestyle", "flat_lay", "collage", "product_only", "text_heavy", "infographic", "unknown"},
    "human_presence":     {"none", "hands", "partial", "full", "unknown"},
    "composition_type":   {"single_focal", "multi_product", "scene", "abstract", "unknown"},
    "text_overlay_level": {"none", "light", "moderate", "heavy", "unknown"},
}

P0 = ["home-decor", "fashion", "womens-fashion", "beauty", "digital-products"]
MAX_BACKFILL = 100
MAX_CONCURRENCY = 2

# LinAPI (OpenAI-compatible) — same provider as web ai-copy visionServer.
LINAPI_KEY = os.environ.get("LINAPI_KEY", "")
LINAPI_BASE = (os.environ.get("LINAPI_BASE_URL") or "https://api.linapi.net/v1").rstrip("/")
VISION_MODEL = os.environ.get("LINAPI_ANALYSIS_MODEL") or "gemini-2.5-flash"

# Gemini 2.5 Flash pricing (LinAPI passthrough, USD per 1M tokens): in $0.30 / out $2.50.
PRICE_IN_PER_M = 0.30
PRICE_OUT_PER_M = 2.50

SCHEMA = """{
  "visual_format": "one of: lifestyle | flat_lay | collage | product_only | text_heavy | infographic | unknown",
  "human_presence": "one of: none | hands | partial | full | unknown",
  "composition_type": "one of: single_focal | multi_product | scene | abstract | unknown",
  "text_overlay_level": "one of: none | light | moderate | heavy | unknown"
}"""

SYSTEM = (
    "You are a precise visual analyst for Pinterest reference images. "
    "Classify ONLY what is visibly true. When genuinely uncertain about a field, output "
    "\"unknown\" for that field rather than guessing. Output STRICT JSON only."
)
USER_PROMPT = (
    "Classify this Pinterest image into these four taxonomy fields. Return STRICT JSON ONLY "
    "matching this schema (values MUST be exactly one of the listed options):\n" + SCHEMA + "\n\n"
    "Definitions:\n"
    "- visual_format: lifestyle=styled real scene; flat_lay=overhead arranged items; "
    "collage=multiple panels/grid; product_only=single product on plain/white bg; "
    "text_heavy=image dominated by words; infographic=structured text+graphics/steps.\n"
    "- human_presence: none / hands (only hands/arms) / partial (cropped body/face) / full (whole person/model).\n"
    "- composition_type: single_focal=one clear subject; multi_product=several products; "
    "scene=environmental setting; abstract=pattern/text/graphic with no physical subject.\n"
    "- text_overlay_level: none / light (small caption) / moderate / heavy (text dominates)."
)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def fetch_image_b64(url: str, client: httpx.Client) -> tuple[str, int] | None:
    """Return (data_url, bytes) or None on failure. One retry for transient CDN blips."""
    for attempt in range(2):
        try:
            r = client.get(url, timeout=20.0, headers={
                "User-Agent": "Mozilla/5.0 (compatible; VibePin/1.0)",
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
            })
            if r.status_code != 200:
                if attempt == 0:
                    time.sleep(1.0); continue
                return None
            ct = (r.headers.get("content-type") or "").split(";")[0].strip()
            if not ct.startswith("image/"):
                return None
            data = r.content
            if not data or len(data) > 10 * 1024 * 1024:
                return None
            return f"data:{ct};base64,{base64.b64encode(data).decode()}", len(data)
        except Exception:
            if attempt == 0:
                time.sleep(1.0); continue
            return None
    return None


def _coerce(label: dict) -> dict:
    """Snap each field to allowed vocab; unknown fallback for anything off-vocab."""
    out = {}
    for col in FOUR_COLS:
        v = str(label.get(col, "unknown")).strip().lower().replace("-", "_").replace(" ", "_")
        out[col] = v if v in VOCAB[col] else "unknown"
    return out


# ── Gateway rate-limit handling (2026-07-13 restart directive #2) ──────────────
# LinAPI throttled sustained concurrency-2 with 429/403 (batch 2 diagnosis).
# Fix: (a) global throttle — >= MIN_CALL_INTERVAL between VLM call STARTS across all
# threads (~0.5 req/s effective); (b) exponential backoff retry on 429/403
# (2s / 8s / 30s). A retry that succeeds does NOT count as a failure; only after
# all retries fail does the row enter the 15% failure budget.
MIN_CALL_INTERVAL = 1.5
RATE_LIMIT_BACKOFFS = (2.0, 8.0, 30.0)
_throttle_lock = threading.Lock()
_last_call_ts = 0.0


def _throttled_vlm_post(http_vlm: httpx.Client, body: dict) -> httpx.Response:
    """POST to LinAPI, globally spaced >= MIN_CALL_INTERVAL between call starts."""
    global _last_call_ts
    with _throttle_lock:
        wait = _last_call_ts + MIN_CALL_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.monotonic()
    return http_vlm.post(
        f"{LINAPI_BASE}/chat/completions",
        headers={"Authorization": f"Bearer {LINAPI_KEY}", "Content-Type": "application/json"},
        json=body, timeout=40.0,
    )


def classify_one(row: dict, http_img: httpx.Client, http_vlm: httpx.Client) -> dict:
    """Returns dict with id, category, image_url, labels, status, tokens."""
    res = {
        "id": row["id"], "category": row.get("category"), "image_url": row.get("image_url"),
        "labels": None, "status": "ok", "tokens_in": 0, "tokens_out": 0, "error": None,
    }
    img = fetch_image_b64(row.get("image_url") or "", http_img)
    if img is None:
        res["status"] = "image_fetch_failed"
        res["error"] = "image_fetch_failed"
        return res
    data_url, _bytes = img
    body = {
        "model": VISION_MODEL,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "reasoning_effort": "none", "thinking_budget": 0, "thinking": {"type": "disabled"},
        "max_tokens": 300,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": [
                {"type": "text", "text": USER_PROMPT},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]},
        ],
    }
    try:
        r = _throttled_vlm_post(http_vlm, body)
        # 429/403 = gateway rate limit → exponential backoff retry (2s/8s/30s).
        # Success on retry is a normal ok row; only exhausted retries count as failure.
        for backoff in RATE_LIMIT_BACKOFFS:
            if r.status_code not in (429, 403):
                break
            res["rate_limit_retries"] = res.get("rate_limit_retries", 0) + 1
            time.sleep(backoff)
            r = _throttled_vlm_post(http_vlm, body)
        if r.status_code != 200:
            res["status"] = f"vlm_http_{r.status_code}"
            res["error"] = r.text[:200]
            return res
        env = r.json()
        usage = env.get("usage") or {}
        res["tokens_in"] = int(usage.get("prompt_tokens") or 0)
        res["tokens_out"] = int(usage.get("completion_tokens") or 0)
        content = (env.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        content = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        first, last = content.find("{"), content.rfind("}")
        if first >= 0 and last > first:
            content = content[first:last + 1]
        raw = json.loads(content)
        res["labels"] = _coerce(raw)
    except Exception as e:
        res["status"] = "vlm_parse_failed"
        res["error"] = str(e)[:200]
    return res


def load_calibration_sample(db: DB) -> list[dict]:
    """10 per P0 category (stratified) from eligible pool → 50 rows."""
    picked: list[dict] = []
    for cat in P0:
        rows = db.select_many(
            "pin_samples",
            columns="id,category,image_url",
            filters={"is_reference_eligible": "is.true", "image_url": "not.is.null", "category": f"eq.{cat}"},
            order="save_count.desc",
            limit=10,
        )
        picked.extend(rows[:10])
    return picked


def load_backfill_sample(db: DB, n: int) -> list[dict]:
    """n eligible rows across P0 categories (proportional-ish, capped at MAX_BACKFILL)."""
    n = min(n, MAX_BACKFILL)
    per = max(1, n // len(P0))
    picked: list[dict] = []
    for cat in P0:
        rows = db.select_many(
            "pin_samples",
            columns="id,category,image_url",
            filters={"is_reference_eligible": "is.true", "image_url": "not.is.null", "category": f"eq.{cat}"},
            order="save_count.desc",
            limit=per + 5,
        )
        picked.extend(rows[:per])
    # top up to n from beauty (largest pool) if rounding left us short
    if len(picked) < n:
        extra = db.select_many(
            "pin_samples", columns="id,category,image_url",
            filters={"is_reference_eligible": "is.true", "image_url": "not.is.null", "category": "eq.beauty"},
            order="save_count.desc", limit=n - len(picked) + 60,
        )
        seen = {r["id"] for r in picked}
        for r in extra:
            if r["id"] not in seen:
                picked.append(r); seen.add(r["id"])
            if len(picked) >= n:
                break
    return picked[:n]


def run_classify(rows: list[dict], concurrency: int) -> list[dict]:
    concurrency = min(concurrency, MAX_CONCURRENCY)
    results: list[dict] = []
    http_img = httpx.Client(follow_redirects=True)
    http_vlm = httpx.Client()
    try:
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(classify_one, r, http_img, http_vlm): r for r in rows}
            for i, fut in enumerate(as_completed(futs), 1):
                res = fut.result()
                results.append(res)
                print(f"  [{i}/{len(rows)}] {res['id'][:8]} cat={res['category']} "
                      f"status={res['status']} labels={res['labels']}", flush=True)
    finally:
        http_img.close(); http_vlm.close()
    return results


def write_backfill(db: DB, results: list[dict]) -> tuple[int, list[str]]:
    """UPDATE only the four columns. Returns (updated_count, updated_ids)."""
    updated_ids: list[str] = []
    written = 0
    for res in results:
        if res["status"] != "ok" or not res["labels"]:
            continue
        payload = {c: res["labels"][c] for c in FOUR_COLS}  # EXACTLY the four columns
        assert set(payload.keys()) == set(FOUR_COLS), "payload must be exactly the four columns"
        db.update_where("pin_samples", data=payload, filters={"id": f"eq.{res['id']}"})
        written += 1
        updated_ids.append(res["id"])
        if written >= MAX_BACKFILL:
            break
    return written, updated_ids


def write_rows_uncapped(db: DB, results: list[dict]) -> tuple[int, list[str]]:
    """PHASE B write: UPDATE only the four columns, no row cap (batch already bounded).
    Only called after the batch has passed the <=15% failure gate."""
    updated_ids: list[str] = []
    written = 0
    for res in results:
        if res["status"] != "ok" or not res["labels"]:
            continue
        payload = {c: res["labels"][c] for c in FOUR_COLS}  # EXACTLY the four columns
        assert set(payload.keys()) == set(FOUR_COLS), "payload must be exactly the four columns"
        db.update_where("pin_samples", data=payload, filters={"id": f"eq.{res['id']}"})
        written += 1
        updated_ids.append(res["id"])
    return written, updated_ids


def load_full_pool(db: DB, exclude_ids: set[str]) -> list[dict]:
    """All eligible rows (any category) minus already-updated ids."""
    rows = db.select_many(
        "pin_samples",
        columns="id,category,image_url",
        filters={"is_reference_eligible": "is.true", "image_url": "not.is.null"},
        order="save_count.desc",
        limit=None,  # paginated by DB class
    )
    return [r for r in rows if r["id"] not in exclude_ids]


def p0_known_rates(db: DB) -> dict:
    """visual_format known-rate (non-null AND != unknown) per P0 category + unknown share."""
    out = {}
    for cat in P0:
        rows = db.select_many(
            "pin_samples", columns="id,visual_format",
            filters={"is_reference_eligible": "is.true", "image_url": "not.is.null", "category": f"eq.{cat}"},
            limit=None,
        )
        total = len(rows)
        known = sum(1 for r in rows if r.get("visual_format") and r["visual_format"] != "unknown")
        unknown = sum(1 for r in rows if r.get("visual_format") == "unknown")
        out[cat] = {
            "total": total, "known": known, "unknown_labeled": unknown,
            "null_unclassified": total - known - unknown,
            "known_rate_pct": round(100 * known / total, 1) if total else 0.0,
        }
    return out


FAILURE_RATE_STOP = 0.15
PHASEB_EVIDENCE = "t4_phaseb_evidence.json"


EVIDENCE_FLUSH_EVERY = 20  # flush cumulative updated_ids to disk every N written rows


def run_full(db: DB, batch_size: int, concurrency: int) -> None:
    """Phase B driver: batched full backfill.

    Session-kill hardening (2026-07-13 restart directive):
      * STREAMING writes — each row is written to DB right after classification
        (four columns only, idempotent), not after the whole batch;
      * evidence file flushed every EVIDENCE_FLUSH_EVERY (20) written rows, so a
        killed process loses at most 19 untracked-but-idempotent rows;
      * runs as a detached OS process (launched via Start-Process), surviving the
        coordinating agent's session;
      * failure gate unchanged: a batch whose failures exceed 15% stops the run —
        checked mid-batch (early abort, remaining calls cancelled) and recorded.
        Rows already written before an abort stay (idempotent, tracked).
    """
    ev_path = _ROOT / "tools" / PHASEB_EVIDENCE
    phase_a_path = _ROOT / "tools" / "t4_backfill_evidence.json"

    exclude: set[str] = set()
    if phase_a_path.exists():
        exclude |= set(json.loads(phase_a_path.read_text(encoding="utf-8"))["updated_ids"])
    ev: dict = {"phase": "B", "started_at": _now_iso(), "model": VISION_MODEL,
                "batches": [], "updated_ids": [], "stopped_reason": None, "final_summary": None}
    if ev_path.exists():  # resume: never re-touch rows already written in phase B
        prev = json.loads(ev_path.read_text(encoding="utf-8"))
        ev["batches"] = prev.get("batches", [])
        ev["updated_ids"] = prev.get("updated_ids", [])
        ev["started_at"] = prev.get("started_at", ev["started_at"])
        exclude |= set(ev["updated_ids"])
        print(f"RESUME: {len(ev['updated_ids'])} rows already written in a prior phase-B run; skipping them.")
    print(f"Excluding {len(exclude)} already-updated ids (phase A + prior phase B).")

    pool = load_full_pool(db, exclude)
    print(f"Remaining pool to classify: {len(pool)} rows; batch_size={batch_size}, "
          f"concurrency<={min(concurrency, MAX_CONCURRENCY)}, evidence flush every {EVIDENCE_FLUSH_EVERY} rows",
          flush=True)

    def _save() -> None:
        tmp = ev_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(ev, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(ev_path)  # never leave a torn evidence file

    t0 = time.time()
    n_batches = (len(pool) + batch_size - 1) // batch_size
    agg = {"total": 0, "ok": 0, "errors": 0, "tokens_in": 0, "tokens_out": 0,
           "unknown_fields": 0, "ok_fields": 0}
    since_flush = 0

    conc = min(concurrency, MAX_CONCURRENCY)
    http_img = httpx.Client(follow_redirects=True)
    http_vlm = httpx.Client()
    try:
        for bi in range(n_batches):
            batch = pool[bi * batch_size:(bi + 1) * batch_size]
            fail_budget = int(FAILURE_RATE_STOP * len(batch))  # abort when failures EXCEED this
            print(f"\n=== BATCH {bi + 1}/{n_batches} ({len(batch)} rows, fail budget {fail_budget}) ===", flush=True)
            w_start = _now_iso()
            b = {"total": 0, "ok": 0, "errors": 0, "tokens_in": 0, "tokens_out": 0,
                 "written": 0, "error_detail": [], "unknown_fields": 0}
            aborted = False

            with ThreadPoolExecutor(max_workers=conc) as ex:
                futs = {ex.submit(classify_one, r, http_img, http_vlm): r for r in batch}
                for i, fut in enumerate(as_completed(futs), 1):
                    res = fut.result()
                    b["total"] += 1
                    b["tokens_in"] += res["tokens_in"]
                    b["tokens_out"] += res["tokens_out"]
                    if res["status"] == "ok" and res["labels"]:
                        b["ok"] += 1
                        b["unknown_fields"] += sum(1 for c in FOUR_COLS if res["labels"][c] == "unknown")
                        # STREAMING write: EXACTLY the four columns, immediately (idempotent).
                        payload = {c: res["labels"][c] for c in FOUR_COLS}
                        assert set(payload.keys()) == set(FOUR_COLS), "payload must be exactly the four columns"
                        db.update_where("pin_samples", data=payload, filters={"id": f"eq.{res['id']}"})
                        b["written"] += 1
                        ev["updated_ids"].append(res["id"])
                        since_flush += 1
                        if since_flush >= EVIDENCE_FLUSH_EVERY:
                            _save(); since_flush = 0
                    else:
                        b["errors"] += 1
                        b["error_detail"].append({"id": res["id"], "status": res["status"], "err": res["error"]})
                    print(f"  [{i}/{len(batch)}] {res['id'][:8]} cat={res['category']} "
                          f"status={res['status']} labels={res['labels']}", flush=True)
                    if b["errors"] > fail_budget:
                        aborted = True
                        ex.shutdown(wait=False, cancel_futures=True)
                        break

            cost = b["tokens_in"] / 1e6 * PRICE_IN_PER_M + b["tokens_out"] / 1e6 * PRICE_OUT_PER_M
            ev["batches"].append({
                "batch_index": bi + 1, "window": {"start_utc": w_start, "end_utc": _now_iso()},
                "total": b["total"], "ok": b["ok"], "errors": b["errors"], "written": b["written"],
                "aborted": aborted, "error_detail": b["error_detail"],
                "tokens_in": b["tokens_in"], "tokens_out": b["tokens_out"], "est_cost_usd": round(cost, 4),
            })
            for k in ("total", "ok", "errors", "tokens_in", "tokens_out", "unknown_fields"):
                agg[k] += b[k]
            agg["ok_fields"] += b["ok"] * len(FOUR_COLS)
            _save(); since_flush = 0

            if aborted:
                rate = b["errors"] / b["total"] if b["total"] else 0
                ev["stopped_reason"] = (f"batch {bi + 1} failures {b['errors']}/{b['total']} ({rate:.1%}) "
                                        f"exceeded {FAILURE_RATE_STOP:.0%} budget — run stopped "
                                        f"(rows already written stay, tracked in updated_ids)")
                _save()
                print(f"\nSTOP: {ev['stopped_reason']}\nEvidence: {ev_path}")
                sys.exit(2)

            print(f"BATCH {bi + 1} done: ok={b['ok']} errors={b['errors']} written={b['written']} "
                  f"cost=${round(cost, 4)} | cumulative written={len(ev['updated_ids'])}", flush=True)
    finally:
        http_img.close(); http_vlm.close()

    cost = agg["tokens_in"] / 1e6 * PRICE_IN_PER_M + agg["tokens_out"] / 1e6 * PRICE_OUT_PER_M
    ev["final_summary"] = {
        "rows_processed": agg["total"],
        "rows_written": len(ev["updated_ids"]),
        "errors": agg["errors"],
        "error_rate": round(agg["errors"] / agg["total"], 4) if agg["total"] else 0,
        "unknown_field_rate": round(agg["unknown_fields"] / agg["ok_fields"], 4) if agg["ok_fields"] else 0,
        "tokens_in": agg["tokens_in"], "tokens_out": agg["tokens_out"],
        "est_cost_usd": round(cost, 4),
        "elapsed_sec": round(time.time() - t0, 1),
        "p0_visual_format_known_rates_after": p0_known_rates(db),
        "rollback_key": "updated_ids list in this file (pin_samples has no updated_at column)",
    }
    _save()
    print("\n=== PHASE B FINAL SUMMARY ===")
    print(json.dumps(ev["final_summary"], indent=2, ensure_ascii=False))
    print(f"\nEvidence: {ev_path}")


def summarize(results: list[dict]) -> dict:
    from collections import Counter
    ok = [r for r in results if r["status"] == "ok" and r["labels"]]
    errors = [r for r in results if r["status"] != "ok"]
    tok_in = sum(r["tokens_in"] for r in results)
    tok_out = sum(r["tokens_out"] for r in results)
    cost = tok_in / 1_000_000 * PRICE_IN_PER_M + tok_out / 1_000_000 * PRICE_OUT_PER_M
    dist = {col: dict(Counter(r["labels"][col] for r in ok)) for col in FOUR_COLS}
    unknown_field_total = sum(
        sum(1 for r in ok if r["labels"][col] == "unknown") for col in FOUR_COLS
    )
    unknown_rate = unknown_field_total / (len(ok) * len(FOUR_COLS)) if ok else 0.0
    return {
        "total": len(results), "ok": len(ok), "errors": len(errors),
        "error_detail": [{"id": r["id"], "status": r["status"], "err": r["error"]} for r in errors],
        "tokens_in": tok_in, "tokens_out": tok_out, "est_cost_usd": round(cost, 4),
        "distributions": dist, "unknown_field_rate": round(unknown_rate, 4),
    }


def build_html(results: list[dict], out_dir: Path) -> None:
    rows_html = []
    for r in results:
        lbl = r["labels"] or {}
        cells = "".join(
            f"<td>{lbl.get(c, '') if r['status'] == 'ok' else ('ERR:' + r['status'])}</td>"
            for c in FOUR_COLS
        )
        img = r.get("image_url") or ""
        rows_html.append(
            f"<tr><td><img loading='lazy' src='{img}' referrerpolicy='no-referrer' "
            f"style='width:120px;height:auto;border-radius:6px'></td>"
            f"<td style='font-family:monospace;font-size:12px'>{r['id'][:8]}</td>"
            f"<td>{r.get('category')}</td>{cells}<td class='manual'></td></tr>"
        )
    html = f"""<h1>T4 Phase A — Reference-pin classification calibration (50 samples)</h1>
<p>Model: {VISION_MODEL} (LinAPI). Predictions written to local file only — NO DB writes for this table.
Fill the "Manual judgment" column per row, then compute agreement rate. `unknown` is a compliant output.</p>
<p>Generated: {_now_iso()}</p>
<style>
 body{{font-family:system-ui,sans-serif;margin:24px;color:#111}}
 table{{border-collapse:collapse;width:100%}}
 th,td{{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}}
 th{{background:#f4f4f4;position:sticky;top:0}}
 td.manual{{min-width:160px;background:#fffbe6}}
 tr:nth-child(even){{background:#fafafa}}
</style>
<table>
 <thead><tr><th>Thumbnail</th><th>pin_id</th><th>category</th>
 <th>visual_format</th><th>human_presence</th><th>composition_type</th><th>text_overlay_level</th>
 <th>Manual judgment (fill in)</th></tr></thead>
 <tbody>
 {''.join(rows_html)}
 </tbody>
</table>
"""
    (out_dir / "index.html").write_text(html, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["calibrate", "backfill", "full"], required=True)
    ap.add_argument("--count", type=int, default=100, help="backfill row count (capped at 100)")
    ap.add_argument("--batch-size", type=int, default=200, help="full mode: rows per batch")
    ap.add_argument("--concurrency", type=int, default=2)
    args = ap.parse_args()

    if not LINAPI_KEY:
        print("ERROR: LINAPI_KEY missing in backend/.env"); sys.exit(1)

    db = DB()
    t0 = time.time()

    if args.mode == "full":
        run_full(db, batch_size=args.batch_size, concurrency=args.concurrency)
        return

    if args.mode == "calibrate":
        rows = load_calibration_sample(db)
        print(f"Loaded {len(rows)} calibration rows (target 50). Classifying (concurrency<=2)...")
        results = run_classify(rows, args.concurrency)
        out_dir = _ROOT.parent / "web" / "artifacts" / "t4-calibration"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "predictions.json").write_text(
            json.dumps({"generated_at": _now_iso(), "model": VISION_MODEL, "results": results}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        build_html(results, out_dir)
        summ = summarize(results)
        summ["elapsed_sec"] = round(time.time() - t0, 1)
        print("\n=== CALIBRATE SUMMARY ===")
        print(json.dumps(summ, indent=2, ensure_ascii=False))
        print(f"\nArtifacts: {out_dir / 'index.html'}\n           {out_dir / 'predictions.json'}")

    else:  # backfill
        n = min(args.count, MAX_BACKFILL)
        rows = load_backfill_sample(db, n)
        print(f"Loaded {len(rows)} backfill rows (cap {MAX_BACKFILL}). Classifying (concurrency<=2)...")
        window_start = _now_iso()
        results = run_classify(rows, args.concurrency)
        # snapshot 5 rows BEFORE write (other-columns-unchanged evidence)
        sample_ids = [r["id"] for r in rows[:5]]
        # NOTE: pin_samples has NO updated_at column. We snapshot the *other* columns this
        # runner must NOT touch (eligibility/quality/etc.) to prove they are unchanged, plus
        # the four columns before/after. Rollback key = explicit updated_ids list (below), not
        # a timestamp window (there is no updated_at to window on).
        OTHER_COLS = "id,is_reference_eligible,reference_quality_score,watermark_detected,image_quality_band,has_clear_subject,scraped_at,save_count"
        before = db.select_many(
            "pin_samples",
            columns=OTHER_COLS + "," + ",".join(FOUR_COLS),
            filters={"id": "in.(" + ",".join(sample_ids) + ")"},
        )
        written, updated_ids = write_backfill(db, results)
        window_end = _now_iso()
        after = db.select_many(
            "pin_samples",
            columns=OTHER_COLS + "," + ",".join(FOUR_COLS),
            filters={"id": "in.(" + ",".join(sample_ids) + ")"},
        )
        summ = summarize(results)
        summ["elapsed_sec"] = round(time.time() - t0, 1)
        summ["written_rows"] = written
        # No updated_at on pin_samples → the authoritative rollback key is the explicit
        # updated_ids list. The wall-clock window is informational only.
        summ["batch_wallclock_window"] = {"start_utc": window_start, "end_utc": window_end}
        summ["rollback_key"] = "explicit updated_ids list (see updated_ids in this file)"
        out_dir = _ROOT / "tools"
        (out_dir / "t4_backfill_evidence.json").write_text(
            json.dumps({
                "summary": summ, "updated_ids": updated_ids,
                "before_snapshot_5": before, "after_snapshot_5": after,
            }, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        print("\n=== BACKFILL SUMMARY ===")
        print(json.dumps(summ, indent=2, ensure_ascii=False, default=str))
        print(f"\nEvidence: {out_dir / 't4_backfill_evidence.json'}")


if __name__ == "__main__":
    main()
