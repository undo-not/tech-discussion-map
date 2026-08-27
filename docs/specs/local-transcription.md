# Local transcription specification

## User-visible flow

1. Initial state is `idle`. Device enumeration may run, but microphone capture must not.
2. `マイクを開始` is enabled only on an HTTP loopback origin. The click changes state to `requesting-permission` and calls `getUserMedia`.
3. After permission, the UI starts the local companion and pinned whisper worker. Success changes state to `listening`.
4. Pause drops new PCM before the worker boundary. Resume requires an existing non-stopped session. Stop closes browser capture, flushes the worker, destroys audio buffers, and does not auto-restart.
5. Permission denial, missing device, missing worker/model, malformed worker output, and local host failure are visible. The user can always select synthetic demo without microphone access.

The UI states are `idle`, `requesting-permission`, `starting-local-engine`, `listening`, `paused`, `stopped`, `permission-denied`, `device-unavailable`, and `engine-unavailable`.

## Utterance contract

Each utterance contains a bounded ID, monotonic revision, `partial` or `final` phase, `local`／`remote`／`synthetic` source, `self`／`remote-group`／`unknown` speaker label, integer start/end milliseconds, and at most 8,000 characters of text.

- Lower or duplicate revisions are ignored.
- A final utterance cannot regress to partial.
- A higher-revision corrected final is preserved as an explicit analyzer event.
- Display order uses start time and stable ID, independent of arrival order.
- The analyzer boundary consumes only entries in `finalForAnalysis`.

MVP must not infer an individual identity from the remote mixed stream.

## Data and network boundary

- Browser microphone PCM: 16 kHz, mono, signed 16-bit little endian, maximum 128 KiB per request.
- Browser送信queue: maximum 512 KiB. local hostが追いつかない場合は古い音声を蓄積せず、sessionを`engine-unavailable`へfail closedする。
- Teams PCM: 48 kHz stereo signed 16-bit little endian, three-frame boxcar low-passでdownmixしてから3:1 decimationし、shared input formatへ変換する。
- Companion listener: exactly `127.0.0.1:43117`.
- Allowed UI origins: `http://127.0.0.1:3000` and `http://localhost:3000`.
- Browser authorization: 256-bit random token, memory-only, Origin-bound, ten-minute expiry.
- Worker IPC: versioned `TMI1` input and `TMO1` output frames with reserved-byte and size validation.
- Raw audio has no file, IndexedDB, localStorage, log, telemetry, crash attachment, or external network sink.
- Meeting runtime has no model download path.

Final transcripts are persisted only after explicit checkbox opt-in. IndexedDB is outside the Git working tree; retention is until the user selects `保存データを削除`. Issue #6 extends deletion to complete session state and exports.

## Manual verification boundary

Before Issue #6, test only synthetic input and the operator's own solo microphone. Do not capture a Teams meeting or another participant. Verify the local UI on port 3000, model checksum, worker startup, start/pause/resume/stop, error fallback, opt-in save, and delete.
