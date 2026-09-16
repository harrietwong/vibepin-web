# Task 6 — Pinterest Video Adapter Implementer Report

## Revision

- Base: `ec94e9ac`
- Implementation commit: `389284edc7810eec8bb7798d2110c4ec005e7e77`
- Branch: `codex/video-pin-p0-task6`

## Delivered Files

- `web/src/lib/server/pinterest/videoPinAdapter.ts`
- `web/scripts/test-pinterest-video-adapter.ts`
- `web/scripts/test-registry.ts`
- `web/package.json`

The adapter is pure and injectable: all provider-boundary calls use caller-supplied
`fetch`, `sleep`, and `now` functions. It is deliberately not wired into routes,
v76 settlement, storage, scheduling, or any real provider client.

## TDD Evidence

### RED

Before implementation, ran:

```text
npx tsx scripts/test-pinterest-video-adapter.ts
```

It failed as intended with:

```text
Cannot find module '../src/lib/server/pinterest/videoPinAdapter'
```

### GREEN

The focused mocked suite passed twice, then again via its registered npm command:

```text
npx tsx scripts/test-pinterest-video-adapter.ts  -> 8 passed, 0 failed
npx tsx scripts/test-pinterest-video-adapter.ts  -> 8 passed, 0 failed
npm run test:pinterest-video-adapter             -> 8 passed, 0 failed
```

Coverage verifies the exact registration request, multipart provider-field order
with the file last and no Authorization, the strict upload `204` requirement,
poll transitions/deadline/failure, exact create request, common Bearer token,
bounded success evidence, malformed registration handling, redaction, and definite
versus unknown outcomes.

## Additional Verification

```text
npx tsx scripts/test-pin-media-source.ts -> 8 passed, 0 failed
npx tsx scripts/check-test-registry.ts   -> OK — 238 tracked scripts, 230 run by npm test, 8 excluded
git diff --cached --check                -> passed (no whitespace errors)
```

The adapter source also passed an isolated strict TypeScript check using TypeScript
5.9.3 with DOM/FormData libraries.

## Environment-Blocked Checks

`web/node_modules` was already incomplete after an interrupted dependency install.
Per coordinator instruction it was not repaired or removed. Consequently:

- Full `npx tsc --noEmit` could not run because the worktree lacks local
  `typescript` and `@types/node`.
- Existing `scripts/test-pinterest-oauth.ts` could not load because
  `@supabase/supabase-js` is absent from the incomplete installation.

The integration worktree with a complete dependency install must run both checks
before acceptance.

## Risks / Handoff

- The adapter intentionally returns `unknown` for network, 5xx, malformed success
  payloads, and deadlines. Task 7 must durably settle those states and prohibit a
  blind replay until reconciliation.
- No route, database, storage, scheduler, deployment, push, or real Pinterest call
  was made by this task.

## Independent Review Repair — Round 1

The independent review found that the original polling deadline only applied between
awaits, evidence identifiers were format-checked but not checked against known
secrets, and a normal object dropped an own `__proto__` upload parameter.

### Repair TDD Evidence

New regression tests were added before the repair. Against the pre-repair adapter,
the focused suite produced the expected RED result: 8 passed and 6 failed. The
failures specifically showed a dropped `__proto__` multipart field, two indefinitely
pending polling operations, an uncapped sleep of `100` instead of the `5` ms budget,
an echoed token in `requestId`, and a token-shaped media ID reaching later stages.

The adapter now races each polling fetch, poll response-body parse, and injected sleep
against the remaining deadline; it aborts an in-flight fetch where `AbortController`
is available. A deadline returns the bounded `unknown` receipt. It preserves upload
parameters as validated entry tuples, so every own field remains ordered and
`__proto__` is appended. Final evidence applies a secret-aware filter against the
access token, presigned upload URL, and upload-parameter values; canonical Pin URLs
must match the filtered Pin ID exactly.

### Repair Verification

```text
npx tsx scripts/test-pinterest-video-adapter.ts  -> 14 passed, 0 failed
npx tsx scripts/test-pinterest-video-adapter.ts  -> 14 passed, 0 failed
npx tsx scripts/test-pin-media-source.ts         -> 8 passed, 0 failed
npx tsx scripts/check-test-registry.ts           -> OK
isolated strict TypeScript adapter check          -> passed
git diff --check                                  -> passed
```

The full-project TypeScript and OAuth/service gates remain blocked by the unchanged
incomplete local dependency installation described above; the integration worktree
must run them before acceptance.
