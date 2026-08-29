# Local transcription companion

This Node.js host is the only browser-to-native bridge used by the MVP. Browser APIs bind to `127.0.0.1:43117`, accept only local UI origins, and require the ephemeral launch secret before issuing short-lived in-memory bearer tokens. Zoom RTMS uses a second listener at `127.0.0.1:43118/zoom/webhook`; it has one signed POST route, no CORS, and no browser or storage API. The host does not persist or log audio, OCR images, TSV, raw participant names, Zoom identities, raw RTMS packets, or caption events.

Run it with Node.js 22.18 or newer. The host intentionally imports the shared TypeScript policy and schema modules directly, relying on Node's unflagged type-stripping support so the browser and companion validate one pinned contract.

Build the native worker and install the model before a meeting, then run:

```powershell
node companion/local-transcription-host.mjs
```

Start the real-meeting runtime with `powershell -ExecutionPolicy Bypass -File scripts/start-mvp.ps1`. The launcher provisions a random secret to the UI server over a loopback request body before opening a plain URL. The secret never appears in a URL, browser history, process argument, file, or console. Restarting the launcher rotates it and invalidates prior bootstrap attempts.

The browser UI remains a separate Vinext process bound to loopback. Zoom setup and the narrow temporary-tunnel boundary are described in `docs/specs/zoom-rtms-source.md`; Whisper setup is described in `native/transcription/README.md`; caption OCR setup and selection behavior are described in `native/teams-captions/README.md`.
