#!/usr/bin/env python3
"""Fix VPS pipeline.py: remove broken guard, re-insert correctly inside step_crawl."""
from __future__ import annotations
import re

def ssh_run(client, cmd, timeout=60):
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

    sftp = client.open_sftp()
    with sftp.open("/opt/vibepin/backend/pipeline.py", "r") as f:
        pipeline = f.read().decode("utf-8")
    sftp.close()

    lines = pipeline.splitlines()
    print(f"pipeline.py: {len(pipeline)} chars, {len(lines)} lines\n")

    # --- Show lines around line 38 (where the error is) ---
    print("Lines 30-55 (error area):")
    for i, l in enumerate(lines[29:55], start=30):
        print(f"  {i:3}: {l!r}")

    print()

    # --- Find step_crawl to understand file structure ---
    sc_line = next((i for i, l in enumerate(lines) if "def step_crawl" in l), None)
    print(f"step_crawl at line: {sc_line + 1 if sc_line is not None else 'NOT FOUND'}")
    if sc_line is not None:
        print(f"  {sc_line+1}: {lines[sc_line]!r}")
        for j in range(sc_line+1, min(sc_line+8, len(lines))):
            print(f"  {j+1}: {lines[j]!r}")

    print()

    # --- Remove broken guard block ---
    # Strategy: find the block by the unique comment markers
    # The guard starts with a comment containing "Search-crawl guard"
    # and ends with "End guard" or the return statement
    clean = pipeline

    # Pattern 1: exact guard with comment markers
    clean = re.sub(
        r'[ \t]*# [─\-]+ Search-crawl guard.*?# [─\-]+ End guard [─\-]+\n\n?',
        '', clean, count=1, flags=re.DOTALL
    )

    # Pattern 2: the broken import lines that were inserted at module level
    # Matches the specific lines we inserted
    clean = re.sub(
        r'[ \t]*# [─\-]+ Search-crawl guard[^\n]*\n'
        r'[ \t]*# [^\n]*\n'
        r'[ \t]*# [^\n]*\n'
        r'[ \t]*# [^\n]*\n'
        r'[ \t]*import os as _os\n'
        r'[ \t]*from dotenv import load_dotenv as _lde; _lde\(\)\n'
        r'[ \t]*if _os\.getenv\("PINTEREST_SEARCH_CRAWL_ENABLED".*?\n'
        r'[ \t]*print\([^\n]*\n'
        r'[ \t]*print\([^\n]*\n'
        r'[ \t]*return \{[^\n]*\n'
        r'[ \t]*"reason"[^\n]*\}\}\n'
        r'[ \t]*# [─\-]+ End guard[^\n]*\n\n?',
        '', clean, count=1, flags=re.DOTALL
    )

    # Pattern 3: simpler fallback — just the import lines if they leaked to module level
    # (import at column 0 or with exactly 4 spaces of indent outside a function)
    if "import os as _os" in clean:
        # Check if it appears outside a function (bad)
        bad_match = re.search(
            r'^\s*import os as _os\n\s*from dotenv import load_dotenv as _lde.*?\n'
            r'\s*if _os\.getenv.*?\n(?:.*\n){1,5}?\s*return \{[^\n]*"skipped"[^\n]*\}\n',
            clean, flags=re.MULTILINE | re.DOTALL
        )
        if bad_match:
            clean = clean[:bad_match.start()] + clean[bad_match.end():]
            print(f"Removed broken block via pattern 3, {len(clean)} chars")

    changed = (clean != pipeline)
    print(f"Removal changed file: {changed}")

    # Check syntax of cleaned version
    sftp = client.open_sftp()
    sftp.open("/opt/vibepin/backend/pipeline_fix_test.py", "w").write(clean.encode("utf-8"))
    sftp.close()
    out, _ = ssh_run(client, "cd /opt/vibepin/backend && .venv/bin/python3 -c 'import importlib.util; s=importlib.util.spec_from_file_location(\"p\",\"pipeline_fix_test.py\"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(\"syntax OK\")' 2>&1", timeout=30)
    print(f"Cleaned syntax: {out.strip()}")
    ssh_run(client, "rm -f /opt/vibepin/backend/pipeline_fix_test.py")

    if "syntax OK" not in out:
        print("ERROR: cleaned file still has syntax errors — aborting, not modifying pipeline.py")
        print("Check lines 30-55 output above to manually inspect the bad block")
        client.close()
        return

    print("Cleaned file is valid.\n")

    # --- Find step_crawl body and insert guard at correct indentation ---
    # Find the function
    func_pat = re.search(r'^(\s*)(async\s+)?def\s+step_crawl\s*\(', clean, re.MULTILINE)
    if not func_pat:
        print("ERROR: step_crawl not found in cleaned file")
        client.close()
        return

    func_idx = func_pat.start()
    func_indent = func_pat.group(1)  # e.g. "" if top-level, "    " if in a class
    body_indent = func_indent + "    "  # function body is one level deeper
    print(f"step_crawl at char {func_idx}, func_indent={func_indent!r}, body_indent={body_indent!r}")

    # Find the colon that ends the function signature
    # Walk from func_idx to find matching ':' at the right nesting level
    # Simple: find ':\n' after the closing ')' of the function signature
    paren_depth = 0
    i = func_idx
    sig_colon = -1
    while i < len(clean):
        c = clean[i]
        if c == '(':
            paren_depth += 1
        elif c == ')':
            paren_depth -= 1
            if paren_depth == 0:
                # Find the ':' after this closing paren (skip -> return type)
                rest = clean[i:]
                colon_m = re.search(r':\s*\n', rest)
                if colon_m:
                    sig_colon = i + colon_m.end()
                break
        i += 1

    if sig_colon < 0:
        print("ERROR: could not find function body start")
        client.close()
        return

    print(f"Function body starts at char {sig_colon}")

    # Skip optional docstring
    pos = sig_colon
    # Skip blank lines
    while pos < len(clean) and clean[pos:clean.find('\n', pos)+1].strip() == '':
        pos = clean.find('\n', pos) + 1

    # Check for docstring
    if clean[pos:pos+len(body_indent)+3] in (body_indent+'"""', body_indent+"'''"):
        quote = clean[pos+len(body_indent):pos+len(body_indent)+3]
        end_q = clean.find(quote, pos + len(body_indent) + 3)
        if end_q >= 0:
            pos = clean.find('\n', end_q + 3) + 1

    # Skip blank lines after docstring
    while pos < len(clean) and clean[pos:clean.find('\n', pos)+1].strip() == '':
        pos = clean.find('\n', pos) + 1

    print(f"Insertion point: char {pos}")
    print(f"Next 120 chars: {clean[pos:pos+120]!r}")

    # Verify the insertion point is at the right indentation
    line_end = clean.find('\n', pos)
    first_line = clean[pos:line_end]
    actual_indent = len(first_line) - len(first_line.lstrip())
    print(f"First body line indent: {actual_indent} spaces")
    if actual_indent != len(body_indent):
        # Use actual detected indent
        body_indent = ' ' * actual_indent
        print(f"Adjusted body_indent to {actual_indent} spaces")

    # Guard block
    i1 = body_indent
    i2 = body_indent + "    "
    guard = (
        f"{i1}# Search-crawl guard: skip on VPS datacenter IP (soft-blocked by Pinterest)\n"
        f"{i1}import os as _scg_os\n"
        f"{i1}from dotenv import load_dotenv as _scg_ld; _scg_ld()\n"
        f"{i1}if _scg_os.getenv('PINTEREST_SEARCH_CRAWL_ENABLED', 'true').lower() == 'false':\n"
        f"{i2}print('  [crawl] PINTEREST_SEARCH_CRAWL_ENABLED=false — skipped on this host')\n"
        f"{i2}return {{'processed': 0, 'pins': 0, 'premium': 0, 'skipped': True}}\n"
        f"\n"
    )

    patched = clean[:pos] + guard + clean[pos:]

    # Final syntax check
    sftp = client.open_sftp()
    sftp.open("/opt/vibepin/backend/pipeline_fix_test.py", "w").write(patched.encode("utf-8"))
    sftp.close()
    out, _ = ssh_run(client, "cd /opt/vibepin/backend && .venv/bin/python3 -c 'import importlib.util; s=importlib.util.spec_from_file_location(\"p\",\"pipeline_fix_test.py\"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(\"final syntax OK\")' 2>&1", timeout=30)
    print(f"\nFinal patched syntax: {out.strip()}")
    ssh_run(client, "rm -f /opt/vibepin/backend/pipeline_fix_test.py")

    if "final syntax OK" not in out:
        print("ERROR: patched file fails syntax check — not writing to pipeline.py")
        client.close()
        return

    # Write the fixed file
    sftp = client.open_sftp()
    sftp.open("/opt/vibepin/backend/pipeline.py", "w").write(patched.encode("utf-8"))
    sftp.close()
    print(f"\nWritten {len(patched)} chars to /opt/vibepin/backend/pipeline.py")

    # Verify
    out, _ = ssh_run(client, "grep -n 'PINTEREST_SEARCH_CRAWL_ENABLED\\|step_crawl\\|Search-crawl' /opt/vibepin/backend/pipeline.py | head -12")
    print("Verification grep:\n", out)

    client.close()
    print("done.")

if __name__ == "__main__":
    run_all()
