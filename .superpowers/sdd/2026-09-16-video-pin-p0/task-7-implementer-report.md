# Task 7 — Durable Video Publish Implementer Report

## Revision

- Base: `d7635c02b2bb010380c39d5c7777fbdadbcab8da`
- Implementation commit: `00d554dc`
- Branch: `codex/video-pin-p0-task7`
- Worktree: `D:/vp-tmp/wt-video-pin-p0-task7`

## Delivered Contract

- Immediate and due Pinterest video delivery share one server orchestrator and the
  approved Task 6 adapter.
- Confirmation fingerprints now distinguish image and video identity, including
  duration/poster facts, while legacy image fingerprints remain compatible.
- The v76 order is enforced as prepare, private-byte materialization, all-items-ready
  destination claim, durable provider attempt, adapter dispatch, and settlement.
- Source bytes are owner/revision/provenance/checksum bound. The provider receives a
  private `Blob`; no public copy or signed URL is created or persisted.
- Provider registration is unreachable before a ready destination claim and durable
  attempt. Future and out-of-window due work performs no durable/provider I/O.
- A started attempt after process loss and every adapter-unknown outcome settles or
  remains `delivery_unknown`; replay is closed until reconciliation.
- Pinterest `201` success is never re-dispatched, including a response with a Pin id
  but no URL (a canonical Pinterest URL is derived where possible).
- Due outcome persistence keeps `delivery_unknown` distinct from `failed`, so sibling
  success remains published and unknown legs cannot be blindly retried.
- Legacy image publishing stays on its existing route. Mixed/multi-video legacy
  bypasses fail with `materialization_required` or defer before due claim/provider.

No Python Pinterest publisher exists under `backend`; no second legacy video path was
introduced.

## TDD Evidence

### RED

- The focused suite first failed with `MODULE_NOT_FOUND` for the missing durable
  orchestrator.
- The due regression proved `delivery_unknown` was being rewritten as `failed`.
- The post-attempt exception regression escaped as an ordinary throw before the
  orchestrator converted it to unknown.
- The due receipt test exposed the need to normalize PostgREST microsecond revisions
  to v76's canonical UTC-millisecond representation.

### GREEN

```text
npx tsx scripts/test-v76-pinterest-video-publish.ts -> 16 passed, 0 failed
npx tsx scripts/test-publish-due-claim.ts           -> 106 passed, 0 failed
npx tsx scripts/test-publish-durable-intent.ts      -> 23 passed, 0 failed
npx tsx scripts/test-publish-confirmation.ts        -> 16 passed, 0 failed
npm run test:pinterest-video-adapter                 -> 16 passed, 0 failed
```

The focused suite covers ordering, lease competition, all-items-ready, durable attempt
idempotency, success-before-settle loss, unknown anti-retry, due/future windows,
partial destinations, source revision conflict, owner/path tampering, legacy bypass,
and canonical success evidence. All provider, Storage and database boundaries are
mocked; no external call is possible in the suite.

## Verification

```text
npm run typecheck                                      -> exit 0
npx eslint <Task 7 changed TS files>                   -> 0 errors, 0 warnings
npx tsx scripts/check-test-registry.ts                 -> OK, 239 tracked / 231 run / 8 excluded
node backend/tests/pglite_v37/verify-v76-publish-assets.mjs
                                                       -> pass, 280/280, two rounds
node backend/tests/pglite_v37/verify-v77-video-media.mjs
                                                       -> pass, 94/94
git diff --cached --check                              -> exit 0
```

The full `npm test` run reached and passed the new registered Task 7 suite. It also
surfaced pre-existing base/environment failures outside this task: three stale static
assertions in `test-publish-social-account-guard.ts` (the compared Pinterest key shape
is byte-identical at base `d7635c02`), seven social retry cases whose fake Request has
an invalid URL at unchanged `publish/social/route.ts:153`, and
`test-ai-copy-language-guardrail.ts` requiring an unset Supabase URL. The run was
stopped after proving these unchanged blockers; focused and requested gates above are
green.

## Risks / Handoff

- Task 7 relies on Task 2 producing the exact owner-first `/api/storage-media?path=…`
  locator and finalized v77 provenance facts. Task 2 is not present on this base, so
  no real end-to-end upload-to-publish run is possible in this worktree.
- Private intent-scoped publish copies are not public and store no signed locator.
  Their eventual cleanup continues to depend on the existing provenance/outbox
  operations policy.
- No independent reviewer subagent was dispatched because the active collaboration
  policy forbids unrequested subagent spawning; integration review remains required.
- No real Pinterest, Storage, database, deployment, push, or merge operation occurred.
