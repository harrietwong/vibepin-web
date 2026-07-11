#!/usr/bin/env python3
"""
Update VPS .env:
- Replace bare PINTEREST_EMAIL= / PINTEREST_PASSWORD= with commented-out, warned versions
- Add PINTEREST_CRAWL_MODE=disabled (default)
- Add PINTEREST_AUTH_CRAWL_ENABLED=false (default)
- Add PINTEREST_CRAWL_SESSION_FILE and safety limit vars
"""
from __future__ import annotations

NEW_ENV_BLOCK = """\

# ── Pinterest crawl mode ─────────────────────────────────────────────────────
# PINTEREST_CRAWL_MODE controls the data pipeline strategy:
#   disabled      → no crawl (current default; use estimated/cached data)
#   anonymous     → anonymous curl_cffi session (Pinterest API blocked this since mid-2025)
#   authenticated → cookie-based authenticated session (TEMPORARY WORKAROUND ONLY)
#
# Production path: apply for Pinterest API / partner / trends access.
# See docs/pinterest-api-architecture.md for full architecture doc.
PINTEREST_CRAWL_MODE=disabled
PINTEREST_AUTH_CRAWL_ENABLED=false

# Pinterest authenticated crawl — TEMPORARY WORKAROUND, NOT PRODUCTION
# Set PINTEREST_CRAWL_MODE=authenticated AND PINTEREST_AUTH_CRAWL_ENABLED=true to enable.
# USE A DISPOSABLE TEST ACCOUNT ONLY. Do NOT use your main Pinterest account.
# Credentials are used once to log in; session cookies are stored in SESSION_FILE
# and reused until expiry (≤25 days). Delete the session file to force re-login.
#
# PINTEREST_EMAIL=your-throwaway-test@example.com
# PINTEREST_PASSWORD=throwaway-test-password
PINTEREST_CRAWL_SESSION_FILE=/opt/vibepin/backend/.pinterest_session.json

# Safety limits for authenticated crawl mode (applied per-run):
PINTEREST_CRAWL_MAX_KEYWORDS_PER_DAY=30
PINTEREST_CRAWL_MAX_REQUESTS_PER_ACCOUNT=150
"""

def run_all():
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("47.89.181.103", port=22, username="root",
                   password="26mXvu2iEMwb!ab", timeout=20)

    sftp = client.open_sftp()
    with sftp.open("/opt/vibepin/backend/.env", "r") as fh:
        env = fh.read().decode("utf-8")
    print(f"Read {len(env)} chars")

    # Remove the bare credentials block I added previously
    lines_out = []
    skip_block = False
    for line in env.splitlines(keepends=True):
        stripped = line.strip()
        # Remove the entire block added by previous patch
        if stripped == "# Pinterest scraper login (required for search API since mid-2025)":
            skip_block = True
        if skip_block:
            if stripped in ("PINTEREST_EMAIL=", "PINTEREST_PASSWORD=", ""):
                continue
            elif not stripped.startswith("#") and stripped not in ("PINTEREST_EMAIL=", "PINTEREST_PASSWORD="):
                skip_block = False
        if not skip_block:
            lines_out.append(line)

    env = "".join(lines_out).rstrip() + "\n"

    # Ensure no bare PINTEREST_EMAIL= or PINTEREST_PASSWORD= lines remain
    final_lines = []
    for line in env.splitlines(keepends=True):
        if line.strip() in ("PINTEREST_EMAIL=", "PINTEREST_PASSWORD="):
            continue
        final_lines.append(line)
    env = "".join(final_lines).rstrip() + "\n"

    # Check if our new block already present
    if "PINTEREST_CRAWL_MODE" in env:
        print("PINTEREST_CRAWL_MODE already in .env — skipping new block")
    else:
        env = env.rstrip() + NEW_ENV_BLOCK
        print("New crawl-mode block appended")

    with sftp.open("/opt/vibepin/backend/.env", "w") as fh:
        fh.write(env.encode("utf-8"))
    sftp.close()

    print("Updated .env:")
    # Show last 30 lines
    for line in env.splitlines()[-30:]:
        print(" ", line)

    client.close()
    print("done.")

if __name__ == "__main__":
    run_all()
