"""
run_scheduler.py — Automated keyword vault scheduler for the Pinterest data engine.

Loops through a curated keyword vault by niche, calling scraper_v2.py for each
keyword with anti-ban cooldowns and live progress logging.

Usage:
  py run_scheduler.py                          # all niches, full pipeline
  py run_scheduler.py --category home          # home decor only
  py run_scheduler.py --category jewelry       # jewelry only
  py run_scheduler.py --no-db --dry-run        # preview without writing
  py run_scheduler.py --delay-min 45 --delay-max 120 --proxy http://user:pass@host:port
  py run_scheduler.py --shuffle --no-stl       # random order, skip shop-the-look
"""

import argparse, os, random, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

# Force UTF-8 so box-drawing / ANSI characters render on Windows terminals.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent

# ── ANSI colours (Windows 11 Terminal / VS Code support these natively) ──────
GREEN  = "\033[92m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BLUE   = "\033[94m"
RED    = "\033[91m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RESET  = "\033[0m"

# ── Keyword Vault ─────────────────────────────────────────────────────────────
# ~100 hand-curated, high-intent seeds across four frontend niches.
# Each keyword is a known high-engagement Pinterest search phrase.
KEYWORD_VAULT: dict[str, list[str]] = {

    "home": [
        # Cozy / Warm
        "cozy kitchen aesthetic apartment",
        "cozy living room aesthetic ideas",
        "cozy bedroom decor aesthetic",
        "warm toned living room ideas",
        "moody living room decor ideas",
        "cozy reading nook ideas aesthetic",
        # Mid-century / Retro
        "mid-century modern living room",
        "mid-century modern bedroom ideas",
        "vintage home decor aesthetic",
        "retro kitchen aesthetic ideas",
        # Japandi / Minimalist / Scandinavian
        "japandi bedroom ideas aesthetic",
        "japandi living room aesthetic",
        "minimalist home aesthetic ideas",
        "scandinavian home decor ideas",
        "wabi sabi home decor aesthetic",
        # Boho / Eclectic / Maximalist
        "boho living room decor ideas",
        "boho bedroom aesthetic ideas",
        "eclectic home decor ideas",
        "maximalist home decor aesthetic",
        # Cottagecore / Dark Academia
        "cottagecore kitchen aesthetic ideas",
        "dark academia home decor",
        "dark academia bedroom aesthetic",
        # Coastal / Natural / Earthy
        "coastal grandmother living room",
        "earthy home decor aesthetic ideas",
        "terracotta home decor ideas 2025",
        "sage green bedroom ideas aesthetic",
        # Specific spaces
        "aesthetic home office setup ideas",
        "bathroom aesthetic decor ideas",
        "gallery wall ideas aesthetic",
        "luxury bedroom ideas aesthetic",
        "small space living room ideas",
        "outdoor patio decor aesthetic",
        "green indoor plant home decor",
    ],

    "fashion": [
        # Quiet luxury / Old money
        "old money aesthetic outfits women",
        "quiet luxury fashion aesthetic",
        "old money outfit ideas 2025",
        "quiet luxury wardrobe essentials",
        # Trendy aesthetics
        "coastal grandmother outfit ideas",
        "dark academia outfit women aesthetic",
        "cottagecore aesthetic outfit ideas",
        "mob wife aesthetic fashion outfits",
        "coquette aesthetic outfits women",
        "ballet core fashion aesthetic",
        "ballet core outfit ideas women",
        # Clean / Minimal
        "clean girl aesthetic outfits",
        "minimalist fashion aesthetic women",
        "capsule wardrobe aesthetic ideas",
        "neutral aesthetic outfits women",
        # Streetwear / Y2K
        "y2k fashion aesthetic women 2025",
        "streetwear aesthetic women outfits",
        "indie sleaze fashion women",
        "grunge aesthetic outfits women",
        # Preppy / Coastal
        "preppy aesthetic outfits women",
        "coastal aesthetic outfits women",
        "resort wear fashion aesthetic",
        "nautical fashion aesthetic women",
        # Feminine / Romantic
        "feminine aesthetic outfits ideas",
        "romantic fashion aesthetic women",
        "boho chic outfit ideas women",
        "floral aesthetic outfit ideas",
        # Seasonal / Western
        "fall fashion aesthetic women 2025",
        "summer aesthetic outfits women",
        "western fashion aesthetic outfits",
        "leopard print outfit ideas aesthetic",
    ],

    "beauty": [
        # Makeup aesthetics
        "clean girl makeup aesthetic look",
        "soft glam makeup look tutorial",
        "no makeup makeup look tutorial",
        "glazed donut skin aesthetic makeup",
        "editorial makeup ideas aesthetic",
        "bold lip makeup ideas aesthetic",
        "blush makeup aesthetic look",
        "cat eye makeup ideas aesthetic",
        # Trend-specific
        "mob wife beauty aesthetic makeup",
        "ballet core makeup look aesthetic",
        "dark academia makeup ideas",
        "coquette makeup aesthetic look",
        "y2k makeup aesthetic look",
        "old money beauty aesthetic makeup",
        # Natural / Glow
        "natural makeup everyday look",
        "glossy skin aesthetic makeup",
        "dewy skin makeup routine aesthetic",
        "glass skin makeup aesthetic",
        # Nails
        "coquette nail art ideas aesthetic",
        "glazed donut nails aesthetic 2025",
        "aesthetic nail ideas 2025",
        "french manicure ideas aesthetic",
        "summer nail art ideas 2025",
        "chrome nails aesthetic ideas",
        "floral nail art aesthetic ideas",
        # Skincare / Routine
        "aesthetic skincare routine products",
        "skincare shelfie aesthetic ideas",
        "minimalist beauty aesthetic routine",
        "glass skin skincare routine",
        "gua sha skincare routine aesthetic",
    ],

    "jewelry": [
        # Gold / Dainty / Layered
        "dainty gold jewelry aesthetic",
        "layered gold necklace ideas aesthetic",
        "gold jewelry aesthetic stack",
        "chunky gold jewelry aesthetic",
        "gold chain necklace aesthetic",
        # Vintage / Pearl
        "vintage jewelry aesthetic ideas",
        "pearl jewelry aesthetic ideas",
        "vintage pearl necklace aesthetic",
        "pearl earrings aesthetic ideas",
        # Ring stacks
        "aesthetic ring stack ideas",
        "minimalist ring stack aesthetic",
        "gold ring stack aesthetic 2025",
        "diamond ring aesthetic ideas",
        # Statement / Boho
        "statement earrings aesthetic ideas",
        "boho jewelry aesthetic ideas",
        "geometric jewelry design aesthetic",
        "hoop earrings aesthetic ideas",
        # Trend aesthetics
        "old money jewelry aesthetic",
        "coquette jewelry aesthetic ideas",
        "old money pearl jewelry aesthetic",
        "quiet luxury jewelry aesthetic",
        "ballet core jewelry aesthetic",
        "mob wife jewelry aesthetic",
        "gemstone jewelry aesthetic ideas",
        "sustainable jewelry aesthetic",
    ],
}

# Map vault categories that don't exist in scraper_v2.py to their closest equivalent.
# scraper_v2.py supports: home, fashion, beauty
SCRAPER_CAT_MAP: dict[str, str] = {
    "jewelry": "fashion",   # jewelry uses fashion-style analysis
}


# ── Logging helpers ───────────────────────────────────────────────────────────

def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def _banner(msg: str) -> None:
    w = 72
    print(f"\n{BOLD}{CYAN}{'=' * w}{RESET}")
    print(f"{BOLD}{CYAN}  {msg}{RESET}")
    print(f"{BOLD}{CYAN}{'=' * w}{RESET}\n")


def _section(msg: str) -> None:
    print(f"\n{BOLD}{YELLOW}>>  {msg}{RESET}")


def _ok(msg: str) -> None:
    print(f"{GREEN}  [OK]  {msg}{RESET}")


def _info(msg: str) -> None:
    print(f"{CYAN}   -   {msg}{RESET}")


def _warn(msg: str) -> None:
    print(f"{YELLOW}  [!]  {msg}{RESET}")


def _err(msg: str) -> None:
    print(f"{RED}  [X]  {msg}{RESET}")


# ── Subprocess runner ─────────────────────────────────────────────────────────

def run_keyword(
    keyword: str,
    category: str,
    extra_flags: list[str],
    dry_run: bool,
) -> bool:
    """
    Invoke scraper_v2.py for one keyword. Streams output live with colour coding.
    Returns True when the subprocess exits with code 0.
    """
    scraper_cat = SCRAPER_CAT_MAP.get(category, category)

    cmd = [
        sys.executable, str(ROOT / "scraper_v2.py"),
        "--category", scraper_cat,
        "--keyword",  keyword,
        "--limit-keywords", "1",
    ] + extra_flags

    _info(f"cmd: py scraper_v2.py --category {scraper_cat} --keyword \"{keyword}\" "
          f"{' '.join(extra_flags)}")

    if dry_run:
        _warn("DRY RUN — subprocess skipped")
        return True

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if not line:
                continue
            # Colour key events for scanability
            if any(k in line for k in ("[HG]", "PREMIUM", "is_high_growth")):
                print(f"  {GREEN}{BOLD}{line}{RESET}")
            elif "[db]" in line:
                print(f"  {CYAN}{line}{RESET}")
            elif any(k in line for k in ("[warn]", "Error", "FAIL", "error:")):
                print(f"  {YELLOW}{line}{RESET}")
            elif any(k in line for k in ("[P]", "save_velocity", "premium")):
                print(f"  {BLUE}{line}{RESET}")
            else:
                print(f"  {DIM}{line}{RESET}")
        proc.wait()
        return proc.returncode == 0
    except Exception as exc:
        _err(f"subprocess failed: {exc}")
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Pinterest scheduler — loops keyword vault through the data engine."
    )
    ap.add_argument("--category", default="all",
                    choices=["home", "fashion", "beauty", "jewelry", "all"],
                    help="Vault niche to run (default: all)")
    ap.add_argument("--proxy",      default=None,
                    help="Proxy URL forwarded to scraper_v2.py")
    ap.add_argument("--delay-min",  type=int, default=30,
                    help="Min cooldown seconds between keywords (default 30)")
    ap.add_argument("--delay-max",  type=int, default=90,
                    help="Max cooldown seconds between keywords (default 90)")
    ap.add_argument("--no-stl",     action="store_true",
                    help="Disable --auto-stl (skip shop-the-look enrichment)")
    ap.add_argument("--no-related", action="store_true",
                    help="Disable --expand-related (skip related-pin expansion)")
    ap.add_argument("--no-db",      action="store_true",
                    help="Disable --db (write JSONL only, skip Supabase)")
    ap.add_argument("--no-filter",  action="store_true",
                    help="Pass --no-filter to scraper (collect all pins, ignore thresholds)")
    ap.add_argument("--shuffle",    action="store_true",
                    help="Randomise keyword order within each niche")
    ap.add_argument("--dry-run",    action="store_true",
                    help="Print commands without executing anything")
    args = ap.parse_args()

    # Enable ANSI escape codes on Windows (no-op on other OSes)
    os.system("")

    # ── Build execution queue ─────────────────────────────────────────────────
    selected_cats = (
        list(KEYWORD_VAULT.keys()) if args.category == "all" else [args.category]
    )
    queue: list[tuple[str, str]] = []   # [(keyword, category), ...]
    for cat in selected_cats:
        kws = list(KEYWORD_VAULT[cat])
        if args.shuffle:
            random.shuffle(kws)
        for kw in kws:
            queue.append((kw, cat))

    total = len(queue)

    # ── Build scraper flags ───────────────────────────────────────────────────
    extra_flags: list[str] = []
    if not args.no_related:
        extra_flags.append("--expand-related")
    if not args.no_stl:
        extra_flags.append("--auto-stl")
    if not args.no_db:
        extra_flags.append("--db")
    if args.no_filter:
        extra_flags.append("--no-filter")
    if args.proxy:
        extra_flags += ["--proxy", args.proxy]

    # ── Header ────────────────────────────────────────────────────────────────
    _banner(f"Pinterest Data Engine Scheduler  | {total} keywords queued")
    _info(f"Niches    : {', '.join(selected_cats)}")
    _info(f"Flags     : {' '.join(extra_flags) or '(none)'}")
    _info(f"Cooldown  : {args.delay_min}–{args.delay_max}s between keywords")
    _info(f"Shuffle   : {'yes' if args.shuffle else 'no'}")
    _info(f"Dry run   : {'YES' if args.dry_run else 'no'}")

    # ── Execution loop ────────────────────────────────────────────────────────
    success = 0
    failed  = 0
    run_start = time.monotonic()

    for idx, (keyword, cat) in enumerate(queue, 1):
        # ETA calculation
        elapsed = time.monotonic() - run_start
        if idx > 1:
            avg_s = elapsed / (idx - 1)
            remaining_s = avg_s * (total - idx + 1)
            rm, rs = divmod(int(remaining_s), 60)
            rh, rm = divmod(rm, 60)
            eta = f"{rh}h{rm:02d}m{rs:02d}s" if rh else f"{rm}m{rs:02d}s"
        else:
            eta = "—"

        pct = f"{100 * (idx - 1) // total}%"

        _section(
            f"[{idx}/{total}]  {pct} done  | ETA {eta}  | {_ts()} UTC"
        )
        print(f"  {BOLD}keyword : {RESET}{keyword}")
        print(f"  {BOLD}niche   : {RESET}{cat}  "
              f"{'(→ scraper cat: ' + SCRAPER_CAT_MAP[cat] + ')' if cat in SCRAPER_CAT_MAP else ''}")

        ok = run_keyword(keyword, cat, extra_flags, args.dry_run)

        if ok:
            success += 1
            _ok(f"Keyword done  | {success} successful so far")
        else:
            failed += 1
            _err(f"Keyword failed  | {failed} failed so far")

        # Cooldown before next keyword (skip after the last one)
        if idx < total:
            delay = random.randint(args.delay_min, args.delay_max)
            _info(f"Cooling down {delay}s  -> next: \"{queue[idx][0]}\"")
            if not args.dry_run:
                # Show a live countdown so the operator knows the script is alive
                for remaining in range(delay, 0, -5):
                    print(f"\r  {DIM}  {remaining}s remaining...{RESET}   ", end="", flush=True)
                    time.sleep(min(5, remaining))
                print(f"\r  {DIM}  ready.{RESET}                  ")

    # ── Final summary ─────────────────────────────────────────────────────────
    total_elapsed = time.monotonic() - run_start
    te_m, te_s = divmod(int(total_elapsed), 60)
    te_h, te_m = divmod(te_m, 60)
    elapsed_str = f"{te_h}h{te_m:02d}m{te_s:02d}s" if te_h else f"{te_m}m{te_s:02d}s"

    _banner(
        f"Run complete  | {success}/{total} succeeded  | "
        f"{failed} failed  | {elapsed_str} elapsed"
    )
    if failed:
        _warn(f"{failed} keyword(s) returned a non-zero exit code. "
              "Check the output above for details.")


if __name__ == "__main__":
    main()
