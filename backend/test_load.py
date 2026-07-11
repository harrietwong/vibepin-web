import sys
sys.argv = ["scraper.py", "--category", "home", "--limit-keywords", "2", "--dry-run"]
import scraper
args = scraper._parse_args()
records = scraper._load_seed_records(args)
print(f"Loaded {len(records)} records")
for r in records:
    print(f"  [{r['category']}] {r['keyword']}  score={r['priority_score']:.0f}")
