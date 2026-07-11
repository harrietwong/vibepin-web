#!/usr/bin/env python3
"""
Concurrency validation for VibePin Studio /api/generate.

Run against a local/dev server started with mock support, for example:

  $env:ALLOW_GENERATION_MOCK_PROVIDER="true"
  $env:GLOBAL_LINAPI_CONCURRENCY="2"
  $env:LINAPI_PERMIT_WAIT_TIMEOUT_SECONDS="3"
  $env:MAX_IMAGES_PER_REQUEST="2"
  npm run dev

Then:

  py -3 scripts/test_generate_concurrency.py --base-url http://localhost:3000 --provider-mode mock --all
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ONE_BY_ONE_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lkWz9wAAAABJRU5ErkJggg=="
)


def post_json(url: str, body: dict[str, Any], headers: dict[str, str], timeout: int) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    start = time.time()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw)
            return {
                "status": resp.status,
                "elapsedMs": round((time.time() - start) * 1000),
                "json": parsed,
            }
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw[:1000]}
        return {
            "status": exc.code,
            "elapsedMs": round((time.time() - start) * 1000),
            "json": parsed,
        }


async def call_generate(base_url: str, body: dict[str, Any], headers: dict[str, str], timeout: int) -> dict[str, Any]:
    return await asyncio.to_thread(post_json, f"{base_url.rstrip('/')}/api/generate", body, headers, timeout)


def make_body(
    *,
    studio_client_id: str,
    generation_request_id: str,
    count: int,
    provider_mode: str,
    behavior: str,
    delay_ms: int,
    category: str = "fashion",
    include_assets: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "keyword": "mock concurrency validation",
        "style": "editorial",
        "count": count,
        "prompt": (
            "Fashion editorial Pinterest pin. Preserve selected products. "
            "Use reference as visual guidance for composition, lighting, and styling."
        ),
        "category": category,
        "format": "2:3",
        "model_key": "gpt_image",
        "provider_mode": provider_mode,
        "mock_provider_behavior": behavior,
        "mock_provider_delay_ms": delay_ms,
        "studioClientId": studio_client_id,
        "generationRequestId": generation_request_id,
        "prompt_mode": "creative_direction_v2",
        "prompt_version": 2,
        "outputCount": count,
        "variationMode": "distinct",
        "productImageCountRequested": 1 if include_assets else 0,
        "referenceImageCountRequested": 1 if include_assets else 0,
        "creative_direction_meta": {
            "version": 2,
            "manualBrief": "mock concurrency validation",
            "selectedAssets": [],
        },
    }
    if include_assets:
        body["product_images"] = [ONE_BY_ONE_PNG]
        body["style_ref"] = ONE_BY_ONE_PNG
    return body


def extract_summary(resp: dict[str, Any]) -> dict[str, Any]:
    js = resp.get("json") or {}
    return {
        "status": resp.get("status"),
        "elapsedMs": resp.get("elapsedMs"),
        "ok": js.get("ok"),
        "error_type": js.get("error_type"),
        "error": js.get("error"),
        "urlCount": len(js.get("urls") or []),
        "errors": js.get("errors"),
        "error_details": js.get("error_details"),
        "requested_image_count": js.get("requested_image_count"),
        "actual_image_count": js.get("actual_image_count"),
        "count_clamped": js.get("count_clamped"),
        "generation_request_id": js.get("generation_request_id"),
    }


def lock_state(lock_root: str | None) -> dict[str, Any]:
    if not lock_root:
        return {"lockRoot": None, "exists": False}
    root = Path(lock_root)
    files: list[str] = []
    if root.exists():
        files = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()]
    return {"lockRoot": str(root), "exists": root.exists(), "files": files}


async def run_same_session(base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    studio_client_id = "anon-session-a"
    bodies = [
        make_body(
            studio_client_id=studio_client_id,
            generation_request_id=f"case-b-{i}",
            count=1,
            provider_mode=args.provider_mode,
            behavior="success",
            delay_ms=args.delay_ms,
        )
        for i in range(2)
    ]
    before = lock_state(args.lock_root)
    responses = await asyncio.gather(*[
        call_generate(base_url, body, {}, args.timeout) for body in bodies
    ])
    await asyncio.sleep(0.25)
    after = lock_state(args.lock_root)
    return {
        "case": "anonymous_same_session_double_click",
        "studioClientId": studio_client_id,
        "beforeLocks": before,
        "responses": [extract_summary(r) for r in responses],
        "afterLocks": after,
    }


async def run_same_logged_in_user(base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    user_id = args.auth_user_ids[0] if args.auth_user_ids else "test_user_1"
    calls = []
    for i in range(2):
        body = make_body(
            studio_client_id=f"logged-session-{i + 1}",
            generation_request_id=f"logged-same-user-{i + 1}",
            count=1,
            provider_mode=args.provider_mode,
            behavior="success",
            delay_ms=args.delay_ms,
        )
        calls.append(call_generate(base_url, body, {"x-vibepin-test-user-id": user_id}, args.timeout))
    before = lock_state(args.lock_root)
    responses = await asyncio.gather(*calls)
    await asyncio.sleep(0.25)
    after = lock_state(args.lock_root)
    return {
        "case": "logged_in_same_user_double_click",
        "testUserId": user_id,
        "beforeLocks": before,
        "responses": [extract_summary(r) for r in responses],
        "afterLocks": after,
    }


async def run_two_logged_in_users(base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    users = args.auth_user_ids[:2] if len(args.auth_user_ids) >= 2 else ["test_user_1", "test_user_2"]
    calls = []
    for i, user_id in enumerate(users):
        body = make_body(
            studio_client_id=f"logged-different-session-{i + 1}",
            generation_request_id=f"logged-different-user-{i + 1}",
            count=1,
            provider_mode=args.provider_mode,
            behavior="success",
            delay_ms=args.delay_ms,
        )
        calls.append(call_generate(base_url, body, {"x-vibepin-test-user-id": user_id}, args.timeout))
    before = lock_state(args.lock_root)
    responses = await asyncio.gather(*calls)
    await asyncio.sleep(0.25)
    after = lock_state(args.lock_root)
    return {
        "case": "logged_in_two_different_users",
        "testUserIds": users,
        "beforeLocks": before,
        "responses": [extract_summary(r) for r in responses],
        "afterLocks": after,
    }


async def run_logged_in_plus_anonymous(base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    user_id = args.auth_user_ids[0] if args.auth_user_ids else "test_user_1"
    logged_body = make_body(
        studio_client_id="logged-plus-anon-user-session",
        generation_request_id="logged-plus-anon-user",
        count=1,
        provider_mode=args.provider_mode,
        behavior="success",
        delay_ms=args.delay_ms,
    )
    anon_body = make_body(
        studio_client_id="logged-plus-anon-anonymous-session",
        generation_request_id="logged-plus-anon-anonymous",
        count=1,
        provider_mode=args.provider_mode,
        behavior="success",
        delay_ms=args.delay_ms,
    )
    before = lock_state(args.lock_root)
    responses = await asyncio.gather(
        call_generate(base_url, logged_body, {"x-vibepin-test-user-id": user_id}, args.timeout),
        call_generate(base_url, anon_body, {}, args.timeout),
    )
    await asyncio.sleep(0.25)
    after = lock_state(args.lock_root)
    return {
        "case": "logged_in_user_plus_anonymous_session",
        "testUserId": user_id,
        "anonymousStudioClientId": "logged-plus-anon-anonymous-session",
        "beforeLocks": before,
        "responses": [extract_summary(r) for r in responses],
        "afterLocks": after,
    }


async def run_multiple_sessions(base_url: str, args: argparse.Namespace, *, users: int, count: int, behavior: str, case: str) -> dict[str, Any]:
    calls = []
    for idx in range(users):
        for req_idx in range(args.requests_per_user):
            body = make_body(
                studio_client_id=f"{case}-session-{idx + 1}",
                generation_request_id=f"{case}-u{idx + 1}-r{req_idx + 1}",
                count=count,
                provider_mode=args.provider_mode,
                behavior=behavior,
                delay_ms=args.delay_ms,
            )
            calls.append(call_generate(base_url, body, {}, args.timeout))
    before = lock_state(args.lock_root)
    responses = await asyncio.gather(*calls)
    await asyncio.sleep(0.25)
    after = lock_state(args.lock_root)
    summaries = [extract_summary(r) for r in responses]
    return {
        "case": case,
        "users": users,
        "requestsPerUser": args.requests_per_user,
        "requestedCount": count,
        "beforeLocks": before,
        "responses": summaries,
        "afterLocks": after,
        "providerBusyCount": sum(1 for r in summaries if r.get("error_type") == "provider_busy"),
        "successCount": sum(1 for r in summaries if r.get("ok")),
    }


async def run_partial_success(base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    body = make_body(
        studio_client_id="partial-session",
        generation_request_id="case-f-partial",
        count=2,
        provider_mode=args.provider_mode,
        behavior="partial",
        delay_ms=args.delay_ms,
        include_assets=True,
    )
    response = await call_generate(base_url, body, {}, args.timeout)
    return {
        "case": "partial_success",
        "response": extract_summary(response),
        "raw": response.get("json"),
    }


async def run_clamp(base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    body = make_body(
        studio_client_id="clamp-session",
        generation_request_id="case-e-clamp",
        count=8,
        provider_mode=args.provider_mode,
        behavior="success",
        delay_ms=args.delay_ms,
    )
    response = await call_generate(base_url, body, {}, args.timeout)
    return {
        "case": "image_count_clamp",
        "response": extract_summary(response),
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=os.environ.get("BASE_URL", "http://localhost:3000"))
    parser.add_argument("--provider-mode", choices=["mock", "real"], default=os.environ.get("PROVIDER_MODE", "mock"))
    parser.add_argument("--delay-ms", type=int, default=int(os.environ.get("MOCK_PROVIDER_DELAY_MS", "1500")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "120")))
    parser.add_argument("--users", type=int, default=int(os.environ.get("CONCURRENCY_USERS", "3")))
    parser.add_argument("--requests-per-user", type=int, default=int(os.environ.get("REQUESTS_PER_USER", "1")))
    parser.add_argument("--requested-count", type=int, default=int(os.environ.get("REQUESTED_IMAGE_COUNT", "2")))
    parser.add_argument("--lock-root", default=os.environ.get("VIBEPIN_GENERATION_LOCK_DIR"))
    parser.add_argument("--output-json", default=os.environ.get("OUTPUT_JSON", ""))
    parser.add_argument("--auth-user-ids", default=os.environ.get("AUTH_USER_IDS", "test_user_1,test_user_2,test_user_3"))
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--case", choices=["same-session", "logged-same-user", "logged-two-users", "logged-plus-anon", "multi", "busy", "clamp", "partial"], default="")
    args = parser.parse_args()
    args.auth_user_ids = [s.strip() for s in args.auth_user_ids.split(",") if s.strip()]

    cases: list[dict[str, Any]] = []
    if args.all or args.case == "same-session":
        cases.append(await run_same_session(args.base_url, args))
    if args.all or args.case == "logged-same-user":
        cases.append(await run_same_logged_in_user(args.base_url, args))
    if args.all or args.case == "logged-two-users":
        cases.append(await run_two_logged_in_users(args.base_url, args))
    if args.all or args.case == "logged-plus-anon":
        cases.append(await run_logged_in_plus_anonymous(args.base_url, args))
    if args.all or args.case == "multi":
        cases.append(await run_multiple_sessions(args.base_url, args, users=args.users, count=args.requested_count, behavior="success", case="multiple_sessions_global_limit"))
    if args.all or args.case == "busy":
        cases.append(await run_multiple_sessions(args.base_url, args, users=args.users, count=1, behavior="success", case="force_provider_busy"))
    if args.all or args.case == "clamp":
        cases.append(await run_clamp(args.base_url, args))
    if args.all or args.case == "partial":
        cases.append(await run_partial_success(args.base_url, args))

    report = {
        "baseUrl": args.base_url,
        "providerMode": args.provider_mode,
        "delayMs": args.delay_ms,
        "lockRoot": args.lock_root,
        "cases": cases,
        "notes": [
            "Mock mode requires server env ALLOW_GENERATION_MOCK_PROVIDER=true.",
            "Provider permit max concurrency is observed from server logs: provider_limiter_acquired/released.",
            "For logged-in users, pass real bearer tokens manually only through local env or config; do not commit credentials.",
        ],
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.output_json:
        Path(args.output_json).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
