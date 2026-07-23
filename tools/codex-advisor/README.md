# Codex Advisor MCP

This project-local MCP server lets Claude Code (advisor/scheduler role) call
Codex as an on-demand advisor for high-stakes judgment calls. It is the
mirror-image counterpart of `tools/claude-dispatcher`, which lets Codex
dispatch bounded work to Claude Opus/Sonnet workers.

## When to call this (enforced by convention, not by code)

- PRD / implementation plan final review
- High-risk architecture, data, or migration decisions
- Resolving a conflict between Opus/Sonnet worker conclusions
- Final commit/diff acceptance before merge
- Merge/deploy ordering decisions

Do not call it for routine implementation, tests, or mechanical edits — that
would burn both Claude and Codex usage for no reason. This tool has no quota
awareness and never auto-detects whether Fable is available; the calling
decision is made by the Claude session, not by this server.

## Tools

- `ask_codex_advisor` — plan/decision review. Takes only the fields you pass
  (task, context file paths, constraints, acceptance criteria) — never the
  full conversation history.
- `review_with_codex` — diffs two **committed** git refs and asks Codex for a
  final verdict against a PRD and acceptance criteria. Uncommitted
  working-tree changes are not supported; diff those yourself and pass the
  text through `ask_codex_advisor` instead.
- `codex_job_status` — poll a job started by either tool above.

Both dispatch tools return a job id immediately and run Codex in a detached
background worker; nothing blocks the calling Claude turn.

## Sandbox and safety

Every `codex exec` invocation is fixed to:

```
codex exec --ephemeral -s read-only --skip-git-repo-check --json
  -c mcp_servers.claude_dispatcher.enabled=false
  -o <job>.output.txt -C <project_root>
```

- `-s read-only`: Codex cannot write files, commit, push, merge, or deploy.
- `--dangerously-bypass-approvals-and-sandbox` is never used and is not
  accepted as a caller-supplied option.
- `-c mcp_servers.claude_dispatcher.enabled=false` disables the reverse
  bridge for this invocation at the config level, not just by convention.
- The child process env is allowlisted (not inherited wholesale) and always
  carries `CODEX_CALLED_FROM_CLAUDE=1`.

## Anti-recursion (defense in depth)

Codex sessions in this project can normally reach back into Claude via
`tools/claude-dispatcher` (`claude_dispatch` etc.). A Codex session spawned by
this advisor bridge must never be able to do that:

1. **Config-level block**: `-c mcp_servers.claude_dispatcher.enabled=false`
   is passed on every invocation, so the Codex process never connects to
   that MCP server in the first place.
2. **Env sentinel**: `CODEX_CALLED_FROM_CLAUDE=1` is set on the child process
   and propagates to any further descendant process.
3. **Prompt-level instruction**: the fixed preface tells the model directly
   not to attempt delegating back to Claude, even if such a tool were
   visible.
4. **Target-side guard**: `tools/claude-dispatcher/server.mjs`'s `dispatch()`
   refuses immediately if `CODEX_CALLED_FROM_CLAUDE=1` is set in its own
   process environment, regardless of whether guards 1-3 held.

`test-mock-invoke.mjs` asserts guards 1 and 2 fired on every mock call.

## State

Jobs and logs live under `%TEMP%\vibepin-codex-advisor\jobs` (override with
`CODEX_ADVISOR_STATE_ROOT`), independent of `claude-dispatcher`'s state
directory. This server never creates or removes git worktrees and never
touches the main working tree's uncommitted changes.

## Tests (no paid model calls)

```powershell
node tools/codex-advisor/test-protocol.mjs
node tools/codex-advisor/test-mock-invoke.mjs
```
