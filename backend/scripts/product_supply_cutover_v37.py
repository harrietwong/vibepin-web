#!/usr/bin/env python3
"""Minimal, reversible VPS cutover for the Product-Supply path.

The script intentionally has a tiny manifest and never replaces the backend tree.
It stages reviewed files, verifies hashes/tools, stops only the Product-Supply timer,
backs up every target, installs atomically, and leaves the timer stopped until an
explicit ``enable`` action after dry-run + canary evidence.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import inspect
import io
import json
import os
import posixpath
import shlex
import sys
import time
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

import paramiko


BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
from product_supply_receipt_contract import (
    batch_receipts_are_safe as _batch_receipts_are_safe,
    validate_scheduled_origin,
)


REMOTE_BACKEND = "/opt/vibepin/backend"
SERVICE = "vibepin-product-supply.service"
TIMER = "vibepin-product-supply.timer"
SCHEDULED_PHYSICAL_MIX = {
    "fashion": 36,
    "womens-fashion": 28,
    "home-decor": 36,
}


def _is_pinterest_hosted_url(value: object) -> bool:
    """Complete host-family check safe to inject into the remote read-only audit."""
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        host = (urlsplit(value).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    return (
        host == "pinterest.com"
        or host.endswith(".pinterest.com")
        or host.startswith("pinterest.")
        or ".pinterest." in host
        or host == "pinimg.com"
        or host.endswith(".pinimg.com")
        or host.startswith("pinimg.")
        or ".pinimg." in host
    )


def _source_provenance_is_safe(
    product_rows: object,
    source_rows: object,
    allowed_categories: object,
) -> bool:
    """Bind each inserted Product row back to its exact selected Source Pin."""
    if not isinstance(product_rows, list) or not isinstance(source_rows, list):
        return False
    if not product_rows:
        return source_rows == []
    if not isinstance(allowed_categories, (set, list, tuple)):
        return False
    allowed = {str(value).strip() for value in allowed_categories if str(value).strip()}
    if not allowed:
        return False
    source_by_pin: dict[str, dict] = {}
    for source in source_rows:
        if not isinstance(source, dict):
            return False
        pin_id = str(source.get("pin_id") or "").strip()
        if not pin_id or pin_id in source_by_pin:
            return False
        source_by_pin[pin_id] = source
    expected_pin_ids: set[str] = set()
    for row in product_rows:
        if not isinstance(row, dict):
            return False
        pin_id = str(row.get("source_pin_id") or "").strip()
        parent_pin_id = str(row.get("parent_pin_id") or "").strip()
        category = str(row.get("source_category") or "").strip()
        seed_keyword = str(row.get("seed_keyword") or "").strip()
        source = source_by_pin.get(pin_id)
        try:
            source_pin_url = urlsplit(str(row.get("source_pin_url") or ""))
        except ValueError:
            return False
        if (
            not pin_id.isdigit()
            or parent_pin_id != pin_id
            or category not in allowed
            or not seed_keyword
            or source is None
            or (source_pin_url.hostname or "").lower().rstrip(".") != "www.pinterest.com"
            or source_pin_url.path.rstrip("/") != f"/pin/{pin_id}"
            or str(source.get("category") or "").strip() != category
            or str(source.get("seed_keyword") or source.get("source_keyword") or "").strip()
            != seed_keyword
        ):
            return False
        expected_pin_ids.add(pin_id)
    return expected_pin_ids == set(source_by_pin)


def _validate_scheduled_origin(origin: object) -> None:
    try:
        validate_scheduled_origin(
            origin,
            timer_unit=TIMER,
            max_service_duration_seconds=6310,
        )
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc

# Deliberately excludes product_harvest.py/product_lifecycle.py: the production copies
# contain newer reviewed retailer/short-link support and are unchanged by this cutover.
MANIFEST = {
    "supply_core.py": f"{REMOTE_BACKEND}/supply_core.py",
    "shop_the_look_expand.py": f"{REMOTE_BACKEND}/shop_the_look_expand.py",
    "run_worker.py": f"{REMOTE_BACKEND}/run_worker.py",
    "tools/t2_harvest.py": f"{REMOTE_BACKEND}/tools/t2_harvest.py",
    "scripts/run_bootstrap_product_supply.py":
        f"{REMOTE_BACKEND}/scripts/run_bootstrap_product_supply.py",
    "scripts/preflight_product_supply.py":
        f"{REMOTE_BACKEND}/scripts/preflight_product_supply.py",
    "scripts/validate_product_supply_merchants.py":
        f"{REMOTE_BACKEND}/scripts/validate_product_supply_merchants.py",
    "scripts/cloud_run_product_supply.sh":
        f"{REMOTE_BACKEND}/scripts/cloud_run_product_supply.sh",
    "deploy/systemd/vibepin-product-supply.service":
        f"/etc/systemd/system/{SERVICE}",
    "deploy/systemd/vibepin-product-supply.timer":
        f"/etc/systemd/system/{TIMER}",
}
EXECUTABLES = {"scripts/cloud_run_product_supply.sh"}


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    for key in ("VPS_HOST", "VPS_PASSWORD"):
        if not out.get(key):
            raise SystemExit(f"{key} is missing from {path}")
    out.setdefault("VPS_USER", "root")
    out.setdefault("VPS_PORT", "22")
    return out


def connect(cfg: dict[str, str]) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    # Deployment credentials must never be offered to an unverified endpoint.
    # The operator provisions the VPS key in the normal OpenSSH known_hosts
    # file; an absent or changed key is a hard stop before authentication.
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(
        cfg["VPS_HOST"],
        port=int(cfg["VPS_PORT"]),
        username=cfg["VPS_USER"],
        password=cfg["VPS_PASSWORD"],
        timeout=30,
    )
    transport = client.get_transport()
    if transport is not None:
        # Long 100-source dry-runs/canaries are intentionally quiet on the SSH
        # channel while systemd owns their output. Keep the control channel alive
        # so an idle timeout cannot hide the unit's final status/journal receipt.
        transport.set_keepalive(30)
    return client


def run(client: paramiko.SSHClient, command: str, *, timeout: int = 120,
        check: bool = True) -> tuple[int, str, str]:
    wrapped = f"bash -lc {shlex.quote(command)}"
    _stdin, stdout, stderr = client.exec_command(wrapped, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if check and code != 0:
        raise RuntimeError(
            f"remote command failed ({code}): {command}\n"
            f"{(err or out)[-2000:]}"
        )
    return code, out, err


def committed_bytes(rel: str) -> bytes:
    """Return the reviewed Git blob, never autocrlf/dirty worktree bytes."""
    return subprocess.check_output(
        ["git", "show", f"HEAD:backend/{rel}"], cwd=BACKEND.parent,
    )


def manifest_sha(rel: str) -> str:
    return hashlib.sha256(committed_bytes(rel)).hexdigest()


def git_short() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "--short=12", "HEAD"], cwd=BACKEND.parent,
        text=True,
    ).strip()


def assert_free(client: paramiko.SSHClient) -> None:
    for lock in (
        "/opt/vibepin/locks/cloud_run_product_supply.lock",
        "/opt/vibepin/locks/pin_products_writer.lock",
    ):
        code, _out, _err = run(
            client, f"mkdir -p /opt/vibepin/locks && flock -n {shlex.quote(lock)} -c true",
            check=False,
        )
        if code != 0:
            raise RuntimeError(f"live lock is held: {lock}")
    code, out, _err = run(
        client,
        "pgrep -af '[r]un_bootstrap_product_supply|[s]hop_the_look_expand|"
        "[r]un_worker.py.*product-supply' || true",
        check=False,
    )
    if out.strip():
        raise RuntimeError(f"Product-Supply process still running:\n{out.strip()}")


def status(client: paramiko.SSHClient) -> None:
    commands = {
        "time": "TZ=Asia/Shanghai date --iso-8601=seconds",
        "timer": (
            f"systemctl is-enabled {TIMER}; systemctl is-active {TIMER}; "
            f"systemctl list-timers {TIMER} --no-pager"
        ),
        "service": (
            f"systemctl is-active {SERVICE} || true; "
            f"systemctl show {SERVICE} -p Result -p ExecMainStatus -p ActiveEnterTimestamp"
        ),
        "locks": (
            "for f in /opt/vibepin/locks/cloud_run_product_supply.lock "
            "/opt/vibepin/locks/pin_products_writer.lock; do "
            "flock -n \"$f\" -c true && echo FREE:$f || echo HELD:$f; done"
        ),
        "processes": (
            "pgrep -af '[r]un_bootstrap_product_supply|[s]hop_the_look_expand|"
            "[r]un_worker.py.*product-supply' || true"
        ),
        "tools": "systemd-analyze --version | head -1; shellcheck --version | head -2",
    }
    for label, command in commands.items():
        code, out, err = run(client, command, check=False)
        print(f"=== {label} (exit {code}) ===")
        print((out or err).strip() or "(empty)")


def shellcheck_bin(client: paramiko.SSHClient, stage_root: str, *, provision: bool) -> str:
    code, out, _err = run(client, "command -v shellcheck", check=False)
    if code == 0 and out.strip():
        return out.strip().splitlines()[-1]
    extracted = f"{stage_root}/tools/shellcheck-root/usr/bin/shellcheck"
    code, _out, _err = run(client, f"test -x {shlex.quote(extracted)}", check=False)
    if code == 0:
        return extracted
    if not provision:
        raise RuntimeError("shellcheck is absent and no staged verified binary exists")

    # Do not install a package into the VPS. Download the Ubuntu-repository .deb into
    # this isolated staging directory and extract only its shellcheck binary. apt's
    # configured signed package metadata supplies the integrity authority.
    tools = f"{stage_root}/tools"
    run(client, f"mkdir -p {shlex.quote(tools)} && cd {shlex.quote(tools)} && apt-get download shellcheck")
    run(client, (
        f"cd {shlex.quote(tools)} && deb=$(find . -maxdepth 1 -name 'shellcheck_*.deb' "
        "-print -quit) && test -n \"$deb\" && "
        f"dpkg-deb -x \"$deb\" {shlex.quote(tools + '/shellcheck-root')}"
    ))
    run(client, f"test -x {shlex.quote(extracted)} && {shlex.quote(extracted)} --version")
    return extracted


def stage(client: paramiko.SSHClient, stage_id: str) -> str:
    stage_root = f"/opt/vibepin/staging/product-supply-{stage_id}"
    run(client, f"mkdir -p {shlex.quote(stage_root)}")
    sftp = client.open_sftp()
    try:
        for rel in MANIFEST:
            data = committed_bytes(rel)
            remote = f"{stage_root}/{rel}"
            run(client, f"mkdir -p {shlex.quote(posixpath.dirname(remote))}")
            temp = remote + ".upload"
            sftp.putfo(io.BytesIO(data), temp, file_size=len(data), confirm=True)
            sftp.rename(temp, remote)
            expected = hashlib.sha256(data).hexdigest()
            _code, out, _err = run(client, f"sha256sum {shlex.quote(remote)}")
            actual = out.split()[0]
            if actual != expected:
                raise RuntimeError(f"staged hash mismatch for {rel}: {actual} != {expected}")
            print(f"STAGED {rel} sha256={actual}")
    finally:
        sftp.close()

    python_files = [f"{stage_root}/{rel}" for rel in MANIFEST if rel.endswith(".py")]
    run(client, f"{REMOTE_BACKEND}/.venv/bin/python -m py_compile " +
        " ".join(shlex.quote(p) for p in python_files))
    wrapper = f"{stage_root}/scripts/cloud_run_product_supply.sh"
    service_unit = f"{stage_root}/deploy/systemd/vibepin-product-supply.service"
    timer_unit = f"{stage_root}/deploy/systemd/vibepin-product-supply.timer"
    run(client, f"bash -n {shlex.quote(wrapper)}")
    sc = shellcheck_bin(client, stage_root, provision=True)
    run(client, f"{shlex.quote(sc)} {shlex.quote(wrapper)}")
    run(
        client,
        "systemd-analyze verify "
        f"{shlex.quote(service_unit)} {shlex.quote(timer_unit)}",
    )
    print(f"STAGE_PASS {stage_root}")
    return stage_root


def _restore(client: paramiko.SSHClient, backup_root: str,
             existed: dict[str, bool]) -> None:
    for rel, dest in MANIFEST.items():
        # A backup failure can occur before every manifest entry has been
        # inspected. Unknown entries have not been installed yet and must be
        # left untouched rather than turning rollback into a masking KeyError.
        if rel not in existed:
            continue
        key = rel.replace("/", "__")
        if existed[rel]:
            run(client, f"cp -a {shlex.quote(backup_root + '/' + key)} {shlex.quote(dest)}")
        else:
            run(client, f"rm -f {shlex.quote(dest)}")
    run(client, "systemctl daemon-reload")


def activate(client: paramiko.SSHClient, stage_root: str, stage_id: str) -> str:
    assert_free(client)
    code, out, _err = run(client, f"systemctl is-active {SERVICE}", check=False)
    if code == 0 and out.strip() == "active":
        raise RuntimeError(f"{SERVICE} is active; refusing cutover")

    # Freeze the old Product-Supply schedule across both normal operation and a
    # reboot. Merely stopping an enabled timer would let timers.target restart it
    # before the candidate dry-run/canary gates have passed.
    run(client, f"systemctl disable --now {TIMER}")
    assert_free(client)

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup_root = f"/opt/vibepin/backups/product-supply-{stage_id}-{stamp}"
    run(client, f"mkdir -p {shlex.quote(backup_root)}")
    existed: dict[str, bool] = {}
    try:
        for rel, dest in MANIFEST.items():
            code, _out, _err = run(client, f"test -e {shlex.quote(dest)}", check=False)
            if code == 0:
                key = rel.replace("/", "__")
                run(client, f"cp -a {shlex.quote(dest)} {shlex.quote(backup_root + '/' + key)}")
                # Record an existing file only after its backup is durable.
                existed[rel] = True
            else:
                existed[rel] = False

        for rel, dest in MANIFEST.items():
            src = f"{stage_root}/{rel}"
            mode = "0755" if rel in EXECUTABLES else "0644"
            run(client, f"install -D -m {mode} {shlex.quote(src)} {shlex.quote(dest)}")

        run(client, "systemctl daemon-reload")
        for rel, dest in MANIFEST.items():
            expected = manifest_sha(rel)
            _code, out, _err = run(client, f"sha256sum {shlex.quote(dest)}")
            actual = out.split()[0]
            if actual != expected:
                raise RuntimeError(f"installed hash mismatch for {rel}: {actual} != {expected}")
        run(client, f"bash -n {REMOTE_BACKEND}/scripts/cloud_run_product_supply.sh")
        sc = shellcheck_bin(client, stage_root, provision=False)
        run(client, f"{shlex.quote(sc)} {REMOTE_BACKEND}/scripts/cloud_run_product_supply.sh")
        run(
            client,
            "systemd-analyze verify "
            f"/etc/systemd/system/{SERVICE} /etc/systemd/system/{TIMER}",
        )
        run(client, (
            f"cd {REMOTE_BACKEND} && .venv/bin/python -c "
            + shlex.quote(
                "import supply_core as c, shop_the_look_expand as s; "
                "assert c.MAX_BATCH == 20; assert c.MAX_RUN_ADMISSIONS == 50; "
                "assert s.supply_core.apply_rows is c.apply_rows; print('IMPORT_CONTRACT_PASS')"
            )
        ))
        print(f"ACTIVATE_PASS backup={backup_root}")
        return backup_root
    except Exception:
        print("ACTIVATE_FAILED: restoring exact prior files; timer remains stopped", file=sys.stderr)
        _restore(client, backup_root, existed)
        raise


def transient_run(client: paramiko.SSHClient, mode: str,
                  source_report: str | None = None) -> str:
    assert_free(client)
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    unit = f"vibepin-product-supply-cutover-{mode}-{stamp}"
    limit = 100
    mix = "fashion:29,womens-fashion:22,home-decor:29,digital-products:20"
    settings = [
        "--property=Type=oneshot",
        f"--property=WorkingDirectory={REMOTE_BACKEND}",
        f"--property=EnvironmentFile={REMOTE_BACKEND}/.env",
        "--property=TimeoutStartSec=6300",
        "--property=TimeoutStopSec=60",
        "--property=KillMode=control-group",
        "--setenv=VIBEPIN_LOCK_DIR=/opt/vibepin/locks",
        "--setenv=VIBEPIN_TIMEOUT_SECONDS=5400",
        f"--setenv=VIBEPIN_SUPPLY_LIMIT={limit}",
        f"--setenv=VIBEPIN_CATEGORY_MIX={mix}",
        "--setenv=VIBEPIN_STL_ALLOW_EXCLUDED=digital-products",
        "--setenv=VIBEPIN_SUPPLY_SINCE_HOURS=720",
        "--setenv=VIBEPIN_SUPPLY_WRITE_LIMIT=1",
        "--setenv=STL_WRITE_BATCH_SIZE=10",
        "--setenv=STL_GOTO_TIMEOUT_MS=45000",
        "--setenv=STL_PIN_TIMEOUT_SECONDS=120",
    ]
    if mode == "canary":
        settings.append("--setenv=VIBEPIN_APPLY_CONFIRM=APPLY_BOOTSTRAP_PRODUCTS")
        if not source_report:
            raise ValueError("canary requires the reviewed dry-run source report")
        settings.append(f"--setenv=VIBEPIN_SUPPLY_SOURCE_REPORT={source_report}")
        wrapper_mode = "apply"
    else:
        wrapper_mode = "dry-run"
    command = " ".join([
        "systemd-run", "--quiet", "--wait", "--collect", f"--unit={unit}",
        *settings,
        f"{REMOTE_BACKEND}/scripts/cloud_run_product_supply.sh", wrapper_mode,
    ])
    code, out, err = run(client, command, timeout=6600, check=False)
    print((out or err).strip())
    _jcode, journal, _jerr = run(
        client, f"journalctl -u {unit}.service --no-pager -n 160", check=False,
    )
    print(journal[-24000:])
    if code != 0:
        raise RuntimeError(f"{mode} transient unit failed with exit {code}")
    assert_free(client)
    print(f"{mode.upper()}_PASS unit={unit}.service")
    return unit


def audit_latest(
    client: paramiko.SSHClient,
    *,
    require_canary_write: bool,
    require_scheduled_run: bool = False,
) -> dict:
    payload = r'''
import json
import datetime as dt
import os
import subprocess
from pathlib import Path
import httpx
import supply_core as core
from urllib.parse import urlsplit

__PINTEREST_HOST_GATE__

__BATCH_RECEIPT_GATE__

__SOURCE_PROVENANCE_GATE__

def systemd_value(unit, prop):
    env = dict(os.environ)
    env["TZ"] = "UTC"
    return subprocess.check_output(
        ["systemctl", "show", unit, "-p", prop, "--value"],
        text=True,
        env=env,
    ).strip()

def systemd_time(unit, prop):
    raw = systemd_value(unit, prop)
    if not raw or raw == "n/a":
        return None
    return dt.datetime.strptime(
        raw,
        "%a %Y-%m-%d %H:%M:%S UTC",
    ).replace(tzinfo=dt.timezone.utc).isoformat()

p = Path("logs/product_supply_expand_shop_the_look_latest.json")
r = json.loads(p.read_text(encoding="utf-8"))
outcome = r.get("writeOutcome") or {}
ids = [str(x) for x in outcome.get("insertedIds") or [] if x]
selection = r.get("sourceSelection") or r.get("selection") or {}
category_mix = selection.get("categoryMixFromSourceReport")
if not category_mix:
    category_mix = {
        str(category): int((details or {}).get("selected") or 0)
        for category, details in (selection.get("byCategory") or {}).items()
    }
batch_receipts = outcome.get("batchReceipts") or []
receipt_ids = [
    str(inserted_id)
    for receipt in batch_receipts
    for inserted_id in (receipt.get("insertedIds") or [])
    if inserted_id
]
receipts_safe = batch_receipts_are_safe(batch_receipts, ids)
rows = []
if ids:
    flt = ",".join(ids)
    with httpx.Client(timeout=30) as c:
        resp = c.get(
            f"{core.SUPABASE_URL}/rest/v1/pin_products?select=id,source_url,parent_pin_id,source_pin_id,source_pin_url,source_category,seed_keyword,image_url,product_name,detail_fetch_status,discovery_method&id=in.({flt})",
            headers=core._headers(),
        )
        resp.raise_for_status()
        rows = resp.json()
source_pin_ids = sorted({str(row.get("source_pin_id") or "").strip() for row in rows if row.get("source_pin_id")})
source_rows = []
if source_pin_ids and all(pin_id.isdigit() for pin_id in source_pin_ids):
    source_filter = ",".join(source_pin_ids)
    with httpx.Client(timeout=30) as c:
        source_resp = c.get(
            f"{core.SUPABASE_URL}/rest/v1/pin_samples?select=pin_id,category,seed_keyword,source_keyword&pin_id=in.({source_filter})",
            headers=core._headers(),
        )
        source_resp.raise_for_status()
        source_rows = source_resp.json()
source_provenance_safe = _source_provenance_is_safe(
    rows,
    source_rows,
    set((category_mix or {}).keys()),
)
inserted_source_category_counts = {}
for row in rows:
    category = str(row.get("source_category") or "")
    inserted_source_category_counts[category] = inserted_source_category_counts.get(category, 0) + 1
safe = all(
    row.get("source_url") and "pinterest.com" not in row["source_url"]
    and (row.get("source_pin_url") or "").startswith("https://www.pinterest.com/pin/")
    and row.get("image_url")
    and not _is_pinterest_hosted_url(row["image_url"])
    and row.get("detail_fetch_status") == core.DETAIL_AVAILABLE
    and row.get("discovery_method") == core.DISCOVERY_METHOD
    for row in rows
) and source_provenance_safe
summary = {
    "reportPath": str(p.resolve()),
    "mode": r.get("mode"),
    # Frozen-source apply reports use sourceSelection; older dry-run reports
    # used selection.  Prefer the current authority but keep the fallback so
    # historical reports remain inspectable.
    "selectedTotal": selection.get("selectedTotal"),
    "categoryMix": category_mix,
    "writes": ((r.get("writes") or {}).get("pin_products") or 0),
    "written": outcome.get("inserted", outcome.get("written", 0)),
    "failedWrites": outcome.get("failed", 0),
    "writeErrors": outcome.get("errors") or [],
    "insertedIds": ids,
    "readbackCount": len(rows),
    "readbackSafe": safe and len(rows) == len(ids),
    "sourcePinCount": len(source_pin_ids),
    "sourceReadbackCount": len(source_rows),
    "sourceProvenanceSafe": source_provenance_safe,
    "insertedSourceCategoryCounts": inserted_source_category_counts,
    "batchReceiptsSafe": receipts_safe,
    "batchReceiptCount": len(batch_receipts),
    "receiptInsertedIdCount": len(receipt_ids),
    "failedBatches": (r.get("incrementalWrite") or {}).get("failedBatches") or [],
    "batchesFailed": (r.get("incrementalWrite") or {}).get("batchesFailed") or 0,
    "runAdmissionCap": (r.get("incrementalWrite") or {}).get("runAdmissionCap"),
    "atomicWriteBatchCap": (r.get("incrementalWrite") or {}).get("atomicWriteBatchCap"),
    "merchantDiscoveryCandidateCap": (
        (r.get("incrementalWrite") or {}).get("merchantDiscoveryCandidateCap")
    ),
    "resultTrust": (r.get("dataQuality") or {}).get("resultTrust"),
    "authenticatedRun": (r.get("dataQuality") or {}).get("authenticatedRun"),
    "renderFailureCount": (r.get("aggregate") or {}).get("renderFailureCount"),
    "productJsonResponses": (r.get("aggregate") or {}).get("productJsonResponses"),
    "pinsWithZeroProductJson": (r.get("aggregate") or {}).get("pinsWithZeroProductJson"),
    "responseErrorCount": (r.get("responseErrors") or {}).get("count", 0),
    "responseErrorSamples": list((r.get("responseErrors") or {}).get("samples") or [])[:10],
    "supplyFunnel": {
        "sourcePinsScanned": (r.get("aggregate") or {}).get("sourcePinsScanned"),
        "rawProductCandidates": (r.get("aggregate") or {}).get("rawProductCandidates"),
        "rejectedProductCandidates": (r.get("aggregate") or {}).get("rejectedProducts"),
        "acceptedBeforeDedup": (r.get("aggregate") or {}).get("acceptedBeforeDedup"),
        "duplicatesSkippedWithinRun": (r.get("aggregate") or {}).get("duplicatesSkipped"),
        "uniqueAcceptedCandidates": (r.get("aggregate") or {}).get("uniqueAcceptedProducts"),
        "alreadyInDatabase": (r.get("incrementalWrite") or {}).get("rowsSkippedAlreadyInDb"),
        "crossBatchDuplicates": (r.get("incrementalWrite") or {}).get("rowsSkippedCrossBatchDuplicate"),
        "skippedByRunAdmissionCap": (r.get("incrementalWrite") or {}).get("rowsSkippedRunAdmissionCap"),
        "merchantDiscoveryAttempts": outcome.get("coreCandidates"),
        "merchantVerified": outcome.get("merchantDiscovered"),
        "merchantVerificationFailures": outcome.get("merchantDiscoveryFailures"),
        "writeDuplicates": outcome.get("duplicates"),
        "safeLegacyRowsWritten": outcome.get("inserted", outcome.get("written", 0)),
        "productNamesPresent": sum(
            1 for row in rows if str(row.get("product_name") or "").strip()
        ),
        "productNamesMissing": sum(
            1 for row in rows if not str(row.get("product_name") or "").strip()
        ),
    },
    "scheduledOrigin": {
        "timerUnitFileState": systemd_value("vibepin-product-supply.timer", "UnitFileState"),
        "timerActiveState": systemd_value("vibepin-product-supply.timer", "ActiveState"),
        "timerLastTriggerAt": systemd_time("vibepin-product-supply.timer", "LastTriggerUSec"),
        "timerNextTriggerAt": systemd_time("vibepin-product-supply.timer", "NextElapseUSecRealtime"),
        "serviceResult": systemd_value("vibepin-product-supply.service", "Result"),
        "serviceExecMainStatus": systemd_value("vibepin-product-supply.service", "ExecMainStatus"),
        "serviceStartAt": systemd_time("vibepin-product-supply.service", "ExecMainStartTimestamp"),
        "serviceExitAt": systemd_time("vibepin-product-supply.service", "ExecMainExitTimestamp"),
        "serviceInvocationId": systemd_value("vibepin-product-supply.service", "InvocationID"),
        "serviceTriggeredBy": systemd_value("vibepin-product-supply.service", "TriggeredBy"),
        "reportGeneratedAt": r.get("generatedAt"),
        "reportMtimeAt": dt.datetime.fromtimestamp(
            p.stat().st_mtime,
            tz=dt.timezone.utc,
        ).isoformat(),
    },
}
print(json.dumps(summary, ensure_ascii=False))
'''.replace(
        "__PINTEREST_HOST_GATE__",
        inspect.getsource(_is_pinterest_hosted_url),
    )
    payload = payload.replace(
        "__BATCH_RECEIPT_GATE__",
        inspect.getsource(_batch_receipts_are_safe),
    )
    payload = payload.replace(
        "__SOURCE_PROVENANCE_GATE__",
        inspect.getsource(_source_provenance_is_safe),
    )
    import base64
    encoded = base64.b64encode(payload.encode()).decode()
    command = (
        f"cd {REMOTE_BACKEND} && .venv/bin/python -c "
        + shlex.quote(f"import base64;exec(base64.b64decode('{encoded}'))")
    )
    _code, out, _err = run(client, command)
    summary = json.loads(out.strip().splitlines()[-1])
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    _validate_audit_summary(
        summary,
        require_canary_write=require_canary_write,
        require_scheduled_run=require_scheduled_run,
    )
    return summary


def _validate_audit_summary(
    summary: dict,
    *,
    require_canary_write: bool,
    require_scheduled_run: bool = False,
) -> None:
    """Fail closed on canary and scheduled-run contracts without conflating them."""
    if require_canary_write and require_scheduled_run:
        raise RuntimeError("choose either canary or scheduled-run audit contract")
    writes = summary.get("writes")
    written = summary.get("written")
    ids = summary.get("insertedIds") or []
    if not isinstance(writes, int) or writes < 0 or not isinstance(written, int) or written < 0:
        raise RuntimeError("write accounting is missing or invalid")
    if writes != written or written != len(ids) or summary.get("readbackCount") != len(ids):
        raise RuntimeError("write accounting does not match exact inserted IDs/readback")
    if summary["insertedIds"] and not summary["readbackSafe"]:
        raise RuntimeError("exact-ID readback failed product evidence checks")
    source_pin_count = summary.get("sourcePinCount")
    source_readback_count = summary.get("sourceReadbackCount")
    source_category_counts = summary.get("insertedSourceCategoryCounts")
    if (
        type(source_pin_count) is not int
        or source_pin_count < 0
        or type(source_readback_count) is not int
        or source_readback_count != source_pin_count
        or summary.get("sourceProvenanceSafe") is not True
        or not isinstance(source_category_counts, dict)
        or any(type(value) is not int or value < 0 for value in source_category_counts.values())
        or sum(source_category_counts.values()) != len(ids)
        or not set(source_category_counts).issubset(set((summary.get("categoryMix") or {}).keys()))
    ):
        raise RuntimeError("exact Source Pin/category provenance readback failed")
    if summary.get("failedWrites") or summary.get("writeErrors"):
        raise RuntimeError("write outcome contains failed rows or errors")
    if summary["failedBatches"] or summary.get("batchesFailed"):
        raise RuntimeError("write batch failure present")
    receipt_count = summary.get("batchReceiptCount")
    receipt_id_count = summary.get("receiptInsertedIdCount")
    if (
        type(receipt_count) is not int
        or receipt_count < 0
        or type(receipt_id_count) is not int
        or receipt_id_count != len(ids)
        or (ids and receipt_count < 1)
    ):
        raise RuntimeError("atomic batch receipt accounting is missing or invalid")
    if not summary.get("batchReceiptsSafe"):
        raise RuntimeError("atomic batch receipt failed red-line/rollback checks")
    if not require_canary_write and not require_scheduled_run:
        return
    if summary.get("mode") != "apply":
        raise RuntimeError("production write audit requires an apply-mode report")
    if summary.get("selectedTotal") != 100:
        raise RuntimeError("audit did not prove the complete 100-Pin scan")
    if summary.get("merchantDiscoveryCandidateCap") != 100:
        raise RuntimeError("audit does not prove the merchant discovery request cap")
    atomic_cap = summary.get("atomicWriteBatchCap")
    if not isinstance(atomic_cap, int) or atomic_cap < 1 or atomic_cap > 20:
        raise RuntimeError("audit does not prove an atomic write cap <= 20")
    funnel = summary.get("supplyFunnel")
    funnel_fields = (
        "sourcePinsScanned",
        "rawProductCandidates",
        "rejectedProductCandidates",
        "acceptedBeforeDedup",
        "duplicatesSkippedWithinRun",
        "uniqueAcceptedCandidates",
        "alreadyInDatabase",
        "crossBatchDuplicates",
        "skippedByRunAdmissionCap",
        "merchantDiscoveryAttempts",
        "merchantVerified",
        "merchantVerificationFailures",
        "writeDuplicates",
        "safeLegacyRowsWritten",
        "productNamesPresent",
        "productNamesMissing",
    )
    if (
        not isinstance(funnel, dict)
        or any(type(funnel.get(field)) is not int or funnel[field] < 0 for field in funnel_fields)
    ):
        raise RuntimeError("Product Supply funnel accounting is missing or invalid")
    if (
        funnel["sourcePinsScanned"] != summary.get("selectedTotal")
        or funnel["rawProductCandidates"]
        != funnel["rejectedProductCandidates"] + funnel["acceptedBeforeDedup"]
        or funnel["acceptedBeforeDedup"]
        != funnel["duplicatesSkippedWithinRun"] + funnel["uniqueAcceptedCandidates"]
        or funnel["merchantDiscoveryAttempts"]
        != funnel["merchantVerified"] + funnel["merchantVerificationFailures"]
        or funnel["merchantVerified"]
        != funnel["safeLegacyRowsWritten"] + funnel["writeDuplicates"]
        or funnel["safeLegacyRowsWritten"] != written
        or funnel["productNamesPresent"] + funnel["productNamesMissing"]
        != summary.get("readbackCount")
    ):
        raise RuntimeError("Product Supply funnel arithmetic does not close")
    if require_scheduled_run:
        _validate_scheduled_origin(summary.get("scheduledOrigin"))
        if summary.get("categoryMix") != SCHEDULED_PHYSICAL_MIX:
            raise RuntimeError("scheduled report does not prove the deployed 36/28/36 category mix")
        if summary.get("runAdmissionCap") != 50:
            raise RuntimeError("scheduled report does not prove the 50-row run cap")
        if writes > 50:
            raise RuntimeError("scheduled run exceeded the 50-row write cap")
        if summary.get("resultTrust") != "trusted" or summary.get("authenticatedRun") is not True:
            raise RuntimeError("scheduled report is not a trusted authenticated run")
        if summary.get("renderFailureCount") != 0:
            raise RuntimeError("scheduled report contains render failures")
        response_error_count = summary.get("responseErrorCount")
        response_error_samples = summary.get("responseErrorSamples")
        product_json_responses = summary.get("productJsonResponses")
        pins_with_zero_json = summary.get("pinsWithZeroProductJson")
        if (
            type(response_error_count) is not int
            or response_error_count < 0
            or not isinstance(response_error_samples, list)
            or (response_error_count > 0 and not response_error_samples)
        ):
            raise RuntimeError("scheduled report has invalid response-error accounting")
        if (
            type(product_json_responses) is not int
            or product_json_responses < 0
            or type(pins_with_zero_json) is not int
            or pins_with_zero_json < 0
            or pins_with_zero_json > summary.get("selectedTotal")
        ):
            raise RuntimeError("scheduled report has invalid product-response diagnostics")
        # Response parsing errors remain visible diagnostics, but are not row or
        # render failures. Pinterest pages can emit non-JSON responses whose URL
        # contains resource/shop/product, and Playwright can release a response
        # body before the async listener reads it. The hard gates above remain
        # authentication, rendered-page trust and exact red-line/write receipts.
        return
    if summary.get("runAdmissionCap") != 1:
        raise RuntimeError("canary report does not prove the one-row run cap")
    if (
        len(ids) != 1
        or summary.get("writes") != 1
        or summary.get("written") != 1
        or summary.get("readbackCount") != 1
    ):
        raise RuntimeError("canary did not prove exactly one safe production write")


def _validate_next_timer_cooldown(cooldown: dict, next_trigger_epoch: int) -> dict:
    """Prove the next scheduled apply will satisfy the Pinterest cooldown.

    This check runs before ``systemctl enable``.  The timer's calendar base is
    intentionally used instead of its randomized-delay result because it is the
    earliest possible trigger and therefore the conservative boundary.
    """
    if not cooldown.get("known") or not cooldown.get("lastActivityAt"):
        raise RuntimeError("cannot enable timer without trustworthy cooldown evidence")
    required = cooldown.get("requiredMinutes")
    if not isinstance(required, (int, float)) or required <= 0:
        raise RuntimeError("cooldown evidence has no valid requiredMinutes")
    try:
        last_activity = dt.datetime.fromisoformat(
            str(cooldown["lastActivityAt"]).replace("Z", "+00:00"),
        )
    except ValueError as exc:
        raise RuntimeError("cooldown lastActivityAt is not valid ISO-8601") from exc
    if last_activity.tzinfo is None:
        raise RuntimeError("cooldown lastActivityAt must include a timezone")
    next_trigger = dt.datetime.fromtimestamp(next_trigger_epoch, tz=dt.timezone.utc)
    elapsed_minutes = (next_trigger - last_activity.astimezone(dt.timezone.utc)).total_seconds() / 60
    if elapsed_minutes < float(required):
        raise RuntimeError(
            "next Product-Supply timer trigger violates cooldown: "
            f"projected {elapsed_minutes:.2f}min, requires {float(required):g}min",
        )
    return {
        "lastActivityAt": last_activity.isoformat(),
        "nextTriggerAt": next_trigger.isoformat(),
        "projectedCooldownMinutes": round(elapsed_minutes, 2),
        "requiredMinutes": required,
    }


def _timer_enable_readiness(client: paramiko.SSHClient) -> dict:
    _code, preflight_out, _err = run(
        client,
        f"cd {REMOTE_BACKEND} && .venv/bin/python scripts/preflight_product_supply.py",
    )
    try:
        preflight = json.loads(preflight_out)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Product-Supply preflight did not return JSON") from exc
    # TimersCalendar is available even while the unit is disabled.  Convert its
    # base next_elapse through GNU date so parsing is independent of local locale.
    # Force UTC because the host renders Asia/Shanghai as "CST", which GNU date
    # can otherwise misread as North-American Central Standard Time (UTC-6).
    command = (
        f"value=$(TZ=UTC systemctl show {TIMER} -p TimersCalendar --value); "
        "next=$(printf '%s\\n' \"$value\" | sed -n "
        "'s/.*next_elapse=\\(.*\\) }/\\1/p'); "
        "test -n \"$next\"; date -u --date=\"$next\" +%s"
    )
    _code, next_out, _err = run(client, command)
    try:
        next_epoch = int(next_out.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise RuntimeError("could not determine next Product-Supply timer trigger") from exc
    return _validate_next_timer_cooldown(preflight.get("cooldown") or {}, next_epoch)


def enable_timer(client: paramiko.SSHClient) -> None:
    assert_free(client)
    readiness = _timer_enable_readiness(client)
    print(json.dumps({"timerEnableReadiness": readiness}, indent=2))
    run(client, f"systemctl enable --now {TIMER}")
    _code, out, _err = run(
        client,
        f"systemctl is-enabled {TIMER}; systemctl is-active {TIMER}; "
        f"systemctl list-timers {TIMER} --no-pager",
    )
    print(out.strip())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=(
        "status", "stage", "activate", "dry-run", "audit", "canary", "enable",
    ))
    ap.add_argument("--deploy-env", type=Path, required=True)
    ap.add_argument("--stage-id", default=None)
    ap.add_argument("--source-report", default=None)
    ap.add_argument("--require-canary-write", action="store_true")
    ap.add_argument("--require-scheduled-run", action="store_true")
    args = ap.parse_args()
    if args.require_canary_write and args.require_scheduled_run:
        ap.error("--require-canary-write and --require-scheduled-run are mutually exclusive")

    cfg = read_env(args.deploy_env)
    stage_id = args.stage_id or git_short()
    client = connect(cfg)
    try:
        if args.action == "status":
            status(client)
        elif args.action == "stage":
            stage(client, stage_id)
        elif args.action == "activate":
            activate(client, f"/opt/vibepin/staging/product-supply-{stage_id}", stage_id)
        elif args.action == "dry-run":
            transient_run(client, "dry-run")
        elif args.action == "canary":
            transient_run(client, "canary", args.source_report)
        elif args.action == "audit":
            audit_latest(
                client,
                require_canary_write=args.require_canary_write,
                require_scheduled_run=args.require_scheduled_run,
            )
        elif args.action == "enable":
            enable_timer(client)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
