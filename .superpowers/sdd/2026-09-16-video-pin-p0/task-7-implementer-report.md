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

## Independent Review Round 1

The independent review at `c449e732` returned **NOT APPROVED** with eight Important
findings and no Critical findings. The original report and both executable probes are
retained beside this report. Round 1 converts those probes into registered regression
tests that execute the production wrapper, real v76/v77 PGlite migrations, and actual
GET/POST route boundaries.

### R1–R8 Closure

- **R1 retry lineage:** video retry confirmation now atomically locks the parent,
  binds `priorIntentId` and the parent destination row, admits only a failed +
  `retry_allowed` exact destination, inherits the attempt ordinal, and consumes the
  entitlement once. Published, started, and delivery-unknown parents cannot mint a
  child delivery.
- **R2 source identity:** operational `pin_drafts.updated_at` is no longer treated as
  content identity. Frozen title/description/alt/destination/media bytes are compared
  instead; sibling lifecycle writes replay, while real content or media changes fail
  before a provider call.
- **R3 active attempts:** a fresh durable `started` attempt returns `in_progress` and
  cannot be settled unknown by a concurrent replay. A stale started attempt remains
  anti-retry and is moved to unknown through the locked settlement boundary.
- **R4 crash recovery:** durable `materialized` and `claimed` destinations resume from
  those states without attempting a second materialization lease. Ready-before-claim
  and claimed-before-attempt process-loss regressions both pass.
- **R5 sibling continuation:** parent lifecycle is derived from all destination rows;
  success, failure, or unknown in one destination never overwrites or blocks an
  untouched sibling.
- **R6 cron TOCTOU:** claim UPDATE is bound to the scanned schedule, revision, due
  window, deleted state, and archive state. Real GET route tests mutate reschedule,
  cancel, delete, and media between scan and claim and observe zero claim, meter,
  durable wrapper, or provider calls.
- **R7 image compatibility:** image fingerprint serialization is byte-identical to the
  pre-video shape; pinned fixture
  `ffc2819b87d6225015c56d27af70f4b8c2883cf8c10f9fdd5757efee6da7e54d` passes.
- **R8 optional canonicalization:** missing/blank video `altText` and `posterUrl` share
  one representation, while non-empty mutations still change the fingerprint and
  source identity.

The actual `/api/pinterest/pins` POST route also rejects a mixed/video legacy bypass
with `materialization_required` before database or legacy provider execution.

### Round 1 Verification

```text
npx tsx scripts/test-v76-pinterest-video-recovery.ts -> all R1–R8 production-boundary probes passed
npx tsx scripts/test-publish-due-video-races.ts      -> 4/4 races, zero claim/meter/provider
npx tsx scripts/test-pinterest-video-legacy-route.ts -> materialization_required, zero legacy provider
npx tsx scripts/test-v76-pinterest-video-publish.ts  -> 17 passed, 0 failed
npx tsx scripts/test-publish-due-claim.ts             -> 106 passed, 0 failed
npx tsx scripts/test-publish-durable-intent.ts        -> 23 passed, 0 failed
npx tsx scripts/test-publish-confirmation.ts          -> 16 passed, 0 failed
npx tsx scripts/test-pinterest-video-adapter.ts       -> 16 passed, 0 failed
node backend/tests/pglite_v37/verify-v76-publish-assets.mjs -> 280/280, two rounds
node backend/tests/pglite_v37/verify-v77-video-media.mjs    -> 94/94
npm run typecheck                                     -> exit 0
npm run check:test-registry                           -> 242 tracked, 234 run, 8 excluded
npx eslint <Round 1 changed TS files>                  -> 0 errors, 0 warnings
```

No external Pinterest, Storage, or database call occurred. No deployment, push, or
merge occurred.

## Independent Review Round 2

Round 2 reviewed `aead8d05` and reported six Important findings, with no Critical
findings. The report and both adversarial probes are retained unchanged in intent;
the probes are now registered as the v78 recovery and upgrade suites.

### R2-I1–I6 Closure

- A replayed `started` attempt is no longer dispatch authority. Two callers racing
  from the same claimed destination acquire one durable attempt and invoke the
  provider exactly once; the replay returns `in_progress`.
- Source identity now has its own v78 ledger fingerprint, separate from operational
  `updated_at`. A later due pass can continue an untouched sibling with the same
  frozen media/content/destination identity, while substantive mutations still fail
  closed. The private publish-copy path is derived from that stable identity too.
- v78 atomically validates and narrows a failed-only child retry before delegating
  graph creation to the byte-identical v76 ledger. A real two-destination parent can
  retry only its failed destination once; successful and unknown siblings cannot be
  widened into the child.
- Video media metadata uses one canonical builder/validator representation. Missing,
  blank, trimmed, and non-empty `altText`/`posterUrl` agree; meaningful tampering
  changes the fingerprint. Legacy image serialization retains its pinned hash.
- Ready/claimed recovery loads the owner/intent/destination-bound frozen private
  asset graph, downloads that publish copy, and verifies MIME, size, checksum, media
  ordinal, and owner path. It does not re-read or rewrite the original upload.
  Missing/corrupt/wrong-owner frozen assets fail closed; removing only the original
  upload does not block recovery.
- v76 is restored byte-for-byte to the official `04b0ebe0` blob. The repair ships as
  additive v78 RPCs and a bounded rollback that retains historical identity evidence.
  Upgrade coverage installs official v76, applies v78 twice, rolls v77 back/reapplies
  it, rolls v78 back/reapplies it, and rejects same-marker function body drift.

### Round 2 Verification

```text
npx tsx scripts/test-v78-pinterest-video-recovery.ts -> 5 adversarial groups passed, 0 failed
npx tsx scripts/test-v78-pinterest-video-upgrade.ts  -> official v76 upgrade/reapply/drift checks passed
npx tsx scripts/test-v76-pinterest-video-recovery.ts -> all R1–R8 production-boundary probes passed
npx tsx scripts/test-v76-pinterest-video-publish.ts  -> 17 passed, 0 failed
npx tsx scripts/test-publish-due-video-races.ts      -> 4/4 races, zero claim/meter/provider
npx tsx scripts/test-pinterest-video-legacy-route.ts -> materialization_required, zero legacy provider
npx tsx scripts/test-publish-due-claim.ts            -> 106 passed, 0 failed
npx tsx scripts/test-publish-durable-intent.ts       -> 23 passed, 0 failed
npx tsx scripts/test-publish-confirmation.ts         -> 16 passed, 0 failed
npx tsx scripts/test-pinterest-video-adapter.ts      -> 16 passed, 0 failed
node backend/tests/pglite_v37/verify-v76-publish-assets.mjs -> 280/280, two rounds
node backend/tests/pglite_v37/verify-v77-video-media.mjs    -> 94/94
npm run typecheck                                     -> exit 0
npm run check:test-registry                           -> 244 tracked, 236 run, 8 excluded
npx eslint <Round 2 changed web TS files>             -> 0 errors, 0 warnings
git diff --cached --check                             -> exit 0
```

All database, Storage, and provider behavior in these tests is local PGlite or an
explicit mock boundary. No external call, deployment, push, or merge occurred.
