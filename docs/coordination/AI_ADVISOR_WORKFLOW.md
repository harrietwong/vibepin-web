# AI Advisor / Worker Workflow

## Current three-project arrangement — user direction, 2026-09-07

For VibePin, the Blue Ocean product tool, and landlord design/procurement:

- Claude Code is the primary implementation tool. The user intends to obtain Max 20x; purchase and active entitlement have not been verified.
- Codex owns task decomposition, architecture decisions, independent acceptance, market research synthesis, marketing briefs/scripts, and knowledge handoff.
- Sonnet handles bounded implementation; Opus handles difficult algorithm implementation or debugging when justified. Fable may provide an additional review when requested; it does not automatically replace Codex as coordinator in this arrangement.
- Codex should not duplicate Claude's implementation. When Codex is explicitly assigned a fix, transfer ownership of the affected files first.
- Maintain at most one primary local code-writing worker plus one independent research/content task as the initial concurrency policy for this laptop. This is a resource guideline, not a plan entitlement limit.
- Existing requirements for isolated worktrees, verification, and no worker deployment remain in effect. Cross-application automatic dispatch is not configured by this document.

The historical defaults below apply where the user has not given a more specific arrangement.

## Ownership

- Advisor: Fable when available; Codex takes over when Fable is unavailable or
  out of quota.
- Opus worker: complex/high-risk execution, difficult debugging, or an
  independent technical audit.
- Sonnet worker: bounded implementation, tests, UI/i18n, and mechanical work.
- The Advisor owns the plan, acceptance criteria, cross-task coordination,
  independent verification, and final integration recommendation.

## Dispatch policy

1. The Advisor writes a bounded task containing scope, exclusions, acceptance
   criteria, verification, base ref, and deployment restrictions.
2. Read-only audits may run against an existing checkout from this repository.
3. Any worker allowed to edit must run in a new isolated worktree.
4. Workers may commit in their worktree but may not push, merge, deploy, or
   change production/external state.
5. A worker report is evidence to review, not proof of completion. The Advisor
   independently inspects the diff and reruns risk-proportional verification.
6. After two failed repair attempts, the worker stops and returns the failure
   evidence for an Advisor decision.

## Model routing

- Use Opus for high-risk architecture execution, complex debugging, algorithm
  changes, migrations, security-sensitive work, and adversarial review.
- Use Sonnet for clear feature implementation, tests, UI changes, i18n,
  documentation, and mechanical refactoring.
- Do not use a Claude worker merely to repeat work the Advisor can verify
  cheaply and directly.

## Integration gate

No worker branch is integrated until the Advisor has checked:

- task scope and unrelated changes;
- acceptance criteria;
- test/typecheck/build evidence appropriate to the change;
- compatibility and rollback risk;
- explicit confirmation that no deployment or production mutation occurred.
