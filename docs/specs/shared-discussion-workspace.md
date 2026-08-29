# Shared discussion workspace

## Purpose and authority boundary

The shared discussion workspace is the screen-sharing surface for a live technical discussion. It helps participants see the current issue, evidence, decisions, unresolved work, actions, risks, and the latest structural change without introducing another persisted data model. The versioned `AnalysisState` remains the sole source of truth. The focus map, decision board, Action/Risk board, side insights, counts, and current-issue banner are deterministic UI projections and are never saved as meeting data or sent to an analyzer.

Changing a view does not create or mutate an analysis item. Edits and confirmations continue through the existing validator-backed human mutation path. View selection, transcript search, presentation mode, one-shot highlight state, and map coordinates are local UI state. Starting, loading, or deleting a session resets that state through the existing workspace generation boundary.

## Views

The default **議論フォーカス** view retains the editable live mind map. **決定ボード** groups decision items into proposed/open, blocked, and confirmed/done columns. It may also navigate to question and topic items through explicit evidence links, but does not synthesize board records for them. **Action・Risk** groups action and risk items using the same columns. Withdrawn and superseded items are omitted from board and insight projections but remain available in the map's explicit history navigation.

The newest active open/proposed/blocked question or topic is shown as the current issue. Ordering is derived from validated item order and is stable for an unchanged revision. Switching among views preserves the selected item, transcript, analysis history, and retained map layout. Unsupported items reached through an explicit transcript, insight, or change-rail command switch to the focus view. Ordinary analysis updates never switch the view, move keyboard focus, pan the map, or replace the user's manual selection.

## Graphical updates

When the `AnalysisState.revision` changes, the workspace compares semantic item values with the previous rendered revision. It reports an addition, content update, or status transition. Evidence and link ordering are normalized so ordering-only changes do not create false updates. Each affected item receives one short emphasis and the bottom update rail provides a persistent textual symbol, label, title, and status transition when relevant. Re-rendering the same revision produces no new event and does not restart emphasis.

The UI does not continuously animate or automatically pan. `prefers-reduced-motion` reduces the emphasis duration to the global minimum while the textual update rail remains understandable without motion or color.

## Presentation mode, evidence, and safety

Presentation mode increases the central workspace share and reduces setup density. It does not unmount capture state. `CAPTURE`, `OPENAI送信`, `LOCAL保存`, input source, external-analysis permission, and participant-consent indicators remain visible, together with an operable compact consent checkbox and active pause/resume/stop controls. A meeting-ended retention reminder also remains visible. The full persistence, external-send, diagnostics, export/delete, and setup controls return when presentation mode is disabled.

Transcript, insight, board, and update-rail controls use the existing one-shot evidence navigation contract. The destination is selected and, only after an explicit user command, keyboard focus may move to the active destination. Tabs, cards, map nodes, and presentation mode are keyboard-operable; state is expressed in text and accessible attributes; structural update text is announced through a polite live region.

## Responsive and security constraints

At desktop sharing widths the workspace uses transcript, central view, and insight columns. At narrower widths, including 736 px and 360 px, the regions stack without dropping data or controls. No remote font, CDN, telemetry, new network destination, meeting fixture, participant identity, or credential is added. Export formats, strict IBIS/Toulmin contracts, owner/due-date fields, and Zoom/Teams adapter changes are outside this specification.

## Verification

Pure tests cover deterministic projection, state immutability, column assignment, semantic add/update/status detection, ordering normalization, and view containment. Component tests cover view switching with the map retained, shared selection, explicit fallback to the focus view, one update entry per revision, the presentation toggle, and continued safety-indicator visibility. The repository gate additionally runs typecheck, lint, production build, privacy checks, portable-launch checks, and native Windows jobs.
