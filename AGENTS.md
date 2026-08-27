# Repository agent contract

These instructions apply to the entire repository and are shared by Codex and Claude Code.

## Sources of truth

- Use GitHub Issues for objectives, scope, acceptance criteria, progress, blockers, and future work.
- Use one Issue-linked branch and pull request as the implementation and review surface for one cohesive outcome.
- Treat `docs/specs/` as normative product behavior, `docs/policies/` as current operating rules, and `docs/adr/` as durable decision rationale.
- Keep status reports, roadmaps, audit logs, local plans, and handoff notes out of the repository. Put volatile state in the Issue or pull request.
- Treat chat history, agent memory, and generated summaries as non-authoritative.

## Task contract

Before changing files, read the complete linked Issue and restate only what is needed to execute it:

- outcome and relevant context;
- hard constraints, non-goals, and approval boundaries;
- observable acceptance criteria and required evidence;
- expected output or handoff shape.

State each instruction once. Prefer an outcome-first prompt and leave implementation choices to the assigned agent unless the exact path is a product or safety requirement. Expose only relevant tools and context. Ask for clarification only when a missing choice would materially change the result.

## Issue delivery

- Start from updated `main`. Use `codex/<issue>-<slug>` for Codex, `claude/<issue>-<slug>` for Claude Code, and `human/<issue>-<slug>` for a person.
- Keep one writer per branch and worktree. A second agent consults or reviews read-only unless it owns a separate Issue branch and worktree.
- Update current specs, policies, ADRs, and tests in the same pull request as the behavior they describe.
- Use cohesive commits that reference the Issue. Use `Closes #<issue>` only when every acceptance criterion is met.
- Write Issue and pull-request titles, bodies, progress comments, and review summaries in Japanese. Keep code identifiers, paths, and commands in their original language.
- Do not merge the first implementation pull request without explicit user acceptance. Later automatic acceptance requires a separate user instruction and green required checks.

## Product and safety boundaries

- Treat meeting audio, transcripts, participant identity, tenant configuration, and credentials as sensitive data.
- Do not access a microphone, Teams tenant, Microsoft Graph, external model, or hosted data store unless the linked Issue authorizes that exact external action.
- Require an explicit user gesture before audio capture. Do not persist raw audio by default.
- Keep every AI-derived decision, question, action, risk, and claim traceable to source utterance IDs.
- Distinguish AI suggestions from human-confirmed content. Never silently overwrite human-confirmed content.
- Fail closed for invalid schemas, broken evidence references, missing consent, or unknown external permissions.

## Implementation

- Build the web application in `app/` with TypeScript, React, and the existing Sites/Vinext toolchain.
- Keep domain contracts independent from microphone, transcription, model, Teams, and persistence adapters.
- Prefer small typed modules and deterministic fixtures. Avoid adding a dependency when the platform or existing stack is sufficient.
- Preserve user changes and avoid destructive Git operations. Use `rg` for search and the active agent's reviewable patch facility for hand edits.
- Never commit credentials, real meeting data, generated build output, or `node_modules`.

## Validation

Select checks proportionate to risk. For every pull request, run from `app/`:

```powershell
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
```

Also run `git diff --check` from the repository root. Report exact outcomes, skipped external checks, and residual risk in the pull request. External-integration and privacy changes require an independent read-only review.

## Agent collaboration

- Follow `docs/policies/agent-collaboration.md` when consulting or delegating to another coding agent.
- Do not let the authoring agent be the only reviewer for external integration, privacy, data retention, or model-output contract changes.
- Do not use permission-bypass modes.
