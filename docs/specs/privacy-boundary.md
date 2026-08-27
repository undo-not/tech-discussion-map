# Privacy, consent, and data lifecycle specification

## Consent and indicators

`consent-confirmed` is a versioned in-memory record containing confirmation time and `all-participants` scope. A local capture start request without this record is rejected before `getUserMedia` or WASAPI opens a device. Revoking confirmation while permission or capture is pending stops capture and deletes the current local session. Consent is rechecked after both device open and companion session creation. The application does not infer consent from Teams configuration or captions.

The UI always renders three independent indicators:

- `CAPTURE ON/OFF` is derived from the capture session state;
- `OPENAI送信 ON/OFF` is derived only from the count of in-flight native Responses requests; permission being enabled does not display a send in progress;
- `LOCAL保存 ON/OFF` reflects the current opt-in setting and never includes raw audio.

## Local data lifecycle

Raw audio has no persistence option. Final transcript, analysis, consent, and session state can be persisted only after opt-in. The native helper provisions `%LOCALAPPDATA%\TechMapLive\sessions` with a non-inherited DACL containing only the current Windows user ACE before the first file is created. Every `.tmps` file contains a DPAPI CurrentUser ciphertext; a plaintext fallback is forbidden.

Session IDs are UUIDs. File names are validated and resolved under the fixed root. Plaintext is limited to 1 MiB, ciphertext to 8 MiB, and the list to 100 sessions. Writes use a unique temporary ciphertext file, flush, and atomic rename. Temporary files contain ciphertext only. Reads validate the complete schema and reject fields named audio, PCM, recording, API key, or authorization.

Persisted retention choices are 1, 7, 30, or 90 days. Expired sessions are swept on privacy-store initialization and explicit refresh. Immediate delete first stops active input, drains pending encrypted writes, removes the entire encrypted session, and prevents that session ID from being persisted again. An unreadable session remains visible as unreadable and can be deleted without decryption. An unpersisted session never reaches disk. Local deletion does not delete a separately exported file or an external API copy. On browser startup, the obsolete `techmap-live-local` IndexedDB from pre-DPAPI builds is deleted without reading its plaintext.

Export requires a user gesture and the browser OS save picker. There is no default export directory or automatic export. Unsupported browsers fail visibly.

## Credential boundary

The OpenAI API key is stored as generic Windows Credential `TechMapLive/OpenAIApiKey`. The setup helper reads it with console echo disabled, validates a printable `sk-` form, writes it through `CredWriteW`, zeroes temporary buffers, and never returns the credential. Status reveals only configured／not configured. Deletion uses `CredDeleteW`.

## Redaction and Responses request

The outbound analysis context includes at most eight final utterances with only utterance ID, source, time, and text, plus at most 40 active local analysis projections with item ID, kind, provenance, status, title, the first 180 characters of detail, and evidence IDs. The utterance window is redacted locally, then the bounded combined context is redacted again so previously derived labels cannot bypass current policy. Deterministic local rules apply NFKC normalization and redact OpenAI-style keys, credential assignments, email, phone, IPv4, and URLs containing query strings. They are heuristic and do not claim to remove every personal or organization name. Invalid Unicode, NUL, empty, oversize, or residual secret patterns fail closed. Before enabling external analysis, the UI states every projected field and displays the actual final combined context that would be sent; it never shows a different transcript-only preview or a hidden pre-redaction diagnostic log.

Only the privacy-safe request factories can construct analyzer requests. Plain requests contain exactly `model`, `store`, and `input`; structured analysis adds only `text.format` with the pinned strict JSON Schema. `store` is literal `false`. The destination is exactly `https://api.openai.com/v1/responses`. Automatic retry count is zero and timeout is 20 seconds. Background mode, conversations, previous response IDs, tools, files, remote MCP, web search, analytics, telemetry, error tracking, remote font, CDN, and source-map upload are forbidden in real-meeting runtime.

Before external analysis can be enabled, the operator confirms the selected API project's data controls and retention. The UI states that Responses API customer content may be retained in abuse monitoring logs for up to 30 days by default and that ZDR／MAM requires OpenAI approval and project configuration. The attestation is an operator claim, not automated proof.

## Threat model

| Threat | Control | Evidence |
|---|---|---|
| Capture before/revoked consent | consent record required before device open; revoke stops pending/active capture | UI state tests and manual synthetic test |
| Browser, hostile site, or another local Windows user reaches local host | loopback bind, exact Host and Origin, ephemeral console-delivered launch secret, short-lived bearer, bounded requests | companion network test |
| Another Windows user reads session files | protected current-user-only DACL + DPAPI CurrentUser | native Windows self-test |
| Plaintext or raw audio reaches disk | typed session schema, forbidden-field scan, DPAPI-only writer, no audio store | privacy-store test and source scan |
| Secret reaches OpenAI or logs | deterministic redaction, residual-secret verifier, no request/content log | redaction tests |
| OpenAI retains application state | `store:false`, no conversations/background/files/tools | exact-key request test |
| Unapproved runtime egress | exact OpenAI URL factory; all other remote runtime services absent | repository/network policy test |
| API key enters browser or Node | native helper owns Credential Manager read and fixed WinHTTP request | Windows build and native source policy test |
| Real data reaches GitHub | ignored data extensions/paths and tracked-file secret scan; synthetic fixtures only | CI public-repository scan |
| Retention outlives user choice | expiry sweep and whole-session delete | lifecycle test |

Tests and CI use only synthetic content. Real meeting verification requires participant consent and a separate manual checklist that records no content.

The boundary does not defend against malware or another process already running as the same Windows user: such a process can inspect that user's UI or invoke that user's DPAPI and Credential Manager context. The launch secret blocks unauthenticated loopback callers and other local users; it is not a same-user sandbox.
