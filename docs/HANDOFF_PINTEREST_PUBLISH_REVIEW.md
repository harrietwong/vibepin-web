# Handoff: Pinterest Publish Flow Review

Status: **Review complete. No product code changed. No advisor sign-off obtained.**
Task stopped by user before any implementation.

---

## 1. Current task objective

End-to-end code review of the Pinterest publishing flow, from Weekly Plan through
OAuth connect, board selection, publish, and "View on Pinterest" — to find and
(pending advisor sign-off) fix correctness, performance, state-sync, UX,
security, and maintainability issues before recording a Pinterest review video.

Explicit constraints from the task: merchant-controlled publishing only, no
auto-publish, Unscheduled/Scheduled/Published as the only user-facing lifecycle
states, optional destination URL and product attachment, image+board as the
only hard publish requirements, no raw backend/env/token errors shown to users,
sandbox ≠ merchant-connected, Plan-origin OAuth must return to Plan not Settings.

This directory is not a git repository, so "PRs merged in the last two weeks"
could not be enumerated from history. The review instead inspected the current
state of the code areas the task specified as recently changed.

---

## 2. Verified end-to-end publish call graph

```
Weekly Plan → open Pin → Connect Pinterest
  → beginPinterestRedirect() [DraftDetailsDrawer.tsx ~447-462]
      flushSync() paints redirect overlay, then requestAnimationFrame →
      window.location.assign(/api/auth/pinterest/connect?next=<returnTo>)
  → GET /api/auth/pinterest/connect [connect/route.ts]
      parse+sanitize returnTo → resolve user (getUserIdFromCookieSession) →
      generate state → redirect to Pinterest authorize URL
      (no fetch-first call, no router.push, no boards/status/connections
      request before navigation — confirmed)

Pinterest authorize page → user authorizes

GET /api/auth/pinterest/callback [callback/route.ts]
  state validation + code exchange (run concurrently) →
  encrypted token persistence/upsert →
  immediate redirect to returnTo
  (profile/account enrichment is deferred ~6s in plan page, off the
  critical path — confirmed not blocking)

Plan page mount [web/src/app/app/plan/page.tsx ~1582-1682]
  one-shot restore of pinId/view/week/month/category from returnTo,
  query params cleaned via window.history.replaceState (not router.replace),
  guarded by a ref so it runs once; reopens the same Pin drawer; shows a
  restoreNotice banner if the draft can't be found.

Drawer open [DraftDetailsDrawer.tsx]
  concurrent Pinterest status + boards fetch (AbortController + timeout +
  stale-sequence protection + one 401 retry)
  → applyBoardsResult() merges board list with existing/prev selection
  → connection-status fallback logic at ~299-320 (see Section 3, B1)

Publish click → handlePublish() [DraftDetailsDrawer.tsx ~696-761]
  client validation (title/description/altText currently required — see B2)
  → in-flight guard: React `publishing` useState (see B4)
  → POST /api/pinterest/pins [pins/route.ts ~74-97]
      no idempotency key, no existing-remotePinId check, calls
      client.createPin() unconditionally (see B3)
  → on success: DraftDetailsDrawer stores result, shows "View on Pinterest"
    using the real res.pin.url returned by Pinterest (correct, first time)

Reopen a published Pin later
  → URL for "View on Pinterest" is reconstructed as
    `https://www.pinterest.com/pin/${remotePinId}/` instead of reusing the
    stored real URL, because pinDraftStore only persists remotePinId, not
    remotePinUrl (see B5, two files)
```

---

## 3. Confirmed P0 bugs (file / line areas)

| ID | File : line area | Bug |
|----|-------------------|-----|
| B1 | `web/src/components/plan/DraftDetailsDrawer.tsx` ~299-320 | If the boards request resolves before the status request, connection state falls back to a hardcoded `connectionSource: "db"` even when status later resolves to `sandbox_demo`. Fabricates a real merchant connection in the sandbox demo environment (the exact review-video setup). Also causes the drawer and `PublishDestinations.tsx` (which correctly checks `isRealPinterestConnection()`) to disagree. |
| B2 | `web/src/components/plan/DraftDetailsDrawer.tsx` ~752-761 | Publish is blocked client-side if `title`, `description`, or `altText` are empty. This contradicts the stated requirement that only a valid public image and a Pinterest board are hard publish requirements. |
| B3 | `web/src/app/api/pinterest/pins/route.ts` ~74-97 | No server-side duplicate-publish protection: every POST calls `client.createPin()` unconditionally — no idempotency key, no check for an existing `remotePinId` before creating. |
| B4 | `web/src/components/plan/DraftDetailsDrawer.tsx` ~696-710 | The publish in-flight guard (`if (publishing || isRedirectingToPinterest) return;`) is React `useState`, which resets if the drawer unmounts. Confirmed path: close the drawer while a publish request is still in flight, reopen it, click Publish again — a second live Pinterest Pin can be created for the same draft, combining with B3 into a real (not theoretical) duplicate-Pin race. |
| B5 | `web/src/components/plan/DraftDetailsDrawer.tsx` ~928 and `web/src/components/studio/PinBoardCard.tsx` ~156 | "View on Pinterest" is correct on the initial publish (uses `res.pin.url`), but on reopening a published Pin later, the URL is reconstructed as `https://www.pinterest.com/pin/{remotePinId}/` instead of the real URL Pinterest returned — because `pinDraftStore.ts` never persists `remotePinUrl`, only `remotePinId`. Fabricated URL, higher risk for sandbox pins whose real URL pattern may differ. |

Areas verified as **not** having P0 issues (confirmed by direct inspection, not assumption): OAuth redirect start (no fetch-first/router.push/Settings hop; no leftover 15s fallback UI), OAuth callback (doesn't block on boards/profile/social/diagnostics; no secrets logged), returnTo sanitization (requires `/app/` prefix, rejects `//` and `://`, encrypted-cookie-bound, one-shot, survives refresh/cancel), hover preview suppression during modal, Published Pin single-close-button and correct `rel="noopener noreferrer"` usage, Supabase client memoization in `useWeeklyPlan`, `getSession()`-only reads in `LocaleProvider`/`ThemeProvider` (writes still use `getUser()`).

---

## 4. Current persistence map

- **`pinterest_connections` (DB table)** — source of truth for a real merchant
  OAuth connection. `/api/pinterest/status` correctly derives `connectionSource`
  from it (`db` / `sandbox_demo` / `none`); DB always outranks sandbox; sandbox
  token is never returned to the client (confirmed in `connectionStore.ts` /
  `status/route.ts`).
- **Sandbox connection state** — derived from server env + token
  (`config.ts` / `canAttemptSandboxPublish()`), gated so it cannot run in
  production and cannot mix with the production base URL. This is a
  *capability*, not a merchant connection — see B1 for where that distinction
  currently leaks into the drawer's fallback logic.
- **`vp:pin_drafts:v1` (browser localStorage, via `pinDraftStore.ts`)** — the
  only place Pin content and published metadata (including `remotePinId`)
  currently live. **No `remotePinUrl` field exists in this store** (root cause
  of B5). There is no DB table (e.g. `scheduled_pins`) backing this data.
  Consequences already documented in the review: published state is lost if
  localStorage is cleared or the browser/profile changes; `returnTo`-restored
  Pins depend entirely on this local record still existing. Not implemented or
  migrated in this task per explicit instruction ("do not implement the full
  scheduled_pins migration").
- **Board default** — no durable storage found. `applyBoardsResult` preserves
  an existing draft's board correctly, but the "last used / default board" is
  only in-memory component state, reset on every fresh drawer mount. Not
  persisted in DB or localStorage.

---

## 5. Pinterest idempotency documentation result

- No server-side idempotency key, request-deduplication, or existing-pin check
  exists in `POST /api/pinterest/pins`.
- The only client-side re-entry guard (`publishing` state) is scoped to the
  component instance and does not survive drawer unmount/remount.
- **Confirmed reproducible race**: close the drawer mid-publish → reopen →
  click Publish again → two live Pinterest Pins can be created for one source
  draft, with only the second response's `remotePinId` surviving in
  `pinDraftStore`.
- The 401-then-retry path in `pinterestClient.ts` is safe: the 401 occurs
  during auth resolution, before `createPin()` is ever reached, so that retry
  cannot itself double-create.
- No client-side fetch timeout/`AbortController` exists on the publish call
  (separate, lower-severity finding — P1).

---

## 6. Advisor consultation outcome

No advisor call succeeded in this conversation. One `advisor()` call was
attempted, immediately before proposing implementation of the idempotency fix
and the B1 connection-source-of-truth fix. It returned an error:
`"The advisor tool is unavailable. Do not try to use it again."` — no
recommendation, first or otherwise, was produced.

Because of that failure, the user was asked how to proceed (proceed without
advisor / report findings only / pause). The user chose **report findings
only**, and the task was stopped before any fix was implemented.

**No advisor sign-off — initial or final — occurred at any point in this
task.**

---

## 7. Advisor calls that failed / sign-off status

- Attempted: 1 (pre-implementation, for the idempotency fix and the B1 fix).
- Succeeded: 0.
- Final-review advisor call (required by the task's process before declaring
  completion): **not reached** — task was stopped at the findings-report stage
  before any implementation, so there was nothing yet to submit for final
  review.

---

## 8. Recommended smallest safe P0 implementation (unapproved — needs advisor review before coding)

- **B2** — remove `title`/`description`/`altText` from the client publish-blocking
  validation in `DraftDetailsDrawer.tsx`; keep image + board as the only hard
  gates. Low risk, no schema involved.
- **B5** — add a `remotePinUrl` field to the draft record in `pinDraftStore.ts`,
  populate it from `res.pin.url` on successful publish, and use it (falling back
  to the reconstructed URL only if genuinely absent) in both
  `DraftDetailsDrawer.tsx` and `PinBoardCard.tsx`. Client-side data-shape change
  only, no DB schema.
- **B1** — change the fallback connection-status logic so it does not default
  to `connectionSource: "db"` before the status request has actually resolved
  (e.g. hold in a "pending" state, or await status resolution specifically for
  the `connectionSource` field). Flagged as needing advisor review because it
  touches sandbox-vs-merchant connection gating directly (product decisions
  #11/#12).
- **B3 + B4 (idempotency)** — proposed candidate, **explicitly flagged in the
  task as requiring advisor sign-off before implementation**: a module-level
  in-flight lock keyed by draft/source ID (matching the existing
  `boardsCache`/`connectionsCache` singleton pattern already used in this
  codebase), which persists across component unmount within the same tab, plus
  disabling Publish while that ID is locked. This closes the close/reopen
  race within a single browser tab. It does **not** protect against
  multi-tab or server-restart duplicate publishes.

---

## 9. Recommended durable P1 solution (not implemented, out of scope for this task)

- Server-side idempotency: a persisted dedup ledger (or a `scheduled_pins`-style
  DB row) keyed by a stable draft/source ID, with a check for an existing
  `remotePinId` before calling Pinterest's create-pin API, and/or a
  client-generated idempotency key accepted by the server. This is a schema
  change and needs both advisor and product sign-off — explicitly out of scope
  ("do not implement the full scheduled_pins migration" / "do not perform full
  data model migration").
- Board default persistence: a durable, DB-backed default board
  (e.g. a `default_board_id` column on `pinterest_connections`), written on
  manual board selection and read on drawer/board load, plus auto-select when
  exactly one board exists. The auto-select-single-board half needs no schema
  change and could be pulled forward; the persisted-default half needs a
  schema change and advisor sign-off.
- Migrating published-Pin metadata (and Pin content generally) out of
  `vp:pin_drafts:v1` localStorage into a DB-backed table, so published state
  survives browser/device changes and reconciles with what's actually live on
  Pinterest.

---

## 10. Exact files likely to change

- `web/src/components/plan/DraftDetailsDrawer.tsx`
- `web/src/lib/pinDraftStore.ts`
- `web/src/components/studio/PinBoardCard.tsx`
- `web/src/app/api/pinterest/pins/route.ts`
- Possibly a new small client-side module (e.g. `web/src/lib/pinterest/publishLock.ts`) for the in-flight publish lock, following the existing `boardsCache.ts`/`connectionsCache.ts` singleton pattern.

No files have been modified as part of this review.

---

## 11. Tests and manual verification required (once fixes are implemented)

Automated:
- TypeScript typecheck
- Lint on touched files
- Relevant Pinterest/Plan regression tests
- i18n validation if any user-facing copy changes (e.g. validation error text)
- Production build, if practical

Manual, in order:
1. Disconnected Plan Pin → click Connect → calm redirect, no fallback UI.
2. OAuth success → returns to same Plan view and same Pin.
3. OAuth cancel/error → safe return, no raw error shown.
4. Connected Pin → boards load without infinite waiting.
5. Board selection preserved / defaulted correctly (existing-board case at minimum; single-board auto-select if implemented).
6. Publish success → real metadata + real "View on Pinterest" URL shown.
7. Reopen the published Pin later (new drawer mount) → "View on Pinterest" still uses the real stored URL, not a reconstructed one (verifies B5 fix).
8. **Double-publish race check**: start a publish, close the drawer before it resolves, reopen it, click Publish again — confirm only one Pin is created (verifies B3/B4 fix).
9. **Sandbox/db fallback race check**: force or observe the boards response resolving before the status response in the sandbox environment — confirm the drawer does not report a real DB connection (verifies B1 fix).
10. Disconnect Pinterest → confirm Settings, Publishing accounts, and the Plan drawer all agree it's disconnected.
11. Refresh / reopen drawer → no stale false-connected state.

---

## 12. Current implementation status

- **No product code was modified during this task.** All work performed was
  read-only investigation (file/content search, four parallel read-only
  research subagents, one failed advisor call) plus this handoff document.
- No commits, no schema changes, no dependency changes.
- Task was stopped by explicit user instruction after the findings report was
  delivered and before any fix (including the "safe, no-advisor-needed" B2/B5
  fixes) was implemented.
- Advisor sign-off has not occurred for any of the five confirmed P0 items.
  Recommend obtaining advisor (or equivalent human) review before implementing
  B1, B3, or B4 specifically, per the task's own risk classification.
