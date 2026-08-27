# ADR-0001: Web companion with adapter boundaries

- Status: Accepted

## Context

The product must provide immediate visual value during a Teams meeting while Teams transcript, Graph, calling-bot, tenant permission, and distribution constraints remain unresolved. Audio capture, transcription, analysis, Teams integration, and persistence carry different permissions and failure modes.

## Decision

Build a responsive web companion in `app/` using TypeScript, React, and the Sites/Vinext stack. Keep the meeting workspace and typed domain model independent from input, transcription, analysis, Teams, and persistence adapters. Use deterministic demo data as the first adapter and require explicit Issues before connecting sensitive or external adapters.

The domain model preserves source utterance references and distinguishes AI suggestions from human-confirmed content. Raw audio is not persisted by default.

## Consequences

The team can validate the workspace and analysis contract before choosing a Teams integration. Real-time input and deployment can evolve independently, but adapter contracts and end-to-end latency must be tested when each external path is introduced.
