# Payment + Publishing Preview Validation Receipt — 2026-08-30

## Verdict

`PREVIEW_DEPLOYED_ACCEPTANCE_BLOCKED_NOT_PRODUCTION`

The candidate is deployed and its build/runtime identity is verified. Preview
acceptance is not complete because Preview billing/metering configuration is
absent, an authenticated no-mock browser session is unavailable, the exact
Preview Supabase project cannot be proven from the current Vercel access level,
and the production predeploy completeness guard correctly blocks this tree.

## Frozen Candidate

- Branch: `codex/payment-publish-handoff-0830`
- Runtime candidate: `75b09ef6388d50e1fd018adffd123bf4dd71316e`
- Manifest commit: `126218e00d8d71799f77c2ead078b45bb28d2d53`
- Manifest: `backend/docs/payment_publish_preview_release_manifest_75b09ef6.json`
- Manifest SHA-256: `f806e490e97464d34a54d879c4c0c231ecaf79f40150a28ba2cefd08ba05c1a0`
- Manifest verification: PASS, 88 unique Git-bound artifacts, no errors.
- Remote branch: pushed to `origin/codex/payment-publish-handoff-0830`.

## Preview Deployment

- Vercel project: `harriets-projects-86e9e358/web`
- Vercel project ID: `prj_dhGFUEZmiktBHuwmCCP7uVNHLsdR`
- Deployment ID: `dpl_5hKohBeNyk4uwCv4nwyQXoWUGk1J`
- Preview URL: `https://web-oo661fhj1-harriets-projects-86e9e358.vercel.app`
- Target: `preview` (never production)
- State: `READY`
- Region: `iad1`
- Vercel build: PASS; TypeScript PASS; 71/71 static pages generated.
- `/pricing`: HTTP 200 through authenticated Vercel curl.
- `/api/version`: reports `environment=preview`, region `iad1`, and the exact
  deployment ID above.
- `/api/billing/creem/status`: unauthenticated request returns 401 as expected.

## Product And Billing Truth

- The rendered pricing payload contains Starter, Pro and Business.
- The rendered pricing payload also contains `Coming soon`.
- Vercel Preview environment inventory contains no `CREEM_MODE`,
  `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, six required `CREEM_PRODUCT_*` plan
  IDs, or extra-account product IDs.
- Therefore a real Creem sandbox checkout/webhook flow cannot be tested on this
  Preview. Product/billing truth is BLOCKED, not passed.
- Production environment inventory contains the six base plan product variable
  names and Creem mode/webhook names, but values remain encrypted/redacted at the
  current access level. No production value was copied to Preview and no cloud
  configuration was changed.
- Local configuration audit found six Creem product IDs and a webhook secret, but
  no `CREEM_MODE` or current `CREEM_API_KEY`; the extra-account product IDs are
  also absent. Those values cannot be proven to belong to the sandbox, so they
  were not written to Preview. Guessing here could mix live and test billing.

## Migration And Recovery Boundary

- Forward order is frozen as `v63 -> v66 -> v67 -> v68`.
- v63, v66 and v67 have explicit SQL rollback files and roll back in reverse order.
- v68 is additive function replacement with no table/column/index DDL. Once
  release ledger events exist, restoring the v55 consume function would break
  re-charge semantics for released key families. Its recovery contract is:
  retain v68 functions and ledger events, set `USAGE_ENFORCE_SCHEDULED_POSTS=false`,
  return `USAGE_METERING_MODE` to shadow/off, and roll back the application only.
- Isolated test Postgres project `snulmwprsahzqvdbyenc`: v68 real-DB suite PASS
  12/12, including refund, re-charge, replay, unknown delivery, over-limit and
  non-negative balance. Cleanup PASS; 11 test accounts and cascaded events removed.
- Exact Preview Supabase identity remains unproven because Vercel returns secret
  environment values as `[SENSITIVE]`. Preview migration verification is BLOCKED.

## Browser And Shadow Gates

- Deployment Protection redirects an unauthenticated browser to Vercel login.
- Authenticated CLI requests work, but they are not a substitute for the required
  no-mock browser interaction chain.
- The logged-in Chrome control connection timed out twice during navigation and
  then became unavailable. No browser E2E pass is claimed.
- The in-app browser reached the protected deployment and followed Vercel's
  `Continue with ChatGPT` login path, but OpenAI then required the user's personal
  login credentials. No credentials were entered; browser acceptance now requires
  a user-completed login session.
- Preview has no `USAGE_METERING_MODE` or per-type `USAGE_ENFORCE_*` variables;
  consequently there is no Preview shadow stream to review. Shadow review is
  BLOCKED. No enforce switch was changed.

## Predeploy Guard

- Project identity, named branch and cleanliness checks passed far enough to run
  the completeness gate.
- The guard FAILED because deploying this candidate to production would omit 26
  other active local branches. No override was used.
- This failure does not invalidate the isolated Preview deployment; it correctly
  forbids production promotion until branch disposition/integration is resolved.

## Required To Resume Acceptance

1. Configure Preview-only Creem sandbox mode/key/webhook and all six base plan
   product IDs; keep production credentials out of Preview.
2. Configure Preview metering as shadow/off with all three enforce flags false.
3. Prove Preview points at the isolated non-production Supabase project and apply/
   verify `v63 -> v66 -> v67 -> v68` there.
4. Restore an authenticated browser-control session (or provide a sanctioned
   Deployment Protection bypass) and run the no-mock pricing, checkout, usage and
   multi-channel publishing E2E chain.
5. Review resulting shadow ledger/refund outcomes, then re-run the guard after the
   26 active branches have explicit integration or exclusion receipts.
