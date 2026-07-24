# Claude Dispatcher MCP

This project-local MCP server lets Codex act as the advisor while Claude Opus
and Sonnet act as bounded workers.

## Roles

- `opus`: complex or high-risk implementation, difficult debugging, or an
  independent technical audit.
- `sonnet`: bounded implementation, tests, UI/i18n work, and mechanical edits.

Fable/Codex remains responsible for planning, product decisions, verification,
and final acceptance. Claude workers must not deploy, push, merge, or change
production state.

## Isolation

- `read_only` uses the project checkout or an existing worktree from the same
  repository and denies edit tools.
- `worktree` creates a new branch and worktree under the configured temporary
  state directory. It never copies dirty main-workspace changes.

Jobs are persistent JSON records. Restarting Codex does not erase their result
files. The bridge never removes worktrees automatically.

## Tools

- `claude_dispatch`
- `claude_job_status`
- `claude_list_jobs`
- `claude_cancel_job`
- `claude_dispatcher_health`

Run the non-billable protocol smoke test with:

```powershell
node tools/claude-dispatcher/test-protocol.mjs
node tools/claude-dispatcher/test-dispatch.mjs
node tools/claude-dispatcher/test-recursion-guard.mjs
```

All three tests avoid paid model calls. `test-dispatch.mjs` uses
`mock-claude.mjs` to exercise persistent asynchronous job execution and
polling. `test-recursion-guard.mjs` asserts that `claude_dispatch` refuses to
run when `CODEX_CALLED_FROM_CLAUDE=1` is set in its environment — this is the
target-side half of the anti-recursion guard for `tools/codex-advisor`, the
mirror-image bridge that lets Claude call Codex as an on-demand advisor. See
`tools/codex-advisor/README.md` for the full guard design.
