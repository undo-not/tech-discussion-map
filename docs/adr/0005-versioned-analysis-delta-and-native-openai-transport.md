# ADR-0005: Versioned analysis delta and native OpenAI transport

## Context

Live analysis must accept untrusted meeting text, update an editable local workspace, preserve evidence, and use an external model without giving it authority over human-confirmed content. The OpenAI API key must not enter the browser bundle, GitHub, logs, command arguments, environment variables, or the Node companion process.

## Decision

Use a pure TypeScript, versioned state-and-delta algebra with five closed operations. Validate then apply atomically, mint IDs locally, make delta IDs idempotent, reject stale revisions, and protect human provenance in the apply layer. Keep a deterministic mock analyzer as the default and outage fallback.

Use Responses Structured Outputs with the pinned analysis JSON Schema, `store: false`, and a locally redacted bounded context. The Windows native privacy helper owns `CredReadW` and WinHTTP. It posts only to the compiled Responses endpoint using direct transport, normal certificate validation, TLS 1.2, finite timeouts, and bounded bodies. The loopback companion authenticates the browser, validates the exact request and schema, and rate-limits calls before spawning the helper.

## Consequences

Model output cannot partially mutate state or silently replace a human decision. Prompt and schema changes are reviewable through hashes and synthetic regression fixtures. OpenAI outages preserve local work and allow mock/manual continuation. Direct WinHTTP intentionally fails in networks requiring proxy interception; adding proxy support requires an explicit privacy decision. Same-Windows-user malware is not isolated by Credential Manager or this helper and remains outside the declared boundary.

## References

- [OpenAI Responses API: create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
