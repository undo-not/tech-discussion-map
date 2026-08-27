# ADR-0006: Keep live-map layout and forward history local

## Context

Analysis updates arrive while an operator may be navigating, confirming, or editing the same meeting structure. Re-running a force layout would move unrelated nodes, and rewinding the analysis revision during undo would make queued model responses ambiguous. Adding coordinates or human operations to the model schema would also give the model authority it does not need.

## Decision

Keep stable lane-slot coordinates and snapshot history bounded across the combined undo and redo stacks by 50 entries and an estimated 8 MiB in the local workspace layer. Trim the farthest target on whichever side has greater depth so the nearest undo and redo operations remain available. Apply human changes through a separate validator-backed function. Undo and redo restore items as a new higher revision while retaining the applied-delta audit log. Preserve an undone AI addition as a withdrawn evidence tombstone and reject a later model add based only on that evidence. Reject an in-flight delta when its captured revision is stale and require an explicit re-analysis action. Treat every start, delete, and saved-session load as a new local workspace generation so React remounts the map and discards prior layout slots independently of analysis revision.

## Consequences

Unrelated node positions remain stable and all changes share one undo surface. Map state stays out of external requests except for the already documented bounded, redacted analysis projection. Local history and retained layout slots are session-scoped and reset at session boundaries. Layout is functional rather than graph-optimized, and display is capped at the latest 100 matching nodes for the MVP.
