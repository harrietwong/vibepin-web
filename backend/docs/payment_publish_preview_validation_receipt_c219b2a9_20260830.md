# Payment + Publishing Preview Validation Receipt — c219b2a9 — 2026-08-30

## Verdict

`UPDATED_PREVIEW_READY_ACCEPTANCE_BLOCKED_NOT_PRODUCTION`

This receipt supersedes the deployment identity in
`payment_publish_preview_validation_receipt_20260830.md`. The older Preview
`dpl_5hKohBeNyk4uwCv4nwyQXoWUGk1J` remains historical evidence only and must
not be promoted because it was built from the pre-Pricing/pre-TikTok Web tree.

## Frozen Identity

- Candidate branch: `codex/payment-publish-handoff-0830`
- Runtime candidate: `c219b2a9f7d47978803d22f8d145cf5378383938`
- Manifest commit: `a299e9f8d3c043724b71a018e9a8cc543563a58c`
- Manifest: `backend/docs/payment_publish_preview_release_manifest_c219b2a9.json`
- Manifest SHA-256: `64e3f05ccf5f6eae4860d078a0f3400c8e2043f815c97f58ca2ef05c69f7a2e2`
- Manifest verifier: `ok=true`, 97 unique Git-bound artifacts, `errors=[]`
- Runtime Web tree: `cae16060f830ab0230a1298cb4333e296eea4742`
- Manifest-commit Web tree: `cae16060f830ab0230a1298cb4333e296eea4742`

The invalid hand-expanded SHA
`c219b2a995d43c63046031736976eebee1d2b873` is explicitly rejected and must
never appear in a release receipt.

## Source Provenance

- Product v3.7 central candidate: `5fe929355c0531f47934aec84248898741be2f6a`
- Product v3.7 runtime/rollback source: `60a540f1f3ead08e112d378f3df778000c189abb`
- Reference Recommendation P0: `68eebbd242889baf3205f2bc3c14396f560a0620`
- Multichannel tombstone/outbox baseline: `f1beaa877a2367cec1c0d4f7eb164b805ded8e97`
- Pricing integration commit: `cc16dfde`
- TikTok source commit: `2cc8c7df90e62c942adec691a4c15647d91c05f3`
- TikTok integrated commit: `c219b2a9f7d47978803d22f8d145cf5378383938`
- TikTok source/integrated patch-id:
  `d4c8de03cf99020aacafd3783afaf7d75f9ced26`

The manifest verifier intentionally retains its previous three-ancestor source
schema. Its `sourceCommits.multichannelFinal` label therefore still names
`f1beaa87` and does not separately list `cc16dfde` or `2cc8c7df`. This is a
non-blocking provenance limitation, not evidence that the new files are absent:
the 97-artifact set contains the Pricing files and TikTok capability/platform
files, while the direct runtime history and equal patch-id above bind the two
new inputs. The verifier script was not changed because doing so would move the
runtime and create a self-referential freeze cycle.

## Updated Preview Deployment

- Vercel project: `harriets-projects-86e9e358/web`
- Project ID: `prj_dhGFUEZmiktBHuwmCCP7uVNHLsdR`
- Deployment ID: `dpl_9R7Hbxd6gS7m27Jzc8vEQMpMagUt`
- URL: `https://web-5zs5qtm8t-harriets-projects-86e9e358.vercel.app`
- Target: `preview`
- Status: `READY`
- Region: `iad1`
- Build: `npm ci`, production compile, TypeScript and 71/71 static pages PASS
- `/api/version`: `environment=preview`, `region=iad1`, and exact deployment ID PASS

No production alias was changed and no `--prod` command was run.

## Public Pricing And Capability Truth

Authenticated Vercel CLI retrieval of `/pricing` returned the rendered payload.
The payload:

- contains the rule that one Content counts as one scheduled post regardless of
  channel count;
- contains the paid extra-account `$7` monthly and `$5` annualized prices;
- defaults to annual plan prices `$15/$39/$79`;
- contains no customer-facing TikTok text.

This static payload check does not replace browser interaction. The monthly
toggle values `$19/$49/$99`, responsive behavior, authenticated checkout and
connected-account flows remain browser gates.

## Remaining Acceptance Gates

1. Configure Preview-only Creem sandbox credentials, webhook and exact six base
   plan product IDs. Never copy or guess production credentials.
2. Configure Preview usage metering as shadow/off with all enforce flags false.
3. Prove Preview points to the isolated non-production Supabase project and
   verify `v63 -> v66 -> v67 -> v68` there only.
4. Complete authenticated no-mock browser E2E for annual/monthly Pricing,
   checkout/webhook, usage/refund, multi-account and multichannel publishing.
5. Complete the Reference Recommendation no-mock chain and the accepted Create
   Pin worker fix after its clean commit and dual review are delivered.
6. Receive exact A/C/B/D Advisor receipts; do not reproduce those repairs here.
7. Review Preview shadow ledger/refund outcomes and obtain explicit disposition
   receipts for every branch still blocked by the production predeploy guard.

Production migration, production database/VPS/systemd/timer changes, enforce and
promotion remain unauthorized. This Preview is not `READY_FOR_PRODUCTION`.
