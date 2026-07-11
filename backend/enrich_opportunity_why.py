"""
enrich_opportunity_why.py
─────────────────────────
Generates why_this_opportunity for NULL rows in the opportunities table
using an OpenAI-compatible API.

Key priority (first found in .env wins):
  1. OPENAI_API_KEY  → OpenAI  (model: gpt-4o-mini)
  2. LINAPI_KEY      → LinAPI proxy (model: LINAPI_ANALYSIS_MODEL or gemini-2.5-flash)
  3. GEMINI_API_KEY  → Google Gemini OpenAI-compat endpoint (model: gemini-2.0-flash)

Usage:
  py enrich_opportunity_why.py --limit 10   # test 10 rows
  py enrich_opportunity_why.py              # full run
  py enrich_opportunity_why.py --dry-run    # print output, no DB writes
  py enrich_opportunity_why.py --batch 5    # 5 rows per batch (default 10)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Prompt constants ──────────────────────────────────────────────────────────

MAX_TOKENS  = 120
BATCH_SLEEP = 1.0

SYSTEM_PROMPT = (
    "You write short, direct Pinterest opportunity summaries for digital product sellers. "
    "Be specific and actionable. Max 2 sentences. No fluff."
)

USER_PROMPT_TEMPLATE = """\
Keyword: {canonical_keyword}
Category: {category}
Label: {primary_label}, {trend_state}
Demand: {search_interest_band}, Competition: {competition_band}

Write a 1-2 sentence opportunity summary explaining:
- why this is worth making content for right now
- what type of digital product fits best (printable/template/planner/SVG/wall art etc)
Keep it under 25 words per sentence.\
"""

# ── Provider detection ────────────────────────────────────────────────────────

@dataclass
class Provider:
    name:     str
    api_key:  str
    base_url: str | None
    model:    str


def _detect_provider() -> Provider:
    """Return the first configured provider, in priority order."""
    openai_key = os.getenv("OPENAI_API_KEY", "")
    if openai_key:
        return Provider(
            name="OpenAI",
            api_key=openai_key,
            base_url=None,                  # use SDK default
            model="gpt-4o-mini",
        )

    linapi_key = os.getenv("LINAPI_KEY", "")
    if linapi_key:
        base_url = os.getenv("LINAPI_BASE_URL", "https://api.linapi.net/v1")
        model    = os.getenv("LINAPI_ANALYSIS_MODEL", "gemini-2.5-flash")
        return Provider(
            name=f"LinAPI ({model})",
            api_key=linapi_key,
            base_url=base_url,
            model=model,
        )

    gemini_key = os.getenv("GEMINI_API_KEY", "")
    if gemini_key:
        return Provider(
            name="Gemini",
            api_key=gemini_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            model="gemini-2.0-flash",
        )

    return Provider(name="", api_key="", base_url=None, model="")


# ── DB helpers ────────────────────────────────────────────────────────────────

def _load_opportunities(limit: int | None) -> list[dict]:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "db"))
    from db import select_many  # type: ignore

    return select_many(
        "opportunities",
        filters={"why_this_opportunity": "is.null"},
        order="confidence_score.desc.nullslast,score.desc.nullslast",
        limit=limit,
    ) or []


def _write_why(opp_id: str, text: str) -> None:
    from db import update_where  # type: ignore

    # update_where adds "eq." prefix automatically — pass the raw UUID
    update_where(
        "opportunities",
        updates={"why_this_opportunity": text},
        filters={"id": opp_id},
    )


# ── LLM call ─────────────────────────────────────────────────────────────────

def _build_prompt(row: dict) -> str:
    return USER_PROMPT_TEMPLATE.format(
        canonical_keyword=row.get("canonical_keyword") or row.get("title") or "unknown",
        category=(row.get("category") or "general").replace("-", " "),
        primary_label=row.get("primary_label") or "Steady",
        trend_state=row.get("trend_state") or "Evergreen",
        search_interest_band=row.get("search_interest_band") or "Medium",
        competition_band=row.get("competition_band") or "Medium",
    )


def _call_llm(client, model: str, prompt: str) -> str:
    response = client.chat.completions.create(
        model=model,
        max_tokens=MAX_TOKENS,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
    )
    return response.choices[0].message.content.strip()


# ── Main ──────────────────────────────────────────────────────────────────────

def run(limit: int | None = None, batch: int = 10, dry_run: bool = False) -> None:
    provider = _detect_provider()

    if not provider.api_key:
        log.error(
            "No API key found. Add one of the following to backend/.env:\n"
            "  OPENAI_API_KEY=sk-...          (OpenAI, gpt-4o-mini)\n"
            "  LINAPI_KEY=sk-...              (LinAPI proxy, uses LINAPI_ANALYSIS_MODEL)\n"
            "  GEMINI_API_KEY=AIza...         (Google Gemini)"
        )
        sys.exit(1)

    log.info("Provider: %s | model: %s", provider.name, provider.model)

    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        log.error("openai package not installed. Run: pip install openai")
        sys.exit(1)

    client_kwargs: dict = {"api_key": provider.api_key}
    if provider.base_url:
        client_kwargs["base_url"] = provider.base_url
    client = OpenAI(**client_kwargs)

    log.info("Loading opportunities with why_this_opportunity IS NULL (limit=%s) …", limit or "all")
    rows = _load_opportunities(limit)
    log.info("Found %d rows to enrich", len(rows))

    if not rows:
        log.info("Nothing to do — all rows already have why_this_opportunity set.")
        return

    ok = failed = 0

    for batch_start in range(0, len(rows), batch):
        chunk = rows[batch_start : batch_start + batch]

        for row in chunk:
            opp_id  = row["id"]
            keyword = row.get("canonical_keyword") or row.get("title") or "?"
            prompt  = _build_prompt(row)

            if dry_run:
                log.info("  [dry] %s", keyword[:50])
                log.info("        prompt → %s", prompt.split("\n")[0])
                ok += 1
                continue

            try:
                text = _call_llm(client, provider.model, prompt)
            except Exception as exc:
                log.warning("  FAIL [%s] %s — %s", opp_id[:8], keyword[:40], exc)
                failed += 1
                continue

            try:
                _write_why(opp_id, text)
                log.info("  OK   %s → %s", keyword[:40], text[:90])
                ok += 1
            except Exception as exc:
                log.warning("  WRITE FAIL [%s] %s — %s", opp_id[:8], keyword[:40], exc)
                failed += 1

        if batch_start + batch < len(rows):
            log.info("  … batch %d/%d done, sleeping %.1fs",
                     batch_start // batch + 1, -(-len(rows) // batch), BATCH_SLEEP)
            time.sleep(BATCH_SLEEP)

    log.info("Done — ok=%d  failed=%d  dry_run=%s", ok, failed, dry_run)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Enrich opportunities.why_this_opportunity via OpenAI-compatible API"
    )
    parser.add_argument("--limit",   type=int, default=None, help="Max rows (default: all)")
    parser.add_argument("--batch",   type=int, default=10,   help="Rows per batch (default: 10)")
    parser.add_argument("--dry-run", action="store_true",    help="No DB writes, just log")
    args = parser.parse_args()

    run(limit=args.limit, batch=args.batch, dry_run=args.dry_run)
