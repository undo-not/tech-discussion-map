# Live mind map workspace

## Scope

The workspace projects the versioned `AnalysisState` into an editable live map without expanding the model's authority. The analysis contract remains the sole source for nodes, links, evidence, provenance, and lifecycle status. Layout coordinates and history are local UI state and are never included in the model schema or outbound request.

## Stable layout and degraded display

Nodes are assigned to deterministic kind lanes. A node keeps its first assigned position even when other nodes are added, withdrawn, filtered, or restored; vacated positions are not compacted within a session. The viewport does not move for ordinary analysis updates, but explicit keyboard navigation scrolls the focused node into view. At most the latest 100 matching nodes are rendered, with an explicit degraded-display notice and search/type filters when more exist. If none of those 100 nodes intersects the current viewport, the viewport moves once to their earliest visible position instead of presenting an empty canvas. This bound limits DOM and edge work while retaining the full validated analysis state. Starting, deleting, or loading a session increments a local workspace generation, remounting the map so both history and retained layout slots reset regardless of the loaded analysis revision.

## Human authority and history

Human title, detail, status, and confirmation changes use a separate local operation path that ends in the same `validateAnalysisState` invariant checks as AI deltas. Any edited field changes provenance to `human-edited`; confirmation-only changes provenance to `human-confirmed`. Later AI deltas cannot overwrite either protected provenance.

AI deltas and human edits share one bounded 50-entry snapshot history. Undo and redo are forward-moving reverts: item content is restored, but revision increases and the applied-delta audit log is retained. This prevents duplicate model deltas and makes any in-flight response based on an older revision fail closed. The UI reports that stale result and provides the explicit analysis-update action; it is not retried automatically. Starting, deleting, or loading another session resets history so evidence cannot cross session boundaries.

## Accessibility and evidence

Every rendered node is a keyboard-focusable button with a roving tab stop. Arrow keys choose the nearest node in that spatial direction, `E` opens editing, `C` confirms an AI suggestion, and Escape cancels an edit. Type, status, provenance, and evidence utterance IDs are present in the accessible name and detail panel. Human editor fields warn that, while OpenAI analysis is enabled, their redacted projection may be sent in a later bounded request.

## Verification

Pure domain tests cover stable placement with 100 nodes, deterministic allocation for new nodes, bounded unified undo/redo, forward-only revision behavior, rejection of an AI overwrite after human confirmation, suppression of duplicate mock nodes after confirmation, selection replacement, the scroll target for distant keyboard navigation, a mixed 300-node degraded viewport, and fresh slots for a loaded session. The app gate also runs typecheck, lint, production build, privacy checks, and the existing native Windows CI jobs.
