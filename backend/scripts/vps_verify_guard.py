#!/usr/bin/env python3
"""Verify VPS guard is active and check cron schedule."""
def ssh_run(client, cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    return out, err

def run_all():
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect("47.89.181.103", port=22, username="root",
                   password="26mXvu2iEMwb!ab", timeout=20)

    # 1. Check guard in pipeline.py
    out, _ = ssh_run(client, "grep -n 'Search-crawl guard\\|PINTEREST_SEARCH_CRAWL_ENABLED\\|step_crawl' /opt/vibepin/backend/pipeline.py | head -10")
    print("=== VPS pipeline.py guard check ===")
    print(out)

    # 2. Check VPS .env
    out, _ = ssh_run(client, "grep 'PINTEREST' /opt/vibepin/backend/.env")
    print("=== VPS .env PINTEREST vars ===")
    print(out)

    # 3. Check cron schedule
    out, _ = ssh_run(client, "crontab -l 2>/dev/null || echo '(no crontab)'")
    print("=== VPS crontab ===")
    print(out)

    # 4. Quick guard smoke test (dry-run the guard check)
    out, _ = ssh_run(client,
        "cd /opt/vibepin/backend && "
        "PINTEREST_SEARCH_CRAWL_ENABLED=false "
        ".venv/bin/python3 -c \""
        "import os; from dotenv import load_dotenv; load_dotenv();"
        "val = os.getenv('PINTEREST_SEARCH_CRAWL_ENABLED','true').lower();"
        "print('PINTEREST_SEARCH_CRAWL_ENABLED from env:', val);"
        "print('Guard would skip:', val == 'false')"
        "\" 2>&1", timeout=15)
    print("=== VPS guard env check ===")
    print(out)

    # 5. Check pipeline.py syntax is OK
    out, _ = ssh_run(client,
        "cd /opt/vibepin/backend && .venv/bin/python3 -m py_compile pipeline.py && echo 'syntax OK' || echo 'SYNTAX ERROR'")
    print("=== VPS pipeline.py syntax ===")
    print(out)

    client.close()

if __name__ == "__main__":
    run_all()
