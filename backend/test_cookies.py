import sys; sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from chrome_cookies import get_cookies

profile = Path.home() / "AppData/Local/PinterestScraper/profile"
cookies = get_cookies(profile, domains=["pinterest.com"])
print(f"Total pinterest cookies: {len(cookies)}")
for c in cookies:
    v = c['value']
    printable = v[:40] if all(32 <= ord(ch) < 127 for ch in v[:40]) else f"[binary-ish len={len(v)}]"
    print(f"  {c['domain']:<30} {c['name']:<25} len={len(v):>6}  val={printable}")
