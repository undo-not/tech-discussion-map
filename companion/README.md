# Local transcription companion

This Node.js host is the only browser-to-native bridge used by the MVP. It binds to `127.0.0.1:43117`, accepts requests only from the local UI origins, requires the ephemeral launch secret printed to its owning console before issuing short-lived in-memory bearer tokens, streams bounded PCM frames to `techmap-transcriber.exe`, and forwards strict alias-only caption events from `techmap-captions.exe`. It does not persist or log audio, OCR images, TSV, raw participant names, or caption events.

Run it with Node.js 22.18 or newer. The host intentionally imports the shared TypeScript policy and schema modules directly, relying on Node's unflagged type-stripping support so the browser and companion validate one pinned contract.

Build the native worker and install the model before a meeting, then run:

```powershell
node companion/local-transcription-host.mjs
```

Open the exact `http://127.0.0.1:3000/#techmap-launch=...` URL printed at startup. The fragment is consumed into browser memory and removed from the address bar before bootstrap. Restarting the companion rotates the secret and invalidates prior bootstrap attempts.

The browser UI remains a separate Vinext process bound to loopback. Whisper setup is described in `native/transcription/README.md`; caption OCR setup and selection behavior are described in `native/teams-captions/README.md`.
