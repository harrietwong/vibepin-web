#!/usr/bin/env python3
"""
Patch VPS pipeline.py to skip the search-crawl step when
PINTEREST_SEARCH_CRAWL_ENABLED=false (default on VPS).

Also update VPS .env to set PINTEREST_SEARCH_CRAWL_ENABLED=false.

The VPS daily cron keeps running: trends, stl-score, product_scores.
Crawl is skipped with a clear log message.
"""
from __future__ import annotations

CRAWL_GUARD = '''\
    # ── Search-crawl guard ──────────────────────────────────────────────────
    # Set PINTEREST_SEARCH_CRAWL_ENABLED=false on VPS to skip Pinterest search
    # scraping from datacenter IPs (which are soft-blocked by Pinterest).
    # Local residential runner handles crawl; VPS handles everything else.
    import os as _os
    from dotenv import load_dotenv as _lde; _lde()
    if _os.getenv("PINTEREST_SEARCH_CRAWL_ENABLED", "true").lower() == "false":
        print("  [crawl] PINTEREST_SEARCH_CRAWL_ENABLED=false — skipping search crawl on this host")
        print("  [crawl] Crawl runs on local residential machine; VPS handles scoring only.")
        return {"processed": 0, "pins": 0, "premium": 0, "skipped": True,
                "reason": "PINTEREST_SEARCH_CRAWL_ENABLED=false"}
    # ── End guard ────────────────────────────────────────────────────────────

'''

def ssh_run(client, cmd, timeout=60):
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return out, err
    except Exception as e:
        return "", str(e)

def run_all():
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("47.89.181.103", port=22, username="root",
                   password="26mXvu2iEMwb!ab", timeout=20)

    sftp = client.open_sftp()

    # ── 1. Patch pipeline.py ────────────────────────────────────────────────
    with sftp.open("/opt/vibepin/backend/pipeline.py", "r") as f:
        pipeline = f.read().decode("utf-8")
    print(f"Read pipeline.py: {len(pipeline)} chars")

    # Find step_crawl function body start — insert guard right after the docstring
    # or after the first line of the function body
    ANCHOR = "async def step_crawl"
    if ANCHOR not in pipeline:
        ANCHOR = "def step_crawl"

    if "PINTEREST_SEARCH_CRAWL_ENABLED" in pipeline:
        print("Guard already in pipeline.py — skipping")
    else:
        idx = pipeline.find(ANCHOR)
        if idx < 0:
            print("ERROR: step_crawl not found in pipeline.py")
        else:
            # Find the function body start: skip past def line, then past any docstring
            body_start = pipeline.find(":\n", idx) + 2  # after the colon+newline
            # Skip blank lines and docstring
            pos = body_start
            while pos < len(pipeline) and pipeline[pos] in (" ", "\t", "\n"):
                pos += 1
            # If it starts with triple-quote, skip past docstring
            if pipeline[pos:pos+3] in ('"""', "'''"):
                quote = pipeline[pos:pos+3]
                end_q = pipeline.find(quote, pos + 3)
                if end_q >= 0:
                    pos = end_q + 3
                    # skip to end of that line
                    pos = pipeline.find("\n", pos) + 1

            # Insert guard at pos
            pipeline = pipeline[:pos] + CRAWL_GUARD + pipeline[pos:]
            print(f"Guard inserted at pos {pos}")

        with sftp.open("/opt/vibepin/backend/pipeline.py", "w") as f:
            f.write(pipeline.encode("utf-8"))
        print(f"Written {len(pipeline)} chars")

    # ── 2. Update VPS .env ───────────────────────────────────────────────────
    with sftp.open("/opt/vibepin/backend/.env", "r") as f:
        env = f.read().decode("utf-8")

    if "PINTEREST_SEARCH_CRAWL_ENABLED" in env:
        print(".env already has PINTEREST_SEARCH_CRAWL_ENABLED")
    else:
        # Append to the crawl-mode block
        insertion = "\nPINTEREST_SEARCH_CRAWL_ENABLED=false  # VPS datacenter IP is soft-blocked; crawl runs locally\n"
        old = "PINTEREST_AUTH_CRAWL_ENABLED=false"
        env = env.replace(old, old + insertion, 1)
        with sftp.open("/opt/vibepin/backend/.env", "w") as f:
            f.write(env.encode("utf-8"))
        print("Added PINTEREST_SEARCH_CRAWL_ENABLED=false to VPS .env")

    sftp.close()

    # ── 3. Syntax check ──────────────────────────────────────────────────────
    out, err = ssh_run(client, "cd /opt/vibepin/backend && .venv/bin/python3 -c 'import pipeline; print(\"pipeline syntax OK\")' 2>&1")
    print("Syntax:", out.strip(), err[:200] if err else "")

    # ── 4. Verify ─────────────────────────────────────────────────────────────
    out, _ = ssh_run(client, "grep -n 'PINTEREST_SEARCH_CRAWL_ENABLED' /opt/vibepin/backend/pipeline.py /opt/vibepin/backend/.env")
    print("Verification:\n", out)

    client.close()
    print("done.")

if __name__ == "__main__":
    run_all()
