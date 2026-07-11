"""Run STL for target categories with lower min-saves threshold."""
import subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).parent
PY = sys.executable

# Categories with 0 or few products, ordered by pin count (most first)
TARGETS = [
    "entertainment",   # 557 pins >500
    "art",             # 694 pins >500 (only 2 products so far)
    "animals",         # 279 pins >500
    "parenting",       # 242 pins >500
    "electronics",     # 202 pins >500
    "food-and-drink",  # 181 pins >500
    "design",          # 174 pins >500
    "finance",         # 173 pins >500
    "architecture",    # 202 pins >500 (only 4 products)
    "sports",          # 138 pins >500
    "quotes",          # 110 pins >500
    "gardening",       #  91 pins >500
    "automotive",      #  62 pins >500
]

LIMIT = 20       # pins per category
MIN_SAVES = 500  # lower threshold

print(f"Running STL for {len(TARGETS)} categories: limit={LIMIT}, min_saves={MIN_SAVES}")
print("="*60)

for i, cat in enumerate(TARGETS, 1):
    print(f"\n[{i}/{len(TARGETS)}] {cat} ...", flush=True)
    start = time.time()
    result = subprocess.run(
        [PY, "-u", "shop_the_look.py", "--db",
         "--category", cat,
         "--min-saves", str(MIN_SAVES),
         "--limit", str(LIMIT)],
        cwd=ROOT,
        capture_output=False,
    )
    elapsed = int(time.time() - start)
    status = "OK" if result.returncode == 0 else f"ERR({result.returncode})"
    print(f"  [{status}] {cat} done in {elapsed}s", flush=True)

print("\nAll done.")
