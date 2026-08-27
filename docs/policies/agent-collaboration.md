# Agent collaboration policy

## Shared contract

Codex and Claude Code read `AGENTS.md` and the complete linked Issue before acting. Each assignment is outcome-first and includes only relevant context, hard constraints, acceptance criteria, required evidence, permitted external effects, and the expected response shape.

## Roles

- The implementation writer owns one branch and worktree.
- A consultant or reviewer works read-only against a named commit or diff.
- Delegated implementation uses a separate Issue, `claude/<issue>-<slug>` branch, and isolated worktree.
- The orchestrating agent reconciles findings with the Issue contract; agent output is advice, not project state.

## Claude Code consultation

Run consultation and independent review with `--permission-mode plan`. The prompt identifies the Issue, review target, severity scale, required evidence, stopping condition, and output format. Do not use permission-bypass modes or allow a review session to edit the implementation worktree.

High-risk changes involving external integrations, consent, meeting data, retention, credentials, or model-output contracts require an independent review. Actionable findings are fixed or recorded in the pull request with rationale before merge.

## Handoff

Return findings in priority order with file and line references where possible. Separate verified defects, risks requiring a product decision, and optional improvements. Record only the concise final review summary in the pull request; do not commit generated review logs.
