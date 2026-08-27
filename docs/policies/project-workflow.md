# Project workflow policy

## Information ownership

| Information | Authoritative location |
|---|---|
| Objective, scope, acceptance criteria | GitHub Issue |
| Progress, blocker, test summary | Issue or pull request |
| In-flight implementation | Issue-linked branch |
| Review and merge decision | Pull request |
| Normative behavior | `docs/specs/` |
| Durable decision | `docs/adr/` |
| Operating constraint | `docs/policies/` and `AGENTS.md` |
| Executable evidence | tests, fixtures, schemas, and CI |

Chat, local plans, agent memory, branch names, and generated reports are not authoritative project state.

## Issue contract

Every implementation Issue defines one cohesive outcome, included scope, explicit non-goals, observable acceptance criteria, evidence expectations, dependencies, safety boundaries, and permitted external effects. Split a child Issue only when it can be delivered or reviewed independently.

GitHub Issue and pull-request titles, descriptions, progress comments, and review summaries are written in Japanese. Code identifiers, paths, commands, and quoted external text remain in their original language when translation would reduce precision.

## Branch and pull-request lifecycle

1. Read the complete Issue and update `main`.
2. Create one branch owned by one writer.
3. Update behavior, specs, durable decisions, and tests together.
4. Open a pull request with `Closes #<issue>` only when all acceptance criteria are satisfied.
5. Record exact validation, skipped checks, independent review, external effects, and residual risk in the pull request.
6. Merge after required checks and acceptance. Delete the branch after merge.

Branch existence does not communicate progress. Pauses, blockers, scope changes, and handoffs belong in the Issue.

## Repository documentation

Tracked documentation uses present-tense normative language. Do not add project status, roadmap, milestone, completion report, next-work queue, test transcript, audit log, or temporary handoff document. Put unresolved work in an Issue and durable rationale in a new ADR.
