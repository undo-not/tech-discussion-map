# ADR-0006: Keep live-map layout and forward history local

## Context

Analysis updates arrive while an operator may be navigating, confirming, or editing the same meeting structure. Re-running a force layout would move unrelated nodes, and rewinding the analysis revision during undo would make queued model responses ambiguous. Adding coordinates or human operations to the model schema would also give the model authority it does not need.

## Decision

Keep stable lane-slot coordinates and bounded snapshot history in the local workspace layer. Apply human changes through a separate validator-backed function. Undo and redo restore items as a new higher revision while retaining the applied-delta audit log. Reject an in-flight delta when its captured revision is stale and require an explicit re-analysis action.

## Consequences

Unrelated node positions remain stable and all changes share one undo surface. Map state stays out of external requests except for the already documented bounded, redacted analysis projection. The local history is intentionally session-scoped and is reset at session boundaries. Layout is functional rather than graph-optimized, and display is capped at 100 matching nodes for the MVP.
