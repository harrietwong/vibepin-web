import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import browser_cookie3

# Get Chrome cookies for pinterest.com
cj = browser_cookie3.chrome(domain_name=".pinterest.com")

pinterest_cookies = []
for c in cj:
    if "pinterest" in c.domain:
        pinterest_cookies.append(c)
        v = c.value[:60] if c.value else ""
        print(f"  {c.domain:<30} {c.name:<25} = {v!r}")

print(f"\nTotal pinterest cookies: {len(pinterest_cookies)}")

# Check if we have session cookie
auth = next((c for c in pinterest_cookies if c.name == "_auth"), None)
sess = next((c for c in pinterest_cookies if c.name == "_pinterest_sess"), None)
print(f"_auth present: {auth is not None} (len={len(auth.value) if auth else 0})")
print(f"_pinterest_sess present: {sess is not None} (len={len(sess.value) if sess else 0})")
if sess:
    print(f"_pinterest_sess value[:80]: {sess.value[:80]!r}")
